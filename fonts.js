/** Curated Google Fonts for ScrollDrop */
export const CURATED_FONTS = [
  { name: "Inter", family: "Inter", weights: "400;600;700" },
  { name: "Roboto", family: "Roboto", weights: "400;700" },
  { name: "Open Sans", family: "Open+Sans", weights: "400;700" },
  { name: "Lato", family: "Lato", weights: "400;700" },
  { name: "Montserrat", family: "Montserrat", weights: "400;600;700" },
  { name: "Playfair Display", family: "Playfair+Display", weights: "400;700" },
  { name: "Oswald", family: "Oswald", weights: "400;600" },
  { name: "Bebas Neue", family: "Bebas+Neue", weights: "400" },
  { name: "Merriweather", family: "Merriweather", weights: "400;700" },
  { name: "Source Code Pro", family: "Source+Code+Pro", weights: "400;600" },
];

const loaded = new Set();

/**
 * Inject a Google Fonts stylesheet for the given family slug.
 * @param {string} familySlug - e.g. "Playfair+Display"
 * @param {string} weights - e.g. "400;700"
 */
export function loadGoogleFont(familySlug, weights = "400;700") {
  const key = `${familySlug}:${weights}`;
  if (loaded.has(key)) return Promise.resolve();
  loaded.add(key);

  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${familySlug}:wght@${weights}&display=swap`;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error(`Failed to load font: ${familySlug}`));
    document.head.appendChild(link);
  });
}

/**
 * Populate a &lt;select&gt; with curated font options.
 * @param {HTMLSelectElement} select
 * @param {(font: typeof CURATED_FONTS[0]) => void} onChange
 */
export function initFontPicker(select, onChange) {
  CURATED_FONTS.forEach((font, i) => {
    const opt = document.createElement("option");
    opt.value = font.family.replace(/\+/g, " ");
    opt.textContent = font.name;
    opt.dataset.slug = font.family;
    opt.dataset.weights = font.weights;
    select.appendChild(opt);
    if (i === 0) select.value = opt.value;
  });

  const first = CURATED_FONTS[0];
  loadGoogleFont(first.family, first.weights).then(() => onChange(first));

  select.addEventListener("change", () => {
    const opt = select.selectedOptions[0];
    const slug = opt.dataset.slug;
    const weights = opt.dataset.weights;
    const font = CURATED_FONTS.find((f) => f.family === slug);
    if (!font) return;
    loadGoogleFont(slug, weights).then(() => onChange(font));
  });
}
