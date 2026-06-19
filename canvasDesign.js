/** Long edge of the logical canvas (scroll coordinates), in px. */
export const DESIGN_LONG_EDGE = 1920;

/** Fixed export frame rate (non-configurable). */
export const EXPORT_FPS = 30;

/** 1080p short edge — portrait/square use 1080px width; landscape uses 1080px height. */
export const EXPORT_SHORT_EDGE = 1080;

export function evenDimension(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * Fixed 1080p output size for the chosen aspect ratio.
 * @param {string} aspectRatio e.g. "9/16"
 */
export function getExportCanvasSize(aspectRatio = "9/16") {
  const [aw, ah] = aspectRatio.split("/").map((x) => parseFloat(x) || 1);
  if (aw >= ah) {
    const height = EXPORT_SHORT_EDGE;
    return {
      width: evenDimension((height * aw) / ah),
      height: evenDimension(height),
    };
  }
  const width = EXPORT_SHORT_EDGE;
  return {
    width: evenDimension(width),
    height: evenDimension((width * ah) / aw),
  };
}

/**
 * Fixed design size for the chosen aspect ratio (preview + scroll coordinates).
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
