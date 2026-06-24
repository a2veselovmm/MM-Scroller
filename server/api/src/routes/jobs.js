import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { JOB_STATUS, LIMITS, MEDIA_FIELDS } from "../../shared/constants.js";
import { planRender } from "../../shared/renderPlan.js";
import { validateProjectForQueue } from "../../shared/projectValidation.js";
import { getJobsCollection } from "../firestore.js";
import {
  exportObjectPath,
  deleteJobObjects,
  deleteExportArtifacts,
  mediaObjectPath,
  objectExists,
  preprocessedBackgroundPath,
  projectObjectPath,
  readObject,
  signedDownloadUrl,
  signedUploadUrl,
  writeObject,
  writeProjectJson,
} from "../gcs.js";
import { enqueueRenderJob } from "../tasks.js";
import { preprocessBackgroundBuffer } from "../preprocessBackground.js";
import { hashIp } from "../middleware/optionalAuth.js";
import { rateLimitMiddleware } from "../middleware/rateLimit.js";

const CANCELLABLE = new Set([
  JOB_STATUS.CREATED,
  JOB_STATUS.UPLOADING,
  JOB_STATUS.QUEUED,
  JOB_STATUS.PROCESSING,
]);

const RETRYABLE = new Set([JOB_STATUS.CANCELLED, JOB_STATUS.FAILED]);

function assertJobAccess(req, job) {
  if (job.identity?.uid) {
    if (req.identity?.uid && job.identity.uid === req.identity.uid) return;
    const err = new Error("Not allowed to access this job.");
    err.status = 403;
    throw err;
  }
  const ipHash = hashIp(req.ip || req.headers["x-forwarded-for"] || "unknown");
  if (job.identity?.ipHash && job.identity.ipHash !== ipHash) {
    const err = new Error("Not allowed to access this job.");
    err.status = 403;
    throw err;
  }
}

function jobSummary(job, extras = {}) {
  const segmentProgress =
    job.renderMode === "segmented" && job.segmentCount
      ? {
          completed: job.segmentsCompleted ?? 0,
          total: job.segmentCount,
        }
      : null;

  return {
    jobId: job.jobId,
    renderName: job.renderName || null,
    status: job.status,
    progress: job.progress ?? 0,
    error: job.error,
    statusMessage: job.statusMessage || null,
    estimatedDurationSec: job.estimatedDurationSec,
    renderMode: job.renderMode || null,
    segmentProgress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || null,
    cancelledAt: job.cancelledAt || null,
    ...extras,
  };
}

async function signedOutputUrl(config, job) {
  if (job.status === JOB_STATUS.COMPLETED && job.outputPath) {
    return signedDownloadUrl(config, job.outputPath);
  }
  return null;
}

/**
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
const UPLOAD_FIELDS = new Set(["project", ...MEDIA_FIELDS]);

export function createJobsRouter(config) {
  const router = Router();

  router.put("/:jobId/upload/:field", async (req, res, next) => {
    try {
      const { jobId, field } = req.params;
      if (!UPLOAD_FIELDS.has(field)) {
        return res.status(400).json({ error: `Invalid upload field: ${field}` });
      }

      const ref = getJobsCollection().doc(jobId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }

      const job = snap.data();
      if (job.identity?.uid && req.identity?.uid && job.identity.uid !== req.identity.uid) {
        return res.status(403).json({ error: "Not allowed to upload to this job." });
      }

      if ([JOB_STATUS.CANCELLED, JOB_STATUS.COMPLETED, JOB_STATUS.FAILED].includes(job.status)) {
        return res.status(409).json({ error: `Job already ${job.status}.` });
      }

      const objectPath = job.uploadPaths?.[field];
      if (!objectPath) {
        return res.status(400).json({ error: `No upload path for ${field}.` });
      }

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: "Empty upload body." });
      }

      const maxBytes =
        field === "project" ? LIMITS.maxProjectJsonBytes : LIMITS.maxFileBytes;
      if (body.length > maxBytes) {
        return res.status(400).json({ error: `${field} exceeds file size limit.` });
      }

      const contentType = req.headers["content-type"] || "application/octet-stream";
      await writeObject(config, objectPath, body, contentType);

      const updatePayload = {
        status: JOB_STATUS.UPLOADING,
        updatedAt: new Date().toISOString(),
      };

      if (field === "background") {
        try {
          let aspectRatio = job.project?.settings?.aspectRatio;
          if (!aspectRatio && job.uploadPaths?.project) {
            const projectBuf = await readObject(config, job.uploadPaths.project);
            if (projectBuf) {
              aspectRatio = JSON.parse(projectBuf.toString())?.settings?.aspectRatio;
            }
          }
          aspectRatio = aspectRatio || "9/16";
          const processed = await preprocessBackgroundBuffer(body, aspectRatio);
          const ppPath = preprocessedBackgroundPath(jobId);
          await writeObject(config, ppPath, processed, "image/jpeg");
          updatePayload["uploadPaths.preprocessedBackground"] = ppPath;
        } catch (preprocessErr) {
          console.warn("[api] background preprocess failed", jobId, preprocessErr.message);
        }
      }

      if (field === "project" && job.uploadPaths?.background) {
        try {
          const projectDoc = JSON.parse(body.toString());
          const aspectRatio = projectDoc?.settings?.aspectRatio || "9/16";
          const bgBuf = await readObject(config, job.uploadPaths.background);
          if (bgBuf) {
            const processed = await preprocessBackgroundBuffer(bgBuf, aspectRatio);
            const ppPath = preprocessedBackgroundPath(jobId);
            await writeObject(config, ppPath, processed, "image/jpeg");
            updatePayload["uploadPaths.preprocessedBackground"] = ppPath;
          }
        } catch (preprocessErr) {
          console.warn("[api] background preprocess on project upload failed", jobId, preprocessErr.message);
        }
      }

      await ref.update(updatePayload);

      res.json({ ok: true, field, bytes: body.length });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", rateLimitMiddleware(config), async (req, res, next) => {
    try {
      const { project, files = {}, renderName } = req.body || {};
      if (!project) {
        return res.status(400).json({ error: "Missing project payload." });
      }

      const name = typeof renderName === "string" ? renderName.trim().slice(0, 120) : "";

      const fileMeta = {};
      let totalUploadBytes = 0;
      for (const field of MEDIA_FIELDS) {
        const meta = files[field];
        if (!meta) continue;
        const size = Number(meta.sizeBytes || 0);
        if (size > LIMITS.maxFileBytes) {
          return res.status(400).json({ error: `${field} exceeds file size limit.` });
        }
        totalUploadBytes += size;
        fileMeta[field] = {
          fileName: meta.fileName || field,
          mimeType: meta.mimeType || "application/octet-stream",
          sizeBytes: size,
        };
      }

      const validation = validateProjectForQueue(project, { totalUploadBytes });
      const renderPlan = planRender(validation.durationSec);
      const jobId = uuidv4();
      const identity = req.identity || { uid: null, email: null, isAnonymous: true };
      const now = new Date().toISOString();

      const uploadUrls = {};
      const uploadPaths = {};

      for (const [field, meta] of Object.entries(fileMeta)) {
        const path = mediaObjectPath(jobId, field, meta.fileName);
        uploadPaths[field] = path;
        uploadUrls[field] = await signedUploadUrl(config, path, meta.mimeType);
      }

      const projectPath = projectObjectPath(jobId);
      uploadPaths.project = projectPath;
      uploadUrls.project = await signedUploadUrl(config, projectPath, "application/json");

      await getJobsCollection().doc(jobId).set({
        jobId,
        renderName: name || null,
        status: JOB_STATUS.CREATED,
        createdAt: now,
        updatedAt: now,
        identity: {
          uid: identity.uid,
          email: identity.email,
          isAnonymous: identity.isAnonymous,
          ipHash: hashIp(req.ip || req.headers["x-forwarded-for"] || "unknown"),
        },
        project,
        fileMeta,
        uploadPaths,
        estimatedDurationSec: validation.durationSec,
        renderMode: renderPlan.mode,
        segmentCount: renderPlan.segmentCount,
        segmentDurationSec: renderPlan.segmentDurationSec,
        segmentsCompleted: 0,
        renderPhase: null,
        progress: 0,
        error: null,
        outputPath: null,
      });

      res.status(201).json({
        jobId,
        renderName: name || null,
        uploadUrls,
        estimatedDurationSec: validation.durationSec,
        renderMode: renderPlan.mode,
        segmentCount: renderPlan.segmentCount,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/", async (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

      if (req.identity?.uid) {
        const snap = await getJobsCollection()
          .where("identity.uid", "==", req.identity.uid)
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get();

        const jobs = await Promise.all(
          snap.docs.map(async (doc) => {
            const job = doc.data();
            const downloadUrl = await signedOutputUrl(config, job);
            return jobSummary(job, { downloadUrl });
          })
        );
        return res.json({ jobs });
      }

      const idsParam = String(req.query.ids || "").trim();
      if (!idsParam) {
        return res.json({ jobs: [] });
      }

      const ids = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))].slice(
        0,
        limit
      );
      const ipHash = hashIp(req.ip || req.headers["x-forwarded-for"] || "unknown");
      const jobs = [];

      for (const jobId of ids) {
        const snap = await getJobsCollection().doc(jobId).get();
        if (!snap.exists) continue;
        const job = snap.data();
        const owned =
          (!job.identity?.uid && job.identity?.ipHash === ipHash) ||
          (job.identity?.uid && job.identity.uid === req.identity?.uid);
        if (!owned) continue;
        const downloadUrl = await signedOutputUrl(config, job);
        jobs.push(jobSummary(job, { downloadUrl }));
      }

      jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:jobId/start", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const ref = getJobsCollection().doc(jobId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      if ([JOB_STATUS.CANCELLED, JOB_STATUS.COMPLETED, JOB_STATUS.FAILED].includes(job.status)) {
        return res.status(409).json({ error: `Job already ${job.status}.` });
      }

      const paths = job.uploadPaths || {};
      if (!(await objectExists(config, paths.project))) {
        return res.status(400).json({ error: "Project JSON not uploaded yet." });
      }

      for (const field of MEDIA_FIELDS) {
        if (paths[field] && !(await objectExists(config, paths[field]))) {
          return res.status(400).json({ error: `Missing upload for ${field}.` });
        }
      }

      if (req.body?.project) {
        validateProjectForQueue(req.body.project);
        await writeProjectJson(config, jobId, req.body.project);
      }

      await ref.update({
        status: JOB_STATUS.QUEUED,
        updatedAt: new Date().toISOString(),
        progress: 5,
      });

      await enqueueRenderJob(jobId, job);

      res.json({ jobId, status: JOB_STATUS.QUEUED });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:jobId/resume", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const ref = getJobsCollection().doc(jobId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      const canResume =
        job.renderMode === "segmented" &&
        job.scrollParams &&
        (job.segmentsCompleted || 0) < (job.segmentCount || 0);

      if (!canResume) {
        return res.status(409).json({ error: "Job is not resumable (missing staged render plan)." });
      }

      if (job.status === JOB_STATUS.CANCELLED || job.status === JOB_STATUS.COMPLETED) {
        return res.status(409).json({ error: `Job already ${job.status}.` });
      }

      await ref.update({
        status: JOB_STATUS.QUEUED,
        updatedAt: new Date().toISOString(),
        error: null,
        statusMessage: `Resuming at part ${(job.segmentsCompleted || 0) + 1}/${job.segmentCount}…`,
      });

      const refreshed = (await ref.get()).data();
      await enqueueRenderJob(jobId, refreshed);
      res.json({ jobId, status: JOB_STATUS.QUEUED, resumed: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:jobId/setup", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const snap = await getJobsCollection().doc(jobId).get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      const embedMedia = req.query.embedMedia !== "false";
      const projectPath = job.uploadPaths?.project;
      let doc = null;

      if (projectPath && (await objectExists(config, projectPath))) {
        const raw = await readObject(config, projectPath);
        doc = JSON.parse(raw.toString("utf8"));
      } else if (job.project && typeof job.project === "object") {
        doc = structuredClone(job.project);
      } else {
        return res.status(404).json({ error: "Project not available for this job." });
      }

      if (embedMedia && job.uploadPaths) {
        doc.media = doc.media && typeof doc.media === "object" ? doc.media : {};
        for (const field of MEDIA_FIELDS) {
          const mediaPath = job.uploadPaths[field];
          if (!mediaPath || !(await objectExists(config, mediaPath))) continue;
          const meta = job.fileMeta?.[field] || {};
          const data = await readObject(config, mediaPath);
          const mimeType = meta.mimeType || "application/octet-stream";
          doc.media[field] = {
            fileName: meta.fileName || field,
            mimeType,
            sizeBytes: data.length,
            dataUrl: `data:${mimeType};base64,${data.toString("base64")}`,
          };
        }
      }

      res.json({ jobId, setup: doc });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:jobId", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const snap = await getJobsCollection().doc(jobId).get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      const downloadUrl = await signedOutputUrl(config, job);

      res.json(jobSummary(job, { downloadUrl }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:jobId/cancel", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const ref = getJobsCollection().doc(jobId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      if (!CANCELLABLE.has(job.status)) {
        return res.status(409).json({ error: `Job cannot be cancelled in state: ${job.status}` });
      }

      const now = new Date().toISOString();
      await ref.update({
        status: JOB_STATUS.CANCELLED,
        cancelledAt: now,
        updatedAt: now,
        progress: 0,
        statusMessage: null,
        error: null,
      });
      res.json({ jobId, status: JOB_STATUS.CANCELLED });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:jobId/retry", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const ref = getJobsCollection().doc(jobId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      if (!RETRYABLE.has(job.status)) {
        return res.status(409).json({ error: `Job cannot be retried in state: ${job.status}` });
      }

      const paths = job.uploadPaths || {};
      if (!(await objectExists(config, paths.project))) {
        return res.status(400).json({ error: "Project JSON no longer available for retry." });
      }

      for (const field of MEDIA_FIELDS) {
        if (paths[field] && !(await objectExists(config, paths[field]))) {
          return res.status(400).json({ error: `Missing upload for ${field}.` });
        }
      }

      await deleteExportArtifacts(config, jobId);

      const canResumeSegments =
        job.renderMode === "segmented" &&
        job.scrollParams &&
        (job.segmentsCompleted || 0) < (job.segmentCount || 0);

      const now = new Date().toISOString();
      await ref.update({
        status: JOB_STATUS.QUEUED,
        updatedAt: now,
        progress: canResumeSegments ? 25 : 5,
        error: null,
        statusMessage: canResumeSegments ? "Resuming segmented encode…" : null,
        cancelledAt: null,
        outputPath: null,
        completedAt: null,
        processingStartedAt: null,
        segmentsCompleted: canResumeSegments ? job.segmentsCompleted || 0 : 0,
        renderPhase: null,
        scrollParams: canResumeSegments ? job.scrollParams : null,
        currentSegmentIndex: null,
      });

      const refreshed = (await ref.get()).data();
      await enqueueRenderJob(jobId, refreshed);
      res.json({ jobId, status: JOB_STATUS.QUEUED });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:jobId", async (req, res, next) => {
    try {
      const { jobId } = req.params;
      const ref = getJobsCollection().doc(jobId);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "Job not found." });
      }
      const job = snap.data();
      assertJobAccess(req, job);

      if (CANCELLABLE.has(job.status)) {
        const now = new Date().toISOString();
        await ref.update({
          status: JOB_STATUS.CANCELLED,
          cancelledAt: now,
          updatedAt: now,
          progress: 0,
          statusMessage: null,
          error: null,
        });
      }

      await deleteJobObjects(config, jobId);
      await ref.delete();

      res.json({ jobId, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
