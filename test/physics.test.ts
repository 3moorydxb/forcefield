import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/core/graph.js';
import { Simulation } from '../src/core/simulation.js';
import {
  DEFAULT_PHYSICS,
  PHYSICS_LIMITS,
  expoResponse,
  expoPosition,
  normalisePhysics,
  PhysicsError,
} from '../src/core/physics.js';
import type { LinkForce } from '../src/core/forces/link.js';
import type { ManyBodyForce } from '../src/core/forces/manyBody.js';

function chain(n: number, seed = 5): Graph {
  const g = new Graph(seed);
  for (let i = 0; i < n; i++) g.addNode({ id: `n${i}` });
  for (let i = 1; i < n; i++) g.addLink({ source: `n${i - 1}`, target: `n${i}` });
  return g;
}

// ---------------------------------------------------------------- the curve

test('expoResponse is exact at both ends, for any floor', () => {
  for (const floor of [0.001, 0.01, 0.1, 0.5]) {
    assert.equal(expoResponse(0, floor), 0);
    assert.ok(Math.abs(expoResponse(1, floor) - 1) < 1e-12);
  }
});

test('expoResponse is monotonically increasing', () => {
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const v = expoResponse(p);
    assert.ok(v > prev, `not monotonic at ${p}: ${v} <= ${prev}`);
    prev = v;
  }
});

test('expoPosition is the exact inverse of expoResponse', () => {
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const round = expoPosition(expoResponse(p));
    assert.ok(Math.abs(round - Math.min(1, p)) < 1e-9, `round trip ${p} -> ${round}`);
  }
});

test('the curve spreads RATIO, not difference — which is the whole point of using it', () => {
  // Equal steps in slider position give roughly equal MULTIPLES of the force.
  // It is only ASYMPTOTICALLY geometric: the `- floor` normalisation that pins
  // response(0) to exactly 0 compresses the bottom of the range, so the ratios
  // start high and converge down on floor^(-1/4) = 10^(1/2) = 3.162.
  const at = (p: number) => expoResponse(p);
  const r1 = at(0.5) / at(0.25); // 4.162
  const r2 = at(0.75) / at(0.5); // 3.403
  const r3 = at(1.0) / at(0.75); // 3.233
  const target = Math.pow(0.01, -0.25);
  assert.ok(Math.abs(target - 3.1622776) < 1e-6);

  for (const r of [r1, r2, r3]) {
    assert.ok(r > 3 && r < 4.3, `ratio ${r} outside the expected band`);
  }
  assert.ok(r1 > r2 && r2 > r3, 'ratios must converge downward, not wander');
  assert.ok(r3 - target < 0.1, `top ratio ${r3} should be closing on ${target}`);

  // The contrast that justifies the curve: a LINEAR control over the same range
  // would give ratios 2.0 / 1.5 / 1.33 — the top half barely changing anything.
  const lin = (p: number) => p;
  assert.ok(lin(1.0) / lin(0.75) < 1.4);
});

test('a non-finite input throws rather than producing NaN', () => {
  assert.throws(() => expoResponse(NaN), PhysicsError);
  assert.throws(() => expoResponse(0.5, 0), PhysicsError);
  assert.throws(() => expoResponse(0.5, 1), PhysicsError);
  assert.throws(() => expoPosition(NaN), PhysicsError);
});

// ------------------------------------------------------------- validation

test('NaN is rejected at the door — it would destroy every position in one tick', () => {
  assert.throws(() => normalisePhysics({ repelForce: NaN }), PhysicsError);
  assert.throws(() => normalisePhysics({ linkDistance: Infinity }), PhysicsError);
  assert.throws(
    () => normalisePhysics({ linkForce: '0.5' as unknown as number }),
    PhysicsError,
  );
});

test('an unknown setting throws instead of being silently ignored', () => {
  assert.throws(() => normalisePhysics({ wobble: 1 } as never), /unknown setting/);
});

test('out-of-range values clamp to the limits rather than throwing', () => {
  assert.deepEqual(normalisePhysics({ centerForce: 99 }), { centerForce: 1 });
  assert.deepEqual(normalisePhysics({ centerForce: -5 }), { centerForce: 0 });
  // linkForce is capped below 1 on purpose: the integrator rings above ~0.9.
  assert.deepEqual(normalisePhysics({ linkForce: 1 }), { linkForce: PHYSICS_LIMITS.linkForce.max });
  assert.ok(PHYSICS_LIMITS.linkForce.max < 1);
});

test('a NaN never reaches a node, even via setForces', () => {
  const g = chain(30);
  const sim = new Simulation(g);
  sim.tick(20);
  assert.throws(() => sim.setForces({ repelForce: NaN }), PhysicsError);
  sim.tick(20);
  for (let i = 0; i < g.nodeCount; i++) {
    assert.ok(Number.isFinite(g.x[i]!) && Number.isFinite(g.y[i]!), `node ${i} went non-finite`);
  }
});

// --------------------------------------------------------------- setForces

test('defaults round-trip: getForces on a fresh simulation is DEFAULT_PHYSICS', () => {
  const sim = new Simulation(chain(5));
  assert.deepEqual(sim.getForces(), { ...DEFAULT_PHYSICS });
});

test('the shipped defaults are exactly what the force objects already had', () => {
  // If these drift apart, calling setForces with the defaults would silently
  // change the layout every screenshot in the README was taken with.
  const sim = new Simulation(chain(5));
  const link = sim.force<LinkForce>('link')!;
  const many = sim.force<ManyBodyForce>('manyBody')!;
  const before = { d: link.distance, s: link.strength, scale: many.scale };
  sim.setForces({ ...DEFAULT_PHYSICS });
  assert.equal(link.distance, before.d);
  assert.equal(link.strength, before.s);
  assert.equal(many.scale, before.scale);
});

test('setForces reaches the force objects', () => {
  const sim = new Simulation(chain(10));
  sim.setForces({ linkDistance: 250, linkForce: 0.4, repelForce: 33 });
  assert.equal(sim.force<LinkForce>('link')!.distance, 250);
  assert.equal(sim.force<LinkForce>('link')!.strength, 0.4);
  assert.equal(sim.force<ManyBodyForce>('manyBody')!.scale, 33);
  assert.equal(sim.getForces().linkDistance, 250);
});

test('a partial patch leaves the other settings alone', () => {
  const sim = new Simulation(chain(5));
  sim.setForces({ linkDistance: 120 });
  const f = sim.getForces();
  assert.equal(f.linkDistance, 120);
  assert.equal(f.repelForce, DEFAULT_PHYSICS.repelForce);
  assert.equal(f.centerForce, DEFAULT_PHYSICS.centerForce);
});

test('getForces returns a COPY — mutating it must not change the simulation', () => {
  const sim = new Simulation(chain(5));
  const f = sim.getForces();
  f.linkDistance = 9999;
  assert.equal(sim.getForces().linkDistance, DEFAULT_PHYSICS.linkDistance);
});

test('🔴 THE ONE THAT SHIPS BROKEN: setForces on a SETTLED graph must make it move', () => {
  const g = chain(40);
  const sim = new Simulation(g);
  sim.tick(4000);
  assert.ok(sim.settled, 'precondition: the graph is settled');

  const before = Array.from({ length: g.nodeCount }, (_, i) => [g.x[i]!, g.y[i]!] as const);
  sim.setForces({ linkDistance: 160 });

  // Without the reheat inside setForces, tick() early-returns forever and the
  // slider moves while the graph sits perfectly still.
  assert.ok(!sim.settled, 'setForces must wake a settled simulation');
  const ran = sim.tick(60);
  assert.equal(ran, 60);

  let moved = 0;
  for (let i = 0; i < g.nodeCount; i++) {
    if (Math.hypot(g.x[i]! - before[i]![0], g.y[i]! - before[i]![1]) > 0.5) moved++;
  }
  assert.ok(moved > g.nodeCount * 0.5, `only ${moved}/${g.nodeCount} nodes responded`);
});

test('setForces does NOT restart — positions are continuous, not re-seeded', () => {
  const g = chain(40);
  const sim = new Simulation(g);
  sim.tick(4000);
  const before = Array.from({ length: g.nodeCount }, (_, i) => [g.x[i]!, g.y[i]!] as const);

  sim.setForces({ linkForce: 0.5 });
  // Assert the temperature BEFORE ticking — a tick immediately begins cooling it.
  assert.equal(sim.alpha, 0.3, 'a reheat to the drag temperature, never a restart to 1');

  // The very next tick starts from where the layout already was.
  sim.tick(1);
  let maxJump = 0;
  for (let i = 0; i < g.nodeCount; i++) {
    maxJump = Math.max(maxJump, Math.hypot(g.x[i]! - before[i]![0], g.y[i]! - before[i]![1]));
  }
  assert.ok(maxJump < 30, `a single tick moved a node ${maxJump} units — that is a jump, not a reflow`);
});

test('setForces does not bump graph.version — that would rebuild adjacency at 60Hz', () => {
  const g = chain(20);
  const sim = new Simulation(g);
  const v = g.version;
  sim.setForces({ repelForce: 2 });
  sim.setForces({ linkDistance: 90 });
  assert.equal(g.version, v);
});

test('centre force drives BOTH centring forces, so a pin cannot silence the slider', () => {
  const sim = new Simulation(chain(10));
  sim.setForces({ centerForce: 0.8 });
  const centre = sim.force('center') as unknown as { strength: number };
  const gravity = sim.force('gravity') as unknown as { strength: number };
  assert.ok(centre.strength > 0, 'CenterForce should be driven');
  assert.ok(gravity.strength > 0, 'GravityForce must be driven too — it is the one that survives a pin');

  // With a node pinned, CenterForce stands down entirely. Gravity is then the
  // only thing carrying the setting, and it must still be non-zero.
  const g2 = chain(10);
  g2.setPinned('n0', true);
  const sim2 = new Simulation(g2);
  sim2.setForces({ centerForce: 0.8 });
  assert.ok((sim2.force('gravity') as unknown as { strength: number }).strength > 0);
});

test('setForces survives a missing force instead of throwing mid-gesture', () => {
  const sim = new Simulation(chain(5));
  sim.removeForce('link');
  sim.removeForce('gravity');
  assert.doesNotThrow(() => sim.setForces({ linkDistance: 100, centerForce: 0.5 }));
  assert.equal(sim.getForces().linkDistance, 100);
});

// ------------------------------------------------------------ hold/release

test('hold/release is refcounted — a slider and a drag do not fight', () => {
  const sim = new Simulation(chain(10));
  sim.tick(3000);
  assert.ok(sim.settled);

  sim.hold(0.3); // e.g. a node drag begins
  assert.equal(sim.holdCount, 1);
  assert.equal(sim.alphaTarget, 0.3);

  sim.hold(0.3); // e.g. a slider gesture begins on top of it
  assert.equal(sim.holdCount, 2);

  sim.release(); // the DRAG ends first
  assert.equal(sim.holdCount, 1);
  assert.equal(
    sim.alphaTarget,
    0.3,
    'the slider is still holding — releasing the drag must NOT freeze the graph',
  );

  sim.release();
  assert.equal(sim.holdCount, 0);
  assert.equal(sim.alphaTarget, 0);
});

test('a held simulation genuinely keeps ticking; releasing lets it cool', () => {
  const sim = new Simulation(chain(20));
  sim.tick(3000);
  sim.hold(0.3);
  assert.equal(sim.tick(400), 400, 'must not stop while held');
  assert.ok(sim.alpha > 0.29);
  sim.release();
  sim.tick(3000);
  assert.ok(sim.settled);
});

test('release() never underflows below zero', () => {
  const sim = new Simulation(chain(5));
  sim.release();
  sim.release();
  assert.equal(sim.holdCount, 0);
  assert.equal(sim.alphaTarget, 0);
});
