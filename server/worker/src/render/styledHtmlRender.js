import { createCanvas, loadImage } from "canvas";
import { resolveFontFamily } from "../fonts/localFonts.js";
import { hexToRgba, normalizeOpacity } from "./renderUtils.js";

const TWEMOJI_BASE_URL = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72";
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

function emojiAdvancePx(style, drawScale) {
  return Math.max(1, Math.round(style.fontSize * drawScale));
}

function measureMixedTextWidth(ctx, text, style, drawScale) {
  const tokens = splitEmojiTokens(text);
  let width = 0;
  for (const token of tokens) {
    if (token.type === "emoji") {
      width += emojiAdvancePx(style, drawScale);
    } else if (token.value) {
      width += ctx.measureText(token.value).width;
    }
  }
  return width;
}

function collectEmojiFromWrappedLines(wrappedLines) {
  const set = new Set();
  for (const line of wrappedLines) {
    for (const run of line.runs) {
      for (const token of splitEmojiTokens(run.text)) {
        if (token.type === "emoji") set.add(token.value);
      }
    }
  }
  return [...set];
}

async function loadEmojiImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Emoji fetch failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return loadImage(bytes);
}

export async function preloadEmojiImagesForWrappedLines(wrappedLines, emojiCache = new Map()) {
  const needed = collectEmojiFromWrappedLines(wrappedLines).filter((emoji) => !emojiCache.has(emoji));
  await Promise.all(
    needed.map(async (emoji) => {
      const url = emojiImageUrl(emoji);
      if (!url) {
        emojiCache.set(emoji, null);
        return;
      }
      try {
        const image = await loadEmojiImage(url);
        emojiCache.set(emoji, image);
      } catch {
        emojiCache.set(emoji, null);
      }
    })
  );
  return emojiCache;
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
  const first = String(value).split(/,(?![^()]*\))/)[0]?.trim();
  if (!first) return null;
  const tokens = first.split(/\s+/).filter(Boolean);
  let color = null;
  const lengths = [];
  for (const token of tokens) {
    if (/^(rgba?\(|hsla?\(|#)/i.test(token)) {
      color = token;
      continue;
    }
    if (/^-?\d+(?:\.\d+)?(?:px)?$/i.test(token)) {
      lengths.push(parseFloat(token));
    }
  }
  if (!color && !lengths.length) return null;
  return {
    color: color || "rgba(0,0,0,0.85)",
    ox: Number.isFinite(lengths[0]) ? lengths[0] : 0,
    oy: Number.isFinite(lengths[1]) ? lengths[1] : 0,
    blur: Number.isFinite(lengths[2]) ? lengths[2] : 0,
  };
}

function mergeStyles(base, extra) {
  return { ...base, ...extra };
}

function parseStroke(css, settings = {}) {
  const raw =
    css["-webkit-text-stroke"] ||
    css["webkit-text-stroke"] ||
    css["webkittextstroke"] ||
    "";
  const rawWidth =
    css["-webkit-text-stroke-width"] ||
    css["webkit-text-stroke-width"] ||
    css["webkittextstrokewidth"] ||
    "";
  const rawColor =
    css["-webkit-text-stroke-color"] ||
    css["webkit-text-stroke-color"] ||
    css["webkittextstrokecolor"] ||
    "";

  if (!raw && !rawWidth && !rawColor) {
    if (!settings.strokeEnabled) return { strokeWidth: 0, strokeColor: "#000000" };
    return {
      strokeWidth: Math.max(0, Number(settings.strokeWidth) || 0),
      strokeColor: hexToRgba(settings.strokeColor || "#000000", normalizeOpacity(settings.strokeOpacity, 1)),
    };
  }

  const widthFromRaw = String(raw).match(/-?\d+(?:\.\d+)?px/i);
  const widthFromLonghand = String(rawWidth).match(/-?\d+(?:\.\d+)?/i);
  const strokeWidth = Math.max(
    0,
    Number(
      widthFromLonghand?.[0] ??
        widthFromRaw?.[0]?.replace(/px$/i, "") ??
        0
    ) || 0
  );

  let strokeColor = String(rawColor || "").trim();
  if (!strokeColor) {
    const colorMatch = String(raw).match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-f]{3,8}|[a-z]+)/i);
    strokeColor = colorMatch ? colorMatch[1] : "";
  }
  if (!strokeColor || strokeColor === "initial" || strokeColor === "unset" || strokeColor === "none") {
    strokeColor = "#000000";
  }
  return { strokeWidth, strokeColor };
}

function defaultShadowFromSettings(settings = {}) {
  if (!settings.shadowEnabled) return null;
  return {
    color: hexToRgba(settings.shadowColor || "#000000", normalizeOpacity(settings.shadowOpacity, 0.85)),
    ox: 0,
    oy: 2,
    blur: Math.max(0, Number(settings.shadowSoftness) || 0),
  };
}

function styleFromCss(css, settings) {
  const fontSize = parsePx(css["font-size"], settings.fontSize ?? 48);
  const stroke = parseStroke(css, settings);
  const rawShadow = String(css["text-shadow"] || "").trim();
  const shadow = rawShadow ? parseTextShadow(rawShadow) : defaultShadowFromSettings(settings);
  return {
    color: css.color || settings.fontColor || "#ffffff",
    fontSize,
    fontFamily: resolveFontFamily(parseFontFamily(css["font-family"], settings.fontFamily || "Inter")),
    fontWeight: css["font-weight"] || (settings.bold ? "700" : "400"),
    fontStyle: css["font-style"] || (settings.italic ? "italic" : "normal"),
    opacity: css.opacity != null ? normalizeOpacity(css.opacity, 1) : normalizeOpacity(settings.fontOpacity, 1),
    strokeWidth: stroke.strokeWidth,
    strokeColor: stroke.strokeColor,
    shadow,
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
      const w = measureMixedTextWidth(ctx, word.text, word.style, drawScale);
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

function drawRun(ctx, run, x, y, drawScale, emojiCache = null) {
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

  const emojiSize = emojiAdvancePx(style, drawScale);
  let cursorX = x;
  for (const token of splitEmojiTokens(run.text)) {
    if (token.type === "emoji") {
      const image = emojiCache?.get(token.value) ?? null;
      if (image) {
        ctx.drawImage(image, cursorX, y, emojiSize, emojiSize);
      } else {
        if (style.strokeWidth > 0) {
          ctx.lineWidth = style.strokeWidth * drawScale;
          ctx.strokeStyle = style.strokeColor;
          ctx.lineJoin = "round";
          ctx.strokeText(token.value, cursorX, y);
        }
        ctx.fillStyle = style.color.includes("rgb") ? style.color : hexToRgba(style.color, style.opacity);
        ctx.fillText(token.value, cursorX, y);
      }
      cursorX += emojiSize;
      continue;
    }
    if (!token.value) continue;
    if (style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth * drawScale;
      ctx.strokeStyle = style.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(token.value, cursorX, y);
    }
    ctx.fillStyle = style.color.includes("rgb") ? style.color : hexToRgba(style.color, style.opacity);
    ctx.fillText(token.value, cursorX, y);
    cursorX += ctx.measureText(token.value).width;
  }
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
    width += measureMixedTextWidth(ctx, run.text, run.style, drawScale);
  }
  return width;
}

/**
 * @param {import('canvas').CanvasRenderingContext2D} ctx
 */
export function drawStyledLines(
  ctx,
  wrappedLines,
  { ew, paddingH, drawScale, align, offsetY = 0, emojiCache = null }
) {
  let y = offsetY;
  for (const line of wrappedLines) {
    const lineWidth = measureRunsWidth(ctx, line.runs, drawScale);
    let x = paddingH * drawScale;
    if (align === "center") x = Math.max(paddingH * drawScale, (ew - lineWidth) / 2);
    else if (align === "right") x = Math.max(paddingH * drawScale, ew - paddingH * drawScale - lineWidth);

    for (const run of line.runs) {
      drawRun(ctx, run, x, y, drawScale, emojiCache);
      ctx.font = buildFontString(run.style, drawScale);
      x += measureMixedTextWidth(ctx, run.text, run.style, drawScale);
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
