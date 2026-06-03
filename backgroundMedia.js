/** Map timeline seconds → position within a looping audio track (seconds). */
export function mapBackgroundTime(t, duration, mode = "loop") {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 0;
  const clamped = Math.max(0, t);

  if (mode === "once") {
    return Math.min(clamped, Math.max(0, duration - 0.001));
  }

  return ((clamped % duration) + duration) % duration;
}
