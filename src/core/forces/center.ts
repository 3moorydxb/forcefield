import type { Force, ForceContext } from './types.js';
import { FLAG_DRAGGING, FLAG_HIDDEN, FLAG_PINNED } from '../graph.js';

/**
 * Keep the graph's centre of mass near a point, by translating everything.
 *
 * This is a correction, not a force: it does not touch velocity, so it cannot
 * add energy and cannot stop the simulation settling. It runs in the `pre`
 * phase, before the quadtree is built, precisely because a uniform translation
 * would otherwise invalidate every centre of mass in the tree by the same
 * offset.
 *
 * Keep `strength` low. At 1 the graph is snapped back every tick, which fights
 * a user dragging a node toward the edge — the node moves and the world slides
 * under it.
 *
 * **It stands down the moment anything is pinned or being dragged.** A pin is
 * the user saying "this belongs here"; a correction that slides it is a pin that
 * does not hold. And once even one node is anchored, the graph's position is no
 * longer arbitrary, so there is nothing left for centring to decide. Gravity
 * still stops a disconnected component drifting away, so nothing escapes.
 *
 * (This was found by a test, not by reasoning: with the naive version a node
 * pinned at x = 17 was sitting at x = 9.3 four hundred ticks later.)
 */
export class CenterForce implements Force {
  readonly name = 'center';
  readonly phase = 'pre' as const;
  enabled = true;

  x = 0;
  y = 0;
  /** Fraction of the offset corrected per tick. */
  strength = 0.05;

  apply(ctx: ForceContext): void {
    const { graph: g } = ctx;
    const n = g.nodeCount;
    const ANCHORED = FLAG_PINNED | FLAG_DRAGGING;
    let sx = 0;
    let sy = 0;
    let m = 0;

    for (let i = 0; i < n; i++) {
      const f = g.flags[i]!;
      if (f & FLAG_HIDDEN) continue;
      if (f & ANCHORED) return; // something is nailed down; defer to it
      const w = g.mass[i]!;
      sx += g.x[i]! * w;
      sy += g.y[i]! * w;
      m += w;
    }
    if (m === 0) return;

    const dx = (this.x - sx / m) * this.strength;
    const dy = (this.y - sy / m) * this.strength;
    if (dx === 0 && dy === 0) return;

    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      g.x[i]! += dx;
      g.y[i]! += dy;
    }
  }
}

/**
 * Radial pull toward a point, as a real force.
 *
 * Centring alone cannot stop a disconnected component drifting away forever —
 * nothing attracts it, and translating the whole graph moves the component and
 * the core together. Gravity is what holds a disconnected graph in one frame.
 */
export class GravityForce implements Force {
  readonly name = 'gravity';
  readonly phase = 'force' as const;
  enabled = true;

  x = 0;
  y = 0;
  strength = 0.03;

  apply(ctx: ForceContext): void {
    const { graph: g, alpha, fx, fy } = ctx;
    const k = this.strength * alpha;
    if (k === 0) return;
    for (let i = 0; i < g.nodeCount; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      fx[i]! += (this.x - g.x[i]!) * k;
      fy[i]! += (this.y - g.y[i]!) * k;
    }
  }
}
