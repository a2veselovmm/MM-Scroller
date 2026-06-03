/** Long edge of the logical canvas (export coordinates), in px. */
export const DESIGN_LONG_EDGE = 1920;

export function evenDimension(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * Fixed design size for the chosen aspect ratio (preview + export coordinates).
 * @param {string} aspectRatio e.g. "9/16"
 */
export function getDesignCanvasSize(aspectRatio = "9/16") {
  const [aw, ah] = aspectRatio.split("/").map((x) => parseFloat(x) || 1);
  if (aw >= ah) {
    const width = DESIGN_LONG_EDGE;
    return {
      width: evenDimension(width),
      height: evenDimension((width * ah) / aw),
    };
  }
  const height = DESIGN_LONG_EDGE;
  return {
    width: evenDimension((height * aw) / ah),
    height: evenDimension(height),
  };
}
