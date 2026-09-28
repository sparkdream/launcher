import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

// nginx serving a prebuilt static bundle: the three.js scene runs in the
// visitor's browser, not here
const resources: SdlResources = {
  cpu: { units: 0.25 },
  memory: { size: "256Mi" },
  storage: [{ size: "512Mi" }],
};

/**
 * The landing page: the hub repo's Vite build behind nginx on port 80. Its one
 * setting (the app link) is baked in at image build time, so the deployment
 * carries no env and nothing chain-specific.
 */
function render(input: RenderInput) {
  const { component } = input;
  return {
    hub: {
      service: {
        image: component.image,
        expose: [{ port: 80, as: 80, accept: [component.domain!], to: [{ global: true }] }],
      },
      resources,
    },
  };
}

export const hub: ComponentDescriptor = {
  key: "hub",
  render,
  resources: () => [resources],
  imageServices: ["hub"],
  shellService: "hub",
  tunnels: () => [],
  envRefresh: "rerender",
  retargetEnv: () => ({}),
};
