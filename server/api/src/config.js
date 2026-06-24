export function loadConfig() {
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
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:5000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    betaKeySecret: process.env.BETA_KEY_SECRET || "mm-scroller-beta-key",
    requireAuth: process.env.REQUIRE_AUTH === "true",
    requireBetaKey: process.env.REQUIRE_BETA_KEY === "true",
    authAllowedDomain: process.env.AUTH_ALLOWED_DOMAIN || "",
    port: Number(process.env.PORT || 8080),
    jobsPerHour: Number(process.env.JOBS_PER_HOUR || 20),
    jobsPerDay: Number(process.env.JOBS_PER_DAY || 100),
  };
}
