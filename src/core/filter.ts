import type { Graph, NodeView } from './graph.js';
import { FLAG_HIDDEN } from './graph.js';

/**
 * Filtering.
 *
 * **Filtering never restarts the simulation.** It sets a hidden flag and nothing
 * else: no alpha change, no re-seeding, no repositioning. Hidden nodes are
 * excluded from the quadtree and from every force, and — because they are also
 * excluded from integration — their coordinates are frozen exactly where they
 * were. Clear the filter and they are still there, so the layout does not
 * explode and then slowly re-converge into a different arrangement.
 *
 * That property is the reason `Filter` resolves to a *mask* rather than mutating
 * as it goes: a filter is a pure function of the graph, applied in one pass.
 */

/** `1` = visible, `0` = hidden. Length is the graph's node count. */
export type Mask = Uint8Array;

export interface Filter {
  readonly name: string;
  resolve(graph: Graph): Mask;
}

export interface FilterStats {
  visible: number;
  hidden: number;
  total: number;
}

/**
 * Apply a filter (or `null` to show everything).
 *
 * Returns what is now visible. Does not touch `alpha` — whether a filter should
 * wake a settled graph is the consumer's call, and for the common
 * "dim the background, keep the layout" case the answer is no.
 */
export function applyFilter(graph: Graph, filter: Filter | null): FilterStats {
  const n = graph.nodeCount;
  const mask = filter ? filter.resolve(graph) : null;
  let visible = 0;

  for (let i = 0; i < n; i++) {
    const show = mask ? mask[i] !== 0 : true;
    if (show) {
      graph.flags[i]! &= ~FLAG_HIDDEN;
      visible++;
    } else {
      graph.flags[i]! |= FLAG_HIDDEN;
      // Freeze it. Leaving velocity on a hidden node means it keeps coasting
      // while invisible and reappears somewhere it was never seen to travel to.
      graph.vx[i] = 0;
      graph.vy[i] = 0;
      graph.ax[i] = 0;
      graph.ay[i] = 0;
    }
  }
  return { visible, hidden: n - visible, total: n };
}

// ---------------------------------------------------------------- primitives

function filled(n: number, v: number): Mask {
  const m = new Uint8Array(n);
  if (v) m.fill(1);
  return m;
}

export const Filters = {
  all(): Filter {
    return { name: 'all', resolve: (g) => filled(g.nodeCount, 1) };
  },

  none(): Filter {
    return { name: 'none', resolve: (g) => filled(g.nodeCount, 0) };
  },

  /** Keep nodes whose `type` is one of these. The engine never invents types. */
  ofType(...types: string[]): Filter {
    const want = new Set(types);
    return {
      name: `type(${types.join('|')})`,
      resolve(g) {
        const m = new Uint8Array(g.nodeCount);
        for (let i = 0; i < g.nodeCount; i++) m[i] = want.has(g.types[i]!) ? 1 : 0;
        return m;
      },
    };
  },

  /** Arbitrary predicate — the escape hatch, so the engine needs no other. */
  predicate(fn: (node: NodeView, graph: Graph) => boolean, name = 'predicate'): Filter {
    return {
      name,
      resolve(g) {
        const m = new Uint8Array(g.nodeCount);
        for (let i = 0; i < g.nodeCount; i++) m[i] = fn(g.viewAt(i), g) ? 1 : 0;
        return m;
      },
    };
  },

  /** Case-insensitive substring match on label, then id. */
  search(query: string): Filter {
    const q = query.trim().toLowerCase();
    return {
      name: `search(${query})`,
      resolve(g) {
        const m = new Uint8Array(g.nodeCount);
        if (q === '') return filled(g.nodeCount, 1);
        for (let i = 0; i < g.nodeCount; i++) {
          m[i] =
            g.labels[i]!.toLowerCase().includes(q) || g.ids[i]!.toLowerCase().includes(q) ? 1 : 0;
        }
        return m;
      },
    };
  },

  /** Keep nodes with at least `min` links (and at most `max`, if given). */
  degree(min: number, max = Infinity): Filter {
    return {
      name: `degree(${min}..${max === Infinity ? '' : max})`,
      resolve(g) {
        const m = new Uint8Array(g.nodeCount);
        for (let i = 0; i < g.nodeCount; i++) {
          const d = g.degree[i]!;
          m[i] = d >= min && d <= max ? 1 : 0;
        }
        return m;
      },
    };
  },

  /**
   * Everything reachable from `rootId`, optionally capped at `maxDepth`.
   *
   * `direction` decides what "reachable" means, which matters the moment links
   * are meaningful in one direction:
   *   - `'out'`  follow source → target  (a tree's descendants)
   *   - `'in'`   follow target → source  (its ancestors)
   *   - `'any'`  ignore direction        (the connected component)
   *
   * `maxDepth: 0` is the root alone; `Infinity` is the whole reachable set.
   */
  branch(
    rootId: string,
    opts: { direction?: 'out' | 'in' | 'any'; maxDepth?: number } = {},
  ): Filter {
    const dir = opts.direction ?? 'out';
    const maxDepth = opts.maxDepth ?? Infinity;
    return {
      name: `branch(${rootId},${dir},${maxDepth})`,
      resolve(g) {
        const m = new Uint8Array(g.nodeCount);
        const root = g.indexOf(rootId);
        // An unknown root yields nothing visible, loudly empty rather than
        // silently "everything" — a typo should look wrong, not look fine.
        if (root < 0) return m;

        const { offset, neighbour } = directedCsr(g, dir);
        const queue = new Int32Array(g.nodeCount);
        const depth = new Int32Array(g.nodeCount).fill(-1);
        let head = 0;
        let tail = 0;
        queue[tail++] = root;
        depth[root] = 0;
        m[root] = 1;

        while (head < tail) {
          const u = queue[head++]!;
          const du = depth[u]!;
          if (du >= maxDepth) continue;
          for (let k = offset[u]!; k < offset[u + 1]!; k++) {
            const v = neighbour[k]!;
            if (depth[v]! >= 0) continue;
            depth[v] = du + 1;
            m[v] = 1;
            queue[tail++] = v;
          }
        }
        return m;
      },
    };
  },

  /** Everything within `maxDepth` hops of `rootId`, ignoring direction. */
  within(rootId: string, maxDepth: number): Filter {
    return Filters.branch(rootId, { direction: 'any', maxDepth });
  },

  and(...fs: Filter[]): Filter {
    return {
      name: `and(${fs.map((f) => f.name).join(',')})`,
      resolve(g) {
        const m = filled(g.nodeCount, 1);
        for (const f of fs) {
          const o = f.resolve(g);
          for (let i = 0; i < m.length; i++) if (!o[i]) m[i] = 0;
        }
        return m;
      },
    };
  },

  or(...fs: Filter[]): Filter {
    return {
      name: `or(${fs.map((f) => f.name).join(',')})`,
      resolve(g) {
        const m = new Uint8Array(g.nodeCount);
        for (const f of fs) {
          const o = f.resolve(g);
          for (let i = 0; i < m.length; i++) if (o[i]) m[i] = 1;
        }
        return m;
      },
    };
  },

  not(f: Filter): Filter {
    return {
      name: `not(${f.name})`,
      resolve(g) {
        const o = f.resolve(g);
        const m = new Uint8Array(g.nodeCount);
        for (let i = 0; i < m.length; i++) m[i] = o[i] ? 0 : 1;
        return m;
      },
    };
  },

  /** Grow a filter by `hops` neighbours in any direction — "and its context". */
  expand(f: Filter, hops = 1): Filter {
    return {
      name: `expand(${f.name},${hops})`,
      resolve(g) {
        let m = f.resolve(g);
        const { offset, neighbour } = directedCsr(g, 'any');
        for (let h = 0; h < hops; h++) {
          const next = new Uint8Array(m);
          for (let u = 0; u < g.nodeCount; u++) {
            if (!m[u]) continue;
            for (let k = offset[u]!; k < offset[u + 1]!; k++) next[neighbour[k]!] = 1;
          }
          m = next;
        }
        return m;
      },
    };
  },
};

/** CSR adjacency respecting link direction. Built per filter call, not per frame. */
function directedCsr(
  g: Graph,
  dir: 'out' | 'in' | 'any',
): { offset: Uint32Array; neighbour: Uint32Array } {
  if (dir === 'any') return g.adjacency();

  const n = g.nodeCount;
  const offset = new Uint32Array(n + 1);
  for (let l = 0; l < g.linkCount; l++) {
    const from = dir === 'out' ? g.linkSource[l]! : g.linkTarget[l]!;
    offset[from + 1]!++;
  }
  for (let i = 0; i < n; i++) offset[i + 1]! += offset[i]!;
  const neighbour = new Uint32Array(g.linkCount);
  const cursor = Uint32Array.from(offset.subarray(0, n));
  for (let l = 0; l < g.linkCount; l++) {
    const from = dir === 'out' ? g.linkSource[l]! : g.linkTarget[l]!;
    const to = dir === 'out' ? g.linkTarget[l]! : g.linkSource[l]!;
    neighbour[cursor[from]!++] = to;
  }
  return { offset, neighbour };
}
