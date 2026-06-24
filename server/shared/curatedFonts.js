/** Curated Google Fonts for MM-Scroller (shared by UI, API, worker). */
export const CURATED_FONTS = [
  { name: "Inter", family: "Inter", weights: "400;600;700", category: "sans" },
  { name: "Roboto", family: "Roboto", weights: "400;700", category: "sans" },
  { name: "Open Sans", family: "Open+Sans", weights: "400;700", category: "sans" },
  { name: "Lato", family: "Lato", weights: "400;700", category: "sans" },
  { name: "Montserrat", family: "Montserrat", weights: "400;600;700", category: "sans" },
  { name: "Poppins", family: "Poppins", weights: "400;600;700", category: "sans" },
  { name: "Raleway", family: "Raleway", weights: "400;700", category: "sans" },
  { name: "Nunito", family: "Nunito", weights: "400;700", category: "sans" },
  { name: "Ubuntu", family: "Ubuntu", weights: "400;700", category: "sans" },
  { name: "Rubik", family: "Rubik", weights: "400;600;700", category: "sans" },
  { name: "Work Sans", family: "Work+Sans", weights: "400;600;700", category: "sans" },
  { name: "DM Sans", family: "DM+Sans", weights: "400;700", category: "sans" },
  { name: "Fira Sans", family: "Fira+Sans", weights: "400;600;700", category: "sans" },
  { name: "Barlow", family: "Barlow", weights: "400;600;700", category: "sans" },
  { name: "Oswald", family: "Oswald", weights: "400;600;700", category: "sans" },
  { name: "Bebas Neue", family: "Bebas+Neue", weights: "400", category: "sans" },
  { name: "Anton", family: "Anton", weights: "400", category: "sans" },
  { name: "Archivo Black", family: "Archivo+Black", weights: "400", category: "sans" },
  { name: "Playfair Display", family: "Playfair+Display", weights: "400;700", category: "serif" },
  { name: "Merriweather", family: "Merriweather", weights: "400;700", category: "serif" },
  { name: "Libre Baskerville", family: "Libre+Baskerville", weights: "400;700", category: "serif" },
  { name: "Cormorant Garamond", family: "Cormorant+Garamond", weights: "400;600;700", category: "serif" },
  { name: "Cinzel", family: "Cinzel", weights: "400;600;700", category: "serif" },
  { name: "Spectral", family: "Spectral", weights: "400;600;700", category: "serif" },
  { name: "Abril Fatface", family: "Abril+Fatface", weights: "400", category: "serif" },
  { name: "Pacifico", family: "Pacifico", weights: "400", category: "cursive" },
  { name: "Dancing Script", family: "Dancing+Script", weights: "400;700", category: "cursive" },
  { name: "Caveat", family: "Caveat", weights: "400;700", category: "cursive" },
  { name: "Lobster", family: "Lobster", weights: "400", category: "cursive" },
  { name: "Permanent Marker", family: "Permanent+Marker", weights: "400", category: "cursive" },
  { name: "Source Code Pro", family: "Source+Code+Pro", weights: "400;600", category: "mono" },
  { name: "JetBrains Mono", family: "JetBrains+Mono", weights: "400;700", category: "mono" },
];

const FALLBACK = {
  sans: "sans-serif",
  serif: "serif",
  cursive: "cursive",
  mono: "monospace",
};

export function fontDisplayName(font) {
  return font.family.replace(/\+/g, " ");
}

export function findFontByFamily(familyName) {
  const primary = String(familyName || "")
    .replace(/['"]/g, "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return (
    CURATED_FONTS.find(
      (f) =>
        fontDisplayName(f).toLowerCase() === primary ||
        f.name.toLowerCase() === primary
    ) || null
  );
}

export function fontCssFamily(font) {
  const name = fontDisplayName(font);
  const fb = FALLBACK[font.category] || "sans-serif";
  return `"${name}", ${fb}`;
}

export function resolveCuratedFamily(familyName) {
  const font = findFontByFamily(familyName);
  return font ? fontDisplayName(font) : null;
}
