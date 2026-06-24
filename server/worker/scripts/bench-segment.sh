#!/usr/bin/env bash
# Encode two 60s scroll segments and concat — validates segmented pipeline locally.
# Usage: ./server/worker/scripts/bench-segment.sh
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg/ffprobe required. Install with: brew install ffmpeg" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"

SEG_DUR=60
FPS=30
EW=1080
EH=1920
TEXT_H=12000
TOTAL=$((SEG_DUR * 2))
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BG="$TMP/bg.jpg"
TEXT="$TMP/text.raw"
SEG0="$TMP/seg0.mp4"
SEG1="$TMP/seg1.mp4"
LIST="$TMP/list.txt"
OUT="$TMP/out.mp4"

ffmpeg -y -f lavfi -i "color=c=#1a1a2e:s=${EW}x${EH}" -frames:v 1 -update 1 "$BG"
ffmpeg -y -f lavfi -i "color=c=white@0.0:s=${EW}x${TEXT_H}" -f rawvideo -pix_fmt rgba -frames:v 1 "$TEXT"

START_Y=0
END_Y=$((TEXT_H - EH))
SPEED=$(( (START_Y - END_Y) / TOTAL ))

encode_segment() {
  local offset="$1"
  local out="$2"
  local y_expr="if(lt(t+${offset}\\,0)\\,${START_Y}\\,max(${END_Y}\\,${START_Y}-((t+${offset})-0)*${SPEED}))"
  local filter="[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[bg];[bg][1:v]overlay=x=0:y='${y_expr}':eval=frame:format=auto[vout]"
  ffmpeg -y \
    -loop 1 -framerate "$FPS" -t "$SEG_DUR" -i "$BG" \
    -stream_loop -1 -f rawvideo -pix_fmt rgba -s "${EW}x${TEXT_H}" -framerate "$FPS" -t "$SEG_DUR" -i "$TEXT" \
    -filter_complex "$filter" -map "[vout]" \
    -c:v libx264 -pix_fmt yuv420p -preset ultrafast -tune stillimage -crf 23 -threads 0 \
    -t "$SEG_DUR" -movflags +faststart \
    "$out"
}

echo "==> Encoding segment 0 (0-${SEG_DUR}s)..."
encode_segment 0 "$SEG0"
echo "==> Encoding segment 1 (${SEG_DUR}-$((SEG_DUR * 2))s)..."
encode_segment "$SEG_DUR" "$SEG1"

printf "file '%s'\nfile '%s'\n" "$SEG0" "$SEG1" >"$LIST"
ffmpeg -y -f concat -safe 0 -i "$LIST" -c copy -movflags +faststart "$OUT"

PROBE_DUR="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")"
echo "Concat output duration: ${PROBE_DUR}s (expected ~${TOTAL}s)"

if ! awk -v d="$PROBE_DUR" -v want="$TOTAL" 'BEGIN { exit !(d+0 >= want-1 && d+0 <= want+1) }'; then
  echo "FAIL: duration not within ±1s of ${TOTAL}s" >&2
  exit 1
fi

echo "PASS: segmented encode + concat"
