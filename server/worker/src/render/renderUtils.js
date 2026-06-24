export function hexToRgba(hex, alpha = 1) {
  const h = String(hex || "#000000").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function normalizeOpacity(value, fallback = 1) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const unit = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, unit));
}

export function mediaExtension(field, fileName) {
  const ext = String(fileName || "").match(/(\.[a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext) return ext;
  if (field === "background") return ".jpg";
  if (field === "music" || field === "voiceover") return ".mp3";
  return "";
}
