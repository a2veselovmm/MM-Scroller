import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const FPS = 30;
const DESIGN_LONG_EDGE = 1920;
const EXPORT_SHORT_EDGE = 1080;

function normalizeName(name) {
  return String(name || "").replace(/['"]/g, "").trim().toLowerCase();
}

function normalizeOpacity(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || "").replace("#", "").trim();
  let r = 255;
  let g = 255;
  let b = 255;
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (clean.length >= 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  }
  const a = normalizeOpacity(alpha, 1);
  return `rgba(${r || 255},${g || 255},${b || 255},${a})`;
}

function evenDimension(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

function parseAspectRatio(aspectRatio = "9/16") {
  const [aw, ah] = String(aspectRatio).split("/").map((x) => parseFloat(x) || 1);
  return { aw, ah };
}

function getDesignCanvasSize(aspectRatio = "9/16") {
  const { aw, ah } = parseAspectRatio(aspectRatio);
  if (aw >= ah) {
    const width = DESIGN_LONG_EDGE;
    return { width: evenDimension(width), height: evenDimension((width * ah) / aw) };
  }
  const height = DESIGN_LONG_EDGE;
  return { width: evenDimension((height * aw) / ah), height: evenDimension(height) };
}

function getExportCanvasSize(aspectRatio = "9/16") {
  const { aw, ah } = parseAspectRatio(aspectRatio);
  if (aw >= ah) {
    const height = EXPORT_SHORT_EDGE;
    return { width: evenDimension((height * aw) / ah), height: evenDimension(height) };
  }
  const width = EXPORT_SHORT_EDGE;
  return { width: evenDimension(width), height: evenDimension((width * ah) / aw) };
}

function parseArgs(argv) {
  const out = { bundle: process.cwd(), output: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--bundle" && argv[i + 1]) out.bundle = argv[++i];
    else if (argv[i] === "--output" && argv[i + 1]) out.output = argv[++i];
  }
  out.bundle = path.resolve(out.bundle);
  out.output = out.output
    ? path.resolve(out.output)
    : path.join(out.bundle, "local-render-output.mp4");
  return out;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeHtml(String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));
}

function parseStyleAttr(styleStr) {
  const out = {};
  for (const part of String(styleStr || "").split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function parsePx(value, fallback) {
  if (!value) return fallback;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

function parseFontFamily(value, fallback) {
  if (!value) return fallback;
  return String(value).split(",")[0].trim().replace(/['"]/g, "") || fallback;
}

function parseTextShadow(value) {
  if (!value || value === "none") return null;
  const m = String(value).match(
    /(rgba?\([^)]+\)|#[0-9a-f]+)\s+(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)(?:\s+(-?\d+(?:\.\d+)?px))?/i
  );
  if (!m) return null;
  return {
    color: m[1],
    ox: parseFloat(m[2]) || 0,
    oy: parseFloat(m[3]) || 0,
    blur: parseFloat(m[4]) || 0,
  };
}

function parseStroke(css) {
  const raw = css["-webkit-text-stroke"];
  if (!raw) return { strokeWidth: 0, strokeColor: "#000000" };
  const px = String(raw).match(/([\d.]+)px/);
  const strokeWidth = px ? parseFloat(px[1]) : 0;
  const strokeColor = String(raw).replace(/^[\d.]+px\s*/, "").trim() || "#000000";
  return { strokeWidth, strokeColor };
}

function resolveFontFamily(name, registry, fallback = "Inter") {
  const primary = normalizeName(String(name || "").split(",")[0]);
  if (registry.has(primary)) return registry.get(primary);
  const fb = normalizeName(fallback);
  if (registry.has(fb)) return registry.get(fb);
  if (registry.size > 0) return registry.values().next().value;
  return "sans-serif";
}

function styleFromCss(css, settings, registry) {
  const fontSize = parsePx(css["font-size"], settings.fontSize ?? 48);
  const stroke = parseStroke(css);
  return {
    color: css.color || settings.fontColor || "#ffffff",
    fontSize,
    fontFamily: resolveFontFamily(
      parseFontFamily(css["font-family"], settings.fontFamily || "Inter"),
      registry,
      settings.fontFamily || "Inter"
    ),
    fontWeight: css["font-weight"] || (settings.bold ? "700" : "400"),
    fontStyle: css["font-style"] || (settings.italic ? "italic" : "normal"),
    opacity:
      css.opacity != null
        ? normalizeOpacity(css.opacity, 1)
        : normalizeOpacity(settings.fontOpacity, 1),
    strokeWidth: stroke.strokeWidth,
    strokeColor: stroke.strokeColor,
    shadow: parseTextShadow(css["text-shadow"]),
    lineHeight: settings.lineHeight ?? 1.35,
  };
}

function parseRunsFromLine(innerHtml, lineStyle, settings, registry) {
  const runs = [];
  const spanRe =
    /<span[^>]*class="[^"]*(?:text-run|text-span)[^"]*"[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi;
  let lastIndex = 0;
  let match;

  while ((match = spanRe.exec(innerHtml)) !== null) {
    if (match.index > lastIndex) {
      const between = stripTags(innerHtml.slice(lastIndex, match.index));
      if (between) runs.push({ text: between, style: lineStyle });
    }
    const spanStyle = {
      ...lineStyle,
      ...styleFromCss(parseStyleAttr(match[1]), settings, registry),
    };
    const text = stripTags(match[2]);
    if (text) runs.push({ text, style: spanStyle });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < innerHtml.length) {
    const tail = stripTags(innerHtml.slice(lastIndex));
    if (tail) runs.push({ text: tail, style: lineStyle });
  }

  if (!runs.length) {
    const plain = stripTags(innerHtml);
    if (plain) runs.push({ text: plain, style: lineStyle });
  }
  return runs;
}

function parseStyledLines(styledHtml, settings = {}, registry) {
  const defaultStyle = styleFromCss({}, settings, registry);
  const lines = [];
  const lineRe = /<div[^>]*class="[^"]*text-line[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;

  while ((match = lineRe.exec(String(styledHtml || ""))) !== null) {
    const full = match[0];
    const inner = match[1];
    const styleMatch = full.match(/style="([^"]*)"/i);
    const lineStyle = {
      ...defaultStyle,
      ...styleFromCss(parseStyleAttr(styleMatch?.[1]), settings, registry),
    };
    const runs = parseRunsFromLine(inner, lineStyle, settings, registry);
    if (!runs.length && /<br\s*\/?>/i.test(inner)) {
      lines.push({ runs: [{ text: "", style: lineStyle }], style: lineStyle });
    } else if (runs.length) {
      lines.push({ runs, style: lineStyle });
    }
  }

  return lines;
}

function buildFontString(style, drawScale) {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize * drawScale}px ${style.fontFamily}`;
}

function wrapStyledLines(lines, ctx, maxWidth, drawScale) {
  const wrapped = [];

  for (const line of lines) {
    const lineHeightPx = line.style.fontSize * line.style.lineHeight * drawScale;
    const words = [];
    for (const run of line.runs) {
      const parts = run.text.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        words.push({ text: part, style: run.style });
      }
    }

    let current = [];
    let currentWidth = 0;
    const flush = () => {
      if (current.length) wrapped.push({ runs: current, lineHeightPx });
      current = [];
      currentWidth = 0;
    };

    for (const word of words) {
      ctx.font = buildFontString(word.style, drawScale);
      const w = ctx.measureText(word.text).width;
      if (current.length && currentWidth + w > maxWidth && !/^\s+$/.test(word.text)) {
        flush();
      }
      current.push(word);
      currentWidth += w;
    }
    flush();
    if (!words.length) {
      wrapped.push({ runs: [{ text: "", style: line.style }], lineHeightPx });
    }
  }

  return wrapped;
}

function drawRun(ctx, run, x, y, drawScale) {
  const style = run.style;
  ctx.save();
  ctx.font = buildFontString(style, drawScale);
  ctx.globalAlpha = style.opacity;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  if (style.shadow) {
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * drawScale;
    ctx.shadowOffsetX = style.shadow.ox * drawScale;
    ctx.shadowOffsetY = style.shadow.oy * drawScale;
  }

  if (style.strokeWidth > 0) {
    ctx.lineWidth = style.strokeWidth * drawScale;
    ctx.strokeStyle = style.strokeColor;
    ctx.lineJoin = "round";
    ctx.strokeText(run.text, x, y);
  }

  ctx.fillStyle = style.color.includes("rgb") ? style.color : hexToRgba(style.color, style.opacity);
  ctx.fillText(run.text, x, y);
  ctx.restore();
}

function styleVerticalPadding(style, drawScale) {
  const strokePad = Math.max(0, ((Number(style.strokeWidth) || 0) * drawScale) / 2);
  if (!style.shadow) return { top: strokePad, bottom: strokePad };
  const blur = Math.max(0, (Number(style.shadow.blur) || 0) * drawScale);
  const oy = (Number(style.shadow.oy) || 0) * drawScale;
  return {
    top: Math.max(strokePad, blur - oy + strokePad),
    bottom: Math.max(strokePad, blur + oy + strokePad),
  };
}

function measureWrappedLinePadding(wrappedLines, drawScale) {
  let top = 0;
  let bottom = 0;
  for (const line of wrappedLines) {
    for (const run of line.runs) {
      const pad = styleVerticalPadding(run.style, drawScale);
      top = Math.max(top, pad.top);
      bottom = Math.max(bottom, pad.bottom);
    }
  }
  return {
    top: top > 0 ? Math.ceil(top + 2) : 0,
    bottom: bottom > 0 ? Math.ceil(bottom + 2) : 0,
  };
}

function measureRunsWidth(ctx, runs, drawScale) {
  let width = 0;
  for (const run of runs) {
    ctx.font = buildFontString(run.style, drawScale);
    width += ctx.measureText(run.text).width;
  }
  return width;
}

function drawStyledLines(ctx, wrappedLines, { ew, paddingH, drawScale, align, offsetY = 0 }) {
  let y = offsetY;
  for (const line of wrappedLines) {
    const lineWidth = measureRunsWidth(ctx, line.runs, drawScale);
    let x = paddingH * drawScale;
    if (align === "center") x = Math.max(paddingH * drawScale, (ew - lineWidth) / 2);
    else if (align === "right") x = Math.max(paddingH * drawScale, ew - paddingH * drawScale - lineWidth);

    for (const run of line.runs) {
      drawRun(ctx, run, x, y, drawScale);
      ctx.font = buildFontString(run.style, drawScale);
      x += ctx.measureText(run.text).width;
    }
    y += line.lineHeightPx;
  }
  return y - offsetY;
}

function wrapPlainLines(ctx, text, maxWidth) {
  const paragraphs = String(text || "").split("\n");
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

function buildStyledTextCanvas({ styledHtml, settings, ew, drawScale, paddingH, align, registry }) {
  const parsed = parseStyledLines(styledHtml, settings, registry);
  const measureCanvas = createCanvas(ew, 10);
  const mctx = measureCanvas.getContext("2d");
  const maxTextWidth = ew - paddingH * 2 * drawScale;
  const wrapped = wrapStyledLines(parsed, mctx, maxTextWidth, drawScale);
  const measuredHeight =
    wrapped.reduce((sum, line) => sum + line.lineHeightPx, 0) + 20;
  const pad = measureWrappedLinePadding(wrapped, drawScale);
  const textCanvas = createCanvas(
    ew,
    Math.max(2, Math.ceil(measuredHeight + pad.top + pad.bottom))
  );
  const tctx = textCanvas.getContext("2d");
  const textHeight = drawStyledLines(tctx, wrapped, {
    ew,
    paddingH,
    drawScale,
    align,
    offsetY: pad.top,
  });
  return { textCanvas, textHeight: Math.ceil(textHeight) + 20, textOffsetY: pad.top };
}

function buildPlainTextCanvas({ plainText, settings, ew, drawScale, paddingH, align, family }) {
  const fontSize = Number(settings.fontSize ?? 48);
  const lineHeight = Number(settings.lineHeight ?? 1.35);
  const fontWeight = settings.bold ? "700" : "400";
  const fontStyle = settings.italic ? "italic" : "normal";
  const opacity = normalizeOpacity(settings.fontOpacity, 1);
  const measureCanvas = createCanvas(ew, 10);
  const mctx = measureCanvas.getContext("2d");
  mctx.font = `${fontStyle} ${fontWeight} ${fontSize * drawScale}px ${family}`;
  const maxTextWidth = ew - paddingH * 2 * drawScale;
  const lineHeightPx = fontSize * lineHeight * drawScale;
  const lines = wrapPlainLines(mctx, plainText, maxTextWidth);
  const textHeight = lines.length * lineHeightPx + 20;
  const textCanvas = createCanvas(ew, Math.max(2, Math.ceil(textHeight)));
  const tctx = textCanvas.getContext("2d");
  tctx.font = mctx.font;
  tctx.fillStyle = settings.fontColor || "#ffffff";
  tctx.globalAlpha = opacity;
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

  return { textCanvas, textHeight: Math.ceil(textHeight), textOffsetY: 0 };
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

async function firstMediaFile(dirPath) {
  try {
    const names = await readdir(dirPath);
    const file = names.find((name) => !name.startsWith("."));
    return file ? path.join(dirPath, file) : null;
  } catch {
    return null;
  }
}

async function registerBundleFonts(bundleRoot) {
  const fontsDir = path.join(bundleRoot, "renderer", "fonts");
  const registry = new Map();
  try {
    const files = await readdir(fontsDir);
    for (const file of files) {
      if (!file.endsWith(".ttf")) continue;
      const match = file.match(/^(.+)-(\d{3})\.ttf$/);
      if (!match) continue;
      const family = match[1].replace(/-/g, " ");
      const fullPath = path.join(fontsDir, file);
      try {
        GlobalFonts.registerFromPath(fullPath, family);
        registry.set(normalizeName(family), family);
      } catch (err) {
        console.warn("register font failed", file, err?.message || err);
      }
    }
  } catch {
    // no bundled fonts directory
  }
  return registry;
}

function scrollYExpr({ startDelay, startY, endY, speedY }) {
  const sd = Number(startDelay) || 0;
  const sy = Number(startY) || 0;
  const ey = Number(endY) || 0;
  const sp = Number(speedY) || 1;
  return `if(lt(t\\,${sd})\\,${sy}\\,max(${ey}\\,${sy}-(t-${sd})*${sp}))`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stdout.on("data", (chunk) => process.stdout.write(chunk));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1200) || `ffmpeg exited with code ${code}`));
    });
  });
}

function isVideoFilePath(filePath) {
  if (!filePath) return false;
  const ext = path.extname(String(filePath)).toLowerCase();
  return ext === ".mp4" || ext === ".mov";
}

function buildFitFilter(width, height, fitMode = "cover", { transparentPad = false } = {}) {
  const w = Math.max(2, Math.round(Number(width) || 1080));
  const h = Math.max(2, Math.round(Number(height) || 1920));
  const fit = fitMode === "contain" ? "contain" : fitMode === "fill" ? "fill" : "cover";
  if (fit === "fill") return `scale=${w}:${h}`;
  if (fit === "contain") {
    const padColor = transparentPad ? "black@0.0" : "black";
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${padColor}`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

function resolveBackgroundVideoMode(settings = {}, media = {}) {
  if (settings.backgroundVideoMode === "boomerang") return "boomerang";
  if (settings.bgVideoMode === "boomerang") return "boomerang";
  if (media?.background?.playbackMode === "boomerang") return "boomerang";
  return "loop";
}

async function prepareBackgroundVideo(inputPath, outputPath, ew, eh, fitMode = "cover") {
  const fit = fitMode === "contain" ? "contain" : fitMode === "fill" ? "fill" : "cover";
  const scaleFilter =
    fit === "fill"
      ? `scale=${ew}:${eh}`
      : fit === "contain"
        ? `scale=${ew}:${eh}:force_original_aspect_ratio=decrease,pad=${ew}:${eh}:(ow-iw)/2:(oh-ih)/2:color=black`
        : `scale=${ew}:${eh}:force_original_aspect_ratio=increase,crop=${ew}:${eh}`;
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-an",
    "-filter:v",
    `${scaleFilter},setpts=PTS-STARTPTS,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  return outputPath;
}

async function createBoomerangVideo(inputPath, outputPath) {
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-an",
    "-filter_complex",
    "[0:v]setpts=PTS-STARTPTS,split[fwd][rev];[rev]reverse,setpts=PTS-STARTPTS[r];[fwd][r]concat=n=2:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  return outputPath;
}

async function main() {
  const { bundle, output } = parseArgs(process.argv);
  const projectPath = path.join(bundle, "project", "project.json");
  const raw = await readFile(projectPath, "utf8");
  const project = JSON.parse(raw);
  const settings = project.settings || {};
  const timeline = project.timeline || {};
  const text = project.text || {};
  const aspectRatio = settings.aspectRatio || "9/16";
  const { width: ew, height: eh } = getExportCanvasSize(aspectRatio);
  const { width: designW, height: designH } = getDesignCanvasSize(aspectRatio);
  const drawScale = ew / designW;
  const yScale = eh / designH;
  const paddingH = Number(settings.paddingH ?? 48);
  const align = settings.textAlign || "center";
  const registry = await registerBundleFonts(bundle);
  const defaultFamily = resolveFontFamily(settings.fontFamily || "Inter", registry, "Inter");

  const plainText =
    text.editMode === "plain"
      ? String(text.plainText || "")
      : stripTags(text.styledHtml || text.plainText || "");

  const styledMode =
    text.editMode !== "plain" && text.styledHtml && String(text.styledHtml).trim();

  const textLayer = styledMode
    ? buildStyledTextCanvas({
        styledHtml: text.styledHtml,
        settings: { ...settings, fontFamily: defaultFamily },
        ew,
        drawScale,
        paddingH,
        align,
        registry,
      })
    : buildPlainTextCanvas({
        plainText,
        settings: { ...settings, fontFamily: defaultFamily },
        ew,
        drawScale,
        paddingH,
        align,
        family: defaultFamily,
      });

  const textCanvas = textLayer.textCanvas;
  const textHeight = textLayer.textHeight;
  const textOffsetY = Number(textLayer.textOffsetY || 0);
  const firstRow = Number(timeline.scrollFirstRow ?? settings.scrollFirstRow ?? designH);
  const lastRow = Number(timeline.scrollLastRow ?? settings.scrollLastRow ?? 0);
  const speedDesign = Number(timeline.speed ?? settings.scrollSpeed ?? 80);
  const speedY = Math.max(1, speedDesign * yScale);
  const startDelay = Math.max(0, Number(timeline.startDelay ?? settings.startDelay ?? 0));
  const startY = firstRow * yScale;
  const endY = lastRow * yScale - textHeight;
  const measuredDuration = Number(timeline.measuredDurationSec);
  const inferredDuration = startDelay + Math.max(0, (startY - endY) / speedY);
  const totalDuration = Math.max(
    1,
    Number.isFinite(measuredDuration) && measuredDuration > 0
      ? measuredDuration
      : inferredDuration
  );

  const bgPath = await firstMediaFile(path.join(bundle, "media", "background"));
  const overlayPath = await firstMediaFile(path.join(bundle, "media", "overlay"));
  const musicPath = await firstMediaFile(path.join(bundle, "media", "music"));
  const voicePath = await firstMediaFile(path.join(bundle, "media", "voiceover"));
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mm-local-render-"));
  const textPngPath = path.join(tmpDir, "text-strip.png");
  await writeFile(textPngPath, textCanvas.toBuffer("image/png"));

  try {
    let bgRenderPath = bgPath;
    let bgIsVideo = false;
    if (bgPath && isVideoFilePath(bgPath)) {
      bgIsVideo = true;
      const preparedBg = path.join(tmpDir, "background-video-prepared.mp4");
      await prepareBackgroundVideo(
        bgPath,
        preparedBg,
        ew,
        eh,
        settings.fitMode || "cover"
      );
      const playbackMode = resolveBackgroundVideoMode(settings, project.media || {});
      if (playbackMode === "boomerang") {
        const boomerangBg = path.join(tmpDir, "background-video-boomerang.mp4");
        await createBoomerangVideo(preparedBg, boomerangBg);
        bgRenderPath = boomerangBg;
      } else {
        bgRenderPath = preparedBg;
      }
    }

    let overlayRenderPath = overlayPath;
    let overlayIsVideo = false;
    if (overlayRenderPath && isVideoFilePath(overlayRenderPath)) {
      overlayIsVideo = true;
    }

    const yExpr = scrollYExpr({ startDelay, startY, endY, speedY });
    const overlayYExpr = textOffsetY ? `(${yExpr})-${textOffsetY}` : yExpr;
    const args = ["-y"];

    if (bgRenderPath) {
      if (bgIsVideo) {
        args.push("-stream_loop", "-1");
        args.push("-t", String(totalDuration), "-i", bgRenderPath);
      } else {
        args.push(
          "-loop",
          "1",
          "-framerate",
          String(FPS),
          "-t",
          String(totalDuration),
          "-i",
          bgRenderPath
        );
      }
    } else {
      args.push(
        "-f",
        "lavfi",
        "-i",
        `color=c=0x111118:s=${ew}x${eh}:r=${FPS}:d=${totalDuration}`
      );
    }

    args.push(
      "-loop",
      "1",
      "-framerate",
      String(FPS),
      "-t",
      String(totalDuration),
      "-i",
      textPngPath
    );

    if (overlayRenderPath) {
      if (overlayIsVideo) {
        args.push("-stream_loop", "-1", "-t", String(totalDuration), "-i", overlayRenderPath);
      } else {
        args.push(
          "-loop",
          "1",
          "-framerate",
          String(FPS),
          "-t",
          String(totalDuration),
          "-i",
          overlayRenderPath
        );
      }
    }

    const hasMusic = !!musicPath;
    const hasVoice = !!voicePath;
    const audioStartIndex = overlayRenderPath ? 3 : 2;
    const musicIndex = hasMusic ? audioStartIndex : -1;
    const voiceIndex = hasVoice ? (hasMusic ? audioStartIndex + 1 : audioStartIndex) : -1;
    if (hasMusic) {
      if (settings.musicLoop !== false) args.push("-stream_loop", "-1");
      args.push("-i", musicPath);
    }
    if (hasVoice) {
      args.push("-stream_loop", "-1", "-i", voicePath);
    }

    const filterParts = [];
    const basePart = bgRenderPath
      ? `[0:v]scale=${ew}:${eh}:force_original_aspect_ratio=increase,crop=${ew}:${eh},format=yuv420p[bg];[bg][1:v]overlay=x=0:y='${overlayYExpr}':eval=frame:format=auto[vtxt]`
      : `[0:v]format=yuv420p[bg];[bg][1:v]overlay=x=0:y='${overlayYExpr}':eval=frame:format=auto[vtxt]`;
    filterParts.push(basePart);
    if (overlayRenderPath) {
      filterParts.push(
        `[2:v]${buildFitFilter(ew, eh, settings.fitMode || "cover", { transparentPad: true })},format=rgba[ovr]`,
        "[vtxt][ovr]overlay=x=0:y=0:eval=frame:format=auto[vout]"
      );
    } else {
      filterParts.push("[vtxt]null[vout]");
    }

    let audioMap = null;
    if (hasMusic || hasVoice) {
      const musicVol = Math.max(0, Math.min(2, Number(settings.musicVolume ?? 100) / 100));
      const voiceVol = Math.max(0, Math.min(2, Number(settings.voiceVolume ?? 100) / 100));
      if (hasMusic) filterParts.push(`[${musicIndex}:a]volume=${musicVol}[m]`);
      if (hasVoice) filterParts.push(`[${voiceIndex}:a]volume=${voiceVol}[v]`);
      if (hasMusic && hasVoice) {
        filterParts.push("[m][v]amix=inputs=2:duration=first:dropout_transition=0[aout]");
        audioMap = "[aout]";
      } else if (hasMusic) {
        audioMap = "[m]";
      } else {
        audioMap = "[v]";
      }
    }

    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", "[vout]");
    if (audioMap) args.push("-map", audioMap);

    args.push(
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-r",
      String(FPS),
      "-t",
      String(totalDuration),
      "-movflags",
      "+faststart"
    );
    if (audioMap) {
      args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
    }
    args.push(output);

    console.log(`Rendering ${Math.round(totalDuration)}s @ ${ew}x${eh} ...`);
    await runFfmpeg(args);
    console.log(`Output written: ${output}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

