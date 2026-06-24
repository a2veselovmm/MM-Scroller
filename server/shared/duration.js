import { getDesignCanvasSize } from "./canvasDesign.js";

/**
 * Estimate scroll duration from project settings (server-side cap check).
 * @param {object} settings
 * @param {object} timeline
 * @param {object} text
 */
export function estimateProjectDurationSec(settings = {}, timeline = {}, text = {}) {
  const measured = Number(timeline.measuredDurationSec);
  if (Number.isFinite(measured) && measured > 0) {
    return measured;
  }

  const aspectRatio = settings.aspectRatio || "9/16";
  const { height: designHeight } = getDesignCanvasSize(aspectRatio);
  const speed = Number(timeline.speed ?? settings.scrollSpeed ?? 80);
  const startDelay = Number(timeline.startDelay ?? settings.startDelay ?? 0);

  const plain = text.plainText || stripHtml(text.styledHtml || "");
  const lineCount = Math.max(1, plain.split("\n").length);
  const fontSize = Number(settings.fontSize ?? 48);
  const lineHeight = Number(settings.lineHeight ?? 1.35);
  const estimatedTextHeight = lineCount * fontSize * lineHeight + 200;

  const firstRow =
    timeline.scrollFirstRow != null
      ? timeline.scrollFirstRow
      : settings.scrollFirstRow != null
        ? settings.scrollFirstRow
        : designHeight;
  const lastRow =
    timeline.scrollLastRow != null
      ? timeline.scrollLastRow
      : settings.scrollLastRow != null
        ? settings.scrollLastRow
        : 0;

  const distance = Math.max(0, firstRow - (lastRow - estimatedTextHeight));
  const scrollDuration = speed > 0 ? distance / speed : 0;
  return startDelay + scrollDuration;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
