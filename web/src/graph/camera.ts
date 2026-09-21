export class Camera {
  private minScale = 0.2;
  private maxScale = 4;

  constructor(
    public x = 0,
    public y = 0,
    public scale = 1
  ) {}

  toScreen(wx: number, wy: number, w: number, h: number): [number, number] {
    return [w / 2 + (wx - this.x) * this.scale, h / 2 + (wy - this.y) * this.scale];
  }

  toWorld(sx: number, sy: number, w: number, h: number): [number, number] {
    return [this.x + (sx - w / 2) / this.scale, this.y + (sy - h / 2) / this.scale];
  }

  /** 以屏幕点 (sx,sy) 为锚缩放 */
  zoomAt(sx: number, sy: number, w: number, h: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy, w, h);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    this.x = wx - (sx - w / 2) / this.scale;
    this.y = wy - (sy - h / 2) / this.scale;
  }

  snapshot() {
    return { x: this.x, y: this.y, scale: this.scale, minScale: this.minScale, maxScale: this.maxScale };
  }

  restore(value: unknown): boolean {
    const saved = value as ReturnType<Camera["snapshot"]> | null;
    if (!saved || ![saved.x, saved.y, saved.scale, saved.minScale, saved.maxScale].every(Number.isFinite)
      || saved.minScale < .02 || saved.maxScale < saved.minScale
      || saved.scale < saved.minScale || saved.scale > saved.maxScale) return false;
    this.x = saved.x; this.y = saved.y; this.scale = saved.scale;
    this.minScale = saved.minScale; this.maxScale = saved.maxScale;
    return true;
  }

  /** 为当前图谱视野设置缩放边界；初始构图可作为有限放大的上限。 */
  setScaleBounds(minScale: number, maxScale: number): void {
    this.minScale = Math.max(0.02, minScale);
    this.maxScale = Math.max(this.minScale, maxScale);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale));
  }

  /** 屏幕像素增量 → 世界平移 */
  panBy(dxPx: number, dyPx: number): void {
    this.x -= dxPx / this.scale;
    this.y -= dyPx / this.scale;
  }
}
