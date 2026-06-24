export function loadWorkerConfig() {
  const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error("GCP_PROJECT_ID is required.");
  }
  return {
    projectId,
    region: process.env.GCP_REGION || "us-central1",
    bucket: process.env.GCS_BUCKET || "mm-anton-sandbox-scroller",
    queue: process.env.CLOUD_TASKS_QUEUE || "mm-scroller-render",
    workerUrl: process.env.WORKER_URL || "",
    tasksSaEmail: process.env.TASKS_SA_EMAIL || "",
  };
}
