/**
 * requestAnimationFrame scroll engine with timeline seek/scrub support.
 * Scroll coordinates are design pixels (same space as server export).
 */
export class ScrollPreview {
  constructor(canvas, textEl, container) {
    this.canvas = canvas;
    this.textEl = textEl;
    this.container = container;
    this.speed = 80;
    this.startDelay = 0;
    /** Canvas Y (px): text top edge at timeline start (null = canvas height). */
    this.scrollFirstRow = null;
    /** Canvas Y (px): text bottom edge at timeline end (null = 0). */
    this.scrollLastRow = null;
    /** Logical canvas height (px); scroll settings use this coordinate system. */
    this.designHeight = 1920;
    this.designWidth = 1080;
    this.running = false;
    this.paused = false;
    this.y = 0;
    this.startY = 0;
    this.endY = 0;
    this.timelineTime = 0;
    this.delayRemaining = 0;
    this.rafId = null;
    this.lastTs = 0;
    this.onStatus = () => {};
    this.onComplete = () => {};
    this.onTimeUpdate = () => {};
  }

  measure() {
    const dh = this.designHeight || this.container.clientHeight || 1;
    this.containerHeight = dh;
    this.textHeight = Math.max(this.textEl.offsetHeight, 1);
    const firstRow = this.scrollFirstRow != null ? this.scrollFirstRow : dh;
    const lastRow = this.scrollLastRow != null ? this.scrollLastRow : 0;
    this.startY = firstRow;
    this.endY = lastRow - this.textHeight;
  }

  /** Timeline Y in design px → translateY inside the design stage. */
  getDisplayY(designY = this.y) {
    return designY;
  }

  getScrollDuration() {
    const distance = this.startY - this.endY;
    return distance > 0 ? distance / this.speed : 0;
  }

  getTotalDuration() {
    return this.startDelay + this.getScrollDuration();
  }

  /** Map timeline seconds → text Y position */
  applyTime(time) {
    const total = this.getTotalDuration();
    const t = Math.max(0, Math.min(time, total));
    this.timelineTime = t;

    if (t < this.startDelay) {
      this.y = this.startY;
      this.delayRemaining = this.startDelay - t;
    } else {
      const scrollT = t - this.startDelay;
      this.y = Math.max(this.endY, this.startY - scrollT * this.speed);
      this.delayRemaining = 0;
    }

    this.applyTransform();
    this.onTimeUpdate(t, total);
    return t;
  }

  applyTransform() {
    this.textEl.style.transform = `translateY(${this.getDisplayY()}px)`;
  }

  seek(time) {
    this.applyTime(time);
  }

  reset() {
    this.stop();
    this.applyTime(0);
    this.onStatus("Ready");
  }

  play() {
    if (this.running && !this.paused) return;
    this.measure();

    if (this.paused) {
      this.paused = false;
      this.lastTs = performance.now();
      this.onStatus("Playing");
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }

    const total = this.getTotalDuration();
    if (this.timelineTime >= total) {
      this.applyTime(0);
    }

    this.running = true;
    this.paused = false;
    this.lastTs = performance.now();
    this.onStatus(
      this.timelineTime < this.startDelay && this.startDelay > 0
        ? `Starting in ${(this.startDelay - this.timelineTime).toFixed(1)}s…`
        : "Playing"
    );
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.onStatus("Paused");
  }

  stop() {
    this.running = false;
    this.paused = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  tick = (ts) => {
    if (!this.running || this.paused) return;

    const now = typeof ts === "number" ? ts : performance.now();
    const dt = Math.min((now - this.lastTs) / 1000, 0.1);
    this.lastTs = now;

    const total = this.getTotalDuration();
    const next = this.timelineTime + dt;

    if (next >= total) {
      this.applyTime(total);
      this.stop();
      this.onStatus("Complete");
      this.onComplete();
      return;
    }

    this.applyTime(next);

    if (this.timelineTime < this.startDelay && this.startDelay > 0) {
      this.onStatus(`Starting in ${(this.startDelay - this.timelineTime).toFixed(1)}s…`);
    } else {
      this.onStatus("Playing");
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  runToCompletion() {
    return new Promise((resolve) => {
      const prev = this.onComplete;
      this.onComplete = () => {
        if (prev) prev();
        resolve();
      };
      this.applyTime(0);
      this.play();
    });
  }
}
