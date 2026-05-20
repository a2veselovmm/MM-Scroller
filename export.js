/**
 * Export via offline frame render + ffmpeg (Remotion-style fixed-FPS encode).
 * @see https://www.remotion.dev/docs/ai/skills
 */

import { encodeFrameSequence } from "./frameEncoder.js";
import { buildGlowShadowStack } from "./textEffects.js";

export const EXPORT_FPS = 30;
const FPS = EXPORT_FPS;

function parseShadow(cs, rootStyle) {
  const sh = cs.textShadow;
  if (!sh || sh === "none") {
    const rsh = rootStyle.textShadow;
    if (!rsh || rsh === "none") return null;
    return parseShadowString(rsh);
  }
  return parseShadowString(sh);
}

function parseShadowString(sh) {
  const m = sh.match(
    /rgba?\([^)]+\)|#[0-9a-f]+|\d+\.?\d*px/gi
  );
  if (!m || m.length < 3) return { blur: 8, color: "rgba(0,0,0,0.8)", ox: 0, oy: 2 };
  const parts = sh.split(/\s+(?![^(]*\))/);
  let color = "rgba(0,0,0,0.85)";
  let blur = 8;
  let ox = 0;
  let oy = 2;
  for (const p of parts) {
    if (p.includes("rgb") || p.startsWith("#")) color = p;
    else if (p.endsWith("px")) {
      const v = parseFloat(p);
      if (blur === 8 && v > 0 && v < 100) blur = v;
      else if (ox === 0) ox = v;
      else oy = v;
    }
  }
  return { blur, color, ox, oy };
}

function segmentStyle(rootStyle, spanEl) {
  const cs = spanEl ? getComputedStyle(spanEl) : rootStyle;
  const fontSize = parseFloat(cs.fontSize);
  return {
    font: `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`,
    fontSize,
    color: cs.color,
    opacity: parseFloat(cs.opacity),
    shadow: parseShadow(cs, rootStyle),
    strokeWidth: parseFloat(cs.webkitTextStrokeWidth) || 0,
    strokeColor: cs.webkitTextStrokeColor || "transparent",
  };
}

function drawSegment(ctx, seg, x, y) {
  ctx.save();
  ctx.font = seg.font;
  ctx.globalAlpha = seg.opacity;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  if (seg.shadow) {
    ctx.shadowColor = seg.shadow.color;
    ctx.shadowBlur = seg.shadow.blur;
    ctx.shadowOffsetX = seg.shadow.ox;
    ctx.shadowOffsetY = seg.shadow.oy;
  }

  if (seg.strokeWidth > 0) {
    ctx.lineWidth = seg.strokeWidth;
    ctx.strokeStyle = seg.strokeColor;
    ctx.lineJoin = "round";
    ctx.strokeText(seg.text, x, y);
  }

  ctx.fillStyle = seg.color;
  ctx.fillText(seg.text, x, y);
  ctx.restore();
}

function findStyledSpan(node) {
  let el = node.parentElement;
  while (el) {
    if (
      el.tagName === "SPAN" &&
      (el.classList.contains("text-run") ||
        el.classList.contains("text-span"))
    ) {
      return el;
    }
    if (el.classList?.contains("text-content")) return null;
    el = el.parentElement;
  }
  return null;
}

function collectCharBoxes(textRoot, containerRect) {
  const boxes = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);

  let node;
  while ((node = walker.nextNode())) {
    const spanEl = findStyledSpan(node);
    const len = node.textContent.length;
    for (let i = 0; i < len; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      boxes.push({
        node,
        index: i,
        char: node.textContent[i],
        x: r.left - containerRect.left,
        y: r.top - containerRect.top,
        top: r.top,
        left: r.left,
        width: r.width,
        spanEl,
      });
    }
  }

  return boxes.sort((a, b) => a.top - b.top || a.left - b.left);
}

function startTextRun(box, rootStyle) {
  const style = segmentStyle(rootStyle, box.spanEl);
  return {
    text: box.char,
    x: box.x,
    y: box.y,
    endLeft: box.left + box.width,
    spanEl: box.spanEl,
    node: box.node,
    endIndex: box.index,
    ...style,
  };
}

function canMergeTextRun(run, prevBox, box) {
  if (Math.abs(box.top - prevBox.top) >= 2) return false;
  if (box.node === run.node && box.index === run.endIndex + 1) return true;
  if (box.spanEl !== run.spanEl) return false;
  return box.left >= run.endLeft - 2;
}

function mergeCharBoxes(boxes, rootStyle) {
  if (!boxes.length) return [];
  const runs = [];
  let run = startTextRun(boxes[0], rootStyle);

  for (let i = 1; i < boxes.length; i++) {
    const box = boxes[i];
    const prev = boxes[i - 1];
    if (canMergeTextRun(run, prev, box)) {
      run.text += box.char;
      run.endLeft = box.left + box.width;
      run.endIndex = box.index;
    } else {
      runs.push(run);
      run = startTextRun(box, rootStyle);
    }
  }
  runs.push(run);
  return runs;
}

function drawGlowSegment(ctx, seg, x, y, options) {
  ctx.save();
  ctx.font = seg.font;
  ctx.globalAlpha = options.glowOpacity ?? 0.6;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = options.glowColor || "#000";
  const stacks = buildGlowShadowStack({
    color: options.glowColorHex || "#000000",
    opacity: options.glowOpacity ?? 0.6,
    radius: options.glowRadius ?? 24,
    softness: options.glowSoftness ?? 50,
  });
  if (stacks !== "none") {
    ctx.shadowColor = "transparent";
    const parts = stacks.split(", ");
    for (const part of parts) {
      const m = part.match(/0 0 ([\d.]+)px (rgba?\([^)]+\))/);
      if (m) {
        ctx.shadowBlur = parseFloat(m[1]);
        ctx.shadowColor = m[2];
        ctx.fillText(seg.text, x, y);
      }
    }
  }
  ctx.fillText(seg.text, x, y);
  ctx.restore();
}

/** Draw text exactly where the browser laid it out (wrap, padding, alignment). */
function drawTextFromDomLayout(
  ctx,
  textContent,
  textContainer,
  canvasW,
  canvasH,
  options = {}
) {
  const rootStyle = getComputedStyle(textContent);
  const padL = parseFloat(rootStyle.paddingLeft) || 0;
  const padR = parseFloat(rootStyle.paddingRight) || 0;
  const containerRect = textContainer.getBoundingClientRect();
  const boxes = collectCharBoxes(textContent, containerRect);
  const runs = mergeCharBoxes(boxes, rootStyle);
  const glowMode = options.mode === "glow";

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, 0, Math.max(0, canvasW - padL - padR), canvasH);
  ctx.clip();

  for (const run of runs) {
    if (glowMode) {
      drawGlowSegment(ctx, run, run.x, run.y, options);
    } else {
      drawSegment(ctx, run, run.x, run.y);
    }
  }

  ctx.restore();
}

function readGlowState(canvasEl) {
  const glow = canvasEl.querySelector("#text-glow-back");
  if (!glow || glow.classList.contains("hidden")) {
    return { enabled: false };
  }
  const cs = getComputedStyle(glow);
  const blur = parseFloat(cs.getPropertyValue("--glow-blur")) || 12;
  return {
    enabled: true,
    sharpness: blur,
    opacity: parseFloat(cs.opacity) || 0.6,
    color: cs.color || "#000",
    colorHex: canvasEl.dataset.glowColor || "#000000",
    radius: parseFloat(canvasEl.dataset.glowRadius || "24"),
    softness: parseFloat(canvasEl.dataset.glowSoftness || "50"),
  };
}

function evenDimension(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

function flushLayout(el) {
  void el.offsetHeight;
}

/** Match preview: top edge of #text-content inside the scroll container (px). */
function measureTextTopInContainer(textEl, container) {
  const cr = container.getBoundingClientRect();
  const tr = textEl.getBoundingClientRect();
  return tr.top - cr.top;
}

function scrollYAtTime(metrics, t) {
  if (t < metrics.startDelay) return metrics.startY;
  const scrollT = t - metrics.startDelay;
  return Math.max(metrics.endY, metrics.startY - scrollT * metrics.speed);
}

async function ensureExportLayout(engine) {
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  flushLayout(engine.textEl);
  engine.measure();
  if (engine.textHeight < 8) {
    await new Promise((r) => requestAnimationFrame(r));
    engine.measure();
  }
}

function canvasToJpegBlob(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not capture frame.")),
      "image/jpeg",
      quality
    );
  });
}

/**
 * Frame-by-frame export (Remotion-style): timeline state drives each captured frame.
 * @param {HTMLElement} canvasEl
 * @param {import('./preview.js').ScrollPreview} engine
 * @param {object} hooks
 * @param {'webm'|'mp4'} hooks.format
 * @param {(time: number) => void | Promise<void>} [hooks.onFrame]
 */
export async function exportRecording(canvasEl, engine, hooks = {}) {
  const {
    onProgress = () => {},
    onStatus = () => {},
    format = "webm",
    videoEl = null,
    bgAudioEl = null,
    videoVolume = 0,
    audioVolume = 100,
    mediaRepeat = "loop",
    exportVideoEl = null,
    onFrame = () => {},
  } = hooks;

  const rect = canvasEl.getBoundingClientRect();
  const w = evenDimension(rect.width);
  const h = evenDimension(rect.height);
  const MAX_EDGE = 1080;
  const longEdge = Math.max(w, h);
  const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
  const ew = evenDimension(w * scale);
  const eh = evenDimension(h * scale);

  const recordCanvas = document.createElement("canvas");
  recordCanvas.width = ew;
  recordCanvas.height = eh;
  const ctx = recordCanvas.getContext("2d");
  const drawScale = ew / w;
  const textContainer = canvasEl.querySelector("#text-scroll-container");

  async function captureFrame() {
    const bgImg = canvasEl.querySelector("#bg-image:not(.hidden)");
    const bgGif = canvasEl.querySelector("#bg-gif-canvas:not(.hidden)");
    const bgVideo =
      exportVideoEl ||
      canvasEl.querySelector("#bg-video:not(.hidden)");
    const placeholder = canvasEl.querySelector("#bg-placeholder:not(.hidden)");
    const overlay = canvasEl.querySelector("#overlay-layer");
    const textContent = canvasEl.querySelector("#text-content");
    const glowState = readGlowState(canvasEl);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#111118";
    ctx.fillRect(0, 0, ew, eh);
    ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);

    const drawMedia = (el, fit) => {
      if (!el) return;
      const mw = el.videoWidth || el.naturalWidth || el.width;
      const mh = el.videoHeight || el.naturalHeight || el.height;
      if (!mw || !mh) return;

      let dw = w;
      let dh = h;
      let dx = 0;
      let dy = 0;

      if (fit === "contain") {
        const s = Math.min(w / mw, h / mh);
        dw = mw * s;
        dh = mh * s;
        dx = (w - dw) / 2;
        dy = (h - dh) / 2;
      } else if (fit === "fill") {
        dw = w;
        dh = h;
      } else {
        const s = Math.max(w / mw, h / mh);
        dw = mw * s;
        dh = mh * s;
        dx = (w - dw) / 2;
        dy = (h - dh) / 2;
      }

      try {
        ctx.drawImage(el, dx, dy, dw, dh);
      } catch {
        /* cross-origin taint */
      }
    };

    const fit =
      bgImg?.dataset.fit || bgGif?.dataset.fit || bgVideo?.dataset.fit || "cover";

    if (bgVideo && (!bgVideo.classList || !bgVideo.classList.contains("hidden"))) {
      drawMedia(bgVideo, fit);
    } else if (bgGif && !bgGif.classList.contains("hidden")) {
      drawMedia(bgGif, fit);
    } else if (bgImg && !bgImg.classList.contains("hidden")) {
      drawMedia(bgImg, fit);
    } else if (placeholder) {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#1a1a2e");
      grad.addColorStop(0.5, "#16213e");
      grad.addColorStop(1, "#0f3460");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    const brightness = parseInt(overlay?.dataset.brightness ?? "100", 10);
    const bgBlur = parseFloat(overlay?.dataset.blur ?? "0");
    const darken = 1 - brightness / 100;
    if (darken > 0) {
      ctx.fillStyle = `rgba(0,0,0,${darken})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (textContent && textContainer) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();

      if (glowState.enabled) {
        ctx.save();
        ctx.filter = `blur(${glowState.sharpness}px)`;
        const glowScale = 1 + glowState.radius / 300;
        ctx.translate(w / 2, 0);
        ctx.scale(glowScale, 1);
        ctx.translate(-w / 2, 0);
        drawTextFromDomLayout(ctx, textContent, textContainer, w, h, {
          mode: "glow",
          glowColor: glowState.color,
          glowColorHex: glowState.colorHex,
          glowOpacity: glowState.opacity,
          glowRadius: glowState.radius,
          glowSoftness: glowState.softness,
        });
        ctx.restore();
      }

      drawTextFromDomLayout(ctx, textContent, textContainer, w, h);
      ctx.restore();
    }

    if (bgBlur > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const snap = ctx.getImageData(0, 0, ew, eh);
      ctx.filter = `blur(${bgBlur}px)`;
      ctx.putImageData(snap, 0, 0);
      ctx.filter = "none";
    }
  }

  await ensureExportLayout(engine);
  const totalDuration = engine.getTotalDuration();

  engine.applyTime(0);
  flushLayout(engine.textEl);
  const calibratedStartY = measureTextTopInContainer(
    engine.textEl,
    textContainer
  );
  engine.applyTime(totalDuration);
  flushLayout(engine.textEl);
  const calibratedEndY = measureTextTopInContainer(
    engine.textEl,
    textContainer
  );

  const scrollMetrics = {
    startDelay: engine.startDelay,
    speed: engine.speed,
    startY: Number.isFinite(calibratedStartY) ? calibratedStartY : engine.startY,
    endY: Number.isFinite(calibratedEndY) ? calibratedEndY : engine.endY,
  };
  engine.startY = scrollMetrics.startY;
  engine.endY = scrollMetrics.endY;

  const frameCount = Math.max(1, Math.ceil(totalDuration * FPS));

  return encodeFrameSequence({
    fps: FPS,
    frameCount,
    totalDuration,
    format,
    renderFrame: async (frameIndex, t) => {
      engine.applyTime(t);
      flushLayout(engine.textEl);

      await onFrame(t);

      flushLayout(engine.textEl);
      await captureFrame();
      return canvasToJpegBlob(recordCanvas);
    },
    audio: {
      videoSrc: videoEl?.src || null,
      bgAudioSrc: bgAudioEl?.src || null,
      videoVolume,
      audioVolume,
      mediaRepeat,
    },
    onProgress,
    onStatus,
  });
}

/** @deprecated Use exportRecording */
export async function exportToWebM(canvasEl, engine, hooks) {
  return exportRecording(canvasEl, engine, { ...hooks, format: "webm" });
}

export function downloadBlob(blob, filename = "scrolldrop-export.webm") {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
