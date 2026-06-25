/**
 * Cloud render queue client — uploads project + media via same-origin API proxy.
 * Direct GCS signed-URL uploads are blocked by COEP (require-corp) on the hosting page.
 */

const DEFAULT_API = "/api";

export function apiBase() {
  return (typeof window !== "undefined" && window.__MM_SCROLLER_API__) || DEFAULT_API;
}

export async function apiFetch(path, options = {}) {
  const { getIdToken, betaKey, body, method = "GET", headers: extraHeaders, ...rest } = options;
  const headers = { ...(extraHeaders || {}) };
  if (getIdToken) {
    const token = await getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (betaKey) headers["X-MM-Beta-Key"] = betaKey;
  if (body != null) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      ...rest,
      headers,
      body: body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
  } catch (err) {
    throw new Error(`Network error (${method} ${path}): ${err.message}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

async function putToJobApi(jobId, field, blob, contentType, { getIdToken, betaKey }) {
  const headers = {
    "Content-Type": contentType || blob.type || "application/octet-stream",
  };
  if (getIdToken) {
    const token = await getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (betaKey) headers["X-MM-Beta-Key"] = betaKey;

  let res;
  try {
    res = await fetch(`${apiBase()}/jobs/${jobId}/upload/${field}`, {
      method: "PUT",
      headers,
      body: blob,
    });
  } catch (err) {
    throw new Error(`Upload failed for ${field}: ${err.message}`);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed for ${field} (${res.status})`);
  }
}

/**
 * Create job, upload assets, and enqueue render. Returns immediately after queueing.
 * @param {object} opts
 */
export async function createAndUploadCloudJob(opts) {
  const {
    buildDocument,
    getMediaBlobs,
    renderName,
    target = "cloud",
    getIdToken = async () => null,
    betaKey,
    onProgress = () => {},
    onStatus = () => {},
  } = opts;

  const isLocalScript = target === "local_script";
  onStatus(isLocalScript ? "Preparing local render bundle job…" : "Preparing cloud render job…");
  onProgress(2);

  const project = await buildDocument();
  const mediaBlobs = await getMediaBlobs();

  const files = {};
  for (const [field, item] of Object.entries(mediaBlobs)) {
    if (!item?.blob) continue;
    files[field] = {
      fileName: item.fileName,
      mimeType: item.mimeType || item.blob.type || "application/octet-stream",
      sizeBytes: item.blob.size,
    };
  }

  onStatus("Creating render job…");
  onProgress(8);

  const created = await apiFetch("/jobs", {
    method: "POST",
    body: { project, files, renderName, target },
    getIdToken,
    betaKey,
  });

  const { jobId } = created;
  onStatus(`Uploading assets (job ${jobId.slice(0, 8)}…)…`);

  const uploadFields = ["project"];
  for (const field of Object.keys(mediaBlobs)) {
    if (mediaBlobs[field]?.blob) uploadFields.push(field);
  }

  let uploadStep = 0;
  const uploadTotal = uploadFields.length || 1;
  const uploadOpts = { getIdToken, betaKey };

  for (const field of uploadFields) {
    if (field === "project") {
      const json = JSON.stringify(project);
      await putToJobApi(
        jobId,
        "project",
        new Blob([json], { type: "application/json" }),
        "application/json",
        uploadOpts
      );
    } else {
      const item = mediaBlobs[field];
      await putToJobApi(jobId, field, item.blob, item.mimeType, uploadOpts);
    }
    uploadStep += 1;
    onProgress(10 + Math.round((uploadStep / uploadTotal) * 30));
  }

  onStatus(isLocalScript ? "Building local render bundle…" : "Starting render queue…");
  onProgress(45);
  const startPath = isLocalScript ? `/jobs/${jobId}/start-local` : `/jobs/${jobId}/start`;
  await apiFetch(startPath, {
    method: "POST",
    body: { project },
    getIdToken,
    betaKey,
  });

  onProgress(50);
  onStatus(isLocalScript ? "Render script bundle queued" : "Queued for cloud render");

  return {
    jobId,
    target,
    renderName: created.renderName || renderName || null,
    estimatedDurationSec: created.estimatedDurationSec,
  };
}

/**
 * @deprecated Use createAndUploadCloudJob + renderQueue instead.
 */
export async function submitCloudRenderJob(opts) {
  const result = await createAndUploadCloudJob(opts);
  const { getIdToken = async () => null, betaKey, onProgress = () => {}, onStatus = () => {} } =
    opts;
  const { jobId } = result;

  onStatus("Rendering on server…");
  const deadline = Date.now() + 45 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const status = await apiFetch(`/jobs/${jobId}`, { method: "GET", getIdToken, betaKey });
    onProgress(Math.max(45, Math.min(99, status.progress || 50)));

    if (status.status === "completed" && status.downloadUrl) {
      onProgress(100);
      onStatus("Download starting…");
      const a = document.createElement("a");
      a.href = status.downloadUrl;
      a.download = "scrolldrop-export.mp4";
      a.rel = "noopener";
      a.click();
      return { jobId, downloadUrl: status.downloadUrl };
    }

    if (status.status === "failed") {
      throw new Error(status.error || "Cloud render failed.");
    }

    if (status.status === "cancelled") {
      throw new Error("Cloud render was cancelled.");
    }

    onStatus(status.statusMessage || `Server render: ${status.status}…`);
  }

  throw new Error("Cloud render timed out. Check job status later.");
}

export async function fetchJob(jobId, { getIdToken, betaKey } = {}) {
  return apiFetch(`/jobs/${jobId}`, { getIdToken, betaKey });
}

export async function fetchJobs({ getIdToken, betaKey, ids } = {}) {
  const params = new URLSearchParams();
  if (ids?.length) params.set("ids", ids.join(","));
  if (getIdToken) params.set("includeGlobalLocal", "1");
  const query = params.size ? `?${params.toString()}` : "";
  return apiFetch(`/jobs${query}`, { getIdToken, betaKey });
}

export async function cancelCloudJob(jobId, { getIdToken, betaKey } = {}) {
  return apiFetch(`/jobs/${jobId}/cancel`, { method: "POST", getIdToken, betaKey });
}

export async function fetchJobSetup(jobId, { getIdToken, betaKey, embedMedia = true } = {}) {
  const query = embedMedia ? "" : "?embedMedia=false";
  return apiFetch(`/jobs/${jobId}/setup${query}`, { getIdToken, betaKey });
}

export async function deleteCloudJob(jobId, { getIdToken, betaKey } = {}) {
  return apiFetch(`/jobs/${jobId}`, { method: "DELETE", getIdToken, betaKey });
}

export async function retryCloudJob(jobId, { getIdToken, betaKey } = {}) {
  return apiFetch(`/jobs/${jobId}/retry`, { method: "POST", getIdToken, betaKey });
}
