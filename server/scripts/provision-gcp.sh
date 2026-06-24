#!/usr/bin/env bash
# Provision GCP resources for MM-Scroller render queue.
# Usage: ./server/scripts/provision-gcp.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/require-gcloud.sh
source "$SCRIPT_DIR/lib/require-gcloud.sh"
require_gcloud

PROJECT_ID="${GCP_PROJECT_ID:-mm-anton-sandbox}"
REGION="${GCP_REGION:-us-central1}"
BUCKET="${GCS_BUCKET:-mm-anton-sandbox-scroller}"
API_SA="mm-scroller-api"
WORKER_SA="mm-scroller-worker"
TASKS_SA="mm-scroller-tasks"
QUEUE="mm-scroller-render"
AR_REPO="mm-scroller"

echo "==> Project: $PROJECT_ID  Region: $REGION"

gcloud config set project "$PROJECT_ID"

echo "==> Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  firestore.googleapis.com \
  cloudtasks.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com

echo "==> Firestore (native mode)..."
gcloud firestore databases create --location="$REGION" 2>/dev/null || true

echo "==> GCS bucket: $BUCKET"
if ! gcloud storage buckets describe "gs://${BUCKET}" &>/dev/null; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="$REGION" \
    --uniform-bucket-level-access
fi

cat > /tmp/mm-scroller-lifecycle.json <<'EOF'
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 7, "matchesPrefix": ["uploads/"] }
    },
    {
      "action": { "type": "Delete" },
      "condition": { "age": 3, "matchesPrefix": ["exports/"] }
    }
  ]
}
EOF
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file=/tmp/mm-scroller-lifecycle.json

echo "==> Artifact Registry..."
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" 2>/dev/null || true

for SA in "$API_SA" "$WORKER_SA" "$TASKS_SA"; do
  echo "==> Service account: $SA"
  gcloud iam service-accounts create "$SA" \
    --display-name="MM-Scroller $SA" 2>/dev/null || true
done

API_SA_EMAIL="${API_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA_EMAIL="${WORKER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
TASKS_SA_EMAIL="${TASKS_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> IAM bindings..."
IAM_FAILED=0
bind_iam() {
  if ! "$@" 2>/dev/null; then
    IAM_FAILED=1
    echo "  (skipped — no permission: $*)"
  fi
}

for ROLE in roles/datastore.user roles/storage.objectAdmin; do
  bind_iam gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${API_SA_EMAIL}" --role="$ROLE" --quiet
  bind_iam gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${WORKER_SA_EMAIL}" --role="$ROLE" --quiet
done

bind_iam gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/cloudtasks.enqueuer" --quiet

bind_iam gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role="roles/cloudtasks.enqueuer" --quiet

bind_iam gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${TASKS_SA_EMAIL}" \
  --role="roles/run.invoker" --quiet

bind_iam gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/storage.objectAdmin" --quiet

bind_iam gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role="roles/storage.objectAdmin" --quiet

bind_iam gcloud iam service-accounts add-iam-policy-binding "${API_SA_EMAIL}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" --quiet

bind_iam gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA_EMAIL}" \
  --member="serviceAccount:${API_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" --quiet

bind_iam gcloud iam service-accounts add-iam-policy-binding "${TASKS_SA_EMAIL}" \
  --member="serviceAccount:${WORKER_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" --quiet

if [[ "$IAM_FAILED" -eq 1 ]]; then
  echo ""
  echo "WARNING: Some IAM bindings failed (need Project IAM Admin)."
  echo "Ask your GCP admin to run:"
  echo "  ./server/scripts/iam-bindings-for-admin.sh"
  echo ""
fi

echo "==> Cloud Tasks queue..."
gcloud tasks queues create "$QUEUE" \
  --location="$REGION" \
  --max-dispatches-per-second=1 \
  --max-concurrent-dispatches=1 \
  --max-attempts=2 2>/dev/null || \
gcloud tasks queues update "$QUEUE" \
  --location="$REGION" \
  --max-dispatches-per-second=1 \
  --max-concurrent-dispatches=1 \
  --max-attempts=2 2>/dev/null || true

echo "==> Optional beta API key secret..."
if ! gcloud secrets describe mm-scroller-beta-key &>/dev/null; then
  openssl rand -hex 24 | gcloud secrets create mm-scroller-beta-key --data-file=-
  gcloud secrets add-iam-policy-binding mm-scroller-beta-key \
    --member="serviceAccount:${API_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" --quiet
fi

echo ""
echo "Done. Next:"
echo "  1. gcloud builds submit --config=cloudbuild.yaml"
echo "  2. Deploy worker, then API (see server/scripts/deploy.sh)"
echo ""
echo "Service accounts:"
echo "  API:    $API_SA_EMAIL"
echo "  Worker: $WORKER_SA_EMAIL"
echo "  Tasks:  $TASKS_SA_EMAIL"
