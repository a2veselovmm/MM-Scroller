#!/usr/bin/env node
/**
 * Download curated font TTF files for the worker image.
 * Usage: node server/scripts/fetch-fonts.mjs [outputDir]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CURATED_FONTS, fontDisplayName } from "../shared/curatedFonts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir =
  process.argv[2] || path.join(__dirname, "../worker/assets/fonts");

async function downloadFontFile(familySlug, weight) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${familySlug}:wght@${weight}&display=swap`;
  const cssRes = await fetch(cssUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MM-Scroller/1.0)" },
  });
  if (!cssRes.ok) throw new Error(`CSS fetch failed ${familySlug} ${weight}`);
  const css = await cssRes.text();
  const ttfMatch = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.ttf)\)/);
  const url = ttfMatch?.[1] || css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1];
  if (!url) throw new Error(`No font URL for ${familySlug} ${weight}`);
  const fontRes = await fetch(url);
  if (!fontRes.ok) throw new Error(`Font download failed ${url}`);
  return Buffer.from(await fontRes.arrayBuffer());
}

async function main() {
  await mkdir(outDir, { recursive: true });
  let ok = 0;
  let fail = 0;

  for (const font of CURATED_FONTS) {
    const slug = font.family;
    const display = fontDisplayName(font);
    const safeSlug = display.replace(/\s+/g, "-");
    const weights = [...new Set(font.weights.split(";").map((w) => w.trim()))];

    for (const weight of weights) {
      const dest = path.join(outDir, `${safeSlug}-${weight}.ttf`);
      try {
        const buf = await downloadFontFile(slug, weight);
        await writeFile(dest, buf);
        ok += 1;
        console.log(`OK ${display} ${weight}`);
      } catch (err) {
        fail += 1;
        console.warn(`SKIP ${display} ${weight}: ${err.message}`);
      }
    }
  }

  console.log(`Fonts: ${ok} saved, ${fail} skipped → ${outDir}`);
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
