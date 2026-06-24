import { CloudTasksClient } from "@google-cloud/tasks";

let client = null;

function getClient() {
  if (!client) client = new CloudTasksClient();
  return client;
}

/**
 * @param {object} config
 * @param {string} config.projectId
 * @param {string} config.region
 * @param {string} config.queue
 * @param {string} config.workerUrl
 * @param {string} config.tasksSaEmail
 * @param {string} jobId
 * @param {object} [payload]
 */
export async function enqueueWorkerTask(config, jobId, payload = {}) {
  if (!config.workerUrl) {
    throw new Error("WORKER_URL is not configured.");
  }
  if (!config.tasksSaEmail) {
    throw new Error("TASKS_SA_EMAIL is not configured.");
  }
  if (!config.queue) {
    throw new Error("CLOUD_TASKS_QUEUE is not configured.");
  }

  const parent = getClient().queuePath(config.projectId, config.region, config.queue);
  const url = `${config.workerUrl.replace(/\/$/, "")}/process`;
  const body = { jobId, ...payload };

  await getClient().createTask({
    parent,
    task: {
      dispatchDeadline: { seconds: 1800 },
      httpRequest: {
        httpMethod: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
        oidcToken: {
          serviceAccountEmail: config.tasksSaEmail,
        },
      },
    },
  });
}
