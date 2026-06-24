#!/usr/bin/env bash
# IAM bindings for MM-Scroller — run by a project Owner / IAM admin.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-mm-anton-sandbox}"
API_SA_EMAIL="mm-scroller-api@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA_EMAIL="mm-scroller-worker@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA_EMAIL="mm-scroller-tasks@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET="${GCS_BUCKET:-mm-anton-sandbox-scroller}"

gcloud config set project "$PROJECT_ID"

for ROLE in roles/datastore.user roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${API_SA_EMAIL}" --role="$ROLE" --quiet
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${WORKER_SA_EMAIL}" --role="$ROLE" --quiet
done

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/cloudtasks.enqueuer" --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role="roles/cloudtasks.enqueuer" --quiet

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${TASKS_SA_EMAIL}" \
  --role="roles/run.invoker" --quiet

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/storage.objectAdmin" --quiet

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role="roles/storage.objectAdmin" --quiet

gcloud iam service-accounts add-iam-policy-binding "${API_SA_EMAIL}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" --quiet

# API must act as the tasks SA when enqueueing OIDC-authenticated Cloud Tasks.
gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA_EMAIL}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" --quiet

gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA_EMAIL}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" --quiet

echo "IAM bindings complete for MM-Scroller service accounts."
