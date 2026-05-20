/** Map timeline seconds → position within background media (seconds). */
export function mapBackgroundTime(t, duration, mode) {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 0;
  const clamped = Math.max(0, t);

  if (mode === "once") {
    return Math.min(clamped, Math.max(0, duration - 0.001));
  }

  return ((clamped % duration) + duration) % duration;
}

function drawMediaCover(ctx, source, cw, ch, fit) {
  const mw = source.videoWidth || source.naturalWidth || source.width;
  const mh = source.videoHeight || source.naturalHeight || source.height;
  if (!mw || !mh) return;

  let dw = cw;
  let dh = ch;
  let dx = 0;
  let dy = 0;

  if (fit === "contain") {
    const scale = Math.min(cw / mw, ch / mh);
    dw = mw * scale;
    dh = mh * scale;
    dx = (cw - dw) / 2;
    dy = (ch - dh) / 2;
  } else if (fit === "fill") {
    dw = cw;
    dh = ch;
  } else {
    const scale = Math.max(cw / mw, ch / mh);
    dw = mw * scale;
    dh = mh * scale;
    dx = (cw - dw) / 2;
    dy = (ch - dh) / 2;
  }

  ctx.drawImage(source, dx, dy, dw, dh);
}

/**
 * Decode and render animated GIFs synced to the scroll timeline.
 */
export class GifBackground {
  constructor(canvasEl) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.frames = [];
    this.duration = 0;
    this.ready = false;
    this.fit = "cover";
    this._decoder = null;
  }

  async load(url) {
    this.dispose();
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const decoder = new ImageDecoder({ data: buffer, type: "image/gif" });
    this._decoder = decoder;

    const track = decoder.tracks[0];
    const count = track.frameCount;
    const frames = [];
    let time = 0;

    for (let i = 0; i < count; i++) {
      const { image, duration } = await decoder.decode({ frameIndex: i });
      const bitmap = await createImageBitmap(image);
      image.close?.();
      const durSec = Math.max(0.02, (duration || 100) / 1000);
      frames.push({ bitmap, start: time, end: time + durSec });
      time += durSec;
    }

    this.frames = frames;
    this.duration = Math.max(0.04, time);
    this.ready = true;
  }

  renderAtTime(timelineTime, mode) {
    if (!this.ready || !this.frames.length) return;

    const mediaTime = mapBackgroundTime(timelineTime, this.duration, mode);
    const frame = this.pickFrame(mediaTime);
    if (!frame) return;

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw < 2 || ch < 2) return;

    this.ctx.clearRect(0, 0, cw, ch);
    drawMediaCover(this.ctx, frame.bitmap, cw, ch, this.fit);
  }

  pickFrame(mediaTime) {
    const t = Math.max(0, Math.min(mediaTime, this.duration - 0.0001));
    for (const f of this.frames) {
      if (t >= f.start && t < f.end) return f;
    }
    return this.frames[this.frames.length - 1];
  }

  resizeToDisplaySize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width));
    const h = Math.max(2, Math.round(rect.height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  dispose() {
    for (const f of this.frames) {
      f.bitmap.close?.();
    }
    this.frames = [];
    this.duration = 0;
    this.ready = false;
    if (this._decoder) {
      this._decoder.close?.();
      this._decoder = null;
    }
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}

export function supportsGifTimeline() {
  return typeof ImageDecoder !== "undefined";
}
