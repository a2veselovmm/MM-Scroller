import sharp from "sharp";
import { getExportCanvasSize } from "../shared/canvasDesign.js";

/**
 * Resize/crop background to export dimensions as JPEG.
 * @param {Buffer} input
 * @param {string} aspectRatio
 * @returns {Promise<Buffer>}
 */
export async function preprocessBackgroundBuffer(input, aspectRatio = "9/16") {
  const { width, height } = getExportCanvasSize(aspectRatio);
  return sharp(input)
    .resize(width, height, { fit: "cover", position: "centre" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
