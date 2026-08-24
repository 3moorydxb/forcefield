import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.js';
import { Quadtree } from '../src/core/quadtree.js';
import { ManyBodyForce } from '../src/core/forces/manyBody.js';
import { Rng } from '../src/util/rng.js';
import type { ForceContext } from '../src/core/forces/types.js';

function scatter(n: number, seed = 7): Graph {
  const g = new Graph(seed);
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) {
    g.addNode({ id: `n${i}`, x: rng.between(-400, 400), y: rng.between(-400, 400) });
  }
  return g;
}

/** The O(n²) answer, computed the obvious way, to check the clever one against. */
function bruteForce(g: Graph, alpha: number, distanceMin: number) {
  const fx = new Float64Array(g.nodeCount);
  const fy = new Float64Array(g.nodeCount);
  const min2 = distanceMin * distanceMin;
  for (let i = 0; i < g.nodeCount; i++) {
    for (let j = 0; j < g.nodeCount; j++) {
      if (i === j) continue;
      const dx = g.x[j]! - g.x[i]!;
      const dy = g.y[j]! - g.y[i]!;
      let d2 = dx * dx + dy * dy;
      if (d2 < min2) d2 = min2;
      const k = (g.charge[j]! * alpha) / d2;
      fx[i]! += dx * k;
      fy[i]! += dy * k;
    }
  }
  return { fx, fy };
}

function runManyBody(g: Graph, theta: number) {
  const rng = new Rng(1);
  const tree = new Quadtree();
  tree.build(g, rng);
  const f = new ManyBodyForce();
  f.theta = theta;
  const fx = new Float64Array(g.nodeCount);
  const fy = new Float64Array(g.nodeCount);
  const ctx: ForceContext = { graph: g, tree, alpha: 1, dt: 1, rng, fx, fy };
  f.apply(ctx);
  return { fx, fy, tree, distanceMin: f.distanceMin };
}

test('theta = 0 makes Barnes-Hut exact — it matches brute force to machine precision', () => {
  const g = scatter(200);
  const bh = runManyBody(g, 0);
  const exact = bruteForce(g, 1, bh.distanceMin);
  for (let i = 0; i < g.nodeCount; i++) {
    assert.ok(
      Math.abs(bh.fx[i]! - exact.fx[i]!) < 1e-9,
      `node ${i}: fx ${bh.fx[i]} vs exact ${exact.fx[i]}`,
    );
    assert.ok(Math.abs(bh.fy[i]! - exact.fy[i]!) < 1e-9);
  }
});

test('theta = 0.9 stays close to exact — the approximation is an approximation, not a different force', () => {
  const g = scatter(600, 11);
  const bh = runManyBody(g, 0.9);
  const exact = bruteForce(g, 1, 1);

  let sumErr = 0;
  let sumMag = 0;
  let worst = 0;
  for (let i = 0; i < g.nodeCount; i++) {
    const ex = exact.fx[i]!;
    const ey = exact.fy[i]!;
    const mag = Math.hypot(ex, ey);
    const err = Math.hypot(bh.fx[i]! - ex, bh.fy[i]! - ey);
    sumErr += err;
    sumMag += mag;
    if (mag > 1e-6) worst = Math.max(worst, err / mag);
  }
  const relative = sumErr / sumMag;
  assert.ok(relative < 0.05, `aggregate relative error ${relative} should be under 5%`);
});

test('the tree carries every body exactly once', () => {
  const g = scatter(500, 3);
  const tree = new Quadtree();
  tree.build(g, new Rng(1));
  assert.equal(tree.bodies[0], g.nodeCount, 'root should count every node');

  // Every node appears in exactly one leaf chain.
  const seen = new Set<number>();
  for (let c = 0; c < tree.count; c++) {
    if (!tree.isLeaf(c)) continue;
    for (let b = tree.bodyHead[c]!; b >= 0; b = tree.bodyNext[b]!) {
      assert.ok(!seen.has(b), `node ${b} appears in more than one leaf`);
      seen.add(b);
    }
  }
  assert.equal(seen.size, g.nodeCount);
});

test('root charge is the sum of every node charge', () => {
  const g = scatter(300, 5);
  const tree = new Quadtree();
  tree.build(g, new Rng(1));
  let total = 0;
  for (let i = 0; i < g.nodeCount; i++) total += g.charge[i]!;
  assert.ok(Math.abs(tree.charge[0]! - total) < 1e-6, `${tree.charge[0]} vs ${total}`);
});

test('coincident nodes terminate instead of subdividing forever', () => {
  const g = new Graph(1);
  for (let i = 0; i < 40; i++) g.addNode({ id: `same${i}`, x: 0, y: 0 });
  const tree = new Quadtree();
  // The real assertion is that this returns at all.
  tree.build(g, new Rng(1));
  assert.equal(tree.bodies[0], 40);
  // And that they were nudged apart, so no pair is at zero distance.
  for (let i = 0; i < g.nodeCount; i++) {
    for (let j = i + 1; j < g.nodeCount; j++) {
      const d = Math.hypot(g.x[i]! - g.x[j]!, g.y[i]! - g.y[j]!);
      assert.ok(d > 0, `nodes ${i} and ${j} are still exactly coincident`);
    }
  }
});

test('hidden nodes are absent from the tree entirely', () => {
  const g = scatter(100, 9);
  for (let i = 0; i < 40; i++) g.setHidden(`n${i}`, true);
  const tree = new Quadtree();
  tree.build(g, new Rng(1));
  assert.equal(tree.bodies[0], 60, 'only visible nodes should be in the tree');
});

test('an empty or all-hidden graph builds a tree with no cells and does not throw', () => {
  const empty = new Graph(1);
  const t1 = new Quadtree();
  t1.build(empty, new Rng(1));
  assert.equal(t1.count, 0);

  const g = scatter(10, 2);
  for (let i = 0; i < 10; i++) g.setHidden(`n${i}`, true);
  const t2 = new Quadtree();
  t2.build(g, new Rng(1));
  assert.equal(t2.count, 0);
});
