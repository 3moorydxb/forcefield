/**
 * graph-engine — a dependency-free force-directed graph engine.
 *
 * Nothing in this package knows what a node means. There is no node type, no
 * colour and no filter here that belongs to any one product; a consumer supplies
 * its own vocabulary through `type`, `data` and a `Theme`, and the engine treats
 * all of it as opaque. If a consumer's concept ever appears in `src/`, that is
 * the bug.
 */

export { Graph, FLAG_PINNED, FLAG_HIDDEN, FLAG_SELECTED, FLAG_DRAGGING } from './core/graph.js';
export type { NodeSpec, LinkSpec, NodeView, GraphData } from './core/graph.js';

export { Simulation } from './core/simulation.js';
export type { SimulationConfig } from './core/simulation.js';

export { Quadtree } from './core/quadtree.js';

export {
  DEFAULT_PHYSICS,
  PHYSICS_LIMITS,
  normalisePhysics,
  expoResponse,
  expoPosition,
  PhysicsError,
} from './core/physics.js';
export type { PhysicsSettings } from './core/physics.js';

export { applyFilter, Filters } from './core/filter.js';
export type { Filter, FilterStats, Mask } from './core/filter.js';

export { assertAnimation, animationPhase, spinSign, DirectionError } from './core/direction.js';
export type { Direction, Spin, AnimationSpec } from './core/direction.js';

export { ManyBodyForce } from './core/forces/manyBody.js';
export { LinkForce } from './core/forces/link.js';
export { CenterForce, GravityForce } from './core/forces/center.js';
export { CollideForce } from './core/forces/collide.js';
export type { Force, ForceContext, ForcePhase } from './core/forces/types.js';

export { Camera } from './render/camera.js';
export { Canvas2DRenderer } from './render/canvas2d.js';
export type { Canvas2DOptions, DecorationInfo } from './render/canvas2d.js';
export type { Renderer, RenderFrame, RenderStats, QuadtreeCells } from './render/renderer.js';
export { darkTheme, lightTheme, TypePalette } from './render/theme.js';
export type { Theme, NodeStyle, LinkStyle, NodeShape } from './render/theme.js';

export { InteractionController } from './interaction/controller.js';
export type { ControllerOptions, ControllerEvent } from './interaction/controller.js';

export { GraphView } from './graphView.js';
export type { GraphViewOptions } from './graphView.js';

export { Rng } from './util/rng.js';
export { FpsMeter } from './util/fps.js';
export type { FrameStats } from './util/fps.js';
