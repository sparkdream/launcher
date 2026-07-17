import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-launch chain assets (§13): which sparkdreamd binary and vendor dir
 * this launch uses. Carried via AsyncLocalStorage so the many sparkdreamd()/
 * vendorDir() call sites (including free render helpers with no StepCtx)
 * resolve per-launch without signature churn: runLaunch() wraps every
 * step.run in runWithAssets, and exec.ts/vendor.ts consult currentAssets()
 * before their env/global fallbacks. Code outside a launch (tests, estimate,
 * dev CLI) falls through to the baked behavior unchanged.
 */

export interface ChainAssets {
  /** sparkdreamd binary path (or bare name for PATH lookup, baked mode). */
  bin: string;
  /** vendor/sparkdream-deploy-shaped directory for this launch's version. */
  vendorDir: string;
  source: "baked" | "cache";
}

const store = new AsyncLocalStorage<ChainAssets>();

export function runWithAssets<T>(assets: ChainAssets | null, fn: () => T): T {
  return assets ? store.run(assets, fn) : fn();
}

export function currentAssets(): ChainAssets | undefined {
  return store.getStore();
}
