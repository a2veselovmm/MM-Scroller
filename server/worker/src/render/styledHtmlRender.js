import { createCanvas } from "canvas";
import { resolveFontFamily } from "../fonts/localFonts.js";
import { hexToRgba, normalizeOpacity } from "./renderUtils.js";

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
  const m = String(value).match(/(rgba?\([^)]+\)|#[0-9a-f]+)\s+(-?\d+(?:\.\d+)?px)\s+(-?\d+(?:\.\d+)?px)(?:\s+(-?\d+(?:\.\d+)?px))?/i);
  if (!m) return null;
  return {
    color: m[1],
    ox: parseFloat(m[2]) || 0,
    oy: parseFloat(m[3]) || 0,
    blur: parseFloat(m[4]) || 0,
  };
}

function mergeStyles(base, extra) {
  return { ...base, ...extra };
}

function parseStroke(css) {
  const raw = css["-webkit-text-stroke"];
  if (!raw) return { strokeWidth: 0, strokeColor: "#000000" };
  const px = String(raw).match(/([\d.]+)px/);
  const strokeWidth = px ? parseFloat(px[1]) : 0;
  const strokeColor = String(raw).replace(/^[\d.]+px\s*/, "").trim() || "#000000";
  return { strokeWidth, strokeColor };
}

function styleFromCss(css, settings) {
  const fontSize = parsePx(css["font-size"], settings.fontSize ?? 48);
  const stroke = parseStroke(css);
  return {
    color: css.color || settings.fontColor || "#ffffff",
    fontSize,
    fontFamily: resolveFontFamily(parseFontFamily(css["font-family"], settings.fontFamily || "Inter")),
    fontWeight: css["font-weight"] || (settings.bold ? "700" : "400"),
    fontStyle: css["font-style"] || (settings.italic ? "italic" : "normal"),
    opacity: css.opacity != null ? normalizeOpacity(css.opacity, 1) : normalizeOpacity(settings.fontOpacity, 1),
    strokeWidth: stroke.strokeWidth,
    strokeColor: stroke.strokeColor,
    shadow: parseTextShadow(css["text-shadow"]),
    lineHeight: settings.lineHeight ?? 1.35,
  };
}

function parseRunsFromLine(innerHtml, lineStyle, settings) {
  const runs = [];
  const spanRe = /<span[^>]*class="[^"]*(?:text-run|text-span)[^"]*"[^>]*style="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi;
  let lastIndex = 0;
  let match;

  while ((match = spanRe.exec(innerHtml)) !== null) {
    if (match.index > lastIndex) {
      const between = stripTags(innerHtml.slice(lastIndex, match.index));
      if (between) runs.push({ text: between, style: lineStyle });
    }
    const spanStyle = mergeStyles(lineStyle, styleFromCss(parseStyleAttr(match[1]), settings));
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

export function parseStyledLines(styledHtml, settings = {}) {
  const defaultStyle = styleFromCss({}, settings);
  const lines = [];
  const lineRe = /<div[^>]*class="[^"]*text-line[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;

  while ((match = lineRe.exec(String(styledHtml || ""))) !== null) {
    const full = match[0];
    const inner = match[1];
    const styleMatch = full.match(/style="([^"]*)"/i);
    const lineStyle = mergeStyles(
      defaultStyle,
      styleFromCss(parseStyleAttr(styleMatch?.[1]), settings)
    );
    const runs = parseRunsFromLine(inner, lineStyle, settings);
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

    if (!words.length) wrapped.push({ runs: [{ text: "", style: line.style }], lineHeightPx });
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

export function measureWrappedLinePadding(wrappedLines, drawScale) {
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

/**
 * @param {import('canvas').CanvasRenderingContext2D} ctx
 */
export function drawStyledLines(ctx, wrappedLines, { ew, paddingH, drawScale, align, offsetY = 0 }) {
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

export function measureStyledDocument(styledHtml, settings, ew, drawScale, paddingH, align) {
  const parsed = parseStyledLines(styledHtml, settings);
  const measureCanvas = createCanvas(ew, 10);
  const ctx = measureCanvas.getContext("2d");
  const maxTextWidth = ew - paddingH * 2 * drawScale;
  const wrapped = wrapStyledLines(parsed, ctx, maxTextWidth, drawScale);
  const height = drawStyledLines(ctx, wrapped, { ew, paddingH, drawScale, align });
  return { wrapped, height: Math.ceil(height) + 20 };
}
