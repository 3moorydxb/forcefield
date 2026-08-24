import type { Force, ForceContext } from './types.js';
import type { Graph } from '../graph.js';
import { FLAG_DRAGGING, FLAG_HIDDEN, FLAG_PINNED } from '../graph.js';

/**
 * Link springs.
 *
 * Each link pulls its endpoints toward a rest length. Two details that matter
 * more than the spring constant:
 *
 * **Degree bias.** The correction is split between the two ends in proportion to
 * their degrees, so a hub with 200 edges is not dragged around by each of them
 * in turn. Without this, high-degree nodes vibrate and low-degree leaves sit
 * still — the opposite of what reads correctly.
 *
 * **Fixed ends take the whole correction.** If one end is pinned or being
 * dragged it will not move, so handing it half the correction throws that half
 * away and the spring feels limp exactly when the user is watching it. The free
 * end gets all of it instead.
 *
 * `weight` scales the spring, so on a graded graph a speculative edge pulls more
 * weakly than a certain one.
 */
export class LinkForce implements Force {
  readonly name = 'link';
  readonly phase = 'force' as const;
  enabled = true;

  /** Rest length used when a link does not carry its own `distance`. */
  distance = 44;
  /** Spring constant in `[0, 1]`-ish. */
  strength = 0.7;
  /** Extra relaxation passes. More passes = stiffer without more instability. */
  iterations = 1;

  private bias = new Float64Array(0);
  private version = -1;

  initialize(g: Graph): void {
    if (this.bias.length < g.linkCount) this.bias = new Float64Array(nextPow2(Math.max(8, g.linkCount)));
    for (let l = 0; l < g.linkCount; l++) {
      const s = g.linkSource[l]!;
      const t = g.linkTarget[l]!;
      const ds = g.degree[s]!;
      const dt = g.degree[t]!;
      this.bias[l] = ds + dt === 0 ? 0.5 : ds / (ds + dt);
    }
    this.version = g.version;
  }

  apply(ctx: ForceContext): void {
    const { graph: g, alpha, fx, fy } = ctx;
    if (this.version !== g.version) this.initialize(g);

    const FIXED = FLAG_PINNED | FLAG_DRAGGING;

    for (let pass = 0; pass < this.iterations; pass++) {
      for (let l = 0; l < g.linkCount; l++) {
        const s = g.linkSource[l]!;
        const t = g.linkTarget[l]!;
        const fs = g.flags[s]!;
        const ft = g.flags[t]!;
        if ((fs | ft) & FLAG_HIDDEN) continue;

        let dx = g.x[t]! - g.x[s]!;
        let dy = g.y[t]! - g.y[s]!;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d === 0) {
          // Coincident endpoints have no direction to relax along. Pick one
          // from the seeded stream so the outcome stays reproducible.
          const j = ctx.rng.discPoint(1);
          dx = j.x || 1e-3;
          dy = j.y;
          d = Math.sqrt(dx * dx + dy * dy);
        }

        const rest = g.linkDistance[l]! > 0 ? g.linkDistance[l]! : this.distance;
        const k = ((d - rest) / d) * alpha * this.strength * g.linkWeight[l]!;

        const sFixed = (fs & FIXED) !== 0;
        const tFixed = (ft & FIXED) !== 0;
        if (sFixed && tFixed) continue;

        let bs: number;
        let bt: number;
        if (sFixed) {
          bs = 0;
          bt = 1;
        } else if (tFixed) {
          bs = 1;
          bt = 0;
        } else {
          const b = this.bias[l]!;
          bt = b; // target's share
          bs = 1 - b; // source's share
        }

        fx[s]! += dx * k * bs;
        fy[s]! += dy * k * bs;
        fx[t]! -= dx * k * bt;
        fy[t]! -= dy * k * bt;
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
