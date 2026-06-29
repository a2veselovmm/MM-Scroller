/**
 * Serialize / download MM-Scroller project state as JSON.
 */

export const PROJECT_FORMAT_VERSION = 1;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read media for project file."));
    reader.readAsDataURL(blob);
  });
}

async function urlToDataPayload(url, fileName, extra = {}) {
  if (!url) return null;
  const res = await fetch(url);
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  return {
    fileName: fileName || "media",
    mimeType: blob.type || "application/octet-stream",
    sizeBytes: blob.size,
    dataUrl,
    ...extra,
  };
}

function cleanBgFileName(label) {
  if (!label || label.startsWith("No file") || label.includes("failed")) {
    return null;
  }
  return label.replace(/ \(decoding…\)$/, "").trim();
}

/**
 * @param {object} payload
 * @returns {Promise<object>}
 */
export async function buildProjectDocument(payload) {
  const embedMedia = payload.embedMedia !== false;
  return {
    scrolldrop: {
      version: PROJECT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      app: "MM-Scroller",
      exportKind: "setup",
      embedMedia,
    },
    settings: payload.settings,
    text: payload.text,
    media: payload.media,
    timeline: payload.timeline,
    ui: payload.ui,
  };
}

export function estimateProjectSize(doc) {
  let bytes = 0;
  const bg = doc.media?.background?.dataUrl;
  const overlay = doc.media?.overlay?.dataUrl;
  const music = doc.media?.music?.dataUrl;
  const voice = doc.media?.voiceover?.dataUrl;
  if (typeof bg === "string") bytes += bg.length;
  if (typeof overlay === "string") bytes += overlay.length;
  if (typeof music === "string") bytes += music.length;
  if (typeof voice === "string") bytes += voice.length;
  bytes += JSON.stringify(doc).length;
  return bytes;
}

export function downloadProjectJson(doc, filename = "scrolldrop-project.json") {
  const json = JSON.stringify(doc, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {string | object} raw
 * @returns {object}
 */
export function parseProjectDocument(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON file.");
    }
  }
  if (!doc || typeof doc !== "object") {
    throw new Error("Invalid setup file.");
  }
  const meta = doc.scrolldrop;
  if (!meta || typeof meta !== "object") {
    throw new Error("Not an MM-Scroller setup file (missing scrolldrop metadata).");
  }
  const version = Number(meta.version);
  if (Number.isFinite(version) && version > PROJECT_FORMAT_VERSION) {
    throw new Error(
      `Setup version ${version} is newer than this app supports (v${PROJECT_FORMAT_VERSION}).`
    );
  }
  return doc;
}

/**
 * @param {{ dataUrl: string, fileName?: string, mimeType?: string }} payload
 * @returns {Promise<File>}
 */
export async function dataUrlToFile(payload) {
  if (!payload?.dataUrl) {
    throw new Error("Media payload has no embedded data.");
  }
  const res = await fetch(payload.dataUrl);
  const blob = await res.blob();
  return new File(
    [blob],
    payload.fileName || "media",
    { type: payload.mimeType || blob.type || "application/octet-stream" }
  );
}

export { urlToDataPayload, cleanBgFileName, blobToDataUrl };
