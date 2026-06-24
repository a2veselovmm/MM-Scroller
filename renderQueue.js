/**
 * Non-blocking cloud render queue — background polling and local job tracking.
 */

import {
  createAndUploadCloudJob,
  fetchJobs,
  cancelCloudJob,
  retryCloudJob,
  deleteCloudJob,
} from "./cloudExport.js";

const STORAGE_KEY = "mm-scroller-tracked-jobs";
const POLL_MS = 3000;

const ACTIVE_STATUSES = new Set([
  "created",
  "uploading",
  "queued",
  "processing",
  "queued_for_render",
]);

/** @type {Set<(jobs: object[]) => void>} */
const listeners = new Set();
let pollTimer = null;
let pollOpts = null;

function readTrackedIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeTrackedIds(ids) {
  const unique = [...new Set(ids)].slice(0, 100);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(unique));
  return unique;
}

export function untrackJobId(jobId) {
  if (!jobId) return;
  writeTrackedIds(readTrackedIds().filter((id) => id !== jobId));
}

export function trackJobId(jobId) {
  if (!jobId) return;
  writeTrackedIds([jobId, ...readTrackedIds()]);
}

function notify(jobs) {
  for (const fn of listeners) {
    try {
      fn(jobs);
    } catch (err) {
      console.error("renderQueue listener error", err);
    }
  }
}

function isActive(status) {
  return ACTIVE_STATUSES.has(status);
}

function groupJobs(jobs) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const active = [];
  const today = [];
  const last7 = [];

  for (const job of jobs) {
    const created = new Date(job.createdAt || 0);
    if (isActive(job.status)) active.push(job);
    else if (created >= startOfToday) today.push(job);
    else if (created >= weekAgo) last7.push(job);
  }

  return { active, today, last7, all: jobs };
}

async function pollOnce() {
  if (!pollOpts) return;
  try {
    const ids = readTrackedIds();
    const data = await fetchJobs({ ...pollOpts, ids });
    const jobs = data.jobs || [];
    notify(groupJobs(jobs));

    const hasActive = jobs.some((j) => isActive(j.status));
    if (!hasActive && ids.length === 0) {
      stopPolling();
    }
  } catch (err) {
    console.error("renderQueue poll failed", err);
  }
}

export function ensurePolling() {
  if (!pollOpts || pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}

export function startPolling(opts) {
  pollOpts = opts;
  const ids = readTrackedIds();
  if (ids.length > 0) ensurePolling();
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function onQueueUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Upload, enqueue, and track a cloud render. Non-blocking after upload completes.
 */
export async function startCloudRender(opts) {
  const result = await createAndUploadCloudJob(opts);
  trackJobId(result.jobId);
  ensurePolling();
  return result;
}

export async function cancelJob(jobId, opts) {
  await cancelCloudJob(jobId, opts);
  if (pollOpts) await pollOnce();
}

export async function deleteJob(jobId, opts) {
  await deleteCloudJob(jobId, opts);
  untrackJobId(jobId);
  if (pollOpts) await pollOnce();
}

export async function retryJob(jobId, opts) {
  await retryCloudJob(jobId, opts);
  trackJobId(jobId);
  if (pollOpts) await pollOnce();
}

export function triggerDownload(downloadUrl, fileName = "scrolldrop-export.mp4") {
  if (!downloadUrl) return;
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = fileName;
  a.rel = "noopener";
  a.click();
}

export { groupJobs, isActive, readTrackedIds };
