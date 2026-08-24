import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.js';
import { Simulation } from '../src/core/simulation.js';
import { applyFilter, Filters } from '../src/core/filter.js';

/**
 * A three-level typed tree, plus one node in a separate component. Links point
 * parent → child, so direction is meaningful and `branch('out')` is testable.
 *
 *   root ─┬─ a1 ─┬─ a1x
 *         │      └─ a1y
 *         └─ a2 ─── a2x
 *   loose (unconnected)
 */
function fixture(): Graph {
  const g = new Graph(3);
  g.addNode({ id: 'root', type: 'map', x: 0, y: 0 });
  g.addNode({ id: 'a1', type: 'branch', x: 10, y: 10 });
  g.addNode({ id: 'a2', type: 'branch', x: -10, y: 10 });
  g.addNode({ id: 'a1x', type: 'leaf', x: 20, y: 20 });
  g.addNode({ id: 'a1y', type: 'leaf', x: 25, y: 22 });
  g.addNode({ id: 'a2x', type: 'leaf', x: -20, y: 20 });
  g.addNode({ id: 'loose', type: 'leaf', x: 300, y: 300 });
  g.addLink({ source: 'root', target: 'a1' });
  g.addLink({ source: 'root', target: 'a2' });
  g.addLink({ source: 'a1', target: 'a1x' });
  g.addLink({ source: 'a1', target: 'a1y' });
  g.addLink({ source: 'a2', target: 'a2x' });
  return g;
}

const visible = (g: Graph): string[] => {
  const out: string[] = [];
  for (let i = 0; i < g.nodeCount; i++) if (!g.isHidden(g.ids[i]!)) out.push(g.ids[i]!);
  return out.sort();
};

test('filtering does NOT restart the simulation', () => {
  const g = fixture();
  const sim = new Simulation(g);
  sim.tick(120);
  const alphaBefore = sim.alpha;

  applyFilter(g, Filters.ofType('leaf'));
  assert.equal(sim.alpha, alphaBefore, 'applying a filter must not touch alpha');

  applyFilter(g, null);
  assert.equal(sim.alpha, alphaBefore);
});

test('hidden node positions are bit-identical after the graph keeps simulating', () => {
  const g = fixture();
  const sim = new Simulation(g);
  sim.tick(80);

  applyFilter(g, Filters.ofType('leaf'));
  const snapshot = new Map<string, [number, number]>();
  for (const id of ['root', 'a1', 'a2']) {
    const i = g.indexOf(id);
    snapshot.set(id, [g.x[i]!, g.y[i]!]);
  }

  sim.reheat(1);
  sim.tick(400);

  for (const [id, [x, y]] of snapshot) {
    const i = g.indexOf(id);
    assert.equal(g.x[i], x, `${id} x moved while hidden`);
    assert.equal(g.y[i], y, `${id} y moved while hidden`);
  }
});

test('unfiltering restores every node exactly where it was — the layout does not explode', () => {
  const g = fixture();
  const sim = new Simulation(g);
  sim.tick(80);

  applyFilter(g, Filters.ofType('leaf'));
  const hiddenPos = new Map<string, [number, number]>();
  for (let i = 0; i < g.nodeCount; i++) {
    if (g.isHidden(g.ids[i]!)) hiddenPos.set(g.ids[i]!, [g.x[i]!, g.y[i]!]);
  }
  assert.ok(hiddenPos.size > 0);

  sim.tick(200);
  applyFilter(g, null);

  for (const [id, [x, y]] of hiddenPos) {
    const i = g.indexOf(id);
    assert.equal(g.x[i], x, `${id} did not come back where it was`);
    assert.equal(g.y[i], y);
  }
});

test('by type', () => {
  const g = fixture();
  applyFilter(g, Filters.ofType('branch'));
  assert.deepEqual(visible(g), ['a1', 'a2']);
});

test('by branch, following link direction', () => {
  const g = fixture();
  applyFilter(g, Filters.branch('a1', { direction: 'out' }));
  assert.deepEqual(visible(g), ['a1', 'a1x', 'a1y']);

  applyFilter(g, Filters.branch('a1x', { direction: 'in' }));
  assert.deepEqual(visible(g), ['a1', 'a1x', 'root'], 'ancestors, not descendants');

  applyFilter(g, Filters.branch('a1x', { direction: 'any' }));
  assert.deepEqual(
    visible(g),
    ['a1', 'a1x', 'a1y', 'a2', 'a2x', 'root'],
    'the whole connected component, excluding the loose node',
  );
});

test('by depth from a root', () => {
  const g = fixture();
  applyFilter(g, Filters.branch('root', { direction: 'out', maxDepth: 0 }));
  assert.deepEqual(visible(g), ['root']);

  applyFilter(g, Filters.branch('root', { direction: 'out', maxDepth: 1 }));
  assert.deepEqual(visible(g), ['a1', 'a2', 'root']);

  applyFilter(g, Filters.within('root', 2));
  assert.deepEqual(visible(g), ['a1', 'a1x', 'a1y', 'a2', 'a2x', 'root']);
});

test('an unknown root hides everything, loudly — a typo should look wrong', () => {
  const g = fixture();
  applyFilter(g, Filters.branch('does-not-exist'));
  assert.deepEqual(visible(g), []);
});

test('by degree, by search, and by arbitrary predicate', () => {
  const g = fixture();
  applyFilter(g, Filters.degree(0, 0));
  assert.deepEqual(visible(g), ['loose']);

  applyFilter(g, Filters.search('a1'));
  assert.deepEqual(visible(g), ['a1', 'a1x', 'a1y']);

  applyFilter(g, Filters.predicate((n) => n.x > 0));
  assert.deepEqual(visible(g), ['a1', 'a1x', 'a1y', 'loose']);
});

test('combinators', () => {
  const g = fixture();
  applyFilter(g, Filters.and(Filters.ofType('leaf'), Filters.predicate((n) => n.x > 0)));
  assert.deepEqual(visible(g), ['a1x', 'a1y', 'loose']);

  applyFilter(g, Filters.or(Filters.ofType('map'), Filters.ofType('branch')));
  assert.deepEqual(visible(g), ['a1', 'a2', 'root']);

  applyFilter(g, Filters.not(Filters.ofType('leaf')));
  assert.deepEqual(visible(g), ['a1', 'a2', 'root']);

  applyFilter(g, Filters.expand(Filters.ofType('map'), 1));
  assert.deepEqual(visible(g), ['a1', 'a2', 'root'], 'root plus one hop');
});

test('filter stats are counted, not estimated', () => {
  const g = fixture();
  const s = applyFilter(g, Filters.ofType('leaf'));
  assert.deepEqual(s, { visible: 4, hidden: 3, total: 7 });
  const all = applyFilter(g, null);
  assert.deepEqual(all, { visible: 7, hidden: 0, total: 7 });
});
