/**
 * Viewport transform.
 *
 * `x`/`y` are the WORLD coordinates currently at the centre of the viewport;
 * `k` is the zoom. Keeping the camera anchored to the centre rather than the
 * top-left means a resize does not slide the graph sideways.
 */
export class Camera {
  x = 0;
  y = 0;
  k = 1;

  minZoom = 0.02;
  maxZoom = 12;

  width = 1;
  height = 1;

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  toScreenX(wx: number): number {
    return (wx - this.x) * this.k + this.width / 2;
  }
  toScreenY(wy: number): number {
    return (wy - this.y) * this.k + this.height / 2;
  }
  toWorldX(sx: number): number {
    return (sx - this.width / 2) / this.k + this.x;
  }
  toWorldY(sy: number): number {
    return (sy - this.height / 2) / this.k + this.y;
  }

  /** Pan by a screen-pixel delta. */
  panBy(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.k;
    this.y -= dyScreen / this.k;
  }

  /**
   * Zoom about a screen point, keeping the world point under it fixed.
   *
   * `factor` is a positive multiplier — `1.1` in, `1/1.1` out. It is never a
   * signed number: direction of zoom is which side of 1 the factor sits, and a
   * factor of `0` or below is a caller bug, not "zoom all the way out".
   */
  zoomAt(sx: number, sy: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`Camera.zoomAt: factor must be > 0, received ${String(factor)}`);
    }
    const wx = this.toWorldX(sx);
    const wy = this.toWorldY(sy);
    const k = clamp(this.k * factor, this.minZoom, this.maxZoom);
    if (k === this.k) return;
    this.k = k;
    // Solve for the camera centre that puts (wx, wy) back under (sx, sy).
    this.x = wx - (sx - this.width / 2) / k;
    this.y = wy - (sy - this.height / 2) / k;
  }

  /** Frame a world-space bounding box with `padding` screen pixels of margin. */
  fit(
    b: { minX: number; minY: number; maxX: number; maxY: number },
    padding = 48,
  ): void {
    const w = Math.max(1e-6, b.maxX - b.minX);
    const h = Math.max(1e-6, b.maxY - b.minY);
    const kx = (this.width - padding * 2) / w;
    const ky = (this.height - padding * 2) / h;
    this.k = clamp(Math.min(kx, ky), this.minZoom, this.maxZoom);
    this.x = (b.minX + b.maxX) / 2;
    this.y = (b.minY + b.maxY) / 2;
  }

  /** World-space rectangle currently visible, expanded by `margin` world units. */
  visibleBounds(margin = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    const hw = this.width / 2 / this.k + margin;
    const hh = this.height / 2 / this.k + margin;
    return { minX: this.x - hw, minY: this.y - hh, maxX: this.x + hw, maxY: this.y + hh };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
