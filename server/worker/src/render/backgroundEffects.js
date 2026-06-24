export function hexToRgba(hex, alpha = 1) {
  const h = String(hex || "#000000").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function clampPercent(value, fallback = 55) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(100, n));
}

export function drawVignette(ctx, w, h, effects) {
  if (!effects.vignetteEnabled) return;
  const rx = clampPercent(effects.vignetteRadiusX);
  const ry = clampPercent(effects.vignetteRadiusY);
  const softness = Math.max(0, Math.min(100, effects.vignetteSoftness ?? 50)) / 100;
  const radius = Math.min(rx, ry);
  const inner = Math.max(0, radius * (1 - softness * 0.98)) / 100;
  const alpha = Math.max(0, Math.min(1, (effects.vignetteOpacity ?? 100) / 100));
  const color = hexToRgba(effects.vignetteColor || "#000000", alpha);
  const rxR = (rx / 100) * w;
  const ryR = (ry / 100) * h;
  if (rxR <= 0 || ryR <= 0) return;

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(rxR, ryR);
  const g = ctx.createRadialGradient(0, 0, inner, 0, 0, 1);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(Math.min(0.98, inner), "rgba(0,0,0,0)");
  g.addColorStop(1, color);
  ctx.fillStyle = g;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

export function drawColorOverlay(ctx, w, h, effects) {
  if (!effects.colorOverlayEnabled) return;
  const a = Math.max(0, Math.min(1, (effects.colorOverlayOpacity ?? 40) / 100));
  ctx.fillStyle = hexToRgba(effects.colorOverlayColor || "#000000", a);
  ctx.fillRect(0, 0, w, h);
}

export function readBgEffects(settings) {
  return {
    vignetteEnabled: !!settings.vignetteEnabled,
    vignetteColor: settings.vignetteColor || "#000000",
    vignetteRadiusX: settings.vignetteRadiusX ?? 55,
    vignetteRadiusY: settings.vignetteRadiusY ?? 55,
    vignetteSoftness: settings.vignetteSoftness ?? 50,
    vignetteOpacity: settings.vignetteOpacity ?? 100,
    colorOverlayEnabled: !!settings.colorOverlayEnabled,
    colorOverlayColor: settings.colorOverlayColor || "#000000",
    colorOverlayOpacity: settings.colorOverlayOpacity ?? 40,
  };
}
