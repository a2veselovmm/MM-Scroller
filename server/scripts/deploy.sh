#!/usr/bin/env bash
# Build and deploy API + worker to Cloud Run.
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
WORKER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/worker:latest"
API_SA="mm-scroller-api@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA="mm-scroller-worker@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA="mm-scroller-tasks@${PROJECT_ID}.iam.gserviceaccount.com"
QUEUE="mm-scroller-render"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "==> Building images via Cloud Build..."
  gcloud builds submit --config=cloudbuild.yaml --project="$PROJECT_ID"
else
  echo "==> Skipping Cloud Build (SKIP_BUILD=1)"
fi

if [[ "${SKIP_WORKER:-}" != "1" ]]; then
  echo "==> Deploying worker..."
  WORKER_MIN_INSTANCES="${WORKER_MIN_INSTANCES:-0}"
  gcloud run deploy mm-scroller-worker \
    --image="$WORKER_IMAGE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --service-account="$WORKER_SA" \
    --no-allow-unauthenticated \
    --memory=8Gi \
    --cpu=8 \
    --cpu-boost \
    --no-cpu-throttling \
    --timeout=3600 \
    --max-instances=3 \
    --min-instances="$WORKER_MIN_INSTANCES" \
    --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCS_BUCKET=${BUCKET},FIRESTORE_DATABASE=(default)"
else
  echo "==> Skipping worker deploy (SKIP_WORKER=1)"
fi

WORKER_URL=$(gcloud run services describe mm-scroller-worker \
  --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')

echo "==> Updating worker task-chaining env..."
gcloud run services update mm-scroller-worker \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCS_BUCKET=${BUCKET},GCP_REGION=${REGION},CLOUD_TASKS_QUEUE=${QUEUE},WORKER_URL=${WORKER_URL},TASKS_SA_EMAIL=${TASKS_SA},FIRESTORE_DATABASE=(default)" \
  --quiet

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

echo "==> Deploying API..."
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

gcloud run services add-iam-policy-binding mm-scroller-worker \
  --region="$REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:${TASKS_SA}" \
  --role="roles/run.invoker" --quiet

echo ""
echo "API URL:    $API_URL"
echo "Worker URL: $WORKER_URL"
echo ""
echo "==> Enabling Firebase /api rewrite..."
chmod +x "$ROOT/server/scripts/enable-hosting-api.sh"
"$ROOT/server/scripts/enable-hosting-api.sh"
echo ""
echo "Next: npm run deploy:hosting"
