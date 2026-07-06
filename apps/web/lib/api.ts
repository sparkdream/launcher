import type { Msg } from "@sparkdream/akash-tx";

export interface StepView {
  name: string;
  status: "pending" | "running" | "waiting" | "done" | "error";
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface LaunchView {
  id: string;
  status: "created" | "running" | "paused" | "completed" | "aborted";
  spec: unknown;
  steps: StepView[];
}

export interface PendingTx {
  step: string;
  msgs: Msg[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

export async function createLaunch(spec: unknown, owner: string): Promise<{ id: string; warnings: { path: string; message: string }[] }> {
  return json(
    await fetch("/api/launches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, owner }),
    }),
  );
}

export async function getLaunch(id: string): Promise<LaunchView> {
  return json(await fetch(`/api/launches/${id}`));
}

export async function startLaunch(id: string): Promise<void> {
  await json(await fetch(`/api/launches/${id}/start`, { method: "POST" }));
}

export async function resumeLaunch(id: string): Promise<void> {
  await json(await fetch(`/api/launches/${id}/resume`, { method: "POST" }));
}

export async function getPendingTx(id: string): Promise<PendingTx | null> {
  const res = await fetch(`/api/launches/${id}/pending-tx`);
  if (res.status === 204) return null;
  return json(res);
}

export async function postTxResult(id: string, txHash: string): Promise<void> {
  await json(
    await fetch(`/api/launches/${id}/tx-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    }),
  );
}
