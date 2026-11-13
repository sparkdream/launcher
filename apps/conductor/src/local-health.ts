/**
 * Is the launcher's own machine healthy enough to judge anything else?
 *
 * Every health reading is taken from this machine: a probe that times out
 * says "the component did not answer in time", and that is just as true
 * when the launcher was the slow one. A machine under heavy load (WSL out
 * of memory and swapping, a build using every core) stalls the launcher for
 * seconds at a time, its probes time out in bulk, and components that are
 * perfectly fine read "unreachable" for as long as the load lasts. Moving
 * them then is all cost: a healthy node is closed and redeployed elsewhere.
 *
 * The stall is measurable from inside: a timer due every second that fires
 * several seconds late means the process was not running (starved of CPU,
 * waiting on swapped-out memory, or the whole machine was suspended). Both
 * the wall clock and the monotonic clock are compared, because a suspended
 * machine may stop one and not the other.
 *
 * After a stall the machine counts as troubled until it has run smoothly
 * for `settleMs`: connections opened during the stall are still timing out,
 * and load of this kind comes in bursts.
 */

export interface LocalHealthGauge {
  /** Why this machine's readings cannot be trusted right now, or null when they can. */
  trouble(): string | null;
}

export interface LocalHealthOptions {
  /** how often the timer is due */
  intervalMs?: number;
  /** how late it may fire before that counts as a stall */
  lagMs?: number;
  /** how long after the last stall readings stay untrusted */
  settleMs?: number;
  wall?: () => number;
  mono?: () => number;
}

export class LocalHealth implements LocalHealthGauge {
  private readonly intervalMs: number;
  private readonly lagMs: number;
  private readonly settleMs: number;
  private readonly wall: () => number;
  private readonly mono: () => number;
  private lastWall: number;
  private lastMono: number;
  private stalledAt: number | undefined;
  private reason = "";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: LocalHealthOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.lagMs = opts.lagMs ?? 2000;
    this.settleMs = opts.settleMs ?? 180_000;
    this.wall = opts.wall ?? Date.now;
    this.mono = opts.mono ?? (() => performance.now());
    this.lastWall = this.wall();
    this.lastMono = this.mono();
  }

  start(): void {
    if (this.timer) return;
    this.lastWall = this.wall();
    this.lastMono = this.mono();
    this.timer = setInterval(() => this.beat(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** How much later than due the timer would be firing now. */
  private late(): number {
    return Math.max(this.wall() - this.lastWall, this.mono() - this.lastMono) - this.intervalMs;
  }

  /** One timer firing (public for tests, which own the clocks). */
  beat(): void {
    const late = this.late();
    this.lastWall = this.wall();
    this.lastMono = this.mono();
    if (late > this.lagMs) this.note(late);
  }

  private note(late: number): void {
    this.stalledAt = this.mono();
    this.reason = `the launcher's own one-second timer fired ${(late / 1000).toFixed(1)}s late`;
    console.log(`[local-health] ${this.reason}: this machine is overloaded or was suspended; health readings are not trusted for ${Math.round(this.settleMs / 60_000)} min`);
  }

  trouble(): string | null {
    // the timer itself may be the thing that is overdue: a caller that got
    // to run before it must not read "fine" off a stall still in progress
    if (this.timer) {
      const late = this.late();
      if (late > this.lagMs && (this.stalledAt === undefined || this.mono() - this.stalledAt > this.intervalMs)) this.note(late);
    }
    if (this.stalledAt === undefined) return null;
    const ago = this.mono() - this.stalledAt;
    if (ago >= this.settleMs) return null;
    return `${this.reason}, ${Math.round(ago / 1000)}s ago`;
  }
}
