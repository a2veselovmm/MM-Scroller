/**
 * Preview layout: canonical design-space stage (matches server export) scaled for display.
 */
import { getDesignCanvasSize } from "./canvasDesign.js";

/** Sum height of transport/timeline/export rows below the preview wrapper. */
function measurePreviewChrome(previewAreaEl) {
  if (!previewAreaEl) return 120;

  let chrome = 0;
  for (const child of previewAreaEl.children) {
    if (child.classList.contains("preview-wrapper")) continue;
    const style = getComputedStyle(child);
    if (style.display === "none") continue;
    chrome += child.offsetHeight;
    chrome += parseFloat(style.marginTop) || 0;
    chrome += parseFloat(style.marginBottom) || 0;
  }

  const areaStyle = getComputedStyle(previewAreaEl);
  chrome +=
    (parseFloat(areaStyle.paddingTop) || 0) +
    (parseFloat(areaStyle.paddingBottom) || 0);

  return chrome;
}

/**
 * @param {HTMLElement | null} wrapperEl
 * @param {string} aspectRatio
 * @param {HTMLElement | null} [previewAreaEl]
 */
export function computePreviewLayout(wrapperEl, aspectRatio, previewAreaEl = null) {
  const { width: designWidth, height: designHeight } =
    getDesignCanvasSize(aspectRatio);

  const availableW = Math.max(
    1,
    wrapperEl?.clientWidth ?? previewAreaEl?.clientWidth ?? designWidth
  );

  let availableH = wrapperEl?.clientHeight ?? 0;
  if (availableH < 8 && previewAreaEl) {
    const chrome = measurePreviewChrome(previewAreaEl);
    availableH = Math.max(1, previewAreaEl.clientHeight - chrome);
  } else {
    availableH = Math.max(1, availableH);
  }

  const scaleByW = Math.min(availableW, designWidth) / designWidth;
  const scaleByH = availableH / designHeight;
  const previewScale = Math.min(scaleByW, scaleByH, 1);
  const displayWidth = Math.round(designWidth * previewScale);
  const displayHeight = Math.round(designHeight * previewScale);

  return {
    designWidth,
    designHeight,
    previewScale,
    displayWidth,
    displayHeight,
  };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.canvasEl
 * @param {HTMLElement} opts.stageEl
 * @param {HTMLElement | null} opts.wrapperEl
 * @param {HTMLElement | null} [opts.previewAreaEl]
 * @param {string} opts.aspectRatio
 */
export function applyPreviewLayout({
  canvasEl,
  stageEl,
  wrapperEl,
  previewAreaEl = null,
  aspectRatio,
}) {
  const layout = computePreviewLayout(wrapperEl, aspectRatio, previewAreaEl);

  canvasEl.style.width = `${layout.displayWidth}px`;
  canvasEl.style.height = `${layout.displayHeight}px`;
  canvasEl.style.aspectRatio = "auto";

  stageEl.style.width = `${layout.designWidth}px`;
  stageEl.style.height = `${layout.designHeight}px`;
  stageEl.style.transform = `scale(${layout.previewScale})`;
  stageEl.style.transformOrigin = "top left";

  canvasEl.dataset.previewScale = String(layout.previewScale);
  canvasEl.dataset.designWidth = String(layout.designWidth);
  canvasEl.dataset.designHeight = String(layout.designHeight);

  return layout;
}

/** Run fn with the preview stage at 1:1 scale (for DOM raster export). */
export function runAtDesignScale(stageEl, fn) {
  const prev = stageEl.style.transform;
  stageEl.style.transform = "none";
  void stageEl.offsetHeight;
  try {
    return fn();
  } finally {
    stageEl.style.transform = prev;
    void stageEl.offsetHeight;
  }
}

/** @param {HTMLElement} canvasEl */
export function readPreviewLayout(canvasEl) {
  const aspectRatio = canvasEl.dataset.aspect || "9/16";
  const { width: designWidth, height: designHeight } =
    getDesignCanvasSize(aspectRatio);
  const previewScale = parseFloat(canvasEl.dataset.previewScale || "1");
  return {
    designWidth:
      parseInt(canvasEl.dataset.designWidth, 10) || designWidth,
    designHeight:
      parseInt(canvasEl.dataset.designHeight, 10) || designHeight,
    previewScale: Number.isFinite(previewScale) ? previewScale : 1,
  };
}
