import type { Graph } from '../core/graph.js';
import type { Camera } from './camera.js';
import type { Theme, TypePalette } from './theme.js';

/**
 * Everything a renderer is given for one frame.
 *
 * Deliberately a plain data bag: a renderer must be replaceable (Canvas 2D today,
 * WebGL when node counts demand it) without the simulation, the controller or
 * the consumer changing at all. Anything a renderer needs goes in here; anything
 * a renderer wants to keep between frames is its own private business.
 */
export interface RenderFrame {
  graph: Graph;
  camera: Camera;
  theme: Theme;
  palette: TypePalette;
  /** Node id under the cursor, or `null`. */
  hover: string | null;
  /**
   * Dim mode. `1` = drawn normally, `0` = drawn at `theme.dimOpacity`.
   * `null` = everything at full strength.
   *
   * Distinct from filtering on purpose: hidden nodes are gone from the physics
   * and the picture; dimmed nodes are still both, just recessive.
   */
  dim: Uint8Array | null;
  /** Screen-space rectangle for an in-progress marquee selection. */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Monotonic milliseconds, for animation. */
  timeMs: number;
  /**
   * The live Barnes-Hut tree, for the debug overlay only. Optional because a
   * renderer must work without it — nothing about drawing depends on physics.
   */
  tree?: QuadtreeCells;
}

/** The read-only slice of the quadtree a debug overlay needs. */
export interface QuadtreeCells {
  count: number;
  cx: Float64Array;
  cy: Float64Array;
  half: Float64Array;
  bodies: Uint32Array;
}

/** What a renderer actually put on screen — reported, never inferred. */
export interface RenderStats {
  nodesDrawn: number;
  linksDrawn: number;
  labelsDrawn: number;
}

export interface Renderer {
  /** Identifier for logs and for the FPS report, e.g. `'canvas2d'`. */
  readonly kind: string;
  /** CSS pixel size plus device pixel ratio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  render(frame: RenderFrame): void;
  /** Counts from the LAST frame. Measured during drawing, not estimated. */
  readonly stats: RenderStats;
  destroy(): void;
}
