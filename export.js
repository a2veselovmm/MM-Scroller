/**
 * Export via offline frame render + ffmpeg (Remotion-style fixed-FPS encode).
 * @see https://www.remotion.dev/docs/ai/skills
 */

import {
  drawColorOverlay,
  drawVignette,
  readBgEffectsFromCanvas,
} from "./backgroundEffects.js";
import { drawImageFit } from "./backgroundImage.js";
import { mapBackgroundTime } from "./backgroundMedia.js";
import { evenDimension, getDesignCanvasSize, getExportCanvasSize, EXPORT_FPS } from "./canvasDesign.js";
import { encodeFrameSequence } from "./frameEncoder.js";
import { runAtDesignScale } from "./previewLayout.js";

export { EXPORT_FPS };
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

function segmentVerticalPadding(seg) {
  const strokePad = Math.max(0, (Number(seg.strokeWidth) || 0) / 2);
  if (!seg.shadow) return { top: strokePad, bottom: strokePad };
  const blur = Math.max(0, Number(seg.shadow.blur) || 0);
  const oy = Number(seg.shadow.oy) || 0;
  return {
    top: Math.max(strokePad, blur - oy + strokePad),
    bottom: Math.max(strokePad, blur + oy + strokePad),
  };
}

function measureRunPadding(layout) {
  let top = 0;
  let bottom = 0;
  const rootSeg = segmentStyle(layout.rootStyle, null);
  const rootPad = segmentVerticalPadding(rootSeg);
  top = Math.max(top, rootPad.top);
  bottom = Math.max(bottom, rootPad.bottom);
  for (const run of layout.runs) {
    const pad = segmentVerticalPadding(run);
    top = Math.max(top, pad.top);
    bottom = Math.max(bottom, pad.bottom);
  }
  return {
    top: top > 0 ? Math.ceil(top + 2) : 0,
    bottom: bottom > 0 ? Math.ceil(bottom + 2) : 0,
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

function collectCharBoxes(textRoot, originRect) {
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
        x: r.left - originRect.left,
        y: r.top - originRect.top,
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

function collectTextLayout(textContent, originRect) {
  const rootStyle = getComputedStyle(textContent);
  const boxes = collectCharBoxes(textContent, originRect);
  const runs = mergeCharBoxes(boxes, rootStyle);
  const padL = parseFloat(rootStyle.paddingLeft) || 0;
  const padR = parseFloat(rootStyle.paddingRight) || 0;
  return { rootStyle, padL, padR, runs };
}

function drawTextFromDomLayout(ctx, layout, canvasW, canvasH, yOffset = 0) {
  const { padL, padR, runs } = layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, 0, Math.max(0, canvasW - padL - padR), canvasH);
  ctx.clip();

  for (const run of runs) {
    drawSegment(ctx, run, run.x, run.y + yOffset);
  }

  ctx.restore();
}

function flushLayout(el) {
  void el.offsetHeight;
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

function canvasToJpegBlob(canvas, quality = 0.78) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not capture frame.")),
      "image/jpeg",
      quality
    );
  });
}

function drawBackgroundLayer(ctx, canvasEl, w, h) {
  const bgImg = canvasEl.querySelector("#bg-image:not(.hidden)");
  const bgVideo = canvasEl.querySelector("#bg-video:not(.hidden)");
  const placeholder = canvasEl.querySelector("#bg-placeholder:not(.hidden)");

  ctx.fillStyle = "#111118";
  ctx.fillRect(0, 0, w, h);

  const drawMedia = (el, fit) => {
    if (!el) return;
    try {
      drawImageFit(ctx, el, w, h, fit);
    } catch {
      /* cross-origin taint */
    }
  };

  const fit = bgVideo?.dataset.fit || bgImg?.dataset.fit || "cover";
  if (bgVideo && !bgVideo.classList.contains("hidden")) {
    drawMedia(bgVideo, fit);
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

}

function drawBackgroundEffects(ctx, canvasEl, ew, eh) {
  const bgEffects = readBgEffectsFromCanvas(canvasEl);
  drawVignette(ctx, ew, eh, bgEffects);
  drawColorOverlay(ctx, ew, eh, bgEffects);
}

function drawOverlayLayer(ctx, canvasEl, w, h) {
  const overlayImg = canvasEl.querySelector("#overlay-image:not(.hidden)");
  const overlayVideo = canvasEl.querySelector("#overlay-video:not(.hidden)");
  const fit = overlayVideo?.dataset.fit || overlayImg?.dataset.fit || "cover";
  const source = overlayVideo && !overlayVideo.classList.contains("hidden")
    ? overlayVideo
    : overlayImg && !overlayImg.classList.contains("hidden")
      ? overlayImg
      : null;
  if (!source) return;
  try {
    drawImageFit(ctx, source, w, h, fit);
  } catch {
    /* cross-origin taint */
  }
}

/** Bake background + vignette + overlay at export resolution (ew×eh). */
function buildBackgroundCache(canvasEl, ew, eh) {
  const cache = document.createElement("canvas");
  cache.width = ew;
  cache.height = eh;
  const sctx = cache.getContext("2d");
  drawBackgroundLayer(sctx, canvasEl, ew, eh);
  drawBackgroundEffects(sctx, canvasEl, ew, eh);

  return cache;
}

/** Bake vignette + color overlay only (for dynamic video backgrounds). */
function buildBackgroundEffectsCache(canvasEl, ew, eh) {
  const cache = document.createElement("canvas");
  cache.width = ew;
  cache.height = eh;
  const sctx = cache.getContext("2d");
  drawBackgroundEffects(sctx, canvasEl, ew, eh);
  return cache;
}

function buildOverlayCache(canvasEl, ew, eh) {
  const cache = document.createElement("canvas");
  cache.width = ew;
  cache.height = eh;
  const sctx = cache.getContext("2d");
  drawOverlayLayer(sctx, canvasEl, ew, eh);
  return cache;
}

function buildTextLayerCaches(textContent, w) {
  const savedTransform = textContent.style.transform;
  textContent.style.transform = "translateY(0px)";
  flushLayout(textContent);

  const originRect = textContent.getBoundingClientRect();
  const layout = collectTextLayout(textContent, originRect);
  const shadowPad = measureRunPadding(layout);
  const layerH = Math.max(1, Math.ceil(textContent.offsetHeight));

  const textCanvas = document.createElement("canvas");
  textCanvas.width = w;
  textCanvas.height = layerH + shadowPad.top + shadowPad.bottom;
  drawTextFromDomLayout(
    textCanvas.getContext("2d"),
    layout,
    w,
    textCanvas.height,
    shadowPad.top
  );

  textContent.style.transform = savedTransform;
  return { textCanvas, textOffsetY: shadowPad.top };
}

function compositeFrame(
  ctx,
  ty,
  {
    bgCache,
    bgEffectsCache,
    overlayCache,
    hasDynamicBackground = false,
    hasDynamicOverlay = false,
    canvasEl,
    textCanvas,
    textOffsetY = 0,
    w,
    h,
    ew,
    eh,
    drawScale,
    designHeight,
  }
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (hasDynamicBackground && canvasEl) {
    drawBackgroundLayer(ctx, canvasEl, ew, eh);
    if (bgEffectsCache) ctx.drawImage(bgEffectsCache, 0, 0);
  } else if (bgCache) {
    ctx.drawImage(bgCache, 0, 0);
  }
  ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  const designH = designHeight || h;
  const tyLayout = ty * (h / designH);

  if (textCanvas) {
    ctx.drawImage(textCanvas, 0, tyLayout - textOffsetY);
  }

  ctx.restore();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (hasDynamicOverlay && canvasEl) {
    drawOverlayLayer(ctx, canvasEl, ew, eh);
  } else if (overlayCache) {
    ctx.drawImage(overlayCache, 0, 0);
  }
}

async function seekVideoForFrame(videoEl, targetSec) {
  if (!videoEl || !Number.isFinite(targetSec)) return;
  if (Math.abs((videoEl.currentTime || 0) - targetSec) < 0.04) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 120);
    videoEl.addEventListener("seeked", finish, { once: true });
    try {
      videoEl.currentTime = targetSec;
    } catch {
      finish();
    }
  });
}

/**
 * Frame-by-frame export (Remotion-style): timeline state drives each captured frame.
 * @param {HTMLElement} canvasEl
 * @param {import('./preview.js').ScrollPreview} engine
 * @param {object} hooks
 * @param {(time: number) => void | Promise<void>} [hooks.onFrame]
 */
export async function exportRecording(canvasEl, engine, hooks = {}) {
  const {
    bgVideoEl = null,
    bgVideoMode = "loop",
    bgVideoDuration = 0,
    overlayVideoEl = null,
    overlayVideoDuration = 0,
    onProgress = () => {},
    onStatus = () => {},
    musicEl = null,
    voiceEl = null,
    musicVolume = 100,
    musicLoop = true,
    voiceVolume = 100,
    onFrame = () => {},
  } = hooks;

  const aspectRatio = canvasEl.dataset.aspect || "9/16";
  const { width: designWidth, height: designHeight } =
    getDesignCanvasSize(aspectRatio);
  const { width: ew, height: eh } = getExportCanvasSize(aspectRatio);
  const w = evenDimension(designWidth);
  const h = evenDimension(designHeight);
  const stageEl = canvasEl.querySelector("#preview-stage") || canvasEl;

  const recordCanvas = document.createElement("canvas");
  recordCanvas.width = ew;
  recordCanvas.height = eh;
  const ctx = recordCanvas.getContext("2d");
  const drawScale = ew / w;
  const textContent = canvasEl.querySelector("#text-content");

  await ensureExportLayout(engine);
  const totalDuration = engine.getTotalDuration();
  engine.measure();

  onStatus("Caching background…");
  const hasDynamicBackground =
    !!bgVideoEl && !!bgVideoEl.src && !bgVideoEl.classList.contains("hidden");
  const bgCache = hasDynamicBackground
    ? null
    : runAtDesignScale(stageEl, () => buildBackgroundCache(canvasEl, ew, eh));
  const bgEffectsCache = hasDynamicBackground
    ? runAtDesignScale(stageEl, () => buildBackgroundEffectsCache(canvasEl, ew, eh))
    : null;
  const hasDynamicOverlay =
    !!overlayVideoEl && !!overlayVideoEl.src && !overlayVideoEl.classList.contains("hidden");
  const overlayCache = hasDynamicOverlay
    ? null
    : runAtDesignScale(stageEl, () => buildOverlayCache(canvasEl, ew, eh));

  onStatus("Caching text…");
  const textLayers = textContent
    ? runAtDesignScale(stageEl, () => buildTextLayerCaches(textContent, w))
    : { textCanvas: null };

  const layerBundle = {
    bgCache,
    bgEffectsCache,
    overlayCache,
    hasDynamicBackground,
    hasDynamicOverlay,
    canvasEl,
    ...textLayers,
    w,
    h,
    ew,
    eh,
    drawScale,
    designHeight: engine.designHeight || h,
  };
  const frameCount = Math.max(1, Math.ceil(totalDuration * FPS));

  return encodeFrameSequence({
    fps: FPS,
    frameCount,
    totalDuration,
    renderFrame: async (_frameIndex, t) => {
      engine.applyTime(t);
      await onFrame(t);
      if (hasDynamicBackground && bgVideoEl) {
        const dur = Number(bgVideoDuration || bgVideoEl.duration || 0);
        if (dur > 0) {
          const mapped = mapBackgroundTime(t, dur, bgVideoMode);
          await seekVideoForFrame(bgVideoEl, mapped);
        }
      }
      if (hasDynamicOverlay && overlayVideoEl) {
        const dur = Number(overlayVideoDuration || overlayVideoEl.duration || 0);
        if (dur > 0) {
          const mapped = mapBackgroundTime(t, dur, "loop");
          await seekVideoForFrame(overlayVideoEl, mapped);
        }
      }
      compositeFrame(ctx, engine.y, layerBundle);
      return canvasToJpegBlob(recordCanvas);
    },
    audio: {
      musicSrc: musicEl?.src || null,
      voiceSrc: voiceEl?.src || null,
      musicVolume,
      musicLoop,
      voiceVolume,
    },
    onProgress,
    onStatus,
  });
}

export function downloadBlob(blob, filename = "scrolldrop-export.mp4") {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
