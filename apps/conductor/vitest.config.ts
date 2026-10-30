import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // each network's genesis binary (pnpm build-chain-bins)
    setupFiles: ["test/chain-bins.ts"],
    globalSetup: ["test/chain-bins.ts"],
  },
});
