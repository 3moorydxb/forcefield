/**
 * Frame timing.
 *
 * Reports the three numbers that actually diagnose a slow graph, kept separate
 * because a single "fps" figure hides which half is slow:
 *   - `fps`      rolling frames per second over the window
 *   - `simMs`    mean time inside `Simulation.tick()`
 *   - `renderMs` mean time inside `Renderer.render()`
 *
 * `low1` is the 1% low (the slowest 1% of frames in the window). A graph that
 * averages 60 and stutters is a graph with a bad 1% low; the mean cannot see it.
 */
export interface FrameStats {
  fps: number;
  low1: number;
  simMs: number;
  renderMs: number;
  frames: number;
}

export class FpsMeter {
  private readonly window: number;
  private readonly dt: number[] = [];
  private readonly sim: number[] = [];
  private readonly render: number[] = [];
  private last = 0;
  private total = 0;

  constructor(window = 120) {
    this.window = window;
  }

  /** Call once per frame with the per-phase costs in milliseconds. */
  frame(nowMs: number, simMs: number, renderMs: number): void {
    if (this.last > 0) {
      push(this.dt, nowMs - this.last, this.window);
      push(this.sim, simMs, this.window);
      push(this.render, renderMs, this.window);
      this.total++;
    }
    this.last = nowMs;
  }

  reset(): void {
    this.dt.length = 0;
    this.sim.length = 0;
    this.render.length = 0;
    this.last = 0;
    this.total = 0;
  }

  stats(): FrameStats {
    if (this.dt.length === 0) {
      return { fps: 0, low1: 0, simMs: 0, renderMs: 0, frames: 0 };
    }
    const meanDt = mean(this.dt);
    // 1% low = mean fps of the slowest 1% of frames (at least one frame).
    const sorted = [...this.dt].sort((a, b) => b - a);
    const n = Math.max(1, Math.ceil(sorted.length * 0.01));
    const worst = mean(sorted.slice(0, n));
    return {
      fps: meanDt > 0 ? 1000 / meanDt : 0,
      low1: worst > 0 ? 1000 / worst : 0,
      simMs: mean(this.sim),
      renderMs: mean(this.render),
      frames: this.total,
    };
  }
}

function push(arr: number[], v: number, cap: number): void {
  arr.push(v);
  if (arr.length > cap) arr.shift();
}

function mean(a: number[]): number {
  if (a.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s / a.length;
}
