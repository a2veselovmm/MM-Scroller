import { findFontByFamily } from "./curatedFonts.js";
import { badRequest } from "./httpError.js";

const SKIP_FONT_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "apple color emoji",
  "segoe ui emoji",
  "noto color emoji",
]);

function normalizeFontName(name) {
  return String(name || "")
    .trim()
    .replace(/['"]/g, "")
    .toLowerCase();
}

function shouldSkipFontFamily(name) {
  return SKIP_FONT_FAMILIES.has(normalizeFontName(name));
}

/**
 * @param {object} doc
 * @returns {string[]}
 */
export function collectProjectFontFamilies(doc) {
  const families = new Set();
  const settings = doc.settings || {};
  const text = doc.text || {};

  const primary = settings.fontFamily || "Inter";
  if (!shouldSkipFontFamily(primary)) families.add(primary);

  if (text.styledHtml && String(text.styledHtml).trim()) {
    const re = /font-family:\s*([^;"']+)/gi;
    let match;
    while ((match = re.exec(text.styledHtml))) {
      const name = match[1].split(",")[0].trim().replace(/['"]/g, "");
      if (name && !shouldSkipFontFamily(name)) families.add(name);
    }
  }

  return [...families];
}

/**
 * @param {object} doc
 */
export function validateProjectFonts(doc) {
  for (const family of collectProjectFontFamilies(doc)) {
    if (!findFontByFamily(family)) {
      throw badRequest(
        `Font "${family}" is not supported. Choose a font from the curated list.`
      );
    }
  }
}
