import type { Force, ForceContext } from './types.js';
import { FLAG_DRAGGING, FLAG_HIDDEN, FLAG_PINNED } from '../graph.js';

/**
 * Circle collision — stop nodes overlapping.
 *
 * Resolved as a **positional** constraint rather than a force: overlapping pairs
 * are pushed apart directly and velocity is left alone. A spring-based collision
 * injects energy on every contact, and a graph with dense clusters then never
 * cools — it hums forever at a low alpha instead of settling. Position-based
 * resolution cannot add energy, so alpha decay still works.
 *
 * Pruning uses the quadtree's per-cell `maxR`: a cell can be skipped entirely
 * when the distance from the node to the cell's box already exceeds the node's
 * radius plus the largest radius anywhere inside that cell.
 */
export class CollideForce implements Force {
  readonly name = 'collide';
  readonly phase = 'relax' as const;
  enabled = true;

  /** Extra gap kept between circle edges, world units. */
  padding = 2;
  /** Fraction of the overlap resolved per pass, `(0, 1]`. */
  strength = 0.7;
  iterations = 1;

  private stack = new Int32Array(1024);

  apply(ctx: ForceContext): void {
    const { graph: g, tree } = ctx;
    if (tree.count === 0) return;

    if (this.stack.length < tree.count + 4) {
      this.stack = new Int32Array(nextPow2(tree.count + 4));
    }
    const stack = this.stack;
    const n = g.nodeCount;
    const FIXED = FLAG_PINNED | FLAG_DRAGGING;

    for (let pass = 0; pass < this.iterations; pass++) {
      for (let i = 0; i < n; i++) {
        const fi = g.flags[i]!;
        if (fi & FLAG_HIDDEN) continue;

        const xi = g.x[i]!;
        const yi = g.y[i]!;
        const ri = g.radius[i]! + this.padding;
        const iFixed = (fi & FIXED) !== 0;

        let sp = 0;
        stack[sp++] = 0;

        while (sp > 0) {
          const c = stack[--sp]!;
          if (tree.bodies[c]! === 0) continue;

          // Closest point on the cell's square to node i.
          const half = tree.half[c]!;
          const ddx = Math.max(0, Math.abs(xi - tree.cx[c]!) - half);
          const ddy = Math.max(0, Math.abs(yi - tree.cy[c]!) - half);
          const reach = ri + tree.maxR[c]! + this.padding;
          if (ddx * ddx + ddy * ddy > reach * reach) continue;

          if (tree.child[c * 4]! >= 0) {
            const base = c * 4;
            stack[sp++] = tree.child[base]!;
            stack[sp++] = tree.child[base + 1]!;
            stack[sp++] = tree.child[base + 2]!;
            stack[sp++] = tree.child[base + 3]!;
            continue;
          }

          for (let b = tree.bodyHead[c]!; b >= 0; b = tree.bodyNext[b]!) {
            // Each unordered pair is resolved once, by the lower index.
            if (b <= i) continue;
            const fb = g.flags[b]!;
            if (fb & FLAG_HIDDEN) continue;

            const dx = g.x[b]! - g.x[i]!;
            const dy = g.y[b]! - g.y[i]!;
            const rr = ri + g.radius[b]! + this.padding;
            const d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr) continue;

            let d = Math.sqrt(d2);
            let ux: number;
            let uy: number;
            if (d === 0) {
              const j = ctx.rng.discPoint(1);
              d = 1e-6;
              ux = j.x || 1;
              uy = j.y;
              const m = Math.hypot(ux, uy) || 1;
              ux /= m;
              uy /= m;
            } else {
              ux = dx / d;
              uy = dy / d;
            }

            const overlap = (rr - d) * this.strength;
            const bFixed = (fb & FIXED) !== 0;

            // Share the correction by inverse mass, and give the whole of it to
            // the free node when the other end cannot move.
            if (iFixed && bFixed) continue;
            let si: number;
            let sb: number;
            if (iFixed) {
              si = 0;
              sb = 1;
            } else if (bFixed) {
              si = 1;
              sb = 0;
            } else {
              const mi = g.mass[i]!;
              const mb = g.mass[b]!;
              const tot = mi + mb;
              si = tot > 0 ? mb / tot : 0.5;
              sb = tot > 0 ? mi / tot : 0.5;
            }

            g.x[i]! -= ux * overlap * si;
            g.y[i]! -= uy * overlap * si;
            g.x[b]! += ux * overlap * sb;
            g.y[b]! += uy * overlap * sb;
          }
        }
      }
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
