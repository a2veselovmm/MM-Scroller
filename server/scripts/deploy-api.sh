#!/usr/bin/env bash
# Deploy API service only (skip Cloud Build). Use after worker is up or to fix env vars.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/require-gcloud.sh
source "$SCRIPT_DIR/lib/require-gcloud.sh"
require_gcloud

PROJECT_ID="${GCP_PROJECT_ID:-mm-anton-sandbox}"
REGION="${GCP_REGION:-us-central1}"
BUCKET="${GCS_BUCKET:-mm-anton-sandbox-scroller}"
AR_REPO="mm-scroller"
API_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/api:latest"
API_SA="mm-scroller-api@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA="mm-scroller-tasks@${PROJECT_ID}.iam.gserviceaccount.com"
QUEUE="mm-scroller-render"

WORKER_URL=$(gcloud run services describe mm-scroller-worker \
  --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')

ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
cat >"$ENV_FILE" <<EOF
GCP_PROJECT_ID: "${PROJECT_ID}"
GCP_REGION: "${REGION}"
GCS_BUCKET: "${BUCKET}"
CLOUD_TASKS_QUEUE: "${QUEUE}"
WORKER_URL: "${WORKER_URL}"
TASKS_SA_EMAIL: "${TASKS_SA}"
ALLOWED_ORIGINS: "https://mm-anton-sandbox.web.app,https://mm-anton-sandbox.firebaseapp.com"
FIRESTORE_DATABASE: "(default)"
JOBS_PER_HOUR: "20"
JOBS_PER_DAY: "100"
EOF

echo "==> Deploying API (worker: ${WORKER_URL})..."
gcloud run deploy mm-scroller-api \
  --image="$API_IMAGE" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --service-account="$API_SA" \
  --allow-unauthenticated \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60 \
  --env-vars-file="$ENV_FILE"

API_URL=$(gcloud run services describe mm-scroller-api \
  --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')

echo ""
echo "API URL: $API_URL"
echo "Test: curl ${API_URL}/api/health"
