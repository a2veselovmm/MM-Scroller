#!/usr/bin/env bash
# Benchmark ffmpeg scroll encode with fixed fixture dimensions.
# Usage: ./server/worker/scripts/bench-encode.sh [duration_sec]
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed. Install with: brew install ffmpeg" >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe is not installed. Install with: brew install ffmpeg" >&2
  exit 1
fi

DUR="${1:-60}"
FPS=30
EW=1080
EH=1920
TEXT_H=12000
MIN_BYTES=$(( DUR * 1000 ))
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BG="$TMP/bg.jpg"
TEXT="$TMP/text.raw"
OUT="$TMP/out.mp4"

echo "==> Generating ${EW}x${EH} bg JPEG and ${EW}x${TEXT_H} RGBA strip (${DUR}s @ ${FPS}fps)..."
ffmpeg -y -f lavfi -i "color=c=#1a1a2e:s=${EW}x${EH}" -frames:v 1 -update 1 "$BG"
ffmpeg -y -f lavfi -i "color=c=white@0.0:s=${EW}x${TEXT_H}" -f rawvideo -pix_fmt rgba -frames:v 1 "$TEXT"

START_Y=0
END_Y=$((TEXT_H - EH))
SPEED=$(( (START_Y - END_Y) / DUR ))
Y_EXPR="if(lt(t\\,0)\\,${START_Y}\\,max(${END_Y}\\,${START_Y}-t*${SPEED}))"

FILTER="[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[bg];[bg][1:v]overlay=x=0:y='${Y_EXPR}':eval=frame:format=auto[vout]"

echo "==> Encoding..."
START_MS="$(python3 - <<'PY'
import time
print(int(time.time()*1000))
PY
)"

ffmpeg -y \
  -loop 1 -framerate "$FPS" -t "$DUR" -i "$BG" \
  -stream_loop -1 -f rawvideo -pix_fmt rgba -s "${EW}x${TEXT_H}" -framerate "$FPS" -t "$DUR" -i "$TEXT" \
  -filter_complex "$FILTER" -map "[vout]" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -tune stillimage -crf 23 -threads 0 \
  -t "$DUR" -movflags +faststart \
  "$OUT"

END_MS="$(python3 - <<'PY'
import time
print(int(time.time()*1000))
PY
)"
ELAPSED=$(( END_MS - START_MS ))
SEC=$(awk "BEGIN {printf \"%.1f\", $ELAPSED/1000}")
BYTES=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
PROBE_DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")"

echo "Encode ${DUR}s video: ${ELAPSED} ms (${SEC}s)"
echo "Output: $(ls -lh "$OUT" | awk '{print $5}') (${BYTES} bytes)"
echo "ffprobe duration: ${PROBE_DUR}s"

FAIL=0
if ! awk -v d="$PROBE_DUR" -v want="$DUR" 'BEGIN { exit !(d+0 >= want-0.5 && d+0 <= want+0.5) }'; then
  echo "FAIL: duration ${PROBE_DUR}s not within ±0.5s of ${DUR}s" >&2
  FAIL=1
fi
if [ "$BYTES" -lt "$MIN_BYTES" ]; then
  echo "FAIL: output size ${BYTES} bytes below minimum ${MIN_BYTES}" >&2
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: duration and size look valid"
else
  exit 1
fi
