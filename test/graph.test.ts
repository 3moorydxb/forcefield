import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.js';
import { Simulation } from '../src/core/simulation.js';

test('adding the same id twice returns the same node instead of duplicating it', () => {
  const g = new Graph(1);
  const a = g.addNode({ id: 'x' });
  const b = g.addNode({ id: 'x' });
  assert.equal(a, b);
  assert.equal(g.nodeCount, 1);
});

test('a link to a node that is not there throws — a phantom node would hide the bug', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a' });
  assert.throws(() => g.addLink({ source: 'a', target: 'ghost' }), /unknown target/);
  assert.throws(() => g.addLink({ source: 'ghost', target: 'a' }), /unknown source/);
  assert.equal(g.linkCount, 0);
});

test('duplicate links and self-loops are dropped', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a' });
  g.addNode({ id: 'b' });
  g.addLink({ source: 'a', target: 'b' });
  g.addLink({ source: 'b', target: 'a' });
  g.addLink({ source: 'a', target: 'a' });
  assert.equal(g.linkCount, 1);
  assert.equal(g.degree[g.indexOf('a')], 1);
});

test('a negative radius or mass throws instead of being quietly absolutised', () => {
  const g = new Graph(1);
  assert.throws(() => g.addNode({ id: 'a', radius: -4 }), /radius/);
  assert.throws(() => g.addNode({ id: 'b', mass: 0 }), /mass/);
  assert.throws(() => g.addNode({ id: 'c', radius: NaN }), /radius/);
});

test('removeNode keeps ids, links and degrees consistent through the swap', () => {
  const g = new Graph(1);
  for (const id of ['a', 'b', 'c', 'd']) g.addNode({ id });
  g.addLink({ source: 'a', target: 'b' });
  g.addLink({ source: 'b', target: 'c' });
  g.addLink({ source: 'c', target: 'd' });
  g.addLink({ source: 'a', target: 'd' });

  // 'b' is not the last slot, so this exercises the swap path.
  assert.equal(g.removeNode('b'), true);
  assert.equal(g.nodeCount, 3);
  assert.equal(g.has('b'), false);
  assert.equal(g.linkCount, 2, 'both links touching b are gone');

  // Every surviving link must still name a real node at the right index.
  for (let l = 0; l < g.linkCount; l++) {
    const s = g.linkSource[l]!;
    const t = g.linkTarget[l]!;
    assert.ok(s < g.nodeCount && t < g.nodeCount, 'link points past the end');
    assert.equal(g.indexOf(g.ids[s]!), s, 'id/index map is out of step');
    assert.equal(g.indexOf(g.ids[t]!), t);
  }
  assert.equal(g.degree[g.indexOf('a')], 1);
  assert.equal(g.degree[g.indexOf('c')], 1);
  assert.equal(g.degree[g.indexOf('d')], 2);
});

test('removing the LAST node also works — the swap is a no-op there', () => {
  const g = new Graph(1);
  for (const id of ['a', 'b', 'c']) g.addNode({ id });
  g.addLink({ source: 'a', target: 'c' });
  assert.equal(g.removeNode('c'), true);
  assert.equal(g.nodeCount, 2);
  assert.equal(g.linkCount, 0);
  assert.equal(g.degree[g.indexOf('a')], 0);
});

test('selection and pinning survive a removal, because they live in the flags', () => {
  const g = new Graph(1);
  for (const id of ['a', 'b', 'c']) g.addNode({ id });
  g.setSelected('c', true);
  g.setPinned('c', true);
  g.removeNode('a'); // swaps 'c' into slot 0
  assert.deepEqual(g.selectedIds(), ['c']);
  assert.equal(g.isPinned('c'), true);
});

test('growing past the initial capacity preserves everything', () => {
  const g = new Graph(1);
  const n = 500;
  for (let i = 0; i < n; i++) g.addNode({ id: `n${i}`, x: i, y: -i });
  for (let i = 1; i < n; i++) g.addLink({ source: `n${i - 1}`, target: `n${i}` });
  assert.equal(g.nodeCount, n);
  assert.equal(g.linkCount, n - 1);
  for (let i = 0; i < n; i++) {
    const j = g.indexOf(`n${i}`);
    assert.equal(g.x[j], i);
    assert.equal(g.y[j], -i);
  }
});

test('adjacency is symmetric and complete', () => {
  const g = new Graph(1);
  for (const id of ['a', 'b', 'c']) g.addNode({ id });
  g.addLink({ source: 'a', target: 'b' });
  g.addLink({ source: 'b', target: 'c' });
  const { offset, neighbour } = g.adjacency();
  const nb = (id: string) => {
    const i = g.indexOf(id);
    return [...neighbour.slice(offset[i]!, offset[i + 1]!)].map((k) => g.ids[k]!).sort();
  };
  assert.deepEqual(nb('a'), ['b']);
  assert.deepEqual(nb('b'), ['a', 'c']);
  assert.deepEqual(nb('c'), ['b']);
});

test('a node inserted into a RUNNING simulation does not restart it', () => {
  const g = new Graph(1);
  for (let i = 0; i < 60; i++) g.addNode({ id: `n${i}`, x: i * 3, y: 0 });
  for (let i = 1; i < 60; i++) g.addLink({ source: `n${i - 1}`, target: `n${i}` });
  const sim = new Simulation(g);
  sim.tick(3000);
  assert.ok(sim.settled);

  // Snapshot the settled layout.
  const before = new Map<string, [number, number]>();
  for (let i = 0; i < g.nodeCount; i++) before.set(g.ids[i]!, [g.x[i]!, g.y[i]!]);

  g.addNode({ id: 'fresh' });
  g.addLink({ source: 'n30', target: 'fresh' });
  g.seedNearNeighbours('fresh');
  sim.reheat(0.3);

  assert.equal(sim.alpha, 0.3, 'a reheat, not a restart to 1');

  // The new node lands beside its neighbour, not at the origin.
  const f = g.indexOf('fresh');
  const anchor = before.get('n30')!;
  assert.ok(
    Math.hypot(g.x[f]! - anchor[0], g.y[f]! - anchor[1]) < 40,
    'a live-inserted node should appear next to what it connects to',
  );

  sim.tick(300);
  // The existing layout should be perturbed, not rearranged.
  let maxShift = 0;
  for (const [id, [x, y]] of before) {
    const i = g.indexOf(id);
    maxShift = Math.max(maxShift, Math.hypot(g.x[i]! - x, g.y[i]! - y));
  }
  assert.ok(maxShift < 120, `settled nodes shifted by up to ${maxShift}; insertion should not reflow everything`);
});

test('toJSON round-trips through Graph.from', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', type: 't', x: 1, y: 2, radius: 5, pinned: true });
  g.addNode({ id: 'b', type: 'u', x: 3, y: 4 });
  g.addLink({ source: 'a', target: 'b', weight: 0.5, kind: 'k' });
  const g2 = Graph.from(g.toJSON());
  assert.equal(g2.nodeCount, 2);
  assert.equal(g2.linkCount, 1);
  assert.equal(g2.isPinned('a'), true);
  assert.equal(g2.x[g2.indexOf('a')], 1);
  assert.equal(g2.linkWeight[0], 0.5);
});
