import { enqueueWorkerTask } from "../shared/enqueueWorker.js";
import { RENDER_MODE, RENDER_PHASE } from "../shared/constants.js";
import { loadConfig } from "./config.js";

/**
 * @param {object} [job]
 */
export function resolveWorkerTaskPayload(job = {}) {
  if (job.renderMode === RENDER_MODE.SEGMENTED) {
    const completed = job.segmentsCompleted || 0;
    const total = job.segmentCount || 0;
    if (job.scrollParams && completed < total) {
      return { phase: RENDER_PHASE.SEGMENT, segmentIndex: completed };
    }
    if (job.scrollParams && completed >= total) {
      return { phase: RENDER_PHASE.CONCAT };
    }
    return { phase: RENDER_PHASE.PREPARE };
  }
  return { phase: "single" };
}

/**
 * Enqueue render worker via Cloud Tasks (OIDC to Cloud Run worker).
 * @param {string} jobId
 * @param {object} [job]
 */
export async function enqueueRenderJob(jobId, job = {}) {
  const config = loadConfig();
  const payload = resolveWorkerTaskPayload(job);
  await enqueueWorkerTask(config, jobId, payload);
}
