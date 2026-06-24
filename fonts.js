/** Curated Google Fonts for MM-Scroller */
import {
  CURATED_FONTS,
  fontDisplayName,
  findFontByFamily,
  fontCssFamily,
} from "./server/shared/curatedFonts.js";

export { CURATED_FONTS, fontDisplayName, findFontByFamily, fontCssFamily };

const loaded = new Set();
let allFontsPromise = null;
let previewStylesEl = null;

const FALLBACK = {
  sans: "sans-serif",
  serif: "serif",
  cursive: "cursive",
  mono: "monospace",
};

function injectPreviewStyles() {
  if (previewStylesEl) return;
  previewStylesEl = document.createElement("style");
  previewStylesEl.id = "font-picker-preview-styles";
  const rules = CURATED_FONTS.map(
    (f) =>
      `.font-picker [data-font-slug="${f.family}"] { font-family: ${fontCssFamily(f)} !important; }`
  ).join("\n");
  previewStylesEl.textContent = rules;
  document.head.appendChild(previewStylesEl);
}

function applyPreviewFont(el, font) {
  if (!el || !font) return;
  el.dataset.fontSlug = font.family;
  el.style.setProperty("font-family", fontCssFamily(font), "important");
}

async function waitForFontFace(font) {
  const name = fontDisplayName(font);
  const weight = font.weights.includes("400") ? "400" : font.weights.split(";")[0];
  try {
    await document.fonts.load(`${weight} 18px "${name}"`);
  } catch {
    /* ignore */
  }
}

/** Load all curated fonts */
export function loadAllCuratedFonts() {
  if (allFontsPromise) return allFontsPromise;

  injectPreviewStyles();

  const batchSize = 6;
  const batches = [];
  for (let i = 0; i < CURATED_FONTS.length; i += batchSize) {
    batches.push(CURATED_FONTS.slice(i, i + batchSize));
  }

  allFontsPromise = (async () => {
    for (const batch of batches) {
      await new Promise((resolve, reject) => {
        const query = batch
          .map((f) => `family=${f.family}:wght@${f.weights}`)
          .join("&");
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
        link.onload = () => {
          batch.forEach((f) => loaded.add(`${f.family}:${f.weights}`));
          resolve();
        };
        link.onerror = () => reject(new Error("Failed to load font batch"));
        document.head.appendChild(link);
      });
    }

    await Promise.all(CURATED_FONTS.map((f) => waitForFontFace(f)));
    if (document.fonts?.ready) await document.fonts.ready;
  })();

  return allFontsPromise;
}

export function loadGoogleFont(familySlug, weights = "400;700") {
  const key = `${familySlug}:${weights}`;
  if (loaded.has(key)) return Promise.resolve();
  const font = CURATED_FONTS.find((f) => f.family === familySlug);
  if (font) return loadAllCuratedFonts().then(() => waitForFontFace(font));
  return loadAllCuratedFonts();
}

function findFontBySlug(slug) {
  return CURATED_FONTS.find((f) => f.family === slug);
}

/**
 * Custom font picker — each name rendered in its typeface.
 */
export function initFontPicker(container, onChange) {
  if (!container) return;

  container.classList.add("font-picker");
  container.innerHTML = `
    <button type="button" class="font-picker-trigger" disabled aria-haspopup="listbox" aria-expanded="false">Loading fonts…</button>
    <ul class="font-picker-list hidden" role="listbox" tabindex="-1"></ul>
  `;

  const trigger = container.querySelector(".font-picker-trigger");
  const list = container.querySelector(".font-picker-list");

  CURATED_FONTS.forEach((font, i) => {
    const li = document.createElement("li");
    li.role = "option";
    li.dataset.slug = font.family;
    li.dataset.weights = font.weights;
    li.textContent = font.name;
    applyPreviewFont(li, font);
    if (i === 0) {
      li.classList.add("is-selected");
      li.setAttribute("aria-selected", "true");
    }
    list.appendChild(li);
  });

  let selected = CURATED_FONTS[0];
  let fontsReady = false;

  function setSelected(font) {
    selected = font;
    trigger.textContent = font.name;
    applyPreviewFont(trigger, font);
    list.querySelectorAll("li").forEach((li) => {
      const fontItem = findFontBySlug(li.dataset.slug);
      const on = fontItem?.family === font.family;
      li.classList.toggle("is-selected", on);
      li.setAttribute("aria-selected", on ? "true" : "false");
      if (fontItem) applyPreviewFont(li, fontItem);
    });
  }

  function closeList() {
    list.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  }

  function openList() {
    if (!fontsReady) return;
    list.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    list.querySelectorAll("li").forEach((li) => {
      const fontItem = findFontBySlug(li.dataset.slug);
      if (fontItem) applyPreviewFont(li, fontItem);
    });
    const current = list.querySelector(".is-selected");
    if (current) current.scrollIntoView({ block: "nearest" });
  }

  function pickFont(font) {
    setSelected(font);
    closeList();
    waitForFontFace(font).then(() => onChange(font));
  }

  trigger.addEventListener("click", () => {
    if (!fontsReady) return;
    if (list.classList.contains("hidden")) openList();
    else closeList();
  });

  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const font = findFontBySlug(li.dataset.slug);
    if (font) pickFont(font);
  });

  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) closeList();
  });

  loadAllCuratedFonts()
    .then(() => {
      fontsReady = true;
      trigger.disabled = false;
      setSelected(selected);
      onChange(selected);
    })
    .catch(() => {
      fontsReady = true;
      trigger.disabled = false;
      trigger.textContent = "Inter";
      setSelected(CURATED_FONTS[0]);
      onChange(CURATED_FONTS[0]);
    });

  return {
    setFontByFamily(familyName) {
      const font = findFontByFamily(familyName);
      if (font) setSelected(font);
    },
  };
}
