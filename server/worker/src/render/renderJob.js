import { createCanvas, loadImage } from "canvas";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getDesignCanvasSize, getExportCanvasSize, EXPORT_FPS } from "../../shared/canvasDesign.js";
import { segmentTimeRange } from "../../shared/renderPlan.js";
import { ensureFontsForProject, resolveFontFamily } from "../fonts/localFonts.js";
import { drawColorOverlay, drawVignette, readBgEffects } from "./backgroundEffects.js";
import {
  createBoomerangVideo,
  concatSegmentsAndMuxAudio,
  encodeScrollSegment,
  encodeScrollVideo,
  prepareBackgroundVideo,
  probeVideoDurationSec,
  writeJpeg,
  writePng,
  writeRawRgba,
} from "./ffmpegScrollEncode.js";
import { ScrollEngine } from "./scrollEngine.js";
import {
  drawStyledLines,
  measureStyledDocument,
  measureWrappedLinePadding,
  preloadEmojiImagesForWrappedLines,
} from "./styledHtmlRender.js";
import { hexToRgba, normalizeOpacity } from "./renderUtils.js";

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

const TWEMOJI_BASE_URL = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72";
const emojiSegmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : null;
const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|\u20E3)/u;

function splitGraphemes(text) {
  const str = String(text || "");
  if (!str) return [];
  if (emojiSegmenter) {
    return Array.from(emojiSegmenter.segment(str), (part) => part.segment);
  }
  return Array.from(str);
}

function isEmojiGrapheme(grapheme) {
  if (!grapheme) return false;
  return EMOJI_GRAPHEME_RE.test(grapheme);
}

function splitEmojiTokens(text) {
  const tokens = [];
  let pending = "";
  for (const grapheme of splitGraphemes(text)) {
    if (isEmojiGrapheme(grapheme)) {
      if (pending) {
        tokens.push({ type: "text", value: pending });
        pending = "";
      }
      tokens.push({ type: "emoji", value: grapheme });
      continue;
    }
    pending += grapheme;
  }
  if (pending) tokens.push({ type: "text", value: pending });
  return tokens;
}

function emojiToCodepoint(emoji) {
  const out = [];
  for (const symbol of splitGraphemes(emoji)) {
    const cp = symbol.codePointAt(0);
    if (!Number.isFinite(cp) || cp === 0xfe0f) continue;
    out.push(cp.toString(16));
  }
  return out.join("-");
}

function emojiImageUrl(emoji) {
  const codepoint = emojiToCodepoint(emoji);
  if (!codepoint) return null;
  return `${TWEMOJI_BASE_URL}/${codepoint}.png`;
}

function emojiAdvancePx(fontSizePx) {
  return Math.max(1, Math.round(fontSizePx));
}

function measureMixedTextWidth(ctx, text, emojiSizePx) {
  let width = 0;
  for (const token of splitEmojiTokens(text)) {
    if (token.type === "emoji") width += emojiAdvancePx(emojiSizePx);
    else if (token.value) width += ctx.measureText(token.value).width;
  }
  return width;
}

async function loadEmojiImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Emoji fetch failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return loadImage(bytes);
}

async function preloadEmojiImages(lines, cache = new Map()) {
  const needed = new Set();
  for (const line of lines) {
    for (const token of splitEmojiTokens(line)) {
      if (token.type === "emoji" && !cache.has(token.value)) {
        needed.add(token.value);
      }
    }
  }
  await Promise.all(
    [...needed].map(async (emoji) => {
      const url = emojiImageUrl(emoji);
      if (!url) {
        cache.set(emoji, null);
        return;
      }
      try {
        const image = await loadEmojiImage(url);
        cache.set(emoji, image);
      } catch {
        cache.set(emoji, null);
      }
    })
  );
  return cache;
}

function drawMixedTextRun(ctx, text, x, y, emojiSizePx, emojiCache = null) {
  let cursorX = x;
  for (const token of splitEmojiTokens(text)) {
    if (token.type === "emoji") {
      const size = emojiAdvancePx(emojiSizePx);
      const image = emojiCache?.get(token.value) ?? null;
      if (image) {
        ctx.drawImage(image, cursorX, y, size, size);
      } else {
        ctx.fillText(token.value, cursorX, y);
      }
      cursorX += size;
    } else if (token.value) {
      ctx.fillText(token.value, cursorX, y);
      cursorX += ctx.measureText(token.value).width;
    }
  }
}

function wrapLines(text, maxWidth, measureWidth) {
  const paragraphs = text.split("\n");
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = `${line} ${words[i]}`;
      if (measureWidth(test) <= maxWidth) line = test;
      else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

function measureTextBlock(text, maxWidth, lineHeightPx, measureWidth) {
  const lines = wrapLines(text, maxWidth, measureWidth);
  return { lines, height: lines.length * lineHeightPx };
}

function drawImageCover(ctx, img, w, h) {
  const ir = img.width / img.height;
  const cr = w / h;
  let dw;
  let dh;
  let dx;
  let dy;
  if (ir > cr) {
    dh = h;
    dw = h * ir;
    dx = (w - dw) / 2;
    dy = 0;
  } else {
    dw = w;
    dh = w / ir;
    dx = 0;
    dy = (h - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
}

function resolvePlainText(text) {
  if (text.editMode === "plain") {
    return text.plainText || stripHtml(text.styledHtml);
  }
  if (text.styledHtml && String(text.styledHtml).trim()) {
    return null;
  }
  return text.plainText || stripHtml(text.styledHtml);
}

function isVideoMediaPath(filePath) {
  if (!filePath) return false;
  const ext = path.extname(String(filePath)).toLowerCase();
  return ext === ".mp4" || ext === ".mov";
}

function backgroundVideoMode(settings = {}, media = {}) {
  if (settings.backgroundVideoMode === "boomerang") return "boomerang";
  if (settings.bgVideoMode === "boomerang") return "boomerang";
  if (media?.background?.playbackMode === "boomerang") return "boomerang";
  return "loop";
}

async function buildTextStrip({ text, settings, ew, drawScale, paddingH, align }) {
  const useStyled = text.editMode !== "plain" && text.styledHtml && String(text.styledHtml).trim();
  if (useStyled) {
    const { wrapped, height } = measureStyledDocument(
      text.styledHtml,
      settings,
      ew,
      drawScale,
      paddingH,
      align
    );
    const pad = measureWrappedLinePadding(wrapped, drawScale);
    const textCanvas = createCanvas(ew, Math.max(1, Math.ceil(height + pad.top + pad.bottom)));
    const tctx = textCanvas.getContext("2d");
    const emojiCache = await preloadEmojiImagesForWrappedLines(wrapped, new Map());
    drawStyledLines(tctx, wrapped, {
      ew,
      paddingH,
      drawScale,
      align,
      offsetY: pad.top,
      emojiCache,
    });
    return { textCanvas, textHeight: height, textOffsetY: pad.top };
  }

  const plain = resolvePlainText(text);
  const fontFamily = resolveFontFamily(settings.fontFamily);
  const fontSize = Number(settings.fontSize ?? 48);
  const lineHeight = Number(settings.lineHeight ?? 1.35);
  const fontOpacity = normalizeOpacity(settings.fontOpacity, 1);
  const fontWeight = settings.bold ? "700" : "400";
  const fontStyle = settings.italic ? "italic" : "normal";
  const strokeWidth = settings.strokeEnabled ? Math.max(0, Number(settings.strokeWidth) || 0) : 0;
  const strokeColor = settings.strokeColor || "#000000";
  const strokeOpacity = normalizeOpacity(settings.strokeOpacity, 1);
  const shadowEnabled = !!settings.shadowEnabled;
  const shadowBlur = shadowEnabled ? Math.max(0, Number(settings.shadowSoftness) || 0) : 0;
  const shadowColor = settings.shadowColor || "#000000";
  const shadowOpacity = normalizeOpacity(settings.shadowOpacity, 0.85);
  const shadowOffsetX = 0;
  const shadowOffsetY = 2;

  const measureCanvas = createCanvas(ew, 10);
  const mctx = measureCanvas.getContext("2d");
  mctx.font = `${fontStyle} ${fontWeight} ${fontSize * drawScale}px ${fontFamily}`;
  const maxTextWidth = ew - paddingH * 2 * drawScale;
  const lineHeightPx = fontSize * lineHeight * drawScale;
  const emojiSizePx = fontSize * drawScale;
  const measureLineWidth = (value) => measureMixedTextWidth(mctx, value, emojiSizePx);
  const { lines, height: textHeight } = measureTextBlock(
    plain,
    maxTextWidth,
    lineHeightPx,
    measureLineWidth
  );

  const scaledStroke = strokeWidth * drawScale;
  const strokePad = Math.max(0, scaledStroke / 2);
  const scaledBlur = shadowBlur * drawScale;
  const scaledOffsetY = shadowOffsetY * drawScale;
  const padTop = shadowEnabled
    ? Math.max(strokePad, scaledBlur - scaledOffsetY + strokePad)
    : strokePad;
  const padBottom = shadowEnabled
    ? Math.max(strokePad, scaledBlur + scaledOffsetY + strokePad)
    : strokePad;
  const textOffsetY = padTop > 0 ? Math.ceil(padTop + 2) : 0;
  const padBottomPx = padBottom > 0 ? Math.ceil(padBottom + 2) : 0;

  const textCanvas = createCanvas(ew, Math.ceil(textHeight) + 20 + textOffsetY + padBottomPx);
  const tctx = textCanvas.getContext("2d");
  tctx.font = mctx.font;
  tctx.textBaseline = "top";
  const emojiCache = await preloadEmojiImages(lines, new Map());

  let y = textOffsetY;
  for (const line of lines) {
    const lineWidth = measureLineWidth(line);
    let x = paddingH * drawScale;
    if (align === "center") {
      tctx.textAlign = "left";
      x = Math.max(paddingH * drawScale, (ew - lineWidth) / 2);
    } else if (align === "right") {
      tctx.textAlign = "left";
      x = Math.max(paddingH * drawScale, ew - paddingH * drawScale - lineWidth);
    } else {
      tctx.textAlign = "left";
    }
    tctx.globalAlpha = fontOpacity;
    if (shadowEnabled) {
      tctx.shadowColor = hexToRgba(shadowColor, shadowOpacity);
      tctx.shadowBlur = scaledBlur;
      tctx.shadowOffsetX = shadowOffsetX * drawScale;
      tctx.shadowOffsetY = scaledOffsetY;
    } else {
      tctx.shadowColor = "rgba(0,0,0,0)";
      tctx.shadowBlur = 0;
      tctx.shadowOffsetX = 0;
      tctx.shadowOffsetY = 0;
    }
    if (scaledStroke > 0) {
      tctx.lineWidth = scaledStroke;
      tctx.strokeStyle = hexToRgba(strokeColor, strokeOpacity);
      tctx.lineJoin = "round";
      for (const token of splitEmojiTokens(line)) {
        if (token.type === "text" && token.value) {
          tctx.strokeText(token.value, x, y);
          x += tctx.measureText(token.value).width;
        } else if (token.type === "emoji") {
          x += emojiAdvancePx(emojiSizePx);
        }
      }
      x = align === "left"
        ? paddingH * drawScale
        : align === "center"
          ? Math.max(paddingH * drawScale, (ew - lineWidth) / 2)
          : Math.max(paddingH * drawScale, ew - paddingH * drawScale - lineWidth);
    }
    tctx.fillStyle = settings.fontColor || "#ffffff";
    drawMixedTextRun(tctx, line, x, y, emojiSizePx, emojiCache);
    y += lineHeightPx;
  }

  return { textCanvas, textHeight: Math.ceil(textHeight) + 20, textOffsetY };
}

async function buildCanvasAssets({
  project,
  backgroundPath,
  preprocessedBackgroundPath,
  onProgress,
  checkCancelled,
}) {
  const settings = project.settings || {};
  const timeline = project.timeline || {};
  const text = project.text || {};
  const aspectRatio = settings.aspectRatio || "9/16";
  const { width: ew, height: eh } = getExportCanvasSize(aspectRatio);
  const { width: designWidth, height: designHeight } = getDesignCanvasSize(aspectRatio);
  const drawScale = ew / designWidth;
  const yScale = eh / designHeight;
  const paddingH = Number(settings.paddingH ?? 48);
  const align = settings.textAlign || "center";

  onProgress(5, "Preparing fonts…");
  await checkCancelled();
  const fontsStart = Date.now();
  await ensureFontsForProject(text, settings);
  const fontsMs = Date.now() - fontsStart;

  onProgress(15, "Rendering text layer…");
  await checkCancelled();
  const canvasStart = Date.now();
  const { textCanvas, textHeight, textOffsetY } = await buildTextStrip({
    text,
    settings,
    ew,
    drawScale,
    paddingH,
    align,
  });

  const engine = new ScrollEngine(settings, timeline, textHeight / yScale);
  engine.measure(designHeight);

  onProgress(25, "Rendering background…");
  await checkCancelled();
  const bgEffects = readBgEffects(settings);
  const bgCache = createCanvas(ew, eh);
  const bctx = bgCache.getContext("2d");
  bctx.fillStyle = "#111118";
  bctx.fillRect(0, 0, ew, eh);

  const bgSource = preprocessedBackgroundPath || backgroundPath;
  if (bgSource) {
    try {
      const img = await loadImage(bgSource);
      drawImageCover(bctx, img, ew, eh);
    } catch {
      const grad = bctx.createLinearGradient(0, 0, ew, eh);
      grad.addColorStop(0, "#1a1a2e");
      grad.addColorStop(1, "#0f3460");
      bctx.fillStyle = grad;
      bctx.fillRect(0, 0, ew, eh);
    }
  }

  drawVignette(bctx, ew, eh, bgEffects);
  drawColorOverlay(bctx, ew, eh, bgEffects);

  const canvasMs = Date.now() - canvasStart;

  return {
    engine,
    yScale,
    bgCache,
    textCanvas,
    textOffsetY,
    ew,
    eh,
    timings: { fontsMs, canvasMs },
  };
}

/**
 * Build canvas layers and scroll params for staging / segmented render.
 * @param {object} opts
 */
export async function prepareRenderAssets({
  project,
  backgroundPath,
  preprocessedBackgroundPath,
  workDir,
  onProgress = () => {},
  checkCancelled = async () => {},
  renderPlan = null,
}) {
  await mkdir(workDir, { recursive: true });
  if (isVideoMediaPath(backgroundPath)) {
    throw new Error("Segmented render staging is not supported for video backgrounds.");
  }

  const built = await buildCanvasAssets({
    project,
    backgroundPath,
    preprocessedBackgroundPath,
    onProgress,
    checkCancelled,
  });
  const { engine, yScale, bgCache, textCanvas, textOffsetY } = built;
  const settings = project.settings || {};

  const totalDuration = engine.getTotalDuration();
  const scrollParams = {
    startY: engine.startY * yScale,
    endY: engine.endY * yScale,
    speedY: engine.speed * yScale,
    startDelay: engine.startDelay,
    totalDuration,
    fps: EXPORT_FPS,
    textOffsetY,
  };

  const bgImagePath = path.join(workDir, "bg.jpg");
  const textStripPath = path.join(workDir, "text.raw");
  await onProgress(22, "Writing background layer…");
  await checkCancelled();
  await writeJpeg(bgCache, bgImagePath);
  await onProgress(24, `Writing text strip (${textCanvas.height}px)…`);
  await checkCancelled();
  await writeRawRgba(textCanvas, textStripPath);

  return {
    stagingAssets: {
      bgImagePath,
      textStripPath,
      textStripWidth: textCanvas.width,
      textStripHeight: textCanvas.height,
      textOffsetY,
      scrollParams,
      renderPlan,
    },
    scrollParams,
    timings: built.timings,
  };
}

/**
 * Encode one segmented scroll chunk (video only).
 */
export async function encodeRenderSegment({
  stagedAssets,
  scrollParams,
  segmentIndex,
  segmentDurationSec,
  outputPath,
  onFfmpegSpawn,
  onEncodeProgress,
}) {
  const { startSec, durationSec } = segmentTimeRange(
    segmentIndex,
    scrollParams.totalDuration,
    segmentDurationSec
  );

  await encodeScrollSegment({
    bgImagePath: stagedAssets.bgImagePath,
    textStripPath: stagedAssets.textStripPath,
    textStripWidth: stagedAssets.textStripWidth,
    textStripHeight: stagedAssets.textStripHeight,
    textStripIsRaw: true,
    outputPath,
    fps: scrollParams.fps || EXPORT_FPS,
    segmentDuration: durationSec,
    timeOffsetSec: startSec,
    startDelay: scrollParams.startDelay,
    startY: scrollParams.startY,
    endY: scrollParams.endY,
    speedY: scrollParams.speedY,
    textOffsetY: scrollParams.textOffsetY || 0,
    onFfmpegSpawn,
    onEncodeProgress,
  });

  return { startSec, durationSec };
}

export { concatSegmentsAndMuxAudio };

/**
 * @param {object} opts
 */
export async function renderJob({
  project,
  backgroundPath,
  preprocessedBackgroundPath,
  overlayPath,
  musicPath,
  voicePath,
  outputPath,
  onProgress = () => {},
  checkCancelled = async () => {},
  onFfmpegSpawn,
  onEncodeProgress,
  stagedAssets = null,
  fps = EXPORT_FPS,
}) {
  const settings = project.settings || {};
  const workDir = path.dirname(outputPath);
  await mkdir(workDir, { recursive: true });

  async function reportProgress(progress, msg) {
    const result = onProgress(progress, msg);
    if (result && typeof result.then === "function") {
      await result;
    }
  }

  let bgImagePath;
  let textStripPath;
  let textStripWidth;
  let textStripHeight;
  let textStripIsRaw = false;
  let totalDuration;
  let startY;
  let endY;
  let speedY;
  let startDelay;
  let textOffsetY = 0;
  let backgroundIsVideo = false;
  let backgroundDurationSec = 0;
  let overlayInputPath = overlayPath || null;
  let overlayIsVideo = false;
  let overlayDurationSec = 0;
  let backgroundEffectsPath = null;
  let frameWidth = 0;
  let frameHeight = 0;
  const timings = { fontsMs: 0, canvasMs: 0, ffmpegMs: 0 };

  if (stagedAssets) {
    await reportProgress(20, "Using cached render layers…");
    bgImagePath = stagedAssets.bgImagePath;
    textStripPath = stagedAssets.textStripPath;
    textStripWidth = stagedAssets.textStripWidth;
    textStripHeight = stagedAssets.textStripHeight;
    textStripIsRaw = true;
    textOffsetY = Number(stagedAssets.textOffsetY || stagedAssets.scrollParams?.textOffsetY || 0);

    const timeline = project.timeline || {};
    const text = project.text || {};
    const aspectRatio = settings.aspectRatio || "9/16";
    const { width: ew, height: eh } = getExportCanvasSize(aspectRatio);
    const { height: designHeight } = getDesignCanvasSize(aspectRatio);
    frameWidth = ew;
    frameHeight = eh;
    const yScale = eh / designHeight;
    const engine = new ScrollEngine(settings, timeline, textStripHeight / yScale);
    engine.measure(designHeight);
    totalDuration = engine.getTotalDuration();
    startY = engine.startY * yScale;
    endY = engine.endY * yScale;
    speedY = engine.speed * yScale;
    startDelay = engine.startDelay;
    if (stagedAssets.scrollParams) {
      totalDuration = stagedAssets.scrollParams.totalDuration ?? totalDuration;
      startY = stagedAssets.scrollParams.startY ?? startY;
      endY = stagedAssets.scrollParams.endY ?? endY;
      speedY = stagedAssets.scrollParams.speedY ?? speedY;
      startDelay = stagedAssets.scrollParams.startDelay ?? startDelay;
    }
  } else {
    const built = await buildCanvasAssets({
      project,
      backgroundPath,
      preprocessedBackgroundPath,
      onProgress,
      checkCancelled,
    });
    const { engine, yScale, bgCache, textCanvas } = built;
    frameWidth = built.ew;
    frameHeight = built.eh;
    timings.fontsMs = built.timings?.fontsMs || 0;
    timings.canvasMs = built.timings?.canvasMs || 0;
    totalDuration = engine.getTotalDuration();
    startY = engine.startY * yScale;
    endY = engine.endY * yScale;
    speedY = engine.speed * yScale;
    startDelay = engine.startDelay;
    textStripPath = path.join(workDir, "text.raw");
    textStripWidth = textCanvas.width;
    textStripHeight = textCanvas.height;
    textStripIsRaw = true;
    textOffsetY = Number(built.textOffsetY || 0);

    const videoBackgroundPath = isVideoMediaPath(backgroundPath) ? backgroundPath : null;
    const bgEffects = readBgEffects(settings);
    const hasBgEffects = !!(bgEffects.vignetteEnabled || bgEffects.colorOverlayEnabled);
    if (videoBackgroundPath) {
      backgroundIsVideo = true;
      const bgFitMode = settings.fitMode || "cover";
      const preparedBg = path.join(workDir, "bg-video-prepared.mp4");
      await prepareBackgroundVideo({
        inputPath: videoBackgroundPath,
        outputPath: preparedBg,
        width: built.ew,
        height: built.eh,
        fitMode: bgFitMode,
        onFfmpegSpawn,
      });

      const mode = backgroundVideoMode(settings, project.media || {});
      if (mode === "boomerang") {
        const boomerangBg = path.join(workDir, "bg-video-boomerang.mp4");
        await createBoomerangVideo({
          inputPath: preparedBg,
          outputPath: boomerangBg,
          onFfmpegSpawn,
        });
        bgImagePath = boomerangBg;
      } else {
        bgImagePath = preparedBg;
      }
      if (hasBgEffects) {
        const effectsCanvas = createCanvas(built.ew, built.eh);
        const ectx = effectsCanvas.getContext("2d");
        drawVignette(ectx, built.ew, built.eh, bgEffects);
        drawColorOverlay(ectx, built.ew, built.eh, bgEffects);
        backgroundEffectsPath = path.join(workDir, "bg-effects.png");
        await writePng(effectsCanvas, backgroundEffectsPath);
      }
      backgroundDurationSec = await probeVideoDurationSec(bgImagePath);
    } else {
      bgImagePath = path.join(workDir, "bg.jpg");
      await writeJpeg(bgCache, bgImagePath);
    }
    if (overlayInputPath && isVideoMediaPath(overlayInputPath)) {
      overlayIsVideo = true;
      overlayDurationSec = await probeVideoDurationSec(overlayInputPath);
    }
    await writeRawRgba(textCanvas, textStripPath);
  }

  if (overlayInputPath && !overlayIsVideo && isVideoMediaPath(overlayInputPath)) {
    overlayIsVideo = true;
    overlayDurationSec = await probeVideoDurationSec(overlayInputPath);
  }

  await reportProgress(40, "Encoding scroll video with ffmpeg…");
  await checkCancelled();
  const ffmpegStart = Date.now();
  let ffmpegProc = null;
  let progressErr = null;

  await encodeScrollVideo({
    bgImagePath,
    backgroundIsVideo,
    backgroundDurationSec,
    backgroundEffectsPath,
    overlayPath: overlayInputPath,
    overlayIsVideo,
    overlayDurationSec,
    frameWidth,
    frameHeight,
    overlayFitMode: settings.overlayFitMode || settings.fitMode || "cover",
    textStripPath,
    textStripWidth,
    textStripHeight,
    textStripIsRaw,
    outputPath,
    fps,
    totalDuration,
    startDelay,
    startY,
    endY,
    speedY,
    textOffsetY,
    musicPath,
    voicePath,
    musicVolume: settings.musicVolume ?? 100,
    voiceVolume: settings.voiceVolume ?? 100,
    musicLoop: settings.musicLoop !== false,
    onFfmpegSpawn: (proc) => {
      ffmpegProc = proc;
      onFfmpegSpawn?.(proc);
    },
    onEncodeProgress: (pct) => {
      const mapped = 40 + Math.round((pct / 100) * 55);
      onEncodeProgress?.(mapped, pct);
      void reportProgress(mapped, `Encoding video… ${pct}%`).catch((err) => {
        progressErr = err;
        if (ffmpegProc && !ffmpegProc.killed) {
          try {
            ffmpegProc.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }
      });
    },
  });
  if (progressErr) throw progressErr;
  timings.ffmpegMs = Date.now() - ffmpegStart;

  await reportProgress(100, "Render complete");

  return {
    durationSec: totalDuration,
    frameCount: Math.max(1, Math.ceil(totalDuration * fps)),
    outputPath,
    timings,
    stagingAssets: stagedAssets || backgroundIsVideo
      ? null
      : {
          bgImagePath,
          textStripPath,
          textStripWidth,
          textStripHeight,
          textOffsetY,
        },
  };
}
