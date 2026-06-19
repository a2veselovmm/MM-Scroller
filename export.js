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
import { evenDimension, getExportCanvasSize, EXPORT_FPS } from "./canvasDesign.js";
import { encodeFrameSequence } from "./frameEncoder.js";
import { buildGlowShadowStack } from "./textEffects.js";

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
function drawTextFromDomLayout(ctx, textContent, originRect, canvasW, canvasH, options = {}) {
  const rootStyle = getComputedStyle(textContent);
  const padL = parseFloat(rootStyle.paddingLeft) || 0;
  const padR = parseFloat(rootStyle.paddingRight) || 0;
  const boxes = collectCharBoxes(textContent, originRect);
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

  const fit = bgImg?.dataset.fit || "cover";
  if (bgImg && !bgImg.classList.contains("hidden")) {
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

/** Bake background + vignette + overlay + blur at export resolution (ew×eh). */
function buildBackgroundCache(canvasEl, ew, eh, drawScale) {
  const cache = document.createElement("canvas");
  cache.width = ew;
  cache.height = eh;
  const sctx = cache.getContext("2d");
  drawBackgroundLayer(sctx, canvasEl, ew, eh);

  const bgEffects = readBgEffectsFromCanvas(canvasEl);
  drawVignette(sctx, ew, eh, bgEffects);
  drawColorOverlay(sctx, ew, eh, bgEffects);

  const overlay = canvasEl.querySelector("#overlay-layer");
  const bgBlur = parseFloat(overlay?.dataset.blur ?? "0");
  if (bgBlur > 0) {
    const snap = sctx.getImageData(0, 0, ew, eh);
    sctx.filter = `blur(${bgBlur * drawScale}px)`;
    sctx.putImageData(snap, 0, 0);
    sctx.filter = "none";
  }

  return cache;
}

function buildTextLayerCaches(textContent, w, glowState) {
  const savedTransform = textContent.style.transform;
  textContent.style.transform = "translateY(0px)";
  flushLayout(textContent);

  const originRect = textContent.getBoundingClientRect();
  const layerH = Math.max(1, Math.ceil(textContent.offsetHeight));
  const glowOpts = glowState.enabled
    ? {
        mode: "glow",
        glowColor: glowState.color,
        glowColorHex: glowState.colorHex,
        glowOpacity: glowState.opacity,
        glowRadius: glowState.radius,
        glowSoftness: glowState.softness,
      }
    : null;

  const textCanvas = document.createElement("canvas");
  textCanvas.width = w;
  textCanvas.height = layerH;
  drawTextFromDomLayout(
    textCanvas.getContext("2d"),
    textContent,
    originRect,
    w,
    layerH
  );

  let glowCanvas = null;
  if (glowOpts) {
    glowCanvas = document.createElement("canvas");
    glowCanvas.width = w;
    glowCanvas.height = layerH;
    const gctx = glowCanvas.getContext("2d");
    gctx.save();
    const glowScale = 1 + glowState.radius / 300;
    gctx.translate(w / 2, 0);
    gctx.scale(glowScale, 1);
    gctx.translate(-w / 2, 0);
    drawTextFromDomLayout(gctx, textContent, originRect, w, layerH, glowOpts);
    gctx.restore();
  }

  textContent.style.transform = savedTransform;
  return { textCanvas, glowCanvas, glowState };
}

function compositeFrame(
  ctx,
  ty,
  { bgCache, textCanvas, glowCanvas, glowState, w, h, ew, eh, drawScale, designHeight }
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCache, 0, 0);
  ctx.setTransform(drawScale, 0, 0, drawScale, 0, 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  const designH = designHeight || h;
  const tyLayout = ty * (h / designH);

  if (glowCanvas && glowState?.enabled) {
    ctx.save();
    ctx.filter = `blur(${glowState.sharpness * drawScale}px)`;
    ctx.drawImage(glowCanvas, 0, tyLayout);
    ctx.restore();
  }

  if (textCanvas) {
    ctx.drawImage(textCanvas, 0, tyLayout);
  }

  ctx.restore();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  const rect = canvasEl.getBoundingClientRect();
  const w = evenDimension(rect.width);
  const h = evenDimension(rect.height);
  const { width: ew, height: eh } = getExportCanvasSize(aspectRatio);

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
  const bgCache = buildBackgroundCache(canvasEl, ew, eh, drawScale);

  onStatus("Caching text…");
  const glowState = readGlowState(canvasEl);
  const textLayers = textContent
    ? buildTextLayerCaches(textContent, w, glowState)
    : { textCanvas: null, glowCanvas: null, glowState };

  const layerBundle = {
    bgCache,
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
