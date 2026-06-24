import { badRequest } from "./httpError.js";
import { LIMITS, RENDER_LIMITS } from "./constants.js";

/**
 * @param {number} durationSec
 * @returns {{ mode: 'single' | 'segmented', segmentCount: number, segmentDurationSec: number }}
 */
export function planRender(durationSec) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw badRequest("Invalid project duration.");
  }
  if (duration > LIMITS.maxDurationSec) {
    throw badRequest(
      `Estimated duration ${duration.toFixed(1)}s exceeds ${LIMITS.maxDurationSec}s cap.`
    );
  }

  if (duration <= RENDER_LIMITS.singlePassMaxSec) {
    return {
      mode: "single",
      segmentCount: 1,
      segmentDurationSec: duration,
    };
  }

  const segmentDurationSec = RENDER_LIMITS.segmentDurationSec;
  const segmentCount = Math.ceil(duration / segmentDurationSec);
  if (segmentCount > RENDER_LIMITS.maxSegments) {
    throw badRequest(
      `Project requires ${segmentCount} segments (max ${RENDER_LIMITS.maxSegments}). Shorten text or increase scroll speed.`
    );
  }

  return {
    mode: "segmented",
    segmentCount,
    segmentDurationSec,
  };
}

/**
 * @param {number} index
 * @param {number} totalDuration
 * @param {number} segmentDurationSec
 * @returns {{ startSec: number, durationSec: number }}
 */
export function segmentTimeRange(index, totalDuration, segmentDurationSec) {
  const startSec = index * segmentDurationSec;
  const durationSec = Math.min(segmentDurationSec, Math.max(0, totalDuration - startSec));
  return { startSec, durationSec };
}

export function segmentObjectPath(jobId, index) {
  return `exports/${jobId}/segments/${index}.mp4`;
}
