#!/usr/bin/env bash
# Add /api/** Cloud Run rewrite to firebase.json (run AFTER mm-scroller-api is deployed).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
node "$ROOT/server/scripts/patch-firebase-rewrite.mjs"

echo "==> firebase.json updated with /api/** rewrite."
echo "    Redeploy hosting: npm run deploy:hosting"
