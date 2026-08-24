/**
 * Direction is an explicit field. It is NEVER encoded as the sign of a number.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CSS clamps a negative `animation-duration` to `0s`. It does not throw, it does
 * not warn, and `getAnimations()` returns nothing — the animation silently does
 * not exist. A sibling project encoded "spin the other way" as a negative
 * duration and shipped a six-layer animation in which three layers stood
 * perfectly still, through a design review, unnoticed.
 *
 * The bug is not CSS's clamp. The bug is overloading a magnitude field to carry
 * a direction. A magnitude has a floor; a direction does not. The moment you put
 * a direction into a magnitude, some layer below you is entitled to clamp it
 * away, and a clamped value looks exactly like a value you never set.
 *
 * So in this engine:
 *   - durations, radii, distances, strengths-as-magnitudes are POSITIVE, validated
 *   - direction / orientation / sense-of-rotation is a STRING UNION, validated
 *   - a negative magnitude is a thrown error, never a silent no-op
 *
 * This applies to every animated or oriented quantity in the package, not just
 * the renderer's pulse. If you add one, route it through `assertAnimation`.
 */

/** The only two values. Not `1 | -1`, not a signed number. */
export type Direction = 'forward' | 'reverse';

/** Rotational sense, for anything angular. Same rule, different vocabulary. */
export type Spin = 'clockwise' | 'counterclockwise';

export interface AnimationSpec {
  /** Strictly positive milliseconds. A non-positive value is an error, not a stop. */
  durationMs: number;
  /** Explicit. Never inferred from the sign of `durationMs`. */
  direction: Direction;
  /** Optional phase offset in milliseconds, may be any finite number. */
  delayMs?: number;
}

export class DirectionError extends Error {
  override name = 'DirectionError';
}

/**
 * Validate an animation spec. Throws loudly rather than degrading quietly.
 *
 * @throws DirectionError if the duration is not a finite number > 0, or if the
 *         direction is not one of the two literals.
 */
export function assertAnimation(spec: AnimationSpec, label = 'animation'): void {
  const { durationMs, direction, delayMs } = spec;

  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    throw new DirectionError(
      `${label}: durationMs must be a finite number, received ${String(durationMs)}`,
    );
  }
  if (durationMs <= 0) {
    throw new DirectionError(
      `${label}: durationMs must be > 0, received ${durationMs}. ` +
        `If you meant to reverse it, set direction: 'reverse' — a negative duration is ` +
        `clamped to zero by CSS and by this engine's guard, which reads as "no animation ` +
        `at all" rather than "the other way round".`,
    );
  }
  if (direction !== 'forward' && direction !== 'reverse') {
    throw new DirectionError(
      `${label}: direction must be 'forward' or 'reverse', received ${JSON.stringify(direction)}`,
    );
  }
  if (delayMs !== undefined && !Number.isFinite(delayMs)) {
    throw new DirectionError(`${label}: delayMs must be finite, received ${String(delayMs)}`);
  }
}

/**
 * Normalised phase in `[0, 1)` for a looping animation.
 *
 * `forward` runs 0 → 1. `reverse` runs 1 → 0. Both take the same positive
 * duration, so halving the duration always means "twice as fast" regardless of
 * direction — which is the property the signed-number encoding destroys.
 */
export function animationPhase(spec: AnimationSpec, elapsedMs: number): number {
  assertAnimation(spec);
  const t = elapsedMs + (spec.delayMs ?? 0);
  // `%` in JS keeps the sign of the dividend; normalise so a negative elapsed
  // (a delay in the future) still lands in [0, 1).
  const raw = ((t % spec.durationMs) + spec.durationMs) % spec.durationMs;
  const forward = raw / spec.durationMs;
  return spec.direction === 'forward' ? forward : 1 - forward;
}

/** `+1` / `-1`, produced ONLY at the point of use, never stored or passed around. */
export function spinSign(spin: Spin): 1 | -1 {
  return spin === 'clockwise' ? 1 : -1;
}
