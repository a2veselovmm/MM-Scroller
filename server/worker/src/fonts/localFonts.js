import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerFont } from "canvas";
import { findFontByFamily, fontDisplayName, resolveCuratedFamily } from "../../shared/curatedFonts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR =
  process.env.MM_FONTS_DIR || path.join(__dirname, "../../assets/fonts");

const registered = new Set();
let initDone = false;

function fontFileBase(displayName) {
  return displayName.replace(/\s+/g, "-");
}

function initLocalFonts() {
  if (initDone) return;
  initDone = true;

  if (!existsSync(FONTS_DIR)) {
    console.warn("Local fonts directory missing:", FONTS_DIR);
    return;
  }

  for (const file of readdirSync(FONTS_DIR)) {
    if (!file.endsWith(".ttf")) continue;
    const match = file.match(/^(.+)-(\d{3})\.ttf$/);
    if (!match) continue;
    const family = match[1].replace(/-/g, " ");
    const weight = Number(match[2]) || 400;
    const fontPath = path.join(FONTS_DIR, file);
    try {
      registerFont(fontPath, { family, weight });
      registered.add(`${family}:${weight}`);
    } catch (err) {
      console.warn("registerFont failed", file, err.message);
    }
  }

  console.log(`Registered ${registered.size} local font files from ${FONTS_DIR}`);
}

/**
 * @param {string} familyName
 * @returns {string}
 */
export function resolveFontFamily(familyName) {
  initLocalFonts();
  const curated = resolveCuratedFamily(familyName);
  if (curated) return curated;
  return "DejaVu Sans";
}

/**
 * @param {object} text
 * @param {object} settings
 */
export async function ensureFontsForProject(text, settings) {
  initLocalFonts();
  const families = new Set([settings.fontFamily || "Inter"]);
  if (text.editMode !== "plain" && text.styledHtml) {
    const re = /font-family:\s*([^;"']+)/gi;
    let match;
    while ((match = re.exec(text.styledHtml))) {
      const name = match[1].split(",")[0].trim().replace(/['"]/g, "");
      if (name) families.add(name);
    }
  }
  for (const family of families) {
    const curated = findFontByFamily(family);
    if (!curated) {
      throw new Error(`Font "${family}" is not in the curated font list.`);
    }
    const display = fontDisplayName(curated);
    const hasWeight = [...registered].some((k) => k.startsWith(`${display}:`));
    if (!hasWeight && registered.size > 0) {
      console.warn(`Local font file missing for ${display}, using DejaVu Sans fallback`);
    }
  }
}
