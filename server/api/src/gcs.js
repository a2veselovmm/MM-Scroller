import { Storage } from "@google-cloud/storage";
import { LIMITS } from "../shared/constants.js";

let storage = null;

function getStorage() {
  if (!storage) {
    storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
  }
  return storage;
}

export function getBucket(config) {
  return getStorage().bucket(config.bucket);
}

export function jobPrefix(jobId) {
  return `uploads/${jobId}`;
}

export function exportPrefix(jobId) {
  return `exports/${jobId}`;
}

export function exportObjectPath(jobId) {
  return `exports/${jobId}/output.mp4`;
}

export function segmentObjectPath(jobId, index) {
  return `exports/${jobId}/segments/${index}.mp4`;
}

export function projectObjectPath(jobId) {
  return `${jobPrefix(jobId)}/project.json`;
}

export function mediaObjectPath(jobId, field, fileName) {
  const safe = String(fileName || field).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${jobPrefix(jobId)}/media/${field}/${safe}`;
}

export function preprocessedBackgroundPath(jobId) {
  return `${jobPrefix(jobId)}/media/background/processed.jpg`;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export async function signedUploadUrl(config, objectPath, contentType) {
  const [url] = await getBucket(config).file(objectPath).getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + LIMITS.uploadUrlTtlMs,
    contentType: contentType || "application/octet-stream",
  });
  return url;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export async function signedDownloadUrl(config, objectPath) {
  const [url] = await getBucket(config).file(objectPath).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + LIMITS.downloadUrlTtlMs,
  });
  return url;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export async function objectExists(config, objectPath) {
  const [exists] = await getBucket(config).file(objectPath).exists();
  return exists;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export async function writeProjectJson(config, jobId, doc) {
  const path = projectObjectPath(jobId);
  await getBucket(config).file(path).save(JSON.stringify(doc), {
    contentType: "application/json",
  });
  return path;
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export async function writeObject(config, objectPath, data, contentType) {
  await getBucket(config).file(objectPath).save(data, {
    contentType: contentType || "application/octet-stream",
    resumable: false,
  });
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {string} objectPath
 * @returns {Promise<Buffer>}
 */
export async function readObject(config, objectPath) {
  const [buf] = await getBucket(config).file(objectPath).download();
  return buf;
}

/**
 * Delete export artifacts (segments + output) for a job retry.
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {string} jobId
 */
export async function deleteExportArtifacts(config, jobId) {
  const bucket = getBucket(config);
  await bucket.deleteFiles({ prefix: `${exportPrefix(jobId)}/` }).catch(() => {});
}

/**
 * Delete all upload and export objects for a job.
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {string} jobId
 */
export async function deleteJobObjects(config, jobId) {
  const bucket = getBucket(config);
  await Promise.all([
    bucket.deleteFiles({ prefix: `${jobPrefix(jobId)}/` }).catch(() => {}),
    bucket.deleteFiles({ prefix: `${exportPrefix(jobId)}/` }).catch(() => {}),
    bucket.deleteFiles({ prefix: `staging/${jobId}/` }).catch(() => {}),
  ]);
}
