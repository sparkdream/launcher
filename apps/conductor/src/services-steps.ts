import type { StepDef } from "./engine.js";
import { generateServicesKeysStep, renderSdlsStep, validateSpecStep } from "./steps/phase-a.js";
import {
  collectBidsStep,
  createDeploymentsStep,
  createLeasesStep,
  ensureCertificateStep,
  sendManifestsStep,
} from "./steps/phase-bcd.js";
import type { LaunchSpec } from "@sparkdream/launch-spec";
import { isServicesFleet } from "@sparkdream/launch-spec";
import { configureNtfyStep, finalizeStep, phaseEFSteps, verifyServicesStep } from "./steps/phase-ef.js";
import { configureMastodonStep } from "./steps/mastodon.js";

/**
 * A services fleet: no chain, no nodes, no mesh. Keys (SSH, age), the
 * component SDLs, the Akash certificate, then the components' deployments,
 * bids, leases and manifests as a chain launch has them, their domains, and
 * each kind's configuration (Mastodon's owner and registrations).
 */
export function servicesSteps(): StepDef[] {
  return [
    validateSpecStep,
    generateServicesKeysStep,
    renderSdlsStep,
    ensureCertificateStep,
    createDeploymentsStep,
    collectBidsStep,
    createLeasesStep,
    sendManifestsStep,
    verifyServicesStep,
    configureMastodonStep,
    configureNtfyStep,
    finalizeStep,
  ];
}

/**
 * The launch steps a mid-launch re-place runs again: send-manifests (whose
 * "lease is gone" recovery re-deploys and re-bids the closed component) and
 * everything after it, since a launch caught mid-flight has not done them
 * and one re-opened after it finished has them all marked done.
 */
export function replaceRerunSteps(spec: LaunchSpec): string[] {
  if (isServicesFleet(spec)) {
    const names = servicesSteps().map((s) => s.name);
    return names.slice(names.indexOf("send-manifests"));
  }
  return ["send-manifests", "upload-node-data", ...phaseEFSteps().map((s) => s.name)];
}
