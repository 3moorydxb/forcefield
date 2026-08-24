/**
 * Live physics settings.
 *
 * These are the knobs a user is allowed to move while looking at the graph. They
 * are deliberately NOT the raw force fields: `ManyBodyForce.scale`,
 * `LinkForce.strength` and the two centring forces interact, and a settings panel
 * that exposed them directly would let a user build a layout that cannot settle.
 *
 * Everything here is in **engine units**. A consumer whose UI speaks some other
 * vocabulary (a 0..20 slider, a perceptual curve) converts on its own side —
 * see `expoResponse` for the curve most graph UIs actually use, and the
 * reference panel in `examples/shared/physics-panel.mjs` for a worked mapping.
 */

export interface PhysicsSettings {
  /**
   * Pull toward the centre, `0..1`.
   *
   * Drives BOTH centring forces, and it has to. `CenterForce` is a translation
   * that stands down entirely whenever any node is pinned or dragged, so on its
   * own this slider would be a silent no-op for any user who has pinned
   * something. `GravityForce` has no such guard, so it carries the setting
   * whenever `CenterForce` is standing down.
   */
  centerForce: number;
  /**
   * Node-to-node repulsion, a multiplier on each node's own `charge`.
   * `1` is the engine's tuned default. `0` switches repulsion off entirely.
   */
  repelForce: number;
  /** Spring stiffness along a link, `0..1`. Above ~0.9 the integrator rings. */
  linkForce: number;
  /** Rest length of a link, in world units. Must be > 0. */
  linkDistance: number;
}

/** The engine's tuned defaults — the layout every screenshot in the README shows. */
export const DEFAULT_PHYSICS: Readonly<PhysicsSettings> = Object.freeze({
  centerForce: 0.1,
  repelForce: 1,
  linkForce: 0.7,
  linkDistance: 44,
});

/**
 * Hard bounds. A settings panel should clamp to these; `setForces` enforces them
 * regardless, because a slider is not the only way values arrive — a restored
 * localStorage blob from an older version is the case that actually bites.
 */
export const PHYSICS_LIMITS: Readonly<
  Record<keyof PhysicsSettings, { min: number; max: number }>
> = Object.freeze({
  centerForce: { min: 0, max: 1 },
  repelForce: { min: 0, max: 400 },
  // Capped below 1: at dt = 1 with damping 0.6 the spring integrator starts to
  // ring above ~0.9, and a settings panel must not be able to produce a layout
  // that never settles.
  linkForce: { min: 0, max: 0.9 },
  linkDistance: { min: 1, max: 4000 },
});

export class PhysicsError extends Error {
  override name = 'PhysicsError';
}

/**
 * Validate and clamp. Throws on a value that is not a finite number.
 *
 * The throw is not pedantry. Every force multiplies into the accumulator that
 * the Barnes-Hut leaf pass touches for every node, so a single `NaN` reaching a
 * force field contaminates the entire graph's positions within one tick — and
 * `NaN` propagates silently, so the result is a blank canvas with no error
 * anywhere. It is the one failure in this engine that a page reload is the only
 * recovery from. Rejecting it at the door is cheap.
 */
export function normalisePhysics(patch: Partial<PhysicsSettings>): Partial<PhysicsSettings> {
  const out: Partial<PhysicsSettings> = {};
  for (const key of Object.keys(patch) as (keyof PhysicsSettings)[]) {
    const v = patch[key];
    if (v === undefined) continue;
    const limit = PHYSICS_LIMITS[key];
    if (limit === undefined) {
      throw new PhysicsError(`setForces: unknown setting ${JSON.stringify(key)}`);
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new PhysicsError(
        `setForces: ${key} must be a finite number, received ${String(v)}. ` +
          `A NaN here silently destroys every node position in one tick.`,
      );
    }
    out[key] = v < limit.min ? limit.min : v > limit.max ? limit.max : v;
  }
  return out;
}

/**
 * Exponential slider response, `[0,1] → [0,1]`.
 *
 *   response(p) = (floor^(1-p) − floor) / (1 − floor)
 *
 * A linear force slider feels wrong, and it is worth being precise about why:
 * what a user perceives is roughly the *ratio* between settings, not their
 * difference. On a linear 0..1 control the bottom tenth covers a 10× change in
 * the force and the top half covers 2×, so all the useful adjustment is crammed
 * into a few pixels at the left and the right half does almost nothing. This
 * curve spreads the ratio evenly across the travel.
 *
 * `floor` is the response at the top of the *inverse* — smaller means a steeper
 * ramp. 0.01 is the value the widely-used graph UIs settle on and is the default
 * here. `response(0) === 0` and `response(1) === 1` exactly, for any floor.
 *
 * `expoPosition` is the exact inverse: given a desired response, the slider
 * position that produces it. Use it to place a handle from a stored value.
 */
export function expoResponse(position: number, floor = 0.01): number {
  if (!Number.isFinite(position)) {
    throw new PhysicsError(`expoResponse: position must be finite, received ${String(position)}`);
  }
  if (!(floor > 0 && floor < 1)) {
    throw new PhysicsError(`expoResponse: floor must be in (0,1), received ${String(floor)}`);
  }
  const p = position < 0 ? 0 : position > 1 ? 1 : position;
  return (Math.pow(floor, 1 - p) - floor) / (1 - floor);
}

/** Inverse of `expoResponse`. */
export function expoPosition(response: number, floor = 0.01): number {
  if (!Number.isFinite(response)) {
    throw new PhysicsError(`expoPosition: response must be finite, received ${String(response)}`);
  }
  if (!(floor > 0 && floor < 1)) {
    throw new PhysicsError(`expoPosition: floor must be in (0,1), received ${String(floor)}`);
  }
  const r = response < 0 ? 0 : response > 1 ? 1 : response;
  return 1 - Math.log(r * (1 - floor) + floor) / Math.log(floor);
}
