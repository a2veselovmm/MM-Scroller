import { validateProjectFonts } from "./fontValidation.js";
import { PROJECT_FORMAT_VERSION, LIMITS } from "./constants.js";
import { estimateProjectDurationSec } from "./duration.js";
import { badRequest } from "./httpError.js";

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function parseProjectDocument(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw);
    } catch {
      throw badRequest("Invalid JSON.");
    }
  }
  if (!doc || typeof doc !== "object") {
    throw badRequest("Invalid setup file.");
  }
  const meta = doc.scrolldrop;
  if (!meta || typeof meta !== "object") {
    throw badRequest("Not an MM-Scroller setup file (missing scrolldrop metadata).");
  }
  const version = Number(meta.version);
  if (Number.isFinite(version) && version > PROJECT_FORMAT_VERSION) {
    throw badRequest(
      `Setup version ${version} is newer than supported (v${PROJECT_FORMAT_VERSION}).`
    );
  }
  if (!doc.settings || typeof doc.settings !== "object") {
    throw badRequest("Missing settings.");
  }
  if (!doc.text || typeof doc.text !== "object") {
    throw badRequest("Missing text.");
  }
  if (!doc.timeline || typeof doc.timeline !== "object") {
    throw badRequest("Missing timeline.");
  }
  if (doc.media && typeof doc.media !== "object") {
    throw badRequest("Invalid media block.");
  }
  if (meta.embedMedia === true && doc.media) {
    for (const key of ["background", "music", "voiceover"]) {
      const item = doc.media[key];
      if (item?.dataUrl && !String(item.dataUrl).startsWith("data:")) {
        throw badRequest(`Media ${key} must use embedded data URLs only.`);
      }
    }
  }
  return doc;
}

/**
 * @param {object} doc
 * @param {{ totalUploadBytes?: number }} opts
 */
export function validateProjectForQueue(doc, opts = {}) {
  parseProjectDocument(doc);
  validateProjectFonts(doc);
  const jsonBytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (jsonBytes > LIMITS.maxProjectJsonBytes) {
    throw badRequest(`Project JSON exceeds ${LIMITS.maxProjectJsonBytes} bytes.`);
  }
  const totalUpload = opts.totalUploadBytes ?? 0;
  if (totalUpload > LIMITS.maxTotalBytes) {
    throw badRequest(`Total upload exceeds ${LIMITS.maxTotalBytes} bytes.`);
  }
  const duration = estimateProjectDurationSec(doc.settings, doc.timeline, doc.text);
  if (duration > LIMITS.maxDurationSec) {
    throw badRequest(
      `Estimated duration ${duration.toFixed(1)}s exceeds ${LIMITS.maxDurationSec}s cap.`
    );
  }
  return { durationSec: duration, jsonBytes };
}
