/**
 * Export preview to WebM via MediaRecorder + canvas captureStream.
 */

import {
  hexToRgba,
  buildGlowShadowStack,
} from "./textEffects.js";

const FPS = 30;

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

function collectLineSegments(lineEl, rootStyle) {
  const segments = [];

  function walk(node, spanEl) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text) segments.push({ text, ...segmentStyle(rootStyle, spanEl) });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const nextSpan =
      node.tagName === "SPAN" &&
      (node.classList.contains("text-run") ||
        node.classList.contains("text-span"))
        ? node
        : spanEl;
    for (const child of node.childNodes) walk(child, nextSpan);
  }

  for (const child of lineEl.childNodes) walk(child, null);
  return segments;
}

function measureSegments(ctx, segments) {
  let w = 0;
  for (const seg of segments) {
    ctx.save();
    ctx.font = seg.font;
    w += ctx.measureText(seg.text).width;
    ctx.restore();
  }
  return w;
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

function drawRichText(ctx, textContent, canvasW, ty, options = {}) {
  const rootStyle = getComputedStyle(textContent);
  const pad = parseInt(rootStyle.paddingLeft, 10) || 0;
  const align = rootStyle.textAlign;
  const lineHeightPx =
    parseFloat(rootStyle.fontSize) * parseFloat(rootStyle.lineHeight);
  const glowMode = options.mode === "glow";
  const glowColor = options.glowColor || "#000";

  const lines = textContent.querySelectorAll(".text-line");
  let y = ty;

  for (const lineEl of lines) {
    const segments = collectLineSegments(lineEl, rootStyle);
    if (!segments.length) {
      y += lineHeightPx;
      continue;
    }

    const lineWidth = measureSegments(ctx, segments);
    let x = pad;
    if (align === "center") x = (canvasW - lineWidth) / 2;
    else if (align === "right") x = canvasW - pad - lineWidth;

    let lineAdvance = lineHeightPx;
    for (const seg of segments) {
      if (glowMode) {
        ctx.save();
        ctx.font = seg.font;
        ctx.globalAlpha = options.glowOpacity ?? 0.6;
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.fillStyle = glowColor;
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
      } else {
        drawSegment(ctx, seg, x, y);
      }
      ctx.save();
      ctx.font = seg.font;
      x += ctx.measureText(seg.text).width;
      lineAdvance = Math.max(
        lineAdvance,
        seg.fontSize * parseFloat(rootStyle.lineHeight)
      );
      ctx.restore();
    }
    y += lineAdvance;
  }
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

function pickMimeType() {
  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export async function exportToWebM(canvasEl, runAnimation, hooks = {}) {
  const { onProgress = () => {}, onStatus = () => {} } = hooks;

  if (!window.MediaRecorder) {
    throw new Error("MediaRecorder is not supported in this browser.");
  }

  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error("No supported WebM codec found for recording.");
  }

  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(2, Math.round(rect.width));
  const h = Math.max(2, Math.round(rect.height));

  const recordCanvas = document.createElement("canvas");
  recordCanvas.width = w;
  recordCanvas.height = h;
  const ctx = recordCanvas.getContext("2d");

  const stream = recordCanvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const blobPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
    };
    recorder.onerror = () => reject(new Error("Recording failed"));
  });

  async function captureFrame() {
    const bgImg = canvasEl.querySelector("#bg-image:not(.hidden)");
    const bgVideo = canvasEl.querySelector("#bg-video:not(.hidden)");
    const placeholder = canvasEl.querySelector("#bg-placeholder:not(.hidden)");
    const overlay = canvasEl.querySelector("#overlay-layer");
    const textContent = canvasEl.querySelector("#text-content");
    const glowState = readGlowState(canvasEl);

    ctx.fillStyle = "#111118";
    ctx.fillRect(0, 0, w, h);

    const drawMedia = (el, fit) => {
      if (!el) return;
      const mw = el.videoWidth || el.naturalWidth;
      const mh = el.videoHeight || el.naturalHeight;
      if (!mw || !mh) return;

      let dw = w;
      let dh = h;
      let dx = 0;
      let dy = 0;

      if (fit === "contain") {
        const scale = Math.min(w / mw, h / mh);
        dw = mw * scale;
        dh = mh * scale;
        dx = (w - dw) / 2;
        dy = (h - dh) / 2;
      } else if (fit === "fill") {
        dw = w;
        dh = h;
      } else {
        const scale = Math.max(w / mw, h / mh);
        dw = mw * scale;
        dh = mh * scale;
        dx = (w - dw) / 2;
        dy = (h - dh) / 2;
      }

      try {
        ctx.drawImage(el, dx, dy, dw, dh);
      } catch {
        /* cross-origin taint */
      }
    };

    const fit = bgImg?.dataset.fit || bgVideo?.dataset.fit || "cover";

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

    const brightness = parseInt(overlay?.dataset.brightness ?? "100", 10);
    const bgBlur = parseFloat(overlay?.dataset.blur ?? "0");
    const darken = 1 - brightness / 100;
    if (darken > 0) {
      ctx.fillStyle = `rgba(0,0,0,${darken})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (textContent) {
      const transform = textContent.style.transform;
      const match = transform.match(/translateY\((-?[\d.]+)px\)/);
      const ty = match ? parseFloat(match[1]) : h;

      if (glowState.enabled) {
        ctx.save();
        ctx.filter = `blur(${glowState.sharpness}px)`;
        const scale = 1 + glowState.radius / 300;
        ctx.translate(w / 2, 0);
        ctx.scale(scale, 1);
        ctx.translate(-w / 2, 0);
        drawRichText(ctx, textContent, w, ty, {
          mode: "glow",
          glowColor: glowState.color,
          glowColorHex: glowState.colorHex,
          glowOpacity: glowState.opacity,
          glowRadius: glowState.radius,
          glowSoftness: glowState.softness,
        });
        ctx.restore();
      }

      ctx.save();
      drawRichText(ctx, textContent, w, ty);
      ctx.restore();
    }

    if (bgBlur > 0) {
      const snap = ctx.getImageData(0, 0, w, h);
      ctx.filter = `blur(${bgBlur}px)`;
      ctx.putImageData(snap, 0, 0);
      ctx.filter = "none";
    }
  }

  onStatus("Recording…");
  recorder.start(100);

  let recording = true;
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress = Math.min(95, progress + 2);
    onProgress(progress);
  }, 200);

  const captureLoop = async () => {
    while (recording) {
      await captureFrame();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  captureLoop();

  await runAnimation();

  recording = false;
  clearInterval(progressInterval);
  onProgress(100);
  onStatus("Finalizing…");

  await new Promise((r) => setTimeout(r, 300));
  recorder.stop();

  return blobPromise;
}

export function downloadBlob(blob, filename = "scrolldrop-export.webm") {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
