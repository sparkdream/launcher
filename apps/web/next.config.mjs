/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the conductor serves apps/web/out — one container, no
  // Next server. If server/API capabilities are ever needed, remove this
  // line and run `next start` alongside (or instead of) static serving.
  output: "export",

  // Dev only: proxy /api to the conductor so the UI is same-origin.
  // (Ignored by `next build` — production is served by the conductor itself.)
  ...(process.env.NODE_ENV === "development"
    ? {
        async rewrites() {
          return [
            { source: "/api/:path*", destination: `http://127.0.0.1:${process.env.CONDUCTOR_PORT ?? "8180"}/api/:path*` },
          ];
        },
      }
    : {}),
};

export default nextConfig;
