#!/usr/bin/env bash
# Ensure gcloud is on PATH (Homebrew install location on macOS).
require_gcloud() {
  if command -v gcloud >/dev/null 2>&1; then
    return 0
  fi
  if [[ -x "/opt/homebrew/share/google-cloud-sdk/bin/gcloud" ]]; then
    export PATH="/opt/homebrew/share/google-cloud-sdk/bin:$PATH"
  elif [[ -x "/usr/local/share/google-cloud-sdk/bin/gcloud" ]]; then
    export PATH="/usr/local/share/google-cloud-sdk/bin:$PATH"
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "ERROR: gcloud CLI not found." >&2
    echo "" >&2
    echo "Install Google Cloud SDK, then log in:" >&2
    echo "  brew install --cask google-cloud-sdk" >&2
    echo "  gcloud auth login" >&2
    echo "  gcloud config set project mm-anton-sandbox" >&2
    echo "" >&2
    echo "Run this script again after install." >&2
    exit 1
  fi
}
