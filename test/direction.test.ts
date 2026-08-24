import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAnimation,
  animationPhase,
  spinSign,
  DirectionError,
} from '../src/core/direction.js';

/**
 * These tests exist because of a real, shipped bug: a reversed animation encoded
 * as a NEGATIVE duration, which CSS clamps to 0s. Three of six layers stood
 * still and nobody saw it, because "clamped to nothing" and "never written"
 * look identical.
 *
 * The rule is enforced here rather than documented: a negative duration is a
 * thrown error, and reverse is measured to actually run backwards.
 */

test('a negative duration throws instead of silently doing nothing', () => {
  assert.throws(
    () => assertAnimation({ durationMs: -2400, direction: 'forward' }),
    DirectionError,
  );
  assert.throws(() => assertAnimation({ durationMs: 0, direction: 'forward' }), DirectionError);
  assert.throws(() => assertAnimation({ durationMs: NaN, direction: 'forward' }), DirectionError);
  assert.throws(
    () => assertAnimation({ durationMs: Infinity, direction: 'forward' }),
    DirectionError,
  );
});

test('the error names the fix rather than just the failure', () => {
  try {
    assertAnimation({ durationMs: -1, direction: 'forward' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match((e as Error).message, /direction: 'reverse'/);
  }
});

test('an unknown direction throws — the union is not decorative', () => {
  assert.throws(
    () => assertAnimation({ durationMs: 100, direction: 'backwards' as never }),
    DirectionError,
  );
});

test('reverse genuinely runs backwards — measured, not asserted by construction', () => {
  const fwd = { durationMs: 1000, direction: 'forward' as const };
  const rev = { durationMs: 1000, direction: 'reverse' as const };

  // Sample the whole cycle and check monotonic direction, not just one point.
  let fwdRises = 0;
  let revFalls = 0;
  for (let t = 0; t < 990; t += 10) {
    if (animationPhase(fwd, t + 10) > animationPhase(fwd, t)) fwdRises++;
    if (animationPhase(rev, t + 10) < animationPhase(rev, t)) revFalls++;
  }
  assert.equal(fwdRises, 99);
  assert.equal(revFalls, 99);
});

test('both directions take the SAME positive duration — halving is twice as fast either way', () => {
  const slowF = animationPhase({ durationMs: 1000, direction: 'forward' }, 250);
  const fastF = animationPhase({ durationMs: 500, direction: 'forward' }, 125);
  assert.equal(slowF, fastF);

  const slowR = animationPhase({ durationMs: 1000, direction: 'reverse' }, 250);
  const fastR = animationPhase({ durationMs: 500, direction: 'reverse' }, 125);
  assert.equal(slowR, fastR);
});

test('phase stays inside [0,1) across wraps and negative elapsed', () => {
  for (const t of [-5000, -1, 0, 1, 999, 1000, 1001, 1e6]) {
    for (const d of ['forward', 'reverse'] as const) {
      const p = animationPhase({ durationMs: 1000, direction: d }, t);
      assert.ok(p >= 0 && p <= 1, `phase ${p} out of range for t=${t} ${d}`);
    }
  }
});

test('spinSign produces a sign only at the point of use', () => {
  assert.equal(spinSign('clockwise'), 1);
  assert.equal(spinSign('counterclockwise'), -1);
});
