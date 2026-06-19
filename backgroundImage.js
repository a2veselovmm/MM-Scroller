import { getDesignCanvasSize } from "./canvasDesign.js";

/**
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load background image."));
    img.src = url;
  });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} img
 * @param {number} w
 * @param {number} h
 * @param {string} fit
 */
export function drawImageFit(ctx, img, w, h, fit = "cover") {
  const mw = img.naturalWidth || img.width;
  const mh = img.naturalHeight || img.height;
  if (!mw || !mh) return;

  let dw = w;
  let dh = h;
  let dx = 0;
  let dy = 0;

  if (fit === "contain") {
    const s = Math.min(w / mw, h / mh);
    dw = mw * s;
    dh = mh * s;
    dx = (w - dw) / 2;
    dy = (h - dh) / 2;
  } else if (fit === "fill") {
    dw = w;
    dh = h;
  } else {
    const s = Math.max(w / mw, h / mh);
    dw = mw * s;
    dh = mh * s;
    dx = (w - dw) / 2;
    dy = (h - dh) / 2;
  }

  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * Downscale a background to design canvas pixels (cover/contain/fill baked in).
 * Returns null when the source is already small enough.
 *
 * @param {HTMLImageElement} img
 * @param {string} aspectRatio
 * @param {string} fitMode
 * @param {number} [quality]
 * @returns {Promise<string | null>} blob URL or null to keep original
 */
export async function rasterizeBackgroundToCanvasSize(
  img,
  aspectRatio,
  fitMode = "cover",
  quality = 0.9
) {
  const { width, height } = getDesignCanvasSize(aspectRatio);
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;

  if (nw <= width && nh <= height) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  drawImageFit(ctx, img, width, height, fitMode);

  const mime = "image/jpeg";
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Could not optimize background image."))),
      mime,
      quality
    );
  });

  return URL.createObjectURL(blob);
}
