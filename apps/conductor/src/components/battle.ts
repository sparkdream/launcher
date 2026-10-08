import type { ComponentDescriptor, RenderInput, SdlResources } from "./types.js";

// one Node process runs every match (bots included) on one core; the
// persistent volume keeps the leaderboard across restarts and updates
const resources: SdlResources = {
  cpu: { units: 1 },
  memory: { size: "1Gi" },
  storage: [
    { size: "1Gi" },
    { name: "data", size: "1Gi", attributes: { persistent: true, class: "beta3" } },
  ],
};

/**
 * The battle royale game: the battle-royale repo's image, one process serving
 * the game page and its WebSocket game server on port 2567. The client
 * connects to whatever origin served the page, so the deployment carries
 * nothing domain- or chain-specific. Its leaderboard is a JSON file in
 * /app/data (the image takes ownership of the volume before dropping root).
 */
function render(input: RenderInput) {
  const { component } = input;
  return {
    battle: {
      service: {
        image: component.image,
        expose: [{ port: 2567, as: 80, accept: [component.domain!], to: [{ global: true }] }],
        params: { storage: { data: { mount: "/app/data", readOnly: false } } },
      },
      resources,
    },
  };
}

export const battle: ComponentDescriptor = {
  key: "battle",
  render,
  resources: () => [resources],
  imageServices: ["battle"],
  shellService: "battle",
  tunnels: () => [],
  envRefresh: "rerender",
  retargetEnv: () => ({}),
};
