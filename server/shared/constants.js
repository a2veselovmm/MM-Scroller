/** @readonly */
export const PROJECT_FORMAT_VERSION = 1;

export const LIMITS = {
  maxProjectJsonBytes: 1 * 1024 * 1024,
  maxFileBytes: 15 * 1024 * 1024,
  maxBackgroundVideoBytes: 100 * 1024 * 1024,
  maxProxyUploadBytes: 30 * 1024 * 1024,
  maxTotalBytes: 230 * 1024 * 1024,
  maxDurationSec: 1800,
  jobsPerHour: 3,
  jobsPerDay: 10,
  uploadUrlTtlMs: 15 * 60 * 1000,
  downloadUrlTtlMs: 60 * 60 * 1000,
};

/** Cloud render segmentation tuning. */
export const RENDER_LIMITS = {
  segmentDurationSec: 120,
  singlePassMaxSec: 600,
  maxSegments: 30,
};

export const RENDER_MODE = {
  SINGLE: "single",
  SEGMENTED: "segmented",
};

export const RENDER_TARGET = {
  CLOUD: "cloud",
  LOCAL_SCRIPT: "local_script",
};

export const RENDER_PHASE = {
  PREPARE: "prepare",
  SEGMENT: "segment",
  CONCAT: "concat",
};

export const JOB_STATUS = {
  CREATED: "created",
  UPLOADING: "uploading",
  QUEUED: "queued",
  PROCESSING: "processing",
  QUEUED_FOR_RENDER: "queued_for_render",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

export const MEDIA_FIELDS = ["background", "overlay", "music", "voiceover"];
