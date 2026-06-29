import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import express from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JOB_STATUS, RENDER_MODE, RENDER_PHASE } from "../shared/constants.js";
import { enqueueWorkerTask } from "../shared/enqueueWorker.js";
import { segmentObjectPath } from "../shared/renderPlan.js";
import { loadWorkerConfig } from "./config.js";
import { resolveFontFamily } from "./fonts/localFonts.js";
import { JobCancelledError } from "./jobErrors.js";
import { validateProject } from "./validateProject.js";
import { localMediaPath } from "./render/ffmpegScrollEncode.js";
import {
  computeInputHash,
  saveStaging,
  tryLoadStaging,
} from "./render/stagingCache.js";
import { createTimer } from "./timing.js";

const projectId = process.env.GCP_PROJECT_ID;
const bucketName = process.env.GCS_BUCKET || "mm-anton-sandbox-scroller";
const port = Number(process.env.PORT || 8080);

const RECENT_PROCESSING_MS = 5 * 60 * 1000;
const STALE_PROCESSING_MS = 45 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 10_000;

const db = new Firestore({ projectId });
const storage = new Storage({ projectId });
const bucket = storage.bucket(bucketName);

/** @type {Map<string, { ffmpegProc: import('node:child_process').ChildProcess | null }>} */
const activeJobs = new Map();
const lastProgressWrite = new Map();

async function downloadToFile(gcsPath, dest) {
  await bucket.file(gcsPath).download({ destination: dest });
}

async function uploadFile(localPath, gcsPath, contentType) {
  await bucket.upload(localPath, {
    destination: gcsPath,
    metadata: { contentType },
  });
}

async function objectExists(gcsPath) {
  const [exists] = await bucket.file(gcsPath).exists();
  return exists;
}

async function safeUpdateJob(jobId, patch) {
  try {
    const ref = db.collection("renderJobs").doc(jobId);
    const snap = await ref.get();
    if (!snap.exists) return;
    await ref.set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.error("updateJob failed", jobId, err.message || err);
  }
}

function killFfmpeg(jobId) {
  const entry = activeJobs.get(jobId);
  const proc = entry?.ffmpegProc;
  if (proc && !proc.killed) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

async function readJobStatus(jobId) {
  const snap = await db.collection("renderJobs").doc(jobId).get();
  if (!snap.exists) return null;
  return snap.data();
}

async function assertNotCancelled(jobId) {
  const job = await readJobStatus(jobId);
  if (!job) throw new JobCancelledError();
  if (job.status === JOB_STATUS.CANCELLED) {
    killFfmpeg(jobId);
    throw new JobCancelledError();
  }
  return job;
}

function shouldSkipProcessing(job, taskPayload = {}) {
  if (job.status === JOB_STATUS.CANCELLED) return true;
  if (job.status === JOB_STATUS.COMPLETED) return true;

  if (job.renderMode === RENDER_MODE.SEGMENTED) {
    const taskPhase = taskPayload.phase;
    const taskSeg = taskPayload.segmentIndex;
    if (taskPhase === RENDER_PHASE.SEGMENT && taskSeg != null) {
      if (taskSeg < (job.segmentsCompleted || 0)) return true;
      const age = Date.now() - Date.parse(job.updatedAt || 0);
      if (
        job.renderPhase === RENDER_PHASE.SEGMENT &&
        taskSeg === job.currentSegmentIndex &&
        age < RECENT_PROCESSING_MS
      ) {
        return true;
      }
    }
    if (taskPhase === RENDER_PHASE.CONCAT && job.renderPhase === RENDER_PHASE.CONCAT) {
      const age = Date.now() - Date.parse(job.updatedAt || 0);
      if (age < RECENT_PROCESSING_MS && job.progress >= 90) return true;
    }
    if (taskPhase === RENDER_PHASE.PREPARE && job.renderPhase === RENDER_PHASE.PREPARE) {
      const age = Date.now() - Date.parse(job.updatedAt || 0);
      if (age < RECENT_PROCESSING_MS && job.scrollParams) return true;
    }
    return false;
  }

  if (job.status === JOB_STATUS.PROCESSING) {
    const updatedAt = Date.parse(job.updatedAt || job.processingStartedAt || 0);
    const age = Date.now() - updatedAt;
    if (age < RECENT_PROCESSING_MS) return true;
    if (age < STALE_PROCESSING_MS) {
      console.warn("Stale processing job, re-running", job.jobId, age);
      return false;
    }
    console.warn("Very stale processing job, re-running", job.jobId, age);
  }

  return false;
}

async function enqueueNext(jobId, payload) {
  await enqueueWorkerTask(loadWorkerConfig(), jobId, payload);
}

async function downloadJobMedia(job, tmp) {
  const projectPath = job.uploadPaths?.project;
  if (!projectPath) throw new Error("Missing project path");

  const fileMeta = job.fileMeta || {};
  const projectLocal = path.join(tmp, "project.json");
  const downloads = [downloadToFile(projectPath, projectLocal)];

  let backgroundPath = null;
  if (job.uploadPaths?.background) {
    backgroundPath = localMediaPath(tmp, "background", fileMeta);
    downloads.push(downloadToFile(job.uploadPaths.background, backgroundPath));
  }

  let preprocessedBackgroundPath = null;
  if (job.uploadPaths?.preprocessedBackground) {
    preprocessedBackgroundPath = path.join(tmp, "background-processed.jpg");
    downloads.push(downloadToFile(job.uploadPaths.preprocessedBackground, preprocessedBackgroundPath));
  }

  let overlayPath = null;
  if (job.uploadPaths?.overlay) {
    overlayPath = localMediaPath(tmp, "overlay", fileMeta);
    downloads.push(downloadToFile(job.uploadPaths.overlay, overlayPath));
  }

  let musicPath = null;
  if (job.uploadPaths?.music) {
    musicPath = localMediaPath(tmp, "music", fileMeta);
    downloads.push(downloadToFile(job.uploadPaths.music, musicPath));
  }

  let voicePath = null;
  if (job.uploadPaths?.voiceover) {
    voicePath = localMediaPath(tmp, "voiceover", fileMeta);
    downloads.push(downloadToFile(job.uploadPaths.voiceover, voicePath));
  }

  await Promise.all(downloads);
  const project = validateProject(JSON.parse(await readFile(projectLocal, "utf8")));
  return {
    project,
    backgroundPath,
    preprocessedBackgroundPath,
    overlayPath,
    musicPath,
    voicePath,
    fileMeta,
  };
}

function forceJobProgress(jobId, progress, statusMessage) {
  lastProgressWrite.set(jobId, Date.now());
  return safeUpdateJob(jobId, { progress, statusMessage });
}

function makeProgressHandlers(jobId) {
  const onProgress = async (progress, msg) => {
    const last = lastProgressWrite.get(jobId) || 0;
    const nowMs = Date.now();
    if (progress < 100 && nowMs - last < PROGRESS_THROTTLE_MS) return;
    lastProgressWrite.set(jobId, nowMs);
    await assertNotCancelled(jobId);
    await safeUpdateJob(jobId, { progress, statusMessage: msg });
  };

  return {
    onProgress,
    forceProgress: (progress, msg) => forceJobProgress(jobId, progress, msg),
    checkCancelled: () => assertNotCancelled(jobId),
    onFfmpegSpawn: (proc) => {
      const entry = activeJobs.get(jobId);
      if (entry) entry.ffmpegProc = proc;
    },
  };
}

async function processSinglePass(jobId, job, tmp) {
  const { project, backgroundPath, preprocessedBackgroundPath, overlayPath, musicPath, voicePath, fileMeta } =
    await downloadJobMedia(job, tmp);
  const timer = createTimer();
  timer.mark("downloadMs");

  const inputHash = computeInputHash(project, fileMeta);
  let stagedAssets = await tryLoadStaging(bucket, jobId, inputHash, tmp);

  const outputLocal = path.join(tmp, "output.mp4");
  const outputGcs = `exports/${jobId}/output.mp4`;
  const { renderJob } = await import("./render/renderJob.js");
  const { onProgress, checkCancelled, onFfmpegSpawn } = makeProgressHandlers(jobId);

  const result = await renderJob({
    project,
    backgroundPath,
    preprocessedBackgroundPath,
    overlayPath,
    musicPath,
    voicePath,
    outputPath: outputLocal,
    onProgress,
    checkCancelled,
    onFfmpegSpawn,
    stagedAssets,
  });

  timer.mark("renderMs");
  const timings = {
    downloadMs: timer.toObject().downloadMs || 0,
    fontsMs: result.timings?.fontsMs || 0,
    canvasMs: result.timings?.canvasMs || 0,
    ffmpegMs: result.timings?.ffmpegMs || 0,
  };

  if (result.stagingAssets && !stagedAssets) {
    try {
      await saveStaging(bucket, jobId, inputHash, result.stagingAssets);
    } catch (err) {
      console.warn("staging cache save failed", jobId, err.message);
    }
  }

  await assertNotCancelled(jobId);
  await uploadFile(outputLocal, outputGcs, "video/mp4");
  timer.mark("uploadMs");
  timings.uploadMs = timer.toObject().uploadMs || 0;
  timings.totalMs =
    timings.downloadMs + timings.fontsMs + timings.canvasMs + timings.ffmpegMs + timings.uploadMs;

  await safeUpdateJob(jobId, {
    status: JOB_STATUS.COMPLETED,
    progress: 100,
    outputPath: outputGcs,
    error: null,
    statusMessage: null,
    renderPhase: null,
    completedAt: new Date().toISOString(),
    timings,
  });
  console.log("Job completed", jobId, timings);
}

async function processPrepare(jobId, job, tmp) {
  console.log("Prepare phase start", jobId, { segmentCount: job.segmentCount });
  await safeUpdateJob(jobId, {
    status: JOB_STATUS.PROCESSING,
    renderPhase: RENDER_PHASE.PREPARE,
    progress: 5,
    statusMessage: "Preparing render layers…",
  });

  const { onProgress, forceProgress, checkCancelled } = makeProgressHandlers(jobId);

  const renderPlan = {
    segmentCount: job.segmentCount,
    segmentDurationSec: job.segmentDurationSec,
  };

  await forceProgress(6, "Downloading project and media…");
  const { project, backgroundPath, preprocessedBackgroundPath, fileMeta } =
    await downloadJobMedia(job, tmp);
  const inputHash = computeInputHash(project, fileMeta);
  await forceProgress(8, "Building text and background layers…");

  const { prepareRenderAssets } = await import("./render/renderJob.js");
  const workDir = path.join(tmp, "prepare");
  const prepared = await prepareRenderAssets({
    project,
    backgroundPath,
    preprocessedBackgroundPath,
    workDir,
    onProgress: async (p, msg) => onProgress(5 + Math.round(p * 0.2), msg),
    checkCancelled,
    renderPlan,
  });

  await forceProgress(24, "Uploading render layers to cache…");
  await saveStaging(bucket, jobId, inputHash, prepared.stagingAssets);
  console.log("Prepare staging saved", jobId, {
    textHeight: prepared.stagingAssets.textStripHeight,
  });

  await safeUpdateJob(jobId, {
    scrollParams: prepared.scrollParams,
    segmentsCompleted: 0,
    renderPhase: null,
    progress: 25,
    statusMessage: "Starting segmented encode…",
  });

  await enqueueNext(jobId, { phase: RENDER_PHASE.SEGMENT, segmentIndex: 0 });
  console.log("Prepare phase done, enqueued segment 0", jobId);
}

async function processSegment(jobId, job, tmp, segmentIndex) {
  const segmentCount = job.segmentCount || 1;
  const segmentDurationSec = job.segmentDurationSec || 60;
  const scrollParams = job.scrollParams;

  if (!scrollParams) throw new Error("Missing scrollParams for segmented render");

  await safeUpdateJob(jobId, {
    status: JOB_STATUS.PROCESSING,
    renderPhase: RENDER_PHASE.SEGMENT,
    currentSegmentIndex: segmentIndex,
    progress: 25 + Math.round((segmentIndex / segmentCount) * 65),
    statusMessage: `Encoding part ${segmentIndex + 1}/${segmentCount}…`,
  });

  const segmentGcs = segmentObjectPath(jobId, segmentIndex);
  const segmentLocal = path.join(tmp, `segment-${segmentIndex}.mp4`);

  if (!(await objectExists(segmentGcs))) {
    const { project, backgroundPath, preprocessedBackgroundPath, fileMeta } =
      await downloadJobMedia(job, tmp);
    const inputHash = computeInputHash(project, fileMeta);

    let stagedAssets = await tryLoadStaging(bucket, jobId, inputHash, tmp);
    if (!stagedAssets) {
      const workDir = path.join(tmp, "prepare");
      const { prepareRenderAssets } = await import("./render/renderJob.js");
      const prepared = await prepareRenderAssets({
        project,
        backgroundPath,
        preprocessedBackgroundPath,
        workDir,
        checkCancelled: () => assertNotCancelled(jobId),
        renderPlan: { segmentCount, segmentDurationSec },
      });
      stagedAssets = prepared.stagingAssets;
      await saveStaging(bucket, jobId, inputHash, stagedAssets);
    }

    const params = scrollParams || stagedAssets.scrollParams;
    if (!params) throw new Error("Missing scrollParams for segment encode");

    const { encodeRenderSegment } = await import("./render/renderJob.js");
    const { onFfmpegSpawn } = makeProgressHandlers(jobId);

    await encodeRenderSegment({
      stagedAssets,
      scrollParams: params,
      segmentIndex,
      segmentDurationSec,
      outputPath: segmentLocal,
      onFfmpegSpawn,
      onEncodeProgress: (_mapped, pct) => {
        void safeUpdateJob(jobId, {
          statusMessage: `Encoding part ${segmentIndex + 1}/${segmentCount}… ${pct}%`,
        });
      },
    });

    await assertNotCancelled(jobId);
    await uploadFile(segmentLocal, segmentGcs, "video/mp4");
  }

  const segmentsCompleted = segmentIndex + 1;
  await safeUpdateJob(jobId, { segmentsCompleted });

  if (segmentsCompleted >= segmentCount) {
    await enqueueNext(jobId, { phase: RENDER_PHASE.CONCAT });
  } else {
    await enqueueNext(jobId, { phase: RENDER_PHASE.SEGMENT, segmentIndex: segmentIndex + 1 });
  }
}

async function processConcat(jobId, job, tmp) {
  const segmentCount = job.segmentCount || 1;
  const scrollParams = job.scrollParams;
  if (!scrollParams) throw new Error("Missing scrollParams for concat");

  await safeUpdateJob(jobId, {
    status: JOB_STATUS.PROCESSING,
    renderPhase: RENDER_PHASE.CONCAT,
    progress: 90,
    statusMessage: "Stitching segments…",
  });

  const segmentPaths = [];
  for (let i = 0; i < segmentCount; i++) {
    const gcsPath = segmentObjectPath(jobId, i);
    const local = path.join(tmp, `seg-${i}.mp4`);
    await downloadToFile(gcsPath, local);
    segmentPaths.push(local);
  }

  let musicPath = null;
  let voicePath = null;
  if (job.uploadPaths?.music || job.uploadPaths?.voiceover) {
    const fileMeta = job.fileMeta || {};
    if (job.uploadPaths?.music) {
      musicPath = localMediaPath(tmp, "music", fileMeta);
      await downloadToFile(job.uploadPaths.music, musicPath);
    }
    if (job.uploadPaths?.voiceover) {
      voicePath = localMediaPath(tmp, "voiceover", fileMeta);
      await downloadToFile(job.uploadPaths.voiceover, voicePath);
    }
  }

  const settings = job.project?.settings || {};
  const videoOnlyPath = path.join(tmp, "video-only.mp4");
  const concatListPath = path.join(tmp, "segments.txt");
  const outputLocal = path.join(tmp, "output.mp4");
  const outputGcs = `exports/${jobId}/output.mp4`;

  const { concatSegmentsAndMuxAudio } = await import("./render/renderJob.js");
  const { onFfmpegSpawn } = makeProgressHandlers(jobId);

  await concatSegmentsAndMuxAudio({
    segmentPaths,
    outputPath: outputLocal,
    totalDuration: scrollParams.totalDuration,
    musicPath,
    voicePath,
    musicVolume: settings.musicVolume ?? 100,
    voiceVolume: settings.voiceVolume ?? 100,
    musicLoop: settings.musicLoop !== false,
    concatListPath,
    videoOnlyPath,
    onFfmpegSpawn,
    onEncodeProgress: (_pct) => {
      void safeUpdateJob(jobId, { statusMessage: "Stitching segments…" });
    },
  });

  await assertNotCancelled(jobId);
  await uploadFile(outputLocal, outputGcs, "video/mp4");

  await safeUpdateJob(jobId, {
    status: JOB_STATUS.COMPLETED,
    progress: 100,
    outputPath: outputGcs,
    error: null,
    statusMessage: null,
    renderPhase: null,
    completedAt: new Date().toISOString(),
  });
  console.log("Segmented job completed", jobId, segmentCount, "segments");
}

async function processJob(jobId, taskPayload = {}) {
  console.log("processJob start", jobId, taskPayload);
  const ref = db.collection("renderJobs").doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Job not found");
  const job = snap.data();

  if (shouldSkipProcessing(job, taskPayload)) {
    console.log("processJob skipped", jobId, taskPayload, job.status, job.renderPhase);
    return;
  }

  activeJobs.set(jobId, { ffmpegProc: null });
  const now = new Date().toISOString();

  await safeUpdateJob(jobId, {
    status: JOB_STATUS.PROCESSING,
    progress: job.progress || 10,
    processingStartedAt: job.processingStartedAt || now,
    error: null,
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "mm-job-"));
  try {
    await assertNotCancelled(jobId);

    const phase =
      taskPayload.phase ||
      (job.renderMode === RENDER_MODE.SEGMENTED ? RENDER_PHASE.PREPARE : "single");

    if (phase === "single" || job.renderMode === RENDER_MODE.SINGLE || !job.renderMode) {
      await processSinglePass(jobId, job, tmp);
      return;
    }

    if (phase === RENDER_PHASE.PREPARE) {
      await processPrepare(jobId, job, tmp);
      return;
    }

    if (phase === RENDER_PHASE.SEGMENT) {
      const segmentIndex = Number(taskPayload.segmentIndex ?? job.segmentsCompleted ?? 0);
      await processSegment(jobId, job, tmp, segmentIndex);
      return;
    }

    if (phase === RENDER_PHASE.CONCAT) {
      await processConcat(jobId, job, tmp);
      return;
    }

    throw new Error(`Unknown render phase: ${phase}`);
  } catch (err) {
    if (err instanceof JobCancelledError || err.name === "FfmpegCancelledError") {
      const remaining = await readJobStatus(jobId);
      if (!remaining) {
        console.log("Job removed during render", jobId);
        return;
      }
      console.log("Job cancelled", jobId);
      await safeUpdateJob(jobId, {
        status: JOB_STATUS.CANCELLED,
        progress: 0,
        statusMessage: null,
      });
      return;
    }
    console.error("Job failed", jobId, err);
    await safeUpdateJob(jobId, {
      status: JOB_STATUS.FAILED,
      error: err.message || "Render failed",
    });
    throw err;
  } finally {
    killFfmpeg(jobId);
    activeJobs.delete(jobId);
    lastProgressWrite.delete(jobId);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mm-scroller-worker" });
});

app.post("/process", async (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) {
    return res.status(400).json({ error: "jobId required" });
  }
  const taskPayload = {
    phase: req.body?.phase,
    segmentIndex: req.body?.segmentIndex,
  };
  try {
    await processJob(jobId, taskPayload);
    res.json({ ok: true, completed: true, jobId, ...taskPayload });
  } catch (err) {
    if (err instanceof JobCancelledError || err.name === "FfmpegCancelledError") {
      return res.json({ ok: true, cancelled: true, jobId, ...taskPayload });
    }
    console.error("processJob failed", jobId, err);
    res.status(500).json({
      error: err.message || "Render failed",
      jobId,
      ...taskPayload,
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  resolveFontFamily("Inter");
  console.log(`MM-Scroller worker listening on :${port}`);
});

process.on("unhandledRejection", (reason) => {
  if (reason instanceof JobCancelledError || reason?.name === "FfmpegCancelledError") {
    console.log("Ignored expected cancellation rejection:", reason.message || reason);
    return;
  }
  console.error("Unhandled rejection", reason);
});

if (process.env.JOB_ID) {
  processJob(process.env.JOB_ID)
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
