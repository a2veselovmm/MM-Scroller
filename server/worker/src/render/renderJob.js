import { createCanvas, loadImage } from "canvas";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getDesignCanvasSize, getExportCanvasSize, EXPORT_FPS } from "../../shared/canvasDesign.js";
import { segmentTimeRange } from "../../shared/renderPlan.js";
import { ensureFontsForProject, resolveFontFamily } from "../fonts/localFonts.js";
import { drawColorOverlay, drawVignette, readBgEffects } from "./backgroundEffects.js";
import {
  concatSegmentsAndMuxAudio,
  encodeScrollSegment,
  encodeScrollVideo,
  writeJpeg,
  writeRawRgba,
} from "./ffmpegScrollEncode.js";
import { normalizeOpacity } from "./renderUtils.js";
import { ScrollEngine } from "./scrollEngine.js";
import { drawStyledLines, measureStyledDocument } from "./styledHtmlRender.js";

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

function wrapLines(ctx, text, maxWidth) {
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
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else {
        lines.push(line);
        line = words[i];
      }
    }
    lines.push(line);
  }
  return lines;
}

function measureTextBlock(ctx, text, maxWidth, lineHeightPx) {
  const lines = wrapLines(ctx, text, maxWidth);
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
    const textCanvas = createCanvas(ew, Math.max(1, height));
    const tctx = textCanvas.getContext("2d");
    drawStyledLines(tctx, wrapped, { ew, paddingH, drawScale, align });
    return { textCanvas, textHeight: height };
  }

  const plain = resolvePlainText(text);
  const fontFamily = resolveFontFamily(settings.fontFamily);
  const fontSize = Number(settings.fontSize ?? 48);
  const lineHeight = Number(settings.lineHeight ?? 1.35);
  const fontOpacity = normalizeOpacity(settings.fontOpacity, 1);
  const fontWeight = settings.bold ? "700" : "400";
  const fontStyle = settings.italic ? "italic" : "normal";

  const measureCanvas = createCanvas(ew, 10);
  const mctx = measureCanvas.getContext("2d");
  mctx.font = `${fontStyle} ${fontWeight} ${fontSize * drawScale}px ${fontFamily}`;
  const maxTextWidth = ew - paddingH * 2 * drawScale;
  const lineHeightPx = fontSize * lineHeight * drawScale;
  const { lines, height: textHeight } = measureTextBlock(mctx, plain, maxTextWidth, lineHeightPx);

  const textCanvas = createCanvas(ew, Math.ceil(textHeight) + 20);
  const tctx = textCanvas.getContext("2d");
  tctx.font = mctx.font;
  tctx.fillStyle = settings.fontColor || "#ffffff";
  tctx.globalAlpha = fontOpacity;
  tctx.textBaseline = "top";

  let y = 0;
  for (const line of lines) {
    let x = paddingH * drawScale;
    if (align === "center") {
      tctx.textAlign = "center";
      x = ew / 2;
    } else if (align === "right") {
      tctx.textAlign = "right";
      x = ew - paddingH * drawScale;
    } else {
      tctx.textAlign = "left";
    }
    tctx.fillText(line, x, y);
    y += lineHeightPx;
  }

  return { textCanvas, textHeight: Math.ceil(textHeight) + 20 };
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
  const { textCanvas, textHeight } = await buildTextStrip({
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

  const built = await buildCanvasAssets({
    project,
    backgroundPath,
    preprocessedBackgroundPath,
    onProgress,
    checkCancelled,
  });
  const { engine, yScale, bgCache, textCanvas } = built;
  const settings = project.settings || {};

  const totalDuration = engine.getTotalDuration();
  const scrollParams = {
    startY: engine.startY * yScale,
    endY: engine.endY * yScale,
    speedY: engine.speed * yScale,
    startDelay: engine.startDelay,
    totalDuration,
    fps: EXPORT_FPS,
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
  const timings = { fontsMs: 0, canvasMs: 0, ffmpegMs: 0 };

  if (stagedAssets) {
    await reportProgress(20, "Using cached render layers…");
    bgImagePath = stagedAssets.bgImagePath;
    textStripPath = stagedAssets.textStripPath;
    textStripWidth = stagedAssets.textStripWidth;
    textStripHeight = stagedAssets.textStripHeight;
    textStripIsRaw = true;

    const timeline = project.timeline || {};
    const text = project.text || {};
    const aspectRatio = settings.aspectRatio || "9/16";
    const { height: eh } = getExportCanvasSize(aspectRatio);
    const { height: designHeight } = getDesignCanvasSize(aspectRatio);
    const yScale = eh / designHeight;
    const engine = new ScrollEngine(settings, timeline, textStripHeight / yScale);
    engine.measure(designHeight);
    totalDuration = engine.getTotalDuration();
    startY = engine.startY * yScale;
    endY = engine.endY * yScale;
    speedY = engine.speed * yScale;
    startDelay = engine.startDelay;
  } else {
    const built = await buildCanvasAssets({
      project,
      backgroundPath,
      preprocessedBackgroundPath,
      onProgress,
      checkCancelled,
    });
    const { engine, yScale, bgCache, textCanvas } = built;
    timings.fontsMs = built.timings?.fontsMs || 0;
    timings.canvasMs = built.timings?.canvasMs || 0;
    totalDuration = engine.getTotalDuration();
    startY = engine.startY * yScale;
    endY = engine.endY * yScale;
    speedY = engine.speed * yScale;
    startDelay = engine.startDelay;

    bgImagePath = path.join(workDir, "bg.jpg");
    textStripPath = path.join(workDir, "text.raw");
    textStripWidth = textCanvas.width;
    textStripHeight = textCanvas.height;
    textStripIsRaw = true;

    await writeJpeg(bgCache, bgImagePath);
    await writeRawRgba(textCanvas, textStripPath);
  }

  await reportProgress(40, "Encoding scroll video with ffmpeg…");
  await checkCancelled();
  const ffmpegStart = Date.now();
  let ffmpegProc = null;
  let progressErr = null;

  await encodeScrollVideo({
    bgImagePath,
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
    stagingAssets: stagedAssets
      ? null
      : {
          bgImagePath,
          textStripPath,
          textStripWidth,
          textStripHeight,
        },
  };
}
