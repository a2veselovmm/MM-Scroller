/**
 * Serialize / download ScrollDrop project state as JSON.
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
  return {
    scrolldrop: {
      version: PROJECT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      app: "ScrollDrop",
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
  const audio = doc.media?.audio?.dataUrl;
  if (typeof bg === "string") bytes += bg.length;
  if (typeof audio === "string") bytes += audio.length;
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

export { urlToDataPayload, cleanBgFileName, blobToDataUrl };
