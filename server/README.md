# MM-Scroller GCP Backend

Cloud render queue for MM-Scroller on `mm-anton-sandbox`.

## Prerequisites

Install **Google Cloud SDK** (one time):

```bash
brew install --cask google-cloud-sdk
gcloud auth login
gcloud config set project mm-anton-sandbox
```

Run each command below **separately** (do not paste comment lines starting with `#`).

Install Node **22 LTS** (recommended; see `.nvmrc`) and project tooling once:

```bash
npm install
```

## 1. Deploy the UI only (works without backend)

```bash
npm run deploy:hosting
```

Browser export works. Cloud queue needs steps 2–4.

## 2. Provision GCP (once)

```bash
chmod +x server/scripts/provision-gcp.sh server/scripts/deploy.sh server/scripts/enable-hosting-api.sh
./server/scripts/provision-gcp.sh
```

## 3. Build & deploy API + worker

```bash
./server/scripts/deploy.sh
```

This deploys Cloud Run services and patches `firebase.json` with the `/api/**` rewrite.

## 4. Redeploy hosting (UI + API proxy)

```bash
npm run deploy:hosting
```

Cloud export in the app will work after this step.

## Optional: beta API key

```bash
gcloud secrets versions access latest --secret=mm-scroller-beta-key
```

Set on API service: `REQUIRE_BETA_KEY=true` and pass header `X-MM-Beta-Key` from the client.

## Authentication

Authentication and approval gates were removed from this backend.
The app and API are now open access by design.

## Local API dev

```bash
cd server/api && npm install && npm run dev
```

Set env: `GCP_PROJECT_ID`, `GCS_BUCKET`, `WORKER_URL`, `TASKS_SA_EMAIL`, `GOOGLE_APPLICATION_CREDENTIALS`.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `gcloud: command not found` | Install SDK with Homebrew (see Prerequisites) |
| `mm-scroller-api does not exist` | Run `./server/scripts/deploy.sh` before enabling API rewrite, or deploy hosting without rewrites (current `firebase.json`) |
| `zsh: command not found: #` | Run one command per line; don't paste `#` comment lines |
