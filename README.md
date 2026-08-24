# graph-engine

A force-directed graph engine: Barnes-Hut many-body simulation, velocity-Verlet integration,
drag / pin / filter / zoom, behind a swappable renderer interface.

**Zero dependencies. Zero build dependencies.** TypeScript in, ESM out, nothing in
`node_modules`.

```bash
npm run build      # tsc
npm test           # 46 tests, node:test
npm run serve      # http://localhost:8902/examples/basic/
```

![Barnes-Hut quadtree over 1,651 nodes](shots/barnes-hut-quadtree.png)

*1,651 nodes, 2,310 links, with the Barnes-Hut subdivision drawn. Cells subdivide only where
nodes are dense — that is the O(n log n).*

---

## What it is for

It does not know what a node means. There is no node type, no colour and no filter here that
belongs to any one product; a consumer supplies its own vocabulary through `type`, `data` and a
`Theme`, and the engine treats all of it as opaque.

It was built for two consumers at once, deliberately:

| | a saved hierarchy | a live investigation |
|---|---|---|
| nodes | thousands, coordinates already stored | grows while you watch, no layout at all |
| edges | strictly hierarchical | arbitrary, confidence-weighted |
| needs | filter by type and branch, dim the background | insertion into a running simulation |

The second one is harder, and building for it makes the first one free. **Replaying stored
coordinates would have served the hierarchy and been useless to the live case** — and on the real
hierarchy this was tested against, the stored coordinates only covered 55% of the nodes anyway.

---

## Quick start

```ts
import { GraphView, Filters } from 'graph-engine';

const view = new GraphView({ container: document.getElementById('app')! });

view.load({
  nodes: [{ id: 'a', type: 'person' }, { id: 'b', type: 'org' }],
  links: [{ source: 'a', target: 'b', weight: 0.8 }],
});

view.fitWhenSettled();
view.start();

// Show one branch. Everything else keeps its coordinates and leaves the physics.
view.filter(Filters.branch('a', { direction: 'out', maxDepth: 3 }));

// Or keep it on screen and push it back instead.
view.highlight(Filters.branch('a', { direction: 'out' }));
```

`GraphView` is optional glue. `Simulation`, `Canvas2DRenderer` and `InteractionController` are
usable on their own if you already own your render loop.

---

## Why this and not sigma.js or cosmograph

Both were read before anything was written here. Both are MIT, so licence was not the deciding
factor.

**[sigma.js](https://github.com/jacomyal/sigma.js)** — a WebGL *renderer* built on graphology. It
is the strongest renderer of the three and it is genuinely fast. But it does not simulate: you
supply coordinates. The usual pairing is `graphology-layout-forceatlas2`, where
`barnesHutOptimize` **defaults to `false`** (so the default really is O(n²)) and which has **no
notion of a fixed or pinned node** — and pin-and-drag is the central requirement here, not a
nice-to-have. Choosing sigma means writing the simulation anyway and inheriting a WebGL renderer
plus a graph library to get it.

**[cosmos.gl](https://github.com/cosmograph-org/cosmos)** — GPU force simulation, hundreds of
thousands of points, genuinely excellent at what it does. It is the wrong shape for the live case:
simulation state lives in GPU textures and the API takes whole arrays
(`setPointPositions`, `setLinks`) with **no incremental add**, so "one node arrives" means
rebuilding every buffer. It also brings a luma.gl dependency and needs WebGL2 — and positions
living on the GPU makes CPU-side hit-testing, labelling and filtering awkward.

**So: the simulation is written here** — that was the actual requirement — and the renderer sits
behind a `Renderer` interface with a Canvas 2D implementation. At the scale this targets (single-
digit thousands) Canvas holds frame rate with room to spare and costs no shader compilation, no
context-loss handling and no dependency.

**Where that stops being true, say so plainly: past ~100k nodes, use cosmos.gl.** This engine is
not going to beat a GPU at brute force, and pretending otherwise would be the kind of claim that
gets found out. `Renderer` is the seam; swapping in a WebGL backend changes nothing else.

---

## Measured

Real numbers from `bench/`, not impressions. Reproduce with `node bench/tick.mjs` and
`/bench/?n=1651`.

### Simulation, headless (`node bench/tick.mjs`, Node 26, darwin/arm64, median of 60 ticks)

| nodes | links | Barnes-Hut | ticks/s | exact O(n²) | speed-up | ms / (n·log₂n) |
|---|---|---|---|---|---|---|
| 500 | 695 | 0.423 ms | 2362 | 2.153 ms | 5.1× | 94.5 ns |
| **1,651** | 2,311 | **1.852 ms** | **540** | 25.328 ms | **13.7×** | 104.9 ns |
| **2,864** | 4,007 | **3.414 ms** | **293** | 79.828 ms | **23.4×** | 103.8 ns |
| 6,000 | 8,399 | 8.336 ms | 120 | 390.602 ms | 46.9× | 110.7 ns |
| 12,000 | 16,797 | 18.838 ms | 53 | — | — | 115.9 ns |
| 25,000 | 34,999 | 42.419 ms | 24 | — | — | 116.1 ns |

The last column is time per node per log₂(n). It stays between 94 and 116 ns across a **50× range
of graph sizes** — that is what O(n log n) looks like when it is real rather than claimed. The
`theta = 0` column is the same code with the quadtree switched off, and at 2,864 nodes the naive
version costs **79.8 ms per tick — 12 fps, before drawing anything.**

### Full frame, in-browser

⚠️ **Measured on a browser with no GPU acceleration** (`getContext('webgl')` returns `null`, so
Canvas 2D is rasterised entirely on the CPU, at dpr 1). These are therefore a **floor**, not a
representative figure for a normal machine.

| graph | mode | fps | 1% low | sim | render call | drawn |
|---|---|---|---|---|---|---|
| 1,651 synthetic | physics every frame | 47.7 | 46.6 | 1.89 ms | 0.25 ms | 1651 nodes / 2308 links |
| 1,651 synthetic | render only, settled | 50.9 | 49.5 | — | 0.26 ms | 1651 / 2308 |
| **2,864 real hierarchy** | **physics every frame** | **51.2** | **50.0** | **3.16 ms** | **0.52 ms** | 2864 / 2795 |
| 100 synthetic | physics every frame | 60.0 | 56.2 | 0.24 ms | 0.52 ms | 100 / 135 |

**Read the last row before the others.** At 100 nodes the same harness hits a clean 60 — so the
harness can do 60, and the gap at 1,651 is rasterisation, not the engine. The engine's own work
per frame is 2.1 ms at 1,651 nodes and 3.7 ms at 2,864, i.e. **13% and 22% of a 60fps budget.**
The remaining ~19 ms is the software rasteriser painting the canvas, which happens after the
measured call returns.

That finding is why `GraphView.redrawPolicy` defaults to `'on-change'`: a settled graph with
nothing hovered and nothing selected **skips the draw entirely**, so idling costs nothing at all.

---

## What it does

### Simulation
Velocity-Verlet, not the semi-implicit Euler most graph layouts use — it carries the previous
acceleration and averages it with the new one, so a dragged node's neighbours trail it instead of
overshooting and snapping back.

Forces run in three phases per tick so they all see one quadtree: `pre` (centring, a pure
translation, before the tree is built) → build → `relax` (collision, positional) → `force`
(repulsion, springs, gravity). All of them are removable and replaceable; `Force` is a two-method
interface.

Alpha decays geometrically and the graph settles. `reheat()` wakes it. `alphaTarget` **holds** it
warm — that distinction is what makes a drag feel alive rather than going limp halfway through the
gesture.

### Pinning
A pinned node does not integrate, but it stays in the quadtree and stays on both ends of its
springs, so it goes on pushing the graph around while standing still. Centring stands down as
soon as anything is pinned, because a pin is the user saying "this belongs here" and a correction
that slides it is a pin that does not hold.

### Filtering
**Filtering never restarts the simulation.** It sets a hidden flag: hidden nodes leave the
quadtree and every force, are not integrated, and keep their coordinates frozen. Clear the filter
and they are exactly where they were.

Verified in the browser on 2,864 real nodes: isolating a 46-node branch moved **0 nodes** and left
alpha byte-identical.

`Filters` composes — `ofType`, `branch` (following link direction), `within`, `search`, `degree`,
`predicate`, `and` / `or` / `not`, `expand`.

`filter()` removes; `highlight()` dims. Different questions: *show me only this branch* versus
*where does this branch sit in the whole thing*.

![dim mode](shots/branch-dim-mode.png)

### Rendering
Canvas 2D, behind an interface. Everything sharing a style goes into one path and is stroked or
filled once — thousands of driver state changes become about twenty. Off-screen nodes are culled;
labels are capped, gated on zoom, and chosen by degree.

The default palette is a **brand-neutral placeholder**, validated colourblind-safe (worst adjacent
pair ΔE 8.4 protan on dark). On dark all eight slots clear 3:1 against the surface; on light three
do not, which is why the hovered node always gets a label and the examples ship a legend —
identity is never carried by colour alone. Replace `Theme.palette` with your own and nothing else
changes.

Types are assigned palette slots **in fixed order over the whole graph, never cycled**, so
filtering down to three types does not repaint them, and a ninth type folds into `other` rather
than getting an invented hue.

### Interaction
Drag (the rest respond), pin/unpin on double-click, hover, click select, shift-drag marquee
multi-select, wheel zoom about the cursor, pan, two-finger pinch, and `p` / `f` / `Escape`.

![mid-drag](shots/drag-mid-gesture.png)

*Mid-gesture, mouse still down: the dragged node sits exactly under the cursor, alpha is held at
0.3, and all 12 of its neighbours have moved.*

---

## One rule worth stating

**Direction is an explicit field. It is never the sign of a number.**

CSS clamps a negative `animation-duration` to `0s` — no error, no warning, `getAnimations()`
returns nothing. A sibling project encoded "spin the other way" as a negative duration and shipped
a six-layer animation in which three layers stood perfectly still, through a design review,
unnoticed. "Clamped to nothing" and "never written" look identical.

The bug is not the clamp. It is overloading a magnitude to carry a direction. So here, magnitudes
(durations, radii, masses, zoom factors) are positive and **validated**, direction is a string
union, and a negative magnitude throws instead of quietly becoming zero. See
`src/core/direction.ts` and the tests that enforce it.

---

## Examples

```bash
npm run build && npm run serve
```

- `/examples/basic/` — synthetic graph generated from a seed, so the benchmark is reproducible by
  anyone with no data at all. Size, forces, θ, quadtree overlay, filtering.
- `/examples/live/` — nodes inserted one at a time into a running simulation, confidence-weighted
  edges. ![live](shots/live-insertion.png)
- `/examples/tree/` — a large real hierarchy. Needs a data file; see
  `examples/adapters/README.md`. The file it reads is `.gitignore`d.

![hierarchy](shots/hierarchy-2864-nodes.png)

---

## Layout

```
src/core/        graph · quadtree · simulation · filter · direction · forces/
src/render/      renderer interface · canvas2d · camera · theme
src/interaction/ controller
src/graphView.ts optional glue: view + loop
examples/        example pages and adapters — NOT part of the engine
bench/           headless tick benchmark + in-browser frame benchmark
test/            46 tests, node:test, no dependencies
```

If a consumer's concept ever appears in `src/`, that is the bug.

## Licence

MIT.
