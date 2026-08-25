const DEFAULT_HOVER_POLL_INTERVAL_MS = 50;

function pointInWindowShape(screenPoint, windowBounds, rectangles) {
  const localX = Math.floor(Number(screenPoint?.x) - Number(windowBounds?.x));
  const localY = Math.floor(Number(screenPoint?.y) - Number(windowBounds?.y));
  if (!Number.isFinite(localX) || !Number.isFinite(localY) || !Array.isArray(rectangles)) {
    return false;
  }

  return rectangles.some((rectangle) => {
    const x = Number(rectangle?.x);
    const y = Number(rectangle?.y);
    const width = Number(rectangle?.width);
    const height = Number(rectangle?.height);
    return Number.isFinite(x) && Number.isFinite(y)
      && Number.isFinite(width) && Number.isFinite(height)
      && width > 0 && height > 0
      && localX >= x && localX < x + width
      && localY >= y && localY < y + height;
  });
}

function shouldMonitorWindowHover({ visible, visualMode, animating }) {
  return Boolean(visible) && visualMode === 'compact' && !animating;
}

class WindowHoverMonitor {
  constructor({
    intervalMs = DEFAULT_HOVER_POLL_INTERVAL_MS,
    sampleHover = () => false,
    onChange = () => {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    this.intervalMs = Math.max(16, Number(intervalMs) || DEFAULT_HOVER_POLL_INTERVAL_MS);
    this.sampleHover = sampleHover;
    this.onChange = onChange;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.timer = null;
    this.running = false;
    this.generation = 0;
    this.hovered = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.#tick(generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.clearTimeout(this.timer);
    this.timer = null;
    this.#publish(false);
  }

  #publish(hovered) {
    const value = Boolean(hovered);
    if (value === this.hovered) return;
    this.hovered = value;
    this.onChange(value);
  }

  #tick(generation) {
    if (!this.running || generation !== this.generation) return;
    this.timer = null;
    let hovered = false;
    try {
      hovered = Boolean(this.sampleHover());
    } catch {}
    this.#publish(hovered);
    if (!this.running || generation !== this.generation) return;
    this.timer = this.setTimeout(() => this.#tick(generation), this.intervalMs);
    this.timer?.unref?.();
  }
}

module.exports = {
  DEFAULT_HOVER_POLL_INTERVAL_MS,
  pointInWindowShape,
  shouldMonitorWindowHover,
  WindowHoverMonitor,
};
