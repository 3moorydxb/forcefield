import type { Graph } from '../graph.js';
import type { Quadtree } from '../quadtree.js';
import type { Rng } from '../../util/rng.js';

/**
 * When a force runs inside a tick.
 *
 * The order exists because the Barnes-Hut tree is built once per tick and every
 * force that needs it must see the same one:
 *
 *   1. `pre`    positional work that does NOT need the tree (centring is a pure
 *               translation). Runs first so the tree is built from final drift
 *               positions.
 *   2. (build the quadtree)
 *   3. `relax`  positional constraints that DO need the tree (collision).
 *   4. `force`  accumulate into the force scratch (repulsion, springs, gravity).
 *
 * `relax` nudges positions after the tree was built, so the `force` phase sees
 * coordinates a fraction of a node-radius off the tree it is querying. That
 * error is bounded by the collision correction and is far below the θ cell size
 * the approximation already accepts. Rebuilding twice a tick to remove it would
 * roughly double the dominant cost of the frame.
 */
export type ForcePhase = 'pre' | 'relax' | 'force';

export interface ForceContext {
  graph: Graph;
  tree: Quadtree;
  /** Global cooling factor in `[0, 1]`. Every force scales by it. */
  alpha: number;
  dt: number;
  rng: Rng;
  /** Force scratch, one entry per node. Cleared before the `force` phase. */
  fx: Float64Array;
  fy: Float64Array;
}

export interface Force {
  readonly name: string;
  readonly phase: ForcePhase;
  enabled: boolean;
  apply(ctx: ForceContext): void;
  /** Called whenever the graph's structure version changes. */
  initialize?(graph: Graph): void;
}
