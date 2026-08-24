import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.js';
import { darkTheme, TypePalette, type NodeStyle, type LinkStyle, type Theme } from '../src/render/theme.js';
import { Canvas2DRenderer } from '../src/render/canvas2d.js';
import { Camera } from '../src/render/camera.js';
import type { RenderFrame } from '../src/render/renderer.js';

/**
 * These tests exist because an audit found the whole style-bucket surface had
 * zero coverage, and inside it a real contract bug: the documented `-1`
 * ("fall back to the palette") return collided with explicit style indices.
 *
 * There is no DOM here, so the canvas context is a recording stub. That is
 * enough — what is under test is which style each node and link is drawn WITH,
 * and the order of state changes, both of which are observable from the calls.
 */

interface Call {
  op: string;
  args: unknown[];
}

function stubCanvas(): { canvas: HTMLCanvasElement; calls: Call[] } {
  const calls: Call[] = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const ctx: Record<string, unknown> = {
    setTransform: rec('setTransform'),
    fillRect: rec('fillRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    // Record the colour IN EFFECT at stroke time, not merely assigned. The
    // renderer sets strokeStyle for passes that may draw nothing (an empty pin
    // pass), so asserting on assignments alone produces false positives.
    stroke: () => calls.push({ op: 'stroke', args: [ctx['strokeStyle']] }),
    strokeRect: rec('strokeRect'),
    setLineDash: rec('setLineDash'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    measureText: () => ({ width: 10 }),
  };
  // Style assignments are the thing we care about, so record them as calls too.
  for (const prop of [
    'fillStyle',
    'strokeStyle',
    'lineWidth',
    'globalAlpha',
    'font',
    'textAlign',
    'textBaseline',
    'lineJoin',
    'lineDashOffset',
  ]) {
    let v: unknown;
    Object.defineProperty(ctx, prop, {
      get: () => v,
      set: (nv) => {
        v = nv;
        calls.push({ op: `set:${prop}`, args: [nv] });
      },
    });
  }
  const canvas = {
    getContext: () => ctx,
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
  } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

function frameFor(g: Graph, theme: Theme): RenderFrame {
  const camera = new Camera();
  camera.setViewport(800, 600);
  camera.k = 1;
  const palette = new TypePalette().assignFrom(g);
  return { graph: g, camera, theme, palette, hover: null, dim: null, marquee: null, timeMs: 0 };
}

function fills(calls: Call[]): string[] {
  return calls.filter((c) => c.op === 'set:fillStyle').map((c) => String(c.args[0]));
}

const NODE_STYLES: NodeStyle[] = [
  { fill: '#111111', shape: 'diamond', labelColor: '#aaaaaa' },
  { fill: '#222222', shape: 'square' },
];
const LINK_STYLES: LinkStyle[] = [
  { color: '#333333', width: 2 },
  { color: '#444444', width: 1, dash: [5, 5], animateDash: true },
];

function styledTheme(): Theme {
  return { ...darkTheme, nodeStyles: NODE_STYLES, linkStyles: LINK_STYLES };
}

test('an explicit style index paints that style', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', type: 't', x: 0, y: 0 });
  g.addNode({ id: 'b', type: 't', x: 30, y: 0 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleNode: (i) => (i === 0 ? 0 : 1) });
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  const f = fills(calls);
  assert.ok(f.includes('#111111'), 'style 0 fill missing');
  assert.ok(f.includes('#222222'), 'style 1 fill missing');
});

test('🔴 returning -1 falls back to the PALETTE, not to a colliding style bucket', () => {
  // The documented contract. Before the fix, -1 landed on palette slot 0, which
  // is also explicit style index 0, so the node was painted #111111 — a style
  // belonging to a completely different category.
  const g = new Graph(1);
  g.addNode({ id: 'a', type: 'alpha', x: 0, y: 0 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleNode: () => -1 });
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));

  const f = fills(calls);
  assert.ok(
    f.includes(darkTheme.palette[0]!),
    `expected the palette colour ${darkTheme.palette[0]}, got ${JSON.stringify(f)}`,
  );
  assert.ok(!f.includes('#111111'), 'a -1 fallback must NOT collide with explicit style 0');
});

test('a -1 link falls back to the weight buckets, not to a link style', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', x: 0, y: 0 });
  g.addNode({ id: 'b', x: 40, y: 0 });
  g.addLink({ source: 'a', target: 'b', weight: 1 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleLink: () => -1 });
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  const stroked = calls.filter((c) => c.op === 'stroke').map((c) => String(c.args[0]));
  assert.ok(stroked.includes(darkTheme.link.color), 'should use the theme link colour');
  assert.ok(!stroked.includes('#333333'), 'must not collide with explicit link style 0');
});

test('batching survives: one fill per occupied style bucket, not one per node', () => {
  const g = new Graph(1);
  for (let i = 0; i < 60; i++) g.addNode({ id: `n${i}`, x: (i % 10) * 12, y: Math.floor(i / 10) * 12 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleNode: (i) => i % 2 });
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  const fillCalls = calls.filter((c) => c.op === 'fill').length;
  assert.ok(fillCalls <= 4, `expected a handful of fills for 2 buckets, got ${fillCalls}`);
  assert.equal(r.stats.nodesDrawn, 60);
});

// ------------------------------------------------------------- animation

test('🔴 an animated dash marks the frame as animating, so it cannot silently freeze', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', x: 0, y: 0 });
  g.addNode({ id: 'b', x: 40, y: 0 });
  g.addLink({ source: 'a', target: 'b' });
  const { canvas } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleLink: () => 1 }); // style 1 animates
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  assert.equal(r.animating, true);
});

test('a static frame reports animating === false, so idle still costs nothing', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', x: 0, y: 0 });
  g.addNode({ id: 'b', x: 40, y: 0 });
  g.addLink({ source: 'a', target: 'b' });
  const { canvas } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleLink: () => 0 }); // style 0 does not animate
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  assert.equal(r.animating, false);
});

test('a selected node animates (the ring breathes)', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', x: 0, y: 0 });
  g.setSelected('a', true);
  const { canvas } = stubCanvas();
  const r = new Canvas2DRenderer(canvas);
  r.resize(800, 600, 1);
  r.render(frameFor(g, darkTheme));
  assert.equal(r.animating, true);
});

test('supplying decorate defaults to animating — the SAFE guess', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', x: 0, y: 0 });
  const { canvas } = stubCanvas();

  const guessed = new Canvas2DRenderer(canvas, { decorate: () => {} });
  guessed.resize(800, 600, 1);
  guessed.render(frameFor(g, darkTheme));
  assert.equal(guessed.animating, true, 'must assume a decoration animates unless told otherwise');

  const declared = new Canvas2DRenderer(canvas, { decorate: () => {}, decorateAnimates: false });
  declared.resize(800, 600, 1);
  declared.render(frameFor(g, darkTheme));
  assert.equal(declared.animating, false, 'an explicit opt-out must be honoured');
});

// ---------------------------------------------------------------- labels

test('a dimmed node keeps its label — recessive must not mean anonymous', () => {
  const g = new Graph(1);
  g.addNode({ id: 'keep', label: 'KEEP', x: 0, y: 0 });
  g.addNode({ id: 'dim', label: 'DIMMED', x: 40, y: 0 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { labelZoom: 0 });
  r.resize(800, 600, 1);
  const frame = frameFor(g, darkTheme);
  frame.dim = Uint8Array.from([1, 0]);
  r.render(frame);
  const texts = calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));
  assert.ok(texts.includes('KEEP'));
  assert.ok(texts.includes('DIMMED'), 'the dimmed node lost its label');
});

test("a style's labelColor is actually used, not a dead field", () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', label: 'A', x: 0, y: 0 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { labelZoom: 0, styleNode: () => 0 });
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  assert.ok(fills(calls).includes('#aaaaaa'), 'labelColor from the style was ignored');
});

test('labelPlacement below centres the text under the node', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', label: 'A', x: 0, y: 0, radius: 10 });
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { labelZoom: 0, labelPlacement: 'below' });
  r.resize(800, 600, 1);
  r.render(frameFor(g, darkTheme));
  const t = calls.find((c) => c.op === 'fillText' && c.args[0] === 'A')!;
  assert.equal(t.args[1], 400, 'x should be the node centre');
  assert.ok((t.args[2] as number) > 300, 'y should be below the node centre');
  const aligns = calls.filter((c) => c.op === 'set:textAlign').map((c) => c.args[0]);
  assert.ok(aligns.includes('center'));
});

test('explicit link styles are NOT overpainted by the built-in active highlight', () => {
  // Selecting a node used to repaint every touching edge in one flat accent
  // colour, destroying the encoding a consumer had put on the link.
  const g = new Graph(1);
  g.addNode({ id: 'a', x: 0, y: 0 });
  g.addNode({ id: 'b', x: 40, y: 0 });
  g.addLink({ source: 'a', target: 'b' });
  g.setSelected('a', true);
  const { canvas, calls } = stubCanvas();
  const r = new Canvas2DRenderer(canvas, { styleLink: () => 0 });
  r.resize(800, 600, 1);
  r.render(frameFor(g, styledTheme()));
  const stroked = calls.filter((c) => c.op === 'stroke').map((c) => String(c.args[0]));
  assert.ok(stroked.includes('#333333'), 'the link kept its own style');
  assert.ok(
    !stroked.includes(darkTheme.link.active),
    `the accent must not overpaint an explicit style; stroked = ${JSON.stringify(stroked)}`,
  );
});
