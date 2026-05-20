/**
 * requestAnimationFrame scroll engine — syncs with export & transport controls.
 */
export class ScrollPreview {
  /** @param {HTMLElement} canvas */
  /** @param {HTMLElement} textEl */
  /** @param {HTMLElement} container */
  constructor(canvas, textEl, container) {
    this.canvas = canvas;
    this.textEl = textEl;
    this.container = container;
    this.speed = 80;
    this.startDelay = 0;
    this.running = false;
    this.paused = false;
    this.y = 0;
    this.startY = 0;
    this.endY = 0;
    this.delayRemaining = 0;
    this.rafId = null;
    this.lastTs = 0;
    this.onStatus = () => {};
    this.onComplete = () => {};
  }

  /** Measure scroll bounds after text/layout changes */
  measure() {
    const ch = this.container.clientHeight;
    const th = this.textEl.offsetHeight;
    this.startY = ch;
    this.endY = -th;
    if (!this.running) {
      this.y = this.startY;
      this.applyTransform();
    }
  }

  applyTransform() {
    this.textEl.style.transform = `translateY(${this.y}px)`;
  }

  reset() {
    this.stop();
    this.y = this.startY;
    this.delayRemaining = 0;
    this.applyTransform();
    this.onStatus("Ready");
  }

  play() {
    if (this.running && !this.paused) return;
    this.measure();
    if (this.paused) {
      this.paused = false;
      this.lastTs = performance.now();
      this.onStatus("Playing");
      this.tick();
      return;
    }
    this.running = true;
    this.paused = false;
    this.y = this.startY;
    this.delayRemaining = this.startDelay;
    this.lastTs = performance.now();
    this.applyTransform();
    this.onStatus(this.startDelay > 0 ? `Starting in ${this.startDelay}s…` : "Playing");
    this.tick();
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
    const dt = Math.min((ts - this.lastTs) / 1000, 0.1);
    this.lastTs = ts;

    if (this.delayRemaining > 0) {
      this.delayRemaining -= dt;
      if (this.delayRemaining > 0) {
        this.onStatus(`Starting in ${this.delayRemaining.toFixed(1)}s…`);
        this.rafId = requestAnimationFrame(this.tick);
        return;
      }
      this.onStatus("Playing");
    }

    this.y -= this.speed * dt;
    this.applyTransform();

    if (this.y <= this.endY) {
      this.stop();
      this.onStatus("Complete");
      this.onComplete();
      return;
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Total duration in seconds for full scroll (delay + scroll time) */
  getTotalDuration() {
    this.measure();
    const distance = this.startY - this.endY;
    const scrollTime = distance / this.speed;
    return this.startDelay + scrollTime;
  }

  /** Seek to start and run until complete; returns Promise */
  runToCompletion() {
    return new Promise((resolve) => {
      const prev = this.onComplete;
      this.onComplete = () => {
        if (prev) prev();
        resolve();
      };
      this.play();
    });
  }
}
