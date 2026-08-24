/**
 * Barrel for the `forcefield/render` subpath export.
 *
 * `package.json` has advertised `"./render": "./dist/src/render/index.js"` since
 * the package's first version, but this file did not exist — so
 * `import 'forcefield/render'` threw `ERR_MODULE_NOT_FOUND`. This re-exports
 * the same render surface `src/index.ts` exposes from the root, so the
 * subpath actually works.
 */

export { Camera } from './camera.js';
export { Canvas2DRenderer } from './canvas2d.js';
export type { Canvas2DOptions, DecorationInfo } from './canvas2d.js';
export type { Renderer, RenderFrame, RenderStats, QuadtreeCells } from './renderer.js';
export { darkTheme, lightTheme, TypePalette } from './theme.js';
export type { Theme, NodeStyle, LinkStyle, NodeShape } from './theme.js';
