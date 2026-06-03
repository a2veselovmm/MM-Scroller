import { hexToRgba } from "./textEffects.js";

function clampPercent(value, fallback = 55) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5, Math.min(100, n));
}

export function vignetteRadiiPercent(effects) {
  return {
    rx: clampPercent(effects.vignetteRadiusX),
    ry: clampPercent(effects.vignetteRadiusY),
  };
}

/** Inner gradient stop (%) — uses the smaller axis; higher softness = softer edge. */
export function vignetteInnerStopPercent(rx, ry, softnessPct) {
  const radius = Math.min(rx, ry);
  const softness = Math.max(0, Math.min(100, softnessPct)) / 100;
  return Math.max(0, radius * (1 - softness * 0.98));
}

export function vignetteCssBackground(effects) {
  const { rx, ry } = vignetteRadiiPercent(effects);
  const inner = vignetteInnerStopPercent(
    rx,
    ry,
    effects.vignetteSoftness
  );
  const color = hexToRgba(effects.vignetteColor, 1);
  return `radial-gradient(ellipse ${rx}% ${ry}% at 50% 50%, transparent ${inner}%, ${color} 100%)`;
}

export function drawVignette(ctx, w, h, effects) {
  if (!effects.vignetteEnabled) return;

  const { rx, ry } = vignetteRadiiPercent(effects);
  const innerFrac =
    vignetteInnerStopPercent(rx, ry, effects.vignetteSoftness) / 100;
  const color = hexToRgba(effects.vignetteColor, 1);
  const maxExtent = Math.max(w, h);
  const rxPx = (rx / 100) * w * 0.5;
  const ryPx = (ry / 100) * h * 0.5;

  ctx.save();
  ctx.translate(w * 0.5, h * 0.5);
  ctx.scale(rxPx / maxExtent, ryPx / maxExtent);

  const innerR = innerFrac * maxExtent;
  const g = ctx.createRadialGradient(0, 0, innerR, 0, 0, maxExtent);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(Math.min(0.98, innerFrac), "rgba(0,0,0,0)");
  g.addColorStop(1, color);

  ctx.fillStyle = g;
  ctx.fillRect(-maxExtent, -maxExtent, maxExtent * 2, maxExtent * 2);
  ctx.restore();
}

export function drawColorOverlay(ctx, w, h, effects) {
  if (!effects.colorOverlayEnabled) return;
  const a = Math.max(0, Math.min(1, effects.colorOverlayOpacity / 100));
  ctx.fillStyle = hexToRgba(effects.colorOverlayColor, a);
  ctx.fillRect(0, 0, w, h);
}

/** @param {HTMLElement} canvasEl */
export function readBgEffectsFromCanvas(canvasEl) {
  const v = canvasEl.querySelector("#bg-vignette-layer");
  const o = canvasEl.querySelector("#bg-color-overlay");
  return {
    vignetteEnabled: v?.dataset.enabled === "1",
    vignetteColor: v?.dataset.color || "#000000",
    vignetteRadiusX: parseFloat(v?.dataset.radiusX ?? "55"),
    vignetteRadiusY: parseFloat(v?.dataset.radiusY ?? "55"),
    vignetteSoftness: parseFloat(v?.dataset.softness ?? "50"),
    colorOverlayEnabled: o?.dataset.enabled === "1",
    colorOverlayColor: o?.dataset.color || "#000000",
    colorOverlayOpacity: parseFloat(o?.dataset.opacity ?? "40"),
  };
}

/**
 * @param {HTMLElement} vignetteEl
 * @param {HTMLElement} overlayEl
 * @param {number} w
 * @param {number} h
 */
export function applyBgEffectsToDom(vignetteEl, overlayEl, w, h, effects) {
  if (effects.vignetteEnabled && w > 0 && h > 0) {
    vignetteEl.dataset.enabled = "1";
    vignetteEl.dataset.color = effects.vignetteColor;
    vignetteEl.dataset.radiusX = String(effects.vignetteRadiusX);
    vignetteEl.dataset.radiusY = String(effects.vignetteRadiusY);
    vignetteEl.dataset.softness = String(effects.vignetteSoftness);
    vignetteEl.style.background = vignetteCssBackground(effects);
    vignetteEl.classList.remove("hidden");
  } else {
    vignetteEl.dataset.enabled = "0";
    vignetteEl.style.background = "none";
    vignetteEl.classList.add("hidden");
  }

  if (effects.colorOverlayEnabled) {
    const a = Math.max(0, Math.min(1, effects.colorOverlayOpacity / 100));
    overlayEl.dataset.enabled = "1";
    overlayEl.dataset.color = effects.colorOverlayColor;
    overlayEl.dataset.opacity = String(effects.colorOverlayOpacity);
    overlayEl.style.background = hexToRgba(effects.colorOverlayColor, a);
    overlayEl.classList.remove("hidden");
  } else {
    overlayEl.dataset.enabled = "0";
    overlayEl.style.background = "transparent";
    overlayEl.classList.add("hidden");
  }
}
