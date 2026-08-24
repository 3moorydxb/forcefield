import type { Force, ForceContext } from './types.js';
import { FLAG_HIDDEN } from '../graph.js';

/**
 * Many-body repulsion, approximated with the Barnes-Hut quadtree.
 *
 * The law is `1/d`, not `1/d²`. That is deliberate and it is what d3-force and
 * ForceAtlas2 both use: in two dimensions the logarithmic potential is the
 * analogue of Coulomb's law in three, and a true inverse-square falls off so
 * fast that distant clusters stop separating and the layout collapses into a
 * hairball. (Implementation detail that hides this: the accumulator multiplies
 * the *unnormalised* offset `dx` by `q/d²`, giving magnitude `q/d`.)
 *
 * θ (`theta`) is the accuracy dial. A cell is treated as one body when its width
 * over its distance is below θ. θ→0 is exact and O(n²); θ=0.9 is the usual
 * quality/speed point and is the default here.
 */
export class ManyBodyForce implements Force {
  readonly name = 'manyBody';
  readonly phase = 'force' as const;
  enabled = true;

  /** Barnes-Hut opening angle. Larger = faster and coarser. */
  theta = 0.9;
  /** Multiplies every node's own `charge`. */
  scale = 1;
  /**
   * Softening floor on distance. Without it two nearly-coincident nodes produce
   * an enormous force and fling each other off screen.
   */
  distanceMin = 1;
  /** Beyond this the interaction is dropped entirely. `Infinity` = never drop. */
  distanceMax = Infinity;

  private stack = new Int32Array(1024);

  apply(ctx: ForceContext): void {
    const { graph: g, tree, alpha, fx, fy } = ctx;
    if (tree.count === 0) return;

    const theta2 = this.theta * this.theta;
    const min2 = this.distanceMin * this.distanceMin;
    const max2 = this.distanceMax === Infinity ? Infinity : this.distanceMax * this.distanceMax;
    const scale = this.scale;
    const n = g.nodeCount;

    if (this.stack.length < tree.count + 4) {
      this.stack = new Int32Array(nextPow2(tree.count + 4));
    }
    const stack = this.stack;

    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      const xi = g.x[i]!;
      const yi = g.y[i]!;
      let ax = 0;
      let ay = 0;

      let sp = 0;
      stack[sp++] = 0;

      while (sp > 0) {
        const c = stack[--sp]!;
        if (tree.bodies[c]! === 0) continue;

        const isLeaf = tree.child[c * 4]! < 0;

        if (!isLeaf) {
          const dx = tree.comX[c]! - xi;
          const dy = tree.comY[c]! - yi;
          const d2 = dx * dx + dy * dy;
          const w = tree.half[c]! * 2;

          // Far enough away to stand in for everything inside it?
          if (w * w < theta2 * d2) {
            if (d2 > max2) continue;
            const soft = d2 < min2 ? min2 : d2;
            const k = (tree.charge[c]! * alpha * scale) / soft;
            ax += dx * k;
            ay += dy * k;
            continue;
          }

          const base = c * 4;
          stack[sp++] = tree.child[base]!;
          stack[sp++] = tree.child[base + 1]!;
          stack[sp++] = tree.child[base + 2]!;
          stack[sp++] = tree.child[base + 3]!;
          continue;
        }

        // Leaf: exact pairwise against every body it holds.
        for (let b = tree.bodyHead[c]!; b >= 0; b = tree.bodyNext[b]!) {
          if (b === i) continue;
          const dx = g.x[b]! - xi;
          const dy = g.y[b]! - yi;
          const d2 = dx * dx + dy * dy;
          if (d2 > max2) continue;
          const soft = d2 < min2 ? min2 : d2;
          const k = (g.charge[b]! * alpha * scale) / soft;
          ax += dx * k;
          ay += dy * k;
        }
      }

      fx[i]! += ax;
      fy[i]! += ay;
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
