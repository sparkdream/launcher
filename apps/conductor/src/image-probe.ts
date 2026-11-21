/**
 * Whether a provider could pull an image, asked of the image's own registry
 * before an op is started for it. An upgrade to a tag that was never pushed
 * is accepted by Akash and then sits in ImagePullBackOff, with the fee paid
 * and (for a rolling upgrade) the node already stopped.
 *
 * Only a definite answer refuses: the registry says the tag is not there,
 * that it cannot be read without credentials (providers pull anonymously:
 * the SDLs carry none), or that it has no linux/amd64 build. A registry that
 * cannot be reached, throttles, or answers anything else is "unknown", which
 * callers let through.
 */

export type ImageAvailability =
  | { state: "available" }
  | { state: "missing"; why: string }
  | { state: "unknown"; why: string };

export type ImageProber = (image: string) => Promise<ImageAvailability>;

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

const TIMEOUT_MS = 10_000;

export interface RegistryRef {
  /** the name as written, for messages ("docker.io" for a bare reference) */
  registry: string;
  /** the host that serves the registry API */
  host: string;
  repository: string;
  /** tag or digest: what the manifest is asked for by */
  reference: string;
}

/** Split an image reference the way a container runtime does (a bare name is Docker Hub, no tag is "latest"). */
export function parseRegistryRef(image: string): RegistryRef {
  let rest = image;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const slash = rest.indexOf("/");
  const first = slash >= 0 ? rest.slice(0, slash) : "";
  // the first part names a registry only when it looks like a host
  const hasRegistry = slash >= 0 && (/[.:]/.test(first) || first === "localhost");
  let registry = hasRegistry ? first : "docker.io";
  let repository = hasRegistry ? rest.slice(slash + 1) : rest;
  let host = registry;
  if (registry === "docker.io" || registry === "index.docker.io" || registry === "registry-1.docker.io") {
    registry = "docker.io";
    host = "registry-1.docker.io";
    if (!repository.includes("/")) repository = `library/${repository}`;
  }
  return { registry, host, repository, reference: digest ?? tag ?? "latest" };
}

/** key="value" pairs of a `WWW-Authenticate: Bearer …` challenge, or null for any other scheme. */
function bearerChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/([a-z_]+)="([^"]*)"/gi)) out[m[1]!.toLowerCase()] = m[2]!;
  return out.realm ? out : null;
}

export function registryImageProber(fetchImpl: FetchLike = fetch as FetchLike): ImageProber {
  const call = (url: string, method: string, token?: string) =>
    fetchImpl(url, {
      method,
      headers: { Accept: MANIFEST_ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return async (image) => {
    let ref: RegistryRef;
    try {
      ref = parseRegistryRef(image);
      // a plain-HTTP or local registry is not one a provider pulls from
      if (ref.host.startsWith("localhost")) return { state: "unknown", why: "a local registry is not checked" };
    } catch (e) {
      return { state: "unknown", why: String(e) };
    }
    const url = `https://${ref.host}/v2/${ref.repository}/manifests/${ref.reference}`;
    const noAccess: ImageAvailability = {
      state: "missing",
      why:
        `${ref.registry} refuses to serve ${ref.repository} without a login: the repository does not exist ` +
        "(check the name), or it is private, and providers pull without credentials",
    };
    try {
      // HEAD first: Docker Hub does not count it against the anonymous pull limit
      let token: string | undefined;
      let res = await call(url, "HEAD");
      if (res.status === 401) {
        const challenge = bearerChallenge(res.headers.get("www-authenticate"));
        if (!challenge) return { state: "unknown", why: `${ref.registry} asks for a login this check cannot do` };
        const q = new URLSearchParams();
        if (challenge.service) q.set("service", challenge.service);
        q.set("scope", challenge.scope ?? `repository:${ref.repository}:pull`);
        const tokenRes = await fetchImpl(`${challenge.realm}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (tokenRes.status === 401 || tokenRes.status === 403) return noAccess;
        if (!tokenRes.ok) return { state: "unknown", why: `${ref.registry} token request: HTTP ${tokenRes.status}` };
        const body = (await tokenRes.json()) as { token?: string; access_token?: string };
        token = body.token ?? body.access_token;
        if (!token) return { state: "unknown", why: `${ref.registry} gave no token` };
        res = await call(url, "HEAD", token);
      }
      if (res.status === 404) {
        return { state: "missing", why: `${ref.registry} has no ${ref.repository}:${ref.reference} (not pushed, or the tag is misspelled)`.replace(":sha256:", "@sha256:") };
      }
      if (res.status === 401 || res.status === 403) return noAccess;
      if (!res.ok) return { state: "unknown", why: `${ref.registry}: HTTP ${res.status}` };

      // a multi-platform image a provider cannot run is as good as missing
      const type = res.headers.get("content-type") ?? "";
      if (/manifest\.list|image\.index/.test(type)) {
        const full = await call(url, "GET", token);
        if (full.ok) {
          const index = (await full.json()) as { manifests?: { platform?: { os?: string; architecture?: string } }[] };
          const platforms = (index.manifests ?? []).map((m) => m.platform).filter((p) => p?.os && p.os !== "unknown");
          if (platforms.length > 0 && !platforms.some((p) => p!.os === "linux" && p!.architecture === "amd64")) {
            const built = [...new Set(platforms.map((p) => `${p!.os}/${p!.architecture}`))].join(", ");
            return { state: "missing", why: `it has no linux/amd64 build (only ${built}), which is what providers run` };
          }
        }
      }
      return { state: "available" };
    } catch (e) {
      return { state: "unknown", why: `${ref.registry} did not answer (${e instanceof Error ? e.message : e})` };
    }
  };
}
