export const DESIGN_LONG_EDGE = 1920;
export const EXPORT_FPS = 30;
export const EXPORT_SHORT_EDGE = 1080;

export function evenDimension(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

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
