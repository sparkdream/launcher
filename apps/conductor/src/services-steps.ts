import type { StepDef } from "./engine.js";
import { generateServicesKeysStep, renderSdlsStep, validateSpecStep } from "./steps/phase-a.js";
import {
  collectBidsStep,
  createDeploymentsStep,
  createLeasesStep,
  ensureCertificateStep,
  sendManifestsStep,
} from "./steps/phase-bcd.js";
import { finalizeStep, verifyServicesStep } from "./steps/phase-ef.js";
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
    finalizeStep,
  ];
}
