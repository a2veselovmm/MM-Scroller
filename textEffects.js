/** @param {string} hex @param {number} alpha */
export function hexToRgba(hex, alpha = 1) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Drop shadow: color, opacity, softness (blur px) */
export function buildTextShadow({ enabled, color, opacity, softness }) {
  if (!enabled) return "none";
  const blur = Math.max(0, softness);
  const a = Math.max(0, Math.min(1, opacity));
  const c = hexToRgba(color, a);
  return `0 2px ${blur}px ${c}, 0 0 ${Math.round(blur * 0.6)}px ${hexToRgba(color, a * 0.5)}`;
}

/** -webkit-text-stroke + paint-order */
export function buildTextStroke({ enabled, color, thickness, opacity }) {
  if (!enabled || thickness <= 0) {
    return { webkitTextStroke: "unset", paintOrder: "unset" };
  }
  const w = Math.max(0.5, thickness);
  const c = hexToRgba(color, opacity);
  return {
    webkitTextStroke: `${w}px ${c}`,
    paintOrder: "stroke fill",
  };
}

/** Layered glow shadows for radius + softness falloff */
export function buildGlowShadowStack({ color, opacity, radius, softness }) {
  const steps = Math.max(4, Math.round(softness / 12) + 2);
  const layers = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const spread = Math.max(1, radius * t);
    const falloff = 1 - Math.pow(t, 1.2 + (100 - softness) / 80);
    const a = opacity * falloff;
    if (a > 0.01) layers.push(`0 0 ${spread}px ${hexToRgba(color, a)}`);
  }
  return layers.length ? layers.join(", ") : "none";
}

/** CSS vars + rules for glow duplicate layer */
export function applyGlowLayer(el, state) {
  if (!el) return;
  if (!state.glowEnabled) {
    el.classList.add("hidden");
    el.style.cssText = "";
    return;
  }
  el.classList.remove("hidden");
  el.style.setProperty("--glow-color", hexToRgba(state.glowColor, state.glowOpacity));
  el.style.setProperty("--glow-blur", `${state.glowSharpness}px`);
  el.style.setProperty("--glow-radius", String(state.glowRadius));
  el.style.setProperty(
    "--glow-shadow",
    buildGlowShadowStack({
      color: state.glowColor,
      opacity: state.glowOpacity,
      radius: state.glowRadius,
      softness: state.glowSoftness,
    })
  );
}

export function strokeStylePayload(state) {
  if (!state.strokeEnabled) {
    return { webkitTextStroke: "initial", paintOrder: "initial" };
  }
  const s = buildTextStroke({
    enabled: true,
    color: state.strokeColor,
    thickness: state.strokeWidth,
    opacity: state.strokeOpacity,
  });
  return {
    webkitTextStroke: s.webkitTextStroke,
    paintOrder: s.paintOrder,
  };
}

export function shadowStylePayload(state) {
  return {
    textShadow: buildTextShadow({
      enabled: state.shadowEnabled,
      color: state.shadowColor,
      opacity: state.shadowOpacity,
      softness: state.shadowSoftness,
    }),
  };
}

/** Read stroke/shadow from computed style for toolbar sync */
export function parseStrokeFromComputed(cs) {
  const w = cs.webkitTextStrokeWidth || cs.getPropertyValue("-webkit-text-stroke-width");
  const c = cs.webkitTextStrokeColor || cs.getPropertyValue("-webkit-text-stroke-color");
  const width = parseFloat(w) || 0;
  return { enabled: width > 0, width, color: c };
}
