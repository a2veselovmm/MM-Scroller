import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function computeInputHash(project, fileMeta = {}) {
  const h = createHash("sha256");
  h.update(JSON.stringify(project));
  for (const field of ["background", "music", "voiceover"]) {
    const meta = fileMeta[field];
    if (meta) h.update(`${field}:${meta.fileName}:${meta.sizeBytes}`);
  }
  return h.digest("hex");
}

/**
 * @param {import("@google-cloud/storage").Bucket} bucket
 * @param {string} jobId
 * @param {string} inputHash
 */
export async function tryLoadStaging(bucket, jobId, inputHash, tmpDir) {
  const prefix = `staging/${jobId}/`;
  const metaPath = `${prefix}meta.json`;
  try {
    const [metaBuf] = await bucket.file(metaPath).download();
    const meta = JSON.parse(metaBuf.toString("utf8"));
    if (meta.inputHash !== inputHash) return null;

    const bgLocal = path.join(tmpDir, "bg.jpg");
    const textLocal = path.join(tmpDir, "text.raw");
    await bucket.file(`${prefix}bg.jpg`).download({ destination: bgLocal });
    await bucket.file(`${prefix}text.raw`).download({ destination: textLocal });

    return {
      bgImagePath: bgLocal,
      textStripPath: textLocal,
      textStripWidth: meta.textWidth,
      textStripHeight: meta.textHeight,
      textStripIsRaw: true,
      scrollParams: meta.scrollParams || null,
      renderPlan: meta.renderPlan || null,
    };
  } catch {
    return null;
  }
}

/**
 * @param {import("@google-cloud/storage").Bucket} bucket
 * @param {string} jobId
 * @param {string} inputHash
 * @param {{ bgImagePath: string, textStripPath: string, textStripWidth: number, textStripHeight: number, scrollParams?: object, renderPlan?: object }} assets
 */
export async function saveStaging(bucket, jobId, inputHash, assets) {
  const prefix = `staging/${jobId}/`;
  const meta = {
    inputHash,
    textWidth: assets.textStripWidth,
    textHeight: assets.textStripHeight,
    savedAt: new Date().toISOString(),
  };
  if (assets.scrollParams) meta.scrollParams = assets.scrollParams;
  if (assets.renderPlan) meta.renderPlan = assets.renderPlan;
  await bucket.file(`${prefix}meta.json`).save(JSON.stringify(meta), {
    contentType: "application/json",
  });
  await bucket.upload(assets.bgImagePath, {
    destination: `${prefix}bg.jpg`,
    metadata: { contentType: "image/jpeg" },
  });
  await bucket.upload(assets.textStripPath, {
    destination: `${prefix}text.raw`,
    metadata: { contentType: "application/octet-stream" },
  });
}
