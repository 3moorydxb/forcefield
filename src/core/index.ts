/**
 * Barrel for the `forcefield/core` subpath export.
 *
 * `package.json` has advertised `"./core": "./dist/src/core/index.js"` since the
 * package's first version, but this file did not exist — so
 * `import 'forcefield/core'` threw `ERR_MODULE_NOT_FOUND`. This re-exports the
 * same core surface `src/index.ts` exposes from the root, so the subpath
 * actually works.
 */

export { Graph, FLAG_PINNED, FLAG_HIDDEN, FLAG_SELECTED, FLAG_DRAGGING } from './graph.js';
export type { NodeSpec, LinkSpec, NodeView, GraphData } from './graph.js';

export { Simulation } from './simulation.js';
export type { SimulationConfig } from './simulation.js';

export { Quadtree } from './quadtree.js';

export {
  DEFAULT_PHYSICS,
  PHYSICS_LIMITS,
  normalisePhysics,
  expoResponse,
  expoPosition,
  PhysicsError,
} from './physics.js';
export type { PhysicsSettings } from './physics.js';

export { applyFilter, Filters } from './filter.js';
export type { Filter, FilterStats, Mask } from './filter.js';

export { assertAnimation, animationPhase, spinSign, DirectionError } from './direction.js';
export type { Direction, Spin, AnimationSpec } from './direction.js';

export { ManyBodyForce } from './forces/manyBody.js';
export { LinkForce } from './forces/link.js';
export { CenterForce, GravityForce } from './forces/center.js';
export { CollideForce } from './forces/collide.js';
export type { Force, ForceContext, ForcePhase } from './forces/types.js';
