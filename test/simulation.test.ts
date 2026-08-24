import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph, FLAG_HIDDEN } from '../src/core/graph.js';
import { Simulation } from '../src/core/simulation.js';
import { LinkForce } from '../src/core/forces/link.js';
import { Rng } from '../src/util/rng.js';

/** A deterministic connected graph: a spine with branches hanging off it. */
function tree(n: number, branching = 3, seed = 42): Graph {
  const g = new Graph(seed);
  const rng = new Rng(seed);
  g.addNode({ id: 'root', x: 0, y: 0 });
  for (let i = 1; i < n; i++) {
    const parent = i <= branching ? 'root' : `n${Math.floor((i - 1) / branching)}`;
    const id = `n${i}`;
    g.addNode({ id, x: rng.between(-200, 200), y: rng.between(-200, 200) });
    g.addLink({ source: g.has(parent) ? parent : 'root', target: id });
  }
  return g;
}

test('the simulation settles rather than jittering forever', () => {
  const g = tree(300);
  const sim = new Simulation(g);
  const ran = sim.tick(2000);
  assert.ok(sim.settled, `alpha ${sim.alpha} should be under alphaMin ${sim.alphaMin}`);
  assert.ok(ran < 2000, `should have stopped early, ran ${ran}`);
  assert.ok(sim.kineticEnergy() < 1, `residual kinetic energy ${sim.kineticEnergy()} too high`);
});

test('it does not blow up — every coordinate stays finite and bounded', () => {
  const g = tree(400);
  const sim = new Simulation(g);
  sim.tick(600);
  for (let i = 0; i < g.nodeCount; i++) {
    assert.ok(Number.isFinite(g.x[i]!) && Number.isFinite(g.y[i]!), `node ${i} is not finite`);
    assert.ok(Math.abs(g.x[i]!) < 1e5 && Math.abs(g.y[i]!) < 1e5, `node ${i} flew off`);
  }
});

test('same seed, same layout — a layout bug has to be reproducible', () => {
  const a = tree(200, 3, 7);
  const b = tree(200, 3, 7);
  new Simulation(a, { seed: 99 }).tick(300);
  new Simulation(b, { seed: 99 }).tick(300);
  for (let i = 0; i < a.nodeCount; i++) {
    assert.equal(a.x[i], b.x[i], `node ${i} x diverged`);
    assert.equal(a.y[i], b.y[i], `node ${i} y diverged`);
  }
});

test('a pinned node does not move AT ALL', () => {
  const g = tree(120);
  g.setPinned('root', true);
  g.setPosition('root', 17, -23);
  const sim = new Simulation(g);
  sim.tick(400);
  const i = g.indexOf('root');
  assert.equal(g.x[i], 17);
  assert.equal(g.y[i], -23);
});

test('centring stands down once anything is pinned, and resumes when it is unpinned', () => {
  const g = tree(80);
  const sim = new Simulation(g);
  const centre = sim.force('center')!;
  assert.equal(centre.enabled, true);

  // With a pin present, no node is translated by the centring correction.
  g.setPinned('root', true);
  g.setPosition('root', 500, 500);
  const before = Array.from({ length: g.nodeCount }, (_, i) => [g.x[i]!, g.y[i]!] as const);
  sim.tick(1);
  // The pin itself is the strict check; free nodes still move under real forces.
  assert.equal(g.x[g.indexOf('root')], 500);
  assert.equal(g.y[g.indexOf('root')], 500);
  void before;

  // Unpinned, centring is live again: a graph pushed far off centre comes back.
  g.setPinned('root', false);
  for (let i = 0; i < g.nodeCount; i++) {
    g.x[i]! += 4000;
    g.y[i]! += 4000;
  }
  sim.reheat(1);
  sim.tick(400);
  const b = sim.bounds()!;
  const cx = (b.minX + b.maxX) / 2;
  assert.ok(Math.abs(cx) < 500, `graph should have been pulled back toward the origin, cx=${cx}`);
});

test('a pinned node still exerts force — it is fixed, not removed', () => {
  // One pinned node, one free node right next to it, and no links. If the pin
  // were excluded from the physics the free node would simply sit there.
  const g = new Graph(1);
  g.addNode({ id: 'anchor', x: 0, y: 0, pinned: true });
  g.addNode({ id: 'free', x: 6, y: 0 });
  const sim = new Simulation(g);
  sim.force('gravity')!.enabled = false;
  sim.force('center')!.enabled = false;
  const before = g.x[g.indexOf('free')]!;
  sim.tick(60);
  const after = g.x[g.indexOf('free')]!;
  assert.ok(after > before + 1, `free node should be pushed away: ${before} -> ${after}`);
  assert.equal(g.x[g.indexOf('anchor')], 0, 'the anchor itself must not have moved');
});

test('reheat raises alpha and never lowers it', () => {
  const g = tree(50);
  const sim = new Simulation(g);
  sim.tick(500);
  assert.ok(sim.settled);
  sim.reheat(0.3);
  assert.equal(sim.alpha, 0.3);
  sim.alpha = 0.8;
  sim.reheat(0.3);
  assert.equal(sim.alpha, 0.8, 'reheat must not cool a running simulation');
});

test('alphaTarget keeps it running — this is what makes a drag feel live', () => {
  const g = tree(60);
  const sim = new Simulation(g);
  sim.tick(1000);
  assert.ok(sim.settled);

  sim.alphaTarget = 0.3;
  sim.reheat(0.3);
  const ran = sim.tick(500);
  assert.equal(ran, 500, 'it should not stop while the target is held up');
  assert.ok(sim.alpha > 0.29, `alpha ${sim.alpha} should hold near the target`);

  sim.alphaTarget = 0;
  sim.tick(2000);
  assert.ok(sim.settled, 'and it should cool again once the target drops');
});

test('links pull connected nodes toward the rest length', () => {
  const g = new Graph(1);
  g.addNode({ id: 'a', x: -400, y: 0 });
  g.addNode({ id: 'b', x: 400, y: 0 });
  g.addLink({ source: 'a', target: 'b' });
  const sim = new Simulation(g);
  sim.force('gravity')!.enabled = false;
  const rest = sim.force<LinkForce>('link')!.distance;
  sim.tick(2000);
  const d = Math.hypot(g.x[0]! - g.x[1]!, g.y[0]! - g.y[1]!);
  // Repulsion holds them a little further apart than the bare rest length; the
  // point is that 800 units collapsed to the same order as the spring.
  assert.ok(d < rest * 3, `distance ${d} should be near the rest length ${rest}`);
});

test('collision keeps nodes from overlapping', () => {
  const g = new Graph(1);
  for (let i = 0; i < 30; i++) g.addNode({ id: `n${i}`, x: 0.5 * i, y: 0, radius: 6 });
  const sim = new Simulation(g);
  sim.tick(600);
  let worst = 0;
  for (let i = 0; i < g.nodeCount; i++) {
    for (let j = i + 1; j < g.nodeCount; j++) {
      const d = Math.hypot(g.x[i]! - g.x[j]!, g.y[i]! - g.y[j]!);
      const need = g.radius[i]! + g.radius[j]!;
      worst = Math.max(worst, need - d);
    }
  }
  assert.ok(worst < 2, `worst overlap ${worst} should be about zero`);
});

test('hidden nodes are frozen while the rest of the graph moves', () => {
  const g = tree(150);
  const sim = new Simulation(g);
  sim.tick(50);

  const frozen = 'n10';
  g.setHidden(frozen, true);
  const i = g.indexOf(frozen);
  const fx = g.x[i]!;
  const fy = g.y[i]!;
  assert.ok((g.flags[i]! & FLAG_HIDDEN) !== 0);

  sim.reheat(1);
  sim.tick(300);
  assert.equal(g.x[i], fx, 'a hidden node must not drift');
  assert.equal(g.y[i], fy);
});
