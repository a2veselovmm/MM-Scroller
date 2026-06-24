import { initAuth, signInWithGoogle, signOut, getIdToken, getCurrentUser } from "./auth.js";
import {
  startCloudRender,
  onQueueUpdate,
  startPolling,
  ensurePolling,
  cancelJob,
  retryJob,
  deleteJob,
  triggerDownload,
  isActive,
} from "./renderQueue.js";
import { fetchJobSetup } from "./cloudExport.js";
import { expandEmojiShortcodes, expandShortcodesInEditable } from "./emojiShortcodes.js";
import {
  loadImageElement,
  rasterizeBackgroundToCanvasSize,
} from "./backgroundImage.js";
import { initFontPicker } from "./fonts.js";
import { createUndoManager } from "./undoHistory.js";
import { getDesignCanvasSize } from "./canvasDesign.js";
import { applyPreviewLayout } from "./previewLayout.js";
import { LIMITS } from "./server/shared/constants.js";
import { ScrollPreview } from "./preview.js";
import { applyBgEffectsToDom } from "./backgroundEffects.js";
import { exportRecording, downloadBlob } from "./export.js";
import {
  buildProjectDocument,
  downloadProjectJson,
  estimateProjectSize,
  parseProjectDocument,
  dataUrlToFile,
  urlToDataPayload,
  cleanBgFileName,
} from "./projectIO.js";
import {
  applyMediaVolume,
  syncBgAudioToTimeline,
} from "./audioSync.js";
import {
  hasSelectionIn,
  applyStyleToSelection,
  syncEditorToPreview,
  applyLayoutStyles,
  getSelectionStyles,
  defaultEditorHtml,
  htmlToPlain,
  plainToHtml,
} from "./editor.js";
import {
  buildTextShadow,
  buildTextStroke,
  strokeStylePayload,
  shadowStylePayload,
  hexToRgba,
} from "./textEffects.js";

const state = {
  fontFamily: "Inter",
  fontSize: 32,
  fontColor: "#ffffff",
  fontOpacity: 1,
  textAlign: "center",
  lineHeight: 1.5,
  letterSpacing: 0,
  strokeEnabled: false,
  strokeColor: "#000000",
  strokeWidth: 2,
  strokeOpacity: 1,
  shadowEnabled: false,
  shadowColor: "#000000",
  shadowOpacity: 0.85,
  shadowSoftness: 8,
  paddingH: 48,
  scrollSpeed: 80,
  startDelay: 0,
  /** Canvas Y (px): top edge of text at timeline start. */
  scrollFirstRow: null,
  /** Canvas Y (px): bottom edge of text at timeline end. */
  scrollLastRow: null,
  fitMode: "cover",
  colorOverlayEnabled: false,
  colorOverlayColor: "#000000",
  colorOverlayOpacity: 40,
  vignetteEnabled: false,
  vignetteColor: "#000000",
  vignetteRadiusX: 55,
  vignetteRadiusY: 55,
  vignetteSoftness: 50,
  vignetteOpacity: 100,
  musicVolume: 100,
  musicLoop: true,
  voiceVolume: 100,
  aspectRatio: "9/16",
  bgUrl: null,
  hasBackgroundImage: false,
  bold: false,
  italic: false,
  editMode: "styled",
};

const $ = (id) => document.getElementById(id);

const canvas = $("preview-canvas");
const previewStage = $("preview-stage");
const previewWrapper = $("preview-wrapper");
const previewArea = document.querySelector(".preview-area");
const textEl = $("text-content");
const textEditor = $("text-editor");
const textPlain = $("text-plain");
const textEditorWrap = $("text-editor-wrap");
const editModeHint = $("edit-mode-hint");
const editModeToggle = $("edit-mode-toggle");
const viewLabelPlain = $("view-label-plain");
const viewLabelStyled = $("view-label-styled");
const textContainer = $("text-scroll-container");
const bgImage = $("bg-image");
const bgMusic = $("bg-music");
const bgVoice = $("bg-voice");
const bgPlaceholder = $("bg-placeholder");

let bgMusicObjectUrl = null;
let bgVoiceObjectUrl = null;
const bgVignetteLayer = $("bg-vignette-layer");
const bgColorOverlay = $("bg-color-overlay");
const playbackStatus = $("playback-status");
const timelineScrub = $("timeline-scrub");
const timeCurrent = $("time-current");
const timeTotal = $("time-total");
const btnPlayPause = $("btn-play-pause");
const styleTargetHint = $("style-target-hint");
const appMain = $("app-main");
const panelResizer = $("panel-resizer");

const engine = new ScrollPreview(canvas, textEl, textContainer);
let bgObjectUrl = null;
/** Full-resolution upload; kept for re-rasterize on aspect/fit change. */
let bgSourceUrl = null;
let isExporting = false;
let isCloudUploading = false;
let isImporting = false;
let isScrubbing = false;
let lastStyledHtml = "";
let plainOnModeEnter = "";
let fontPickerApi = null;

const undoManager = createUndoManager(captureUndoSnapshot, applyUndoSnapshot);

function pushUndo() {
  if (isImporting || undoManager.isRestoring()) return;
  undoManager.push();
}

function performUndo() {
  if (!undoManager.undo()) return;
  playbackStatus.textContent = "Undone";
}

function captureUndoSnapshot() {
  const { bgUrl, ...stateCopy } = state;
  return {
    state: { ...stateCopy, bgUrl },
    lastStyledHtml: textEditor.innerHTML,
    plainText: textPlain.value,
    plainOnModeEnter,
    timelineTime: engine.timelineTime,
  };
}

function applyUndoSnapshot(snap) {
  Object.assign(state, snap.state);

  lastStyledHtml = snap.lastStyledHtml;
  plainOnModeEnter = snap.plainOnModeEnter;
  textPlain.value = snap.plainText;

  const styled = state.editMode === "styled";
  editModeToggle.checked = styled;
  textEditorWrap.dataset.mode = state.editMode;
  if (styled) {
    textEditor.innerHTML = snap.lastStyledHtml;
    textEditor.classList.remove("hidden");
    textPlain.classList.add("hidden");
    viewLabelPlain.classList.remove("is-active");
    viewLabelStyled.classList.add("is-active");
    editModeHint.textContent =
      "Styled — select words and format visually. Updates preview live.";
  } else {
    textEditor.classList.add("hidden");
    textPlain.classList.remove("hidden");
    viewLabelPlain.classList.add("is-active");
    viewLabelStyled.classList.remove("is-active");
    editModeHint.textContent =
      "Plain text editor only. Preview and export keep your styled text.";
  }

  applyStateToControls();
  engine.speed = state.scrollSpeed;
  engine.startDelay = state.startDelay;
  engine.scrollFirstRow = state.scrollFirstRow;
  engine.scrollLastRow = state.scrollLastRow;
  applyBackground();
  refreshPreview();
  engine.applyTime(snap.timelineTime);
  refreshDuration();
  updatePlayPauseButton();
  refreshToolbarFromSelection();
}

function applyStateToControls() {
  $("aspect-ratio").value = state.aspectRatio;
  $("fit-mode").value = state.fitMode;

  $("font-size").value = String(state.fontSize);
  $("font-size-val").textContent = `${state.fontSize}px`;
  $("font-color").value = state.fontColor;
  $("font-opacity").value = String(Math.round(state.fontOpacity * 100));
  $("font-opacity-val").textContent = `${Math.round(state.fontOpacity * 100)}%`;

  $("line-height").value = String(state.lineHeight);
  $("line-height-val").textContent = String(state.lineHeight);
  $("letter-spacing").value = String(state.letterSpacing);
  $("letter-spacing-val").textContent = `${state.letterSpacing}px`;
  $("padding-h").value = String(state.paddingH);
  $("padding-h-val").textContent = `${state.paddingH}px`;

  $("scroll-speed").value = String(state.scrollSpeed);
  $("scroll-speed-val").textContent = `${state.scrollSpeed} px/s`;
  $("start-delay").value = String(state.startDelay);
  $("start-delay-val").textContent = `${state.startDelay}s`;

  $("stroke-enabled").checked = state.strokeEnabled;
  $("stroke-color").value = state.strokeColor;
  $("stroke-opacity").value = String(Math.round(state.strokeOpacity * 100));
  $("stroke-opacity-val").textContent = `${Math.round(state.strokeOpacity * 100)}%`;
  $("stroke-width").value = String(state.strokeWidth);
  $("stroke-width-val").textContent = `${state.strokeWidth}px`;

  $("shadow-enabled").checked = state.shadowEnabled;
  $("shadow-color").value = state.shadowColor;
  $("shadow-opacity").value = String(Math.round(state.shadowOpacity * 100));
  $("shadow-opacity-val").textContent = `${Math.round(state.shadowOpacity * 100)}%`;
  $("shadow-softness").value = String(state.shadowSoftness);
  $("shadow-softness-val").textContent = `${state.shadowSoftness}px`;

  $("color-overlay-enabled").checked = state.colorOverlayEnabled;
  $("color-overlay-color").value = state.colorOverlayColor;
  $("color-overlay-opacity").value = String(state.colorOverlayOpacity);
  $("color-overlay-opacity-val").textContent = `${state.colorOverlayOpacity}%`;

  $("vignette-enabled").checked = state.vignetteEnabled;
  $("vignette-color").value = state.vignetteColor;
  $("vignette-radius-x").value = String(state.vignetteRadiusX);
  $("vignette-radius-x-val").textContent = String(Math.round(state.vignetteRadiusX));
  $("vignette-radius-y").value = String(state.vignetteRadiusY);
  $("vignette-radius-y-val").textContent = String(Math.round(state.vignetteRadiusY));
  $("vignette-softness").value = String(state.vignetteSoftness);
  $("vignette-softness-val").textContent = String(Math.round(state.vignetteSoftness));
  $("vignette-opacity").value = String(state.vignetteOpacity);
  $("vignette-opacity-val").textContent = `${state.vignetteOpacity}%`;

  $("bg-music-volume").value = String(state.musicVolume);
  $("bg-music-volume-val").textContent = `${state.musicVolume}%`;
  $("music-loop").checked = state.musicLoop;
  $("bg-voice-volume").value = String(state.voiceVolume);
  $("bg-voice-volume-val").textContent = `${state.voiceVolume}%`;

  setEffectPanelEnabled("stroke-controls", state.strokeEnabled);
  setEffectPanelEnabled("shadow-controls", state.shadowEnabled);
  setEffectPanelEnabled("color-overlay-controls", state.colorOverlayEnabled);
  setEffectPanelEnabled("vignette-controls", state.vignetteEnabled);

  document.querySelectorAll("[data-align]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.align === state.textAlign);
  });

  fontPickerApi?.setFontByFamily(state.fontFamily);
  updateScrollPositionControls();
  applyMediaVolume(bgMusic, state.musicVolume);
  applyMediaVolume(bgVoice, state.voiceVolume);
  bgMusic.loop = state.musicLoop;
}

engine.onStatus = (s) => {
  playbackStatus.textContent = s;
  updatePlayPauseButton();
};
engine.onComplete = () => {
  pauseTimelineAudio();
  updatePlayPauseButton();
};
engine.onTimeUpdate = (current, total) => {
  updateTimelineUI(current, total);
  try {
    const isPlaying = engine.running && !engine.paused;
    syncTimelineAudio(current, { isPlaying });
  } catch (err) {
    console.error("Audio sync failed:", err);
  }
};

function updatePlayPauseButton() {
  const playing = engine.running && !engine.paused;
  btnPlayPause.textContent = playing ? "⏸ Pause" : "▶ Play";
  btnPlayPause.setAttribute("aria-label", playing ? "Pause" : "Play");
  btnPlayPause.classList.toggle("is-playing", playing);
}

function togglePlayPause() {
  if (isExporting) return;
  if (engine.running && !engine.paused) {
    engine.pause();
    pauseTimelineAudio();
    syncTimelineAudio(engine.timelineTime);
  } else {
    engine.play();
    syncTimelineAudio(engine.timelineTime, { isPlaying: true });
  }
  updatePlayPauseButton();
}

function fontStack(family = state.fontFamily) {
  return `"${family}", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;
}

function getLayoutStyles() {
  return {
    fontFamily: fontStack(),
    fontSize: state.fontSize,
    color: hexToRgba(state.fontColor, state.fontOpacity),
    textAlign: state.textAlign,
    lineHeight: state.lineHeight,
    letterSpacing: state.letterSpacing,
    paddingH: state.paddingH,
    defaultTextShadow: buildTextShadow({
      enabled: state.shadowEnabled,
      color: state.shadowColor,
      opacity: state.shadowOpacity,
      softness: state.shadowSoftness,
    }),
    defaultStroke: buildTextStroke({
      enabled: state.strokeEnabled,
      color: state.strokeColor,
      thickness: state.strokeWidth,
      opacity: state.strokeOpacity,
    }),
  };
}

function setEffectPanelEnabled(panelId, enabled) {
  $(panelId).classList.toggle("is-disabled", !enabled);
}

function getStyledHtmlForPreview() {
  if (lastStyledHtml) return lastStyledHtml;
  if (textEditor.innerHTML.trim()) return textEditor.innerHTML;
  return defaultEditorHtml();
}

/** Push preview from current state (plain or styled source). */
function syncPreviewFromStyled() {
  const html =
    state.editMode === "plain"
      ? plainToHtml(textPlain.value)
      : getStyledHtmlForPreview();
  applyLayoutStyles(textEditor, textEl, getLayoutStyles());
  textEl.innerHTML = html;
  scheduleTimelineRefresh();
}

/** Apply control state to all text in styled mode when nothing is selected. */
function applyDefaultStylesToAllText() {
  if (state.editMode !== "styled") return;

  const color = hexToRgba(state.fontColor, state.fontOpacity);
  const fontFamily = fontStack();
  const shadow = shadowStylePayload(state);
  const stroke = strokeStylePayload(state);
  const nodes = textEditor.querySelectorAll(".text-line, .text-run, .text-span");

  for (const el of nodes) {
    el.style.color = color;
    el.style.fontFamily = fontFamily;
    el.style.fontSize = `${state.fontSize}px`;
    el.style.fontWeight = state.bold ? "700" : "400";
    el.style.fontStyle = state.italic ? "italic" : "normal";
    el.style.textShadow = shadow.textShadow;
    if (stroke.webkitTextStroke) {
      el.style.webkitTextStroke = stroke.webkitTextStroke;
      el.style.paintOrder = stroke.paintOrder;
    } else {
      el.style.webkitTextStroke = "";
      el.style.paintOrder = "";
    }
  }
}

/** Full preview + timeline refresh after any control change. */
function refreshPreview() {
  syncFromEditor();
}

/** Wait for layout after DOM text changes before measuring scroll distance. */
function scheduleTimelineRefresh() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshTimeline({ syncScrollSliders: true });
    });
  });
}

function applyEffectToSelectionOrDefault(effectFn) {
  if (state.editMode !== "styled") {
    syncPreviewFromStyled();
    return false;
  }
  const hasSel = hasSelectionIn(textEditor);
  if (hasSel) {
    effectFn();
    updateStyleHint(true);
  } else {
    applyDefaultStylesToAllText();
    updateStyleHint(false);
  }
  refreshPreview();
  return hasSel;
}

function syncFromEditor() {
  if (state.editMode === "plain") {
    const html = plainToHtml(textPlain.value);
    applyLayoutStyles(textEditor, textEl, getLayoutStyles());
    textEl.innerHTML = html;
    scheduleTimelineRefresh();
    return;
  }

  expandShortcodesInEditable(textEditor);
  lastStyledHtml = textEditor.innerHTML;
  applyLayoutStyles(textEditor, textEl, getLayoutStyles());
  syncEditorToPreview(textEditor, textEl);
  scheduleTimelineRefresh();
}

function setEditMode(mode) {
  if (mode === state.editMode) return;
  if (!undoManager.isRestoring() && !isImporting) pushUndo();

  if (mode === "plain") {
    lastStyledHtml = textEditor.innerHTML;
    const plain = htmlToPlain(textEditor);
    textPlain.value = plain;
    plainOnModeEnter = plain;
    textEditor.classList.add("hidden");
    textPlain.classList.remove("hidden");
    editModeHint.textContent =
      "Plain text editor only. Preview and export keep your styled text.";
    editModeToggle.checked = false;
    viewLabelPlain.classList.add("is-active");
    viewLabelStyled.classList.remove("is-active");
  } else {
    const plain = textPlain.value;
    const plainChanged = plain !== plainOnModeEnter;
    if (plainChanged || !lastStyledHtml) {
      textEditor.innerHTML = plainToHtml(plain);
    } else {
      textEditor.innerHTML = lastStyledHtml;
    }
    lastStyledHtml = textEditor.innerHTML;
    textPlain.classList.add("hidden");
    textEditor.classList.remove("hidden");
    editModeHint.textContent =
      "Styled — select words and format visually. Updates preview live.";
    editModeToggle.checked = true;
    viewLabelPlain.classList.remove("is-active");
    viewLabelStyled.classList.add("is-active");
  }

  state.editMode = mode;
  textEditorWrap.dataset.mode = mode;
  syncFromEditor();
  updateStyleHint(false);
}

function applyToSelectionOrDefault(styleFn) {
  if (state.editMode !== "styled") {
    syncPreviewFromStyled();
    updateStyleHint(false);
    return false;
  }

  const hasSel = hasSelectionIn(textEditor);
  if (hasSel) {
    styleFn();
    updateStyleHint(true);
  } else {
    applyDefaultStylesToAllText();
    updateStyleHint(false);
  }
  refreshPreview();
  return hasSel;
}

function updateStyleHint(hasSelection) {
  styleTargetHint.textContent = hasSelection
    ? "Editing selected text"
    : "Adjusts defaults for new typing";
  styleTargetHint.classList.toggle("is-selection", hasSelection);
}

function setToggleButton(btn, value) {
  const isMixed = value === "mixed";
  const isOn = value === true;
  btn.setAttribute("aria-pressed", String(isOn));
  btn.classList.toggle("is-mixed", isMixed);
  btn.dataset.state = isMixed ? "mixed" : isOn ? "on" : "off";
}

function refreshToolbarFromSelection() {
  if (state.editMode !== "styled") {
    setToggleButton($("btn-bold"), false);
    setToggleButton($("btn-italic"), false);
    return;
  }

  const selStyle = getSelectionStyles(textEditor);
  if (!selStyle) {
    setToggleButton($("btn-bold"), false);
    setToggleButton($("btn-italic"), false);
    updateStyleHint(false);
    return;
  }

  if (selStyle.color) {
    const hex = rgbToHex(selStyle.color);
    if (hex) {
      state.fontColor = hex;
      $("font-color").value = hex;
    }
  }

  if (selStyle.fontSize) {
    state.fontSize = Math.round(selStyle.fontSize);
    $("font-size").value = String(state.fontSize);
    $("font-size-val").textContent = `${state.fontSize}px`;
  }

  if (selStyle.opacity != null) {
    state.fontOpacity = selStyle.opacity;
    $("font-opacity").value = String(Math.round(selStyle.opacity * 100));
    $("font-opacity-val").textContent = `${Math.round(selStyle.opacity * 100)}%`;
  }

  state.bold = selStyle.bold === true;
  state.italic = selStyle.italic === true;
  setToggleButton($("btn-bold"), selStyle.bold);
  setToggleButton($("btn-italic"), selStyle.italic);

  updateStyleHint(selStyle.hasSelection);
}

function rgbToHex(rgb) {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const h = (n) => parseInt(n, 10).toString(16).padStart(2, "0");
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? `${m}:${sec.padStart(4, "0")}` : `0:${sec.padStart(4, "0")}`;
}

/** Recompute scroll range, preview frame, scrubber max, and time labels. */
function refreshTimeline({ syncScrollSliders = false } = {}) {
  syncEngineDesignSpace();
  if (syncScrollSliders) {
    updateScrollPositionControls();
  } else {
    migrateScrollRowSettings();
    engine.scrollFirstRow = state.scrollFirstRow;
    engine.scrollLastRow = state.scrollLastRow;
    engine.measure();
  }

  const total = engine.getTotalDuration();
  const t = Math.min(engine.timelineTime, total);
  engine.applyTime(t);

  const max = Math.max(1, Math.round(total * 10));
  timelineScrub.max = String(max);
  timelineScrub.value = String(Math.round(t * 10));
  updateTimelineUI(t, total, true);
  return total;
}

function refreshDuration() {
  return refreshTimeline();
}

function updateTimelineUI(current, total, force = false) {
  if (isScrubbing && !force) return;
  timeCurrent.textContent = formatTime(current);
  timeTotal.textContent = formatTime(total);
  timelineScrub.value = String(Math.round(current * 10));
  $("timeline-duration-label").textContent =
    `Scroll duration · ${formatTime(total)}`;
}

function syncAudioTrack(el, time, volume, { isPlaying = false, mode = "loop" } = {}) {
  if (!el?.src) return;
  const dur = el.duration;
  if (!dur || !Number.isFinite(dur)) return;
  syncBgAudioToTimeline(el, time, dur, mode, isPlaying, volume);
}

function syncTimelineAudio(time, { isPlaying = false } = {}) {
  syncAudioTrack(bgMusic, time, state.musicVolume, {
    isPlaying,
    mode: state.musicLoop ? "loop" : "once",
  });
  syncAudioTrack(bgVoice, time, state.voiceVolume, { isPlaying, mode: "loop" });
}

function applyMusicLoop() {
  bgMusic.loop = state.musicLoop;
  syncTimelineAudio(engine.timelineTime, {
    isPlaying: engine.running && !engine.paused,
  });
}

function pauseTimelineAudio() {
  if (bgMusic.src) bgMusic.pause();
  if (bgVoice.src) bgVoice.pause();
}

function clearMusic() {
  if (bgMusicObjectUrl) URL.revokeObjectURL(bgMusicObjectUrl);
  bgMusicObjectUrl = null;
  bgMusic.pause();
  bgMusic.removeAttribute("src");
  $("bg-music-filename").textContent = "No music";
}

function clearVoiceover() {
  if (bgVoiceObjectUrl) URL.revokeObjectURL(bgVoiceObjectUrl);
  bgVoiceObjectUrl = null;
  bgVoice.pause();
  bgVoice.removeAttribute("src");
  $("bg-voice-filename").textContent = "No voiceover";
}

function loadMusic(file) {
  if (!undoManager.isRestoring() && !isImporting) pushUndo();
  clearMusic();
  const url = URL.createObjectURL(file);
  bgMusicObjectUrl = url;
  $("bg-music-filename").textContent = file.name;
  bgMusic.src = url;
  bgMusic.loop = state.musicLoop;
  bgMusic.addEventListener(
    "loadedmetadata",
    () => {
      applyMediaVolume(bgMusic, state.musicVolume);
      applyMusicLoop();
    },
    { once: true }
  );
}

function loadVoiceover(file) {
  if (!undoManager.isRestoring() && !isImporting) pushUndo();
  clearVoiceover();
  const url = URL.createObjectURL(file);
  bgVoiceObjectUrl = url;
  $("bg-voice-filename").textContent = file.name;
  bgVoice.src = url;
  bgVoice.addEventListener(
    "loadedmetadata",
    () => {
      applyMediaVolume(bgVoice, state.voiceVolume);
      syncTimelineAudio(engine.timelineTime, {
        isPlaying: engine.running && !engine.paused,
      });
    },
    { once: true }
  );
}

function syncEngineDesignSpace() {
  const { width, height } = getDesignCanvasSize(state.aspectRatio);
  engine.designWidth = width;
  engine.designHeight = height;
}

/** Logical canvas height in px (e.g. 1920 for 9:16). */
function getCanvasScrollHeight() {
  return getDesignCanvasSize(state.aspectRatio).height;
}

function syncPreviewLayout() {
  const layout = applyPreviewLayout({
    canvasEl: canvas,
    stageEl: previewStage,
    wrapperEl: previewWrapper,
    previewAreaEl: previewArea,
    aspectRatio: state.aspectRatio,
  });
  engine.designWidth = layout.designWidth;
  engine.designHeight = layout.designHeight;
  return layout;
}

function getDesignDimensions() {
  const { width, height } = getDesignCanvasSize(state.aspectRatio);
  return { w: width, h: height };
}

function getPreviewDisplayScale() {
  const layout = readPreviewLayoutFromDom();
  return layout.previewScale;
}

function readPreviewLayoutFromDom() {
  const scale = parseFloat(canvas.dataset.previewScale || "1");
  const { width, height } = getDesignCanvasSize(state.aspectRatio);
  return {
    designWidth: parseInt(canvas.dataset.designWidth, 10) || width,
    designHeight: parseInt(canvas.dataset.designHeight, 10) || height,
    previewScale: Number.isFinite(scale) ? scale : 1,
  };
}

function migrateScrollRowSettings() {
  const designH = getCanvasScrollHeight();
  const scale = getPreviewDisplayScale();
  const thDisplay = Math.max(textEl.offsetHeight, 1);

  if (state.scrollFirstRow == null) {
    if (state.scrollStartY != null) {
      state.scrollFirstRow = Math.round(state.scrollStartY / scale);
    } else {
      state.scrollFirstRow = designH;
    }
  }
  if (state.scrollLastRow == null) {
    if (state.scrollEndY != null) {
      state.scrollLastRow = Math.round((state.scrollEndY + thDisplay) / scale);
    } else {
      state.scrollLastRow = 0;
    }
  }
}

function updateScrollPositionControls() {
  syncEngineDesignSpace();
  const ch = getCanvasScrollHeight();
  const startSlider = $("scroll-start");
  const endSlider = $("scroll-end");

  migrateScrollRowSettings();

  startSlider.min = "0";
  startSlider.max = String(ch);
  endSlider.min = "0";
  endSlider.max = String(ch);

  state.scrollFirstRow = Math.min(ch, Math.max(0, Math.round(state.scrollFirstRow)));
  state.scrollLastRow = Math.min(ch, Math.max(0, Math.round(state.scrollLastRow)));

  engine.scrollFirstRow = state.scrollFirstRow;
  engine.scrollLastRow = state.scrollLastRow;

  startSlider.value = String(state.scrollFirstRow);
  endSlider.value = String(state.scrollLastRow);
  $("scroll-start-val").textContent = `${state.scrollFirstRow}px`;
  $("scroll-end-val").textContent = `${state.scrollLastRow}px`;

  engine.measure();
}

function remeasureAndApply() {
  scheduleTimelineRefresh();
}

function bindRange(id, valId, format, onChange) {
  const input = $(id);
  const val = $(valId);
  input.addEventListener("pointerdown", () => {
    if (!undoManager.isRestoring()) pushUndo();
  });
  const update = () => {
    const v = input.type === "range" ? parseFloat(input.value) : input.value;
    if (val) val.textContent = format(v);
    onChange(v);
  };
  input.addEventListener("input", update);
  update();
}

function bindColorInput(id, onChange) {
  const input = $(id);
  input.addEventListener("pointerdown", () => {
    if (!undoManager.isRestoring()) pushUndo();
  });
  input.addEventListener("input", onChange);
}

function applyBgEffects() {
  const { w, h } = getDesignDimensions();
  applyBgEffectsToDom(bgVignetteLayer, bgColorOverlay, w, h, {
    vignetteEnabled: state.vignetteEnabled,
    vignetteColor: state.vignetteColor,
    vignetteRadiusX: state.vignetteRadiusX,
    vignetteRadiusY: state.vignetteRadiusY,
    vignetteSoftness: state.vignetteSoftness,
    vignetteOpacity: state.vignetteOpacity,
    colorOverlayEnabled: state.colorOverlayEnabled,
    colorOverlayColor: state.colorOverlayColor,
    colorOverlayOpacity: state.colorOverlayOpacity,
  });
  engine.applyTime(engine.timelineTime);
}

function applyBackground() {
  const fit = state.fitMode;
  bgImage.dataset.fit = fit;
  bgImage.style.objectFit = fit === "fill" ? "fill" : fit;

  applyBgEffects();
  engine.applyTime(engine.timelineTime);
}

function setAspectRatio(ratio) {
  canvas.dataset.aspect = ratio;
  syncPreviewLayout();
}

function clearBackground() {
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  if (bgSourceUrl && bgSourceUrl !== bgObjectUrl) URL.revokeObjectURL(bgSourceUrl);
  bgObjectUrl = null;
  bgSourceUrl = null;
  state.bgUrl = null;
  state.hasBackgroundImage = false;
  bgImage.classList.add("hidden");
  bgImage.removeAttribute("src");
  bgPlaceholder.classList.remove("hidden");
  $("bg-filename").textContent = "No file — gradient placeholder";
}

async function applyBackgroundDisplayUrl(displayUrl) {
  state.bgUrl = displayUrl;
  bgImage.onload = () => remeasureAndApply();
  bgImage.src = displayUrl;
  bgImage.classList.remove("hidden");
  bgPlaceholder.classList.add("hidden");
  requestAnimationFrame(() => remeasureAndApply());
  applyBackground();
}

async function refreshBackgroundRaster() {
  if (!bgSourceUrl || !state.hasBackgroundImage) return;

  try {
    const img = await loadImageElement(bgSourceUrl);
    const optimized = await rasterizeBackgroundToCanvasSize(
      img,
      state.aspectRatio,
      state.fitMode
    );
    const displayUrl = optimized ?? bgSourceUrl;

    if (bgObjectUrl && bgObjectUrl !== bgSourceUrl && bgObjectUrl !== displayUrl) {
      URL.revokeObjectURL(bgObjectUrl);
    }
    bgObjectUrl = displayUrl;
    await applyBackgroundDisplayUrl(displayUrl);
  } catch (err) {
    console.warn(err);
  }
}

async function loadBackground(file) {
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    alert("Background must be a still image (JPG, PNG, or WebP).");
    return;
  }

  if (!undoManager.isRestoring() && !isImporting) pushUndo();
  clearBackground();

  const sourceUrl = URL.createObjectURL(file);
  bgSourceUrl = sourceUrl;
  state.hasBackgroundImage = true;
  $("bg-filename").textContent = file.name;

  try {
    const img = await loadImageElement(sourceUrl);
    const optimized = await rasterizeBackgroundToCanvasSize(
      img,
      state.aspectRatio,
      state.fitMode
    );
    bgObjectUrl = optimized ?? sourceUrl;
    await applyBackgroundDisplayUrl(bgObjectUrl);
  } catch (err) {
    clearBackground();
    alert(`Could not load background: ${err.message}`);
  }
}

function initEditor() {
  textEditor.innerHTML = defaultEditorHtml();
  lastStyledHtml = textEditor.innerHTML;
  textPlain.value = htmlToPlain(textEditor);
  plainOnModeEnter = textPlain.value;
  textEditor.dataset.placeholder =
    "Type your scrolling text… Select words to style them.";
  textEditorWrap.dataset.mode = "styled";

  textEditor.addEventListener("beforeinput", () => {
    if (!undoManager.isRestoring()) undoManager.noteTypingStart();
  });

  textEditor.addEventListener("input", () => {
    lastStyledHtml = textEditor.innerHTML;
    syncFromEditor();
    undoManager.noteTypingEnd();
  });

  textEditor.addEventListener("keyup", refreshToolbarFromSelection);
  textEditor.addEventListener("mouseup", refreshToolbarFromSelection);
  textEditor.addEventListener("focus", refreshToolbarFromSelection);

  document.addEventListener("selectionchange", () => {
    if (state.editMode !== "styled") return;
    if (!textEditor.contains(document.activeElement) && !hasSelectionIn(textEditor)) {
      return;
    }
    requestAnimationFrame(refreshToolbarFromSelection);
  });

  textEditor.addEventListener("paste", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    e.preventDefault();
    const text = expandEmojiShortcodes(e.clipboardData.getData("text/plain"));
    document.execCommand("insertText", false, text);
    requestAnimationFrame(() => syncFromEditor());
  });

  const onPlainTextBeforeInput = () => {
    if (!undoManager.isRestoring()) undoManager.noteTypingStart();
  };
  const onPlainTextChange = () => {
    syncFromEditor();
    undoManager.noteTypingEnd();
  };
  textPlain.addEventListener("beforeinput", onPlainTextBeforeInput);
  textPlain.addEventListener("input", onPlainTextChange);
  textPlain.addEventListener("paste", () => {
    if (!undoManager.isRestoring()) pushUndo();
  });

  editModeToggle.addEventListener("change", () => {
    setEditMode(editModeToggle.checked ? "styled" : "plain");
  });
}

function initAlignButtons() {
  document.querySelectorAll("[data-align]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-align]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (!undoManager.isRestoring()) pushUndo();
      state.textAlign = btn.dataset.align;
      refreshPreview();
    });
  });
}

function initUndo() {
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z" || e.shiftKey) {
      return;
    }
    e.preventDefault();
    performUndo();
  });
}

function initControls() {
  fontPickerApi = initFontPicker($("font-picker"), (font) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.fontFamily = font.family.replace(/\+/g, " ");
    applyToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, {
        fontFamily: fontStack(state.fontFamily),
      });
    });
  });

  bindRange("font-size", "font-size-val", (v) => `${v}px`, (v) => {
    state.fontSize = v;
    applyToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, { fontSize: v });
    });
  });

  bindColorInput("font-color", (e) => {
    state.fontColor = e.target.value;
    applyToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, {
        color: hexToRgba(state.fontColor, state.fontOpacity),
      });
    });
  });

  bindRange("font-opacity", "font-opacity-val", (v) => `${v}%`, (v) => {
    state.fontOpacity = v / 100;
    applyToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, {
        color: hexToRgba(state.fontColor, state.fontOpacity),
        opacity: state.fontOpacity,
      });
    });
  });

  $("btn-bold").addEventListener("click", () => {
    if (!undoManager.isRestoring()) pushUndo();
    if (state.editMode !== "styled") {
      syncPreviewFromStyled();
      return;
    }
    const selStyle = getSelectionStyles(textEditor);
    const turnOn = selStyle?.bold !== true;
    if (hasSelectionIn(textEditor)) {
      applyStyleToSelection(textEditor, {
        fontWeight: turnOn ? "700" : "400",
      });
    } else {
      state.bold = turnOn;
      applyDefaultStylesToAllText();
    }
    refreshPreview();
    refreshToolbarFromSelection();
  });

  $("btn-italic").addEventListener("click", () => {
    if (!undoManager.isRestoring()) pushUndo();
    if (state.editMode !== "styled") {
      syncPreviewFromStyled();
      return;
    }
    const selStyle = getSelectionStyles(textEditor);
    const turnOn = selStyle?.italic !== true;
    if (hasSelectionIn(textEditor)) {
      applyStyleToSelection(textEditor, {
        fontStyle: turnOn ? "italic" : "normal",
      });
    } else {
      state.italic = turnOn;
      applyDefaultStylesToAllText();
    }
    refreshPreview();
    refreshToolbarFromSelection();
  });

  bindRange("line-height", "line-height-val", (v) => String(v), (v) => {
    state.lineHeight = v;
    refreshPreview();
  });

  bindRange("letter-spacing", "letter-spacing-val", (v) => `${v}px`, (v) => {
    state.letterSpacing = v;
    refreshPreview();
  });

  $("stroke-enabled").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.strokeEnabled = e.target.checked;
    setEffectPanelEnabled("stroke-controls", state.strokeEnabled);
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, strokeStylePayload(state));
    });
  });

  bindColorInput("stroke-color", (e) => {
    state.strokeColor = e.target.value;
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, strokeStylePayload(state));
    });
  });

  bindRange("stroke-opacity", "stroke-opacity-val", (v) => `${v}%`, (v) => {
    state.strokeOpacity = v / 100;
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, strokeStylePayload(state));
    });
  });

  bindRange("stroke-width", "stroke-width-val", (v) => `${v}px`, (v) => {
    state.strokeWidth = v;
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, strokeStylePayload(state));
    });
  });

  $("shadow-enabled").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.shadowEnabled = e.target.checked;
    setEffectPanelEnabled("shadow-controls", state.shadowEnabled);
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, shadowStylePayload(state));
    });
  });

  bindColorInput("shadow-color", (e) => {
    state.shadowColor = e.target.value;
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, shadowStylePayload(state));
    });
  });

  bindRange("shadow-opacity", "shadow-opacity-val", (v) => `${v}%`, (v) => {
    state.shadowOpacity = v / 100;
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, shadowStylePayload(state));
    });
  });

  bindRange("shadow-softness", "shadow-softness-val", (v) => `${v}px`, (v) => {
    state.shadowSoftness = v;
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, shadowStylePayload(state));
    });
  });

  bindRange("padding-h", "padding-h-val", (v) => `${v}px`, (v) => {
    state.paddingH = v;
    refreshPreview();
  });

  bindRange("scroll-speed", "scroll-speed-val", (v) => `${v} px/s`, (v) => {
    state.scrollSpeed = v;
    engine.speed = v;
    refreshTimeline();
  });

  bindRange("start-delay", "start-delay-val", (v) => `${v}s`, (v) => {
    state.startDelay = v;
    engine.startDelay = v;
    refreshTimeline();
  });

  bindRange("scroll-start", "scroll-start-val", (v) => `${v}px`, (v) => {
    state.scrollFirstRow = v;
    refreshTimeline({ syncScrollSliders: true });
  });

  bindRange("scroll-end", "scroll-end-val", (v) => `${v}px`, (v) => {
    state.scrollLastRow = v;
    refreshTimeline({ syncScrollSliders: true });
  });

  $("fit-mode").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.fitMode = e.target.value;
    applyBackground();
    refreshBackgroundRaster();
  });

  $("color-overlay-enabled").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.colorOverlayEnabled = e.target.checked;
    setEffectPanelEnabled("color-overlay-controls", state.colorOverlayEnabled);
    applyBgEffects();
  });

  bindColorInput("color-overlay-color", (e) => {
    state.colorOverlayColor = e.target.value;
    applyBgEffects();
  });

  bindRange("color-overlay-opacity", "color-overlay-opacity-val", (v) => `${v}%`, (v) => {
    state.colorOverlayOpacity = v;
    applyBgEffects();
  });

  $("vignette-enabled").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.vignetteEnabled = e.target.checked;
    setEffectPanelEnabled("vignette-controls", state.vignetteEnabled);
    applyBgEffects();
  });

  bindColorInput("vignette-color", (e) => {
    state.vignetteColor = e.target.value;
    applyBgEffects();
  });

  bindRange("vignette-radius-x", "vignette-radius-x-val", (v) => String(Math.round(v)), (v) => {
    state.vignetteRadiusX = v;
    applyBgEffects();
  });

  bindRange("vignette-radius-y", "vignette-radius-y-val", (v) => String(Math.round(v)), (v) => {
    state.vignetteRadiusY = v;
    applyBgEffects();
  });

  bindRange("vignette-softness", "vignette-softness-val", (v) => String(Math.round(v)), (v) => {
    state.vignetteSoftness = v;
    applyBgEffects();
  });

  bindRange("vignette-opacity", "vignette-opacity-val", (v) => `${v}%`, (v) => {
    state.vignetteOpacity = v;
    applyBgEffects();
  });

  bindRange("bg-music-volume", "bg-music-volume-val", (v) => `${v}%`, (v) => {
    state.musicVolume = v;
    applyMediaVolume(bgMusic, state.musicVolume);
    syncTimelineAudio(engine.timelineTime, {
      isPlaying: engine.running && !engine.paused,
    });
  });

  $("music-loop").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.musicLoop = e.target.checked;
    applyMusicLoop();
  });

  bindRange("bg-voice-volume", "bg-voice-volume-val", (v) => `${v}%`, (v) => {
    state.voiceVolume = v;
    applyMediaVolume(bgVoice, state.voiceVolume);
    syncTimelineAudio(engine.timelineTime, {
      isPlaying: engine.running && !engine.paused,
    });
  });

  $("bg-music-upload").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) loadMusic(file);
  });

  $("bg-voice-upload").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) loadVoiceover(file);
  });

  $("aspect-ratio").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.aspectRatio = e.target.value;
    setAspectRatio(state.aspectRatio);
    syncEngineDesignSpace();
    requestAnimationFrame(() => {
      refreshBackgroundRaster();
      updateScrollPositionControls();
      applyBgEffects();
      refreshPreview();
    });
  });

  $("bg-upload").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) loadBackground(file);
  });
}

function initPanelResize() {
  const stored = localStorage.getItem("scrolldrop-panel-w");
  if (stored) {
    const w = Math.min(560, Math.max(260, parseInt(stored, 10)));
    if (!Number.isNaN(w)) appMain.style.setProperty("--panel-w", `${w}px`);
  }

  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    if (!panelResizer.classList.contains("is-dragging")) return;
    const dx = e.clientX - startX;
    const w = Math.min(560, Math.max(260, startW + dx));
    appMain.style.setProperty("--panel-w", `${w}px`);
    syncPreviewLayout();
    engine.applyTime(engine.timelineTime);
  };

  const onUp = (e) => {
    if (!panelResizer.classList.contains("is-dragging")) return;
    panelResizer.classList.remove("is-dragging");
    panelResizer.releasePointerCapture(e.pointerId);
    const w = parseInt(
      getComputedStyle(appMain).getPropertyValue("--panel-w"),
      10
    );
    localStorage.setItem("scrolldrop-panel-w", String(w));
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    syncPreviewLayout();
    updateScrollPositionControls();
    refreshTimeline();
    applyBgEffects();
  };

  panelResizer.addEventListener("pointerdown", (e) => {
    startX = e.clientX;
    startW = parseInt(
      getComputedStyle(appMain).getPropertyValue("--panel-w"),
      10
    );
    panelResizer.classList.add("is-dragging");
    panelResizer.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  panelResizer.addEventListener("pointermove", onMove);
  panelResizer.addEventListener("pointerup", onUp);
  panelResizer.addEventListener("pointercancel", onUp);

  panelResizer.addEventListener("keydown", (e) => {
    let w = parseInt(
      getComputedStyle(appMain).getPropertyValue("--panel-w"),
      10
    );
    if (e.key === "ArrowLeft") w = Math.max(260, w - 16);
    else if (e.key === "ArrowRight") w = Math.min(560, w + 16);
    else return;
    e.preventDefault();
    appMain.style.setProperty("--panel-w", `${w}px`);
    localStorage.setItem("scrolldrop-panel-w", String(w));
  });
}

function initTimeline() {
  timelineScrub.addEventListener("pointerdown", () => {
    if (isExporting) return;
    isScrubbing = true;
    if (engine.running) engine.pause();
    pauseTimelineAudio();
    updatePlayPauseButton();
  });

  timelineScrub.addEventListener("input", () => {
    if (isExporting) return;
    const t = parseInt(timelineScrub.value, 10) / 10;
    engine.seek(t);
    syncTimelineAudio(t);
    timeCurrent.textContent = formatTime(t);
    const total = engine.getTotalDuration();
    timeTotal.textContent = formatTime(total);
  });

  timelineScrub.addEventListener("pointerup", () => {
    isScrubbing = false;
  });
}

function initTransport() {
  btnPlayPause.addEventListener("click", togglePlayPause);

  $("btn-reset").addEventListener("click", () => {
    engine.reset();
    if (bgMusic.src) {
      bgMusic.pause();
      bgMusic.currentTime = 0;
    }
    if (bgVoice.src) {
      bgVoice.pause();
      bgVoice.currentTime = 0;
    }
    syncTimelineAudio(0);
    refreshDuration();
    updatePlayPauseButton();
  });

}

async function runExport() {
  if (isExporting) return;
  isExporting = true;
  const exportBtn = $("btn-export");
  const progressEl = $("export-progress");
  const progressFill = $("export-progress-fill");
  const progressLabel = $("export-progress-label");

  exportBtn.disabled = true;
  btnPlayPause.disabled = true;
  $("btn-export-setup").disabled = true;
  $("btn-import-setup").disabled = true;
  timelineScrub.disabled = true;
  progressEl.classList.remove("hidden");
  canvas.classList.add("is-recording");

  const savedOnTimeUpdate = engine.onTimeUpdate;
  engine.onTimeUpdate = () => {};

  try {
    syncFromEditor();
    engine.stop();
    pauseTimelineAudio();
    engine.speed = state.scrollSpeed;
    engine.startDelay = state.startDelay;
    engine.scrollFirstRow = state.scrollFirstRow;
    engine.scrollLastRow = state.scrollLastRow;
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    updateScrollPositionControls();
    engine.reset();

    progressLabel.textContent = "Preparing export…";

    const blob = await exportRecording(canvas, engine, {
      musicEl: bgMusic.src ? bgMusic : null,
      voiceEl: bgVoice.src ? bgVoice : null,
      musicVolume: state.musicVolume,
      musicLoop: state.musicLoop,
      voiceVolume: state.voiceVolume,
      onFrame: async (t) => {
        syncTimelineAudio(t);
      },
      onProgress: (pct) => {
        progressFill.style.width = `${pct}%`;
      },
      onStatus: (msg) => {
        progressLabel.textContent = msg;
      },
    });

    downloadBlob(blob, "scrolldrop-export.mp4");
    progressLabel.textContent = "Export complete — download started";
    playbackStatus.textContent = "Export complete";
    pauseTimelineAudio();
  } catch (err) {
    console.error(err);
    progressLabel.textContent = `Export failed: ${err.message}`;
    playbackStatus.textContent = "Export failed";
    alert(`Export failed: ${err.message}`);
  } finally {
    engine.onTimeUpdate = savedOnTimeUpdate;
    isExporting = false;
    exportBtn.disabled = false;
    btnPlayPause.disabled = false;
    $("btn-export-setup").disabled = false;
    $("btn-import-setup").disabled = false;
    timelineScrub.disabled = false;
    canvas.classList.remove("is-recording");
    setTimeout(() => progressEl.classList.add("hidden"), 3000);
  }
}

function serializeSettings() {
  const { bgUrl: _bgUrl, ...settings } = state;
  return {
    ...settings,
    scrollFirstRow: state.scrollFirstRow,
    scrollLastRow: state.scrollLastRow,
  };
}

function serializeTextState() {
  syncFromEditor();
  const styledHtml = lastStyledHtml || textEditor.innerHTML;
  return {
    editMode: state.editMode,
    styledHtml,
    plainText:
      state.editMode === "plain"
        ? textPlain.value
        : htmlToPlain(styledHtml),
  };
}

function serializeTimelineState() {
  return {
    position: engine.timelineTime,
    speed: engine.speed,
    startDelay: engine.startDelay,
    scrollFirstRow: engine.scrollFirstRow,
    scrollLastRow: engine.scrollLastRow,
    measuredDurationSec: engine.getTotalDuration(),
  };
}

function serializeUiState() {
  const collapsibles = {};
  document.querySelectorAll(".collapsible").forEach((el) => {
    if (el.id) collapsibles[el.id] = el.open;
  });
  const panelW = appMain.style.getPropertyValue("--panel-w");
  return {
    activeTab: localStorage.getItem("scrolldrop-active-tab") || "text",
    collapsibles,
    panelWidth: panelW || localStorage.getItem("scrolldrop-panel-w") || null,
  };
}

function collectProjectMediaRefs() {
  const bgName = cleanBgFileName($("bg-filename").textContent);
  const musicName = $("bg-music-filename").textContent;
  const voiceName = $("bg-voice-filename").textContent;

  return {
    background: state.hasBackgroundImage && bgName
      ? { type: "image", fileName: bgName }
      : null,
    music:
      bgMusic.src && !musicName.startsWith("No music")
        ? { type: "music", fileName: musicName }
        : null,
    voiceover:
      bgVoice.src && !voiceName.startsWith("No voiceover")
        ? { type: "voiceover", fileName: voiceName }
        : null,
  };
}

async function collectProjectMedia() {
  let background = null;

  if (state.hasBackgroundImage && bgImage.src) {
    background = await urlToDataPayload(
      bgImage.currentSrc || bgImage.src,
      cleanBgFileName($("bg-filename").textContent),
      { type: "image" }
    );
  }

  let music = null;
  const musicName = $("bg-music-filename").textContent;
  if (bgMusic.src && !musicName.startsWith("No music")) {
    music = await urlToDataPayload(bgMusic.currentSrc || bgMusic.src, musicName, {
      type: "music",
    });
  }

  let voiceover = null;
  const voiceName = $("bg-voice-filename").textContent;
  if (bgVoice.src && !voiceName.startsWith("No voiceover")) {
    voiceover = await urlToDataPayload(bgVoice.currentSrc || bgVoice.src, voiceName, {
      type: "voiceover",
    });
  }

  return { background, music, voiceover };
}

async function buildSetupDocument(embedMedia) {
  syncFromEditor();
  const media = embedMedia
    ? await collectProjectMedia()
    : collectProjectMediaRefs();
  return buildProjectDocument({
    settings: serializeSettings(),
    text: serializeTextState(),
    media,
    timeline: serializeTimelineState(),
    ui: serializeUiState(),
    embedMedia,
  });
}

async function blobFromObjectUrl(url) {
  if (!url) return null;
  const res = await fetch(url);
  return res.blob();
}

async function getMediaBlobsForCloud() {
  const out = {};
  if (state.hasBackgroundImage && bgImage.src) {
    const fileName = cleanBgFileName($("bg-filename").textContent) || "background.jpg";
    const blob = await blobFromObjectUrl(bgImage.currentSrc || bgImage.src);
    out.background = {
      blob,
      fileName,
      mimeType: blob.type || "image/jpeg",
    };
  }
  const musicName = $("bg-music-filename").textContent;
  if (bgMusic.src && !musicName.startsWith("No music")) {
    const blob = await blobFromObjectUrl(bgMusic.currentSrc || bgMusic.src);
    out.music = {
      blob,
      fileName: musicName,
      mimeType: blob.type || "audio/mpeg",
    };
  }
  const voiceName = $("bg-voice-filename").textContent;
  if (bgVoice.src && !voiceName.startsWith("No voiceover")) {
    const blob = await blobFromObjectUrl(bgVoice.currentSrc || bgVoice.src);
    out.voiceover = {
      blob,
      fileName: voiceName,
      mimeType: blob.type || "audio/mpeg",
    };
  }
  return out;
}

async function runCloudExport(renderName = "") {
  if (isCloudUploading) return;
  isCloudUploading = true;

  const progressEl = $("export-progress");
  const progressFill = $("export-progress-fill");
  const progressLabel = $("export-progress-label");
  const progressHint = $("export-progress-hint");

  progressEl.classList.remove("hidden");
  progressHint.textContent = "Uploading to cloud queue — editor stays unlocked after upload.";
  progressLabel.textContent = "Preparing cloud render…";
  progressFill.style.width = "5%";

  try {
    syncFromEditor();
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }

    const durationSec = refreshTimeline();
    if (durationSec > LIMITS.maxDurationSec) {
      throw new Error(
        `Estimated duration ${durationSec.toFixed(1)}s exceeds ${LIMITS.maxDurationSec}s (30 min) cloud cap. Shorten text or increase scroll speed.`
      );
    }

    const result = await startCloudRender({
      renderName: renderName.trim() || defaultRenderName(),
      buildDocument: () => buildSetupDocument(false),
      getMediaBlobs: getMediaBlobsForCloud,
      getIdToken,
      onProgress: (pct) => {
        progressFill.style.width = `${pct}%`;
      },
      onStatus: (msg) => {
        progressLabel.textContent = msg;
      },
    });

    openQueuePanel();
    progressFill.style.width = "100%";
    progressLabel.textContent = `Queued: ${result.renderName || result.jobId.slice(0, 8)}`;
    playbackStatus.textContent = "Cloud render queued — track in queue panel";
  } catch (err) {
    console.error(err);
    progressLabel.textContent = `Cloud export failed: ${err.message}`;
    playbackStatus.textContent = "Cloud export failed";
    alert(`Cloud export failed: ${err.message}`);
  } finally {
    isCloudUploading = false;
    progressHint.textContent = "Track progress in the queue panel (header → Queue).";
    setTimeout(() => progressEl.classList.add("hidden"), 5000);
  }
}

function defaultRenderName() {
  const now = new Date();
  const stamp = now.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Render ${stamp}`;
}

function openRenderNameDialog() {
  const dialog = $("render-name-dialog");
  const input = $("render-name-input");
  if (!dialog?.showModal) {
    runCloudExport();
    return;
  }
  input.value = defaultRenderName();
  dialog.showModal();
  input.focus();
  input.select();
}

function openQueuePanel() {
  const panel = $("render-queue-panel");
  const toggle = $("btn-queue-toggle");
  panel?.classList.remove("hidden");
  toggle?.setAttribute("aria-expanded", "true");
  localStorage.setItem("scrolldrop-queue-open", "1");
  ensurePolling();
  requestAnimationFrame(() => syncPreviewLayout());
}

function closeQueuePanel() {
  const panel = $("render-queue-panel");
  const toggle = $("btn-queue-toggle");
  panel?.classList.add("hidden");
  toggle?.setAttribute("aria-expanded", "false");
  localStorage.setItem("scrolldrop-queue-open", "0");
  requestAnimationFrame(() => syncPreviewLayout());
}

function toggleQueuePanel() {
  const panel = $("render-queue-panel");
  if (panel?.classList.contains("hidden")) openQueuePanel();
  else closeQueuePanel();
}

const REEDIT_STATUSES = new Set(["cancelled", "failed", "completed"]);

function formatJobStatus(status) {
  return String(status || "").replace(/_/g, " ");
}

function renderQueueCard(job) {
  const card = document.createElement("article");
  card.className = "render-queue-card";
  card.dataset.jobId = job.jobId;

  const title = document.createElement("p");
  title.className = "render-queue-card-title";
  title.textContent = job.renderName || `Render ${job.jobId.slice(0, 8)}`;

  const status = document.createElement("span");
  status.className = `render-queue-status is-${job.status}`;
  status.textContent = formatJobStatus(job.status);

  const meta = document.createElement("p");
  meta.className = "render-queue-card-meta";
  const parts = [];
  if (job.segmentProgress?.total) {
    parts.push(`part ${job.segmentProgress.completed}/${job.segmentProgress.total}`);
  }
  if (job.estimatedDurationSec) parts.push(`~${Math.round(job.estimatedDurationSec)}s video`);
  if (job.progress && isActive(job.status)) parts.push(`${job.progress}%`);
  if (job.statusMessage && isActive(job.status)) parts.push(job.statusMessage);
  if (job.error) parts.push(job.error);
  meta.textContent = parts.join(" · ") || `Job ${job.jobId.slice(0, 8)}`;

  card.append(title, status, meta);

  if (isActive(job.status)) {
    const bar = document.createElement("div");
    bar.className = "render-queue-progress";
    const fill = document.createElement("div");
    fill.style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;
    bar.append(fill);
    card.append(bar);
  }

  const actions = document.createElement("div");
  actions.className = "render-queue-card-actions";

  if (isActive(job.status)) {
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-secondary btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      const msg =
        job.status === "processing"
          ? "Stop this render? Your project files will be kept."
          : "Cancel this render?";
      if (!confirm(msg)) return;
      cancelBtn.disabled = true;
      try {
        await cancelJob(job.jobId, { getIdToken });
      } catch (err) {
        alert(err.message);
        cancelBtn.disabled = false;
      }
    });
    actions.append(cancelBtn);
  }

  if (job.status === "completed" && job.downloadUrl) {
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn btn-primary btn-sm";
    dlBtn.textContent = "Download";
    dlBtn.addEventListener("click", () => {
      triggerDownload(job.downloadUrl, `${(job.renderName || "scrolldrop-export").replace(/\W+/g, "-")}.mp4`);
    });
    actions.append(dlBtn);
  }

  appendReEditButton(actions, job);

  if (job.status === "cancelled" || job.status === "failed") {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "btn btn-secondary btn-sm";
    retryBtn.textContent = "Re-create";
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      try {
        await retryJob(job.jobId, { getIdToken });
      } catch (err) {
        alert(err.message);
        retryBtn.disabled = false;
      }
    });
    actions.append(retryBtn);
  }

  appendDeleteButton(actions, job);

  if (actions.childElementCount) card.append(actions);
  return card;
}

function appendDeleteButton(actions, job) {
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-secondary btn-sm render-queue-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    const isActiveJob = isActive(job.status);
    const msg = isActiveJob
      ? "Stop this render and delete all files? This cannot be undone."
      : "Delete this render and all files? This cannot be undone.";
    if (!confirm(msg)) return;
    deleteBtn.disabled = true;
    try {
      await deleteJob(job.jobId, { getIdToken });
    } catch (err) {
      alert(err.message);
      deleteBtn.disabled = false;
    }
  });
  actions.append(deleteBtn);
}

function appendReEditButton(actions, job) {
  if (!REEDIT_STATUSES.has(job.status)) return;

  const reEditBtn = document.createElement("button");
  reEditBtn.type = "button";
  reEditBtn.className = "btn btn-secondary btn-sm";
  reEditBtn.textContent = "Re-Edit";
  reEditBtn.addEventListener("click", () => reEditJobFromQueue(job.jobId, reEditBtn));
  actions.append(reEditBtn);
}

async function reEditJobFromQueue(jobId, triggerBtn) {
  if (isExporting || isCloudUploading) {
    alert("Wait until the current export finishes.");
    return;
  }

  const prevLabel = triggerBtn?.textContent;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Loading…";
  }
  isImporting = true;

  try {
    const { setup } = await fetchJobSetup(jobId, { getIdToken });
    const doc = parseProjectDocument(setup);
    await applyProjectDocument(doc);
    undoManager.reset();
    playbackStatus.textContent = "Project loaded from render queue";
  } catch (err) {
    console.error(err);
    alert(`Could not load project: ${err.message}`);
    playbackStatus.textContent = "Re-Edit failed";
  } finally {
    isImporting = false;
    if (triggerBtn) {
      triggerBtn.disabled = false;
      if (prevLabel != null) triggerBtn.textContent = prevLabel;
    }
  }
}

function renderQueueLists(groups) {
  const empty = $("render-queue-empty");
  const sections = [
    { key: "active", el: $("render-queue-active"), section: $("render-queue-active-section") },
    { key: "today", el: $("render-queue-today"), section: $("render-queue-today-section") },
    { key: "last7", el: $("render-queue-week"), section: $("render-queue-week-section") },
  ];

  const hasAny =
    groups.active.length + groups.today.length + groups.last7.length > 0;
  empty?.classList.toggle("hidden", hasAny);

  for (const { key, el, section } of sections) {
    const jobs = groups[key === "last7" ? "last7" : key] || [];
    if (!el || !section) continue;
    el.replaceChildren(...jobs.map(renderQueueCard));
    section.classList.toggle("hidden", jobs.length === 0);
  }
}

function initRenderQueue() {
  const pollOpts = { getIdToken };
  startPolling(pollOpts);
  const notifiedCompletions = new Set();

  onQueueUpdate((groups) => {
    renderQueueLists(groups);
    for (const job of groups.all || []) {
      if (
        job.status === "completed" &&
        job.downloadUrl &&
        !notifiedCompletions.has(job.jobId)
      ) {
        notifiedCompletions.add(job.jobId);
        playbackStatus.textContent = `Cloud render ready: ${job.renderName || job.jobId.slice(0, 8)}`;
      }
    }
  });

  $("btn-queue-toggle")?.addEventListener("click", toggleQueuePanel);
  $("btn-queue-close")?.addEventListener("click", closeQueuePanel);

  if (localStorage.getItem("scrolldrop-queue-open") === "1") {
    openQueuePanel();
  }

  const nameDialog = $("render-name-dialog");
  $("render-name-cancel")?.addEventListener("click", () => nameDialog?.close());
  $("render-name-form")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("render-name-input")?.value || "";
    nameDialog?.close();
    await runCloudExport(name);
  });
}

function openExportChoiceDialog() {
  const dialog = $("export-choice-dialog");
  if (!dialog?.showModal) {
    runExport();
    return;
  }
  dialog.showModal();
}

async function handleExportChoice(ev) {
  ev?.preventDefault();
  const dialog = $("export-choice-dialog");
  const selected = dialog?.querySelector('input[name="export-target"]:checked')?.value || "browser";
  dialog?.close();
  if (selected === "cloud") {
    openRenderNameDialog();
  } else {
    await runExport();
  }
}

function initAuthUi() {
  const signInBtn = $("btn-auth-signin");
  const signOutBtn = $("btn-auth-signout");
  const userEl = $("auth-user");

  initAuth().then((state) => {
    if (!state.enabled) return;
    signInBtn?.classList.remove("hidden");
    updateAuthUi();
  });

  signInBtn?.addEventListener("click", async () => {
    try {
      await signInWithGoogle();
      updateAuthUi();
    } catch (err) {
      alert(err.message);
    }
  });

  signOutBtn?.addEventListener("click", async () => {
    await signOut();
    updateAuthUi();
  });

  function updateAuthUi() {
    const user = getCurrentUser();
    if (user) {
      userEl.textContent = user.email || user.displayName || "Signed in";
      userEl.classList.remove("hidden");
      signInBtn?.classList.add("hidden");
      signOutBtn?.classList.remove("hidden");
    } else {
      userEl.classList.add("hidden");
      signInBtn?.classList.remove("hidden");
      signOutBtn?.classList.add("hidden");
    }
  }
}

const STATE_MEDIA_KEYS = new Set(["bgUrl", "hasBackgroundImage"]);

function applySettingsFromDocument(settings) {
  if (!settings || typeof settings !== "object") return;

  const legacyScrollKeys = new Set(["scrollStartY", "scrollEndY", "scrollEndAuto"]);

  for (const [key, value] of Object.entries(settings)) {
    if (STATE_MEDIA_KEYS.has(key)) continue;
    if (key in state || legacyScrollKeys.has(key)) state[key] = value;
  }
}

function applyImportedText(text) {
  if (!text) return;

  lastStyledHtml =
    text.styledHtml && String(text.styledHtml).trim()
      ? text.styledHtml
      : defaultEditorHtml();
  textPlain.value = expandEmojiShortcodes(text.plainText ?? htmlToPlain(lastStyledHtml));
  plainOnModeEnter = textPlain.value;

  const mode = text.editMode === "plain" ? "plain" : "styled";
  state.editMode = mode;
  editModeToggle.checked = mode === "styled";
  textEditorWrap.dataset.mode = mode;

  if (mode === "styled") {
    textEditor.innerHTML = lastStyledHtml;
    expandShortcodesInEditable(textEditor);
    lastStyledHtml = textEditor.innerHTML;
    textEditor.classList.remove("hidden");
    textPlain.classList.add("hidden");
    viewLabelPlain.classList.remove("is-active");
    viewLabelStyled.classList.add("is-active");
    editModeHint.textContent =
      "Styled — select words and format visually. Updates preview live.";
  } else {
    textEditor.classList.add("hidden");
    textPlain.classList.remove("hidden");
    viewLabelPlain.classList.add("is-active");
    viewLabelStyled.classList.remove("is-active");
    editModeHint.textContent =
      "Plain text editor only. Preview and export keep your styled text.";
  }
}

function applyUiFromDocument(ui) {
  if (!ui || typeof ui !== "object") return;

  if (ui.panelWidth) {
    const w = parseInt(String(ui.panelWidth).replace(/px$/, ""), 10);
    if (!Number.isNaN(w)) {
      const clamped = Math.min(560, Math.max(260, w));
      appMain.style.setProperty("--panel-w", `${clamped}px`);
      localStorage.setItem("scrolldrop-panel-w", String(clamped));
    }
  }

  if (ui.collapsibles && typeof ui.collapsibles === "object") {
    for (const [id, open] of Object.entries(ui.collapsibles)) {
      const el = document.getElementById(id);
      if (el && "open" in el) el.open = !!open;
    }
  }

  if (ui.activeTab && CONTROL_TAB_IDS.includes(ui.activeTab)) {
    activateControlTab(ui.activeTab);
  }
}

async function applyMediaFromDocument(media) {
  clearBackground();
  clearMusic();
  clearVoiceover();

  if (!media || typeof media !== "object") return;

  const bg = media.background;
  if (bg?.dataUrl) {
    try {
      const file = await dataUrlToFile(bg);
      await loadBackground(file);
    } catch (err) {
      console.warn(err);
      $("bg-filename").textContent = `${bg.fileName || "background"} (import failed)`;
    }
  } else if (bg?.fileName) {
    $("bg-filename").textContent = `${bg.fileName} (not embedded — re-upload)`;
  }

  const music = media.music;
  if (music?.dataUrl) {
    try {
      const file = await dataUrlToFile(music);
      loadMusic(file);
    } catch (err) {
      console.warn(err);
      $("bg-music-filename").textContent = `${music.fileName || "music"} (import failed)`;
    }
  } else if (music?.fileName) {
    $("bg-music-filename").textContent = `${music.fileName} (not embedded — re-upload)`;
  }

  const voice = media.voiceover;
  if (voice?.dataUrl) {
    try {
      const file = await dataUrlToFile(voice);
      loadVoiceover(file);
    } catch (err) {
      console.warn(err);
      $("bg-voice-filename").textContent = `${voice.fileName || "voiceover"} (import failed)`;
    }
  } else if (voice?.fileName) {
    $("bg-voice-filename").textContent = `${voice.fileName} (not embedded — re-upload)`;
  }
}

async function applyProjectDocument(doc) {
  engine.stop();
  pauseTimelineAudio();

  applySettingsFromDocument(doc.settings);
  applyImportedText(doc.text);
  await applyMediaFromDocument(doc.media);

  const timeline = doc.timeline;
  if (timeline && typeof timeline === "object") {
    if (timeline.speed != null) {
      state.scrollSpeed = timeline.speed;
      engine.speed = timeline.speed;
    }
    if (timeline.startDelay != null) {
      state.startDelay = timeline.startDelay;
      engine.startDelay = timeline.startDelay;
    }
    if (timeline.scrollFirstRow != null) state.scrollFirstRow = timeline.scrollFirstRow;
    if (timeline.scrollLastRow != null) state.scrollLastRow = timeline.scrollLastRow;
  }

  setAspectRatio(state.aspectRatio);
  syncEngineDesignSpace();
  applyStateToControls();
  applyBackground();
  applyMusicLoop();
  refreshPreview();
  updateScrollPositionControls();

  const position =
    timeline && typeof timeline.position === "number" ? timeline.position : 0;
  engine.applyTime(position);
  refreshDuration();
  updatePlayPauseButton();
  refreshToolbarFromSelection();
  syncTimelineAudio(engine.timelineTime, { isPlaying: false });

  applyUiFromDocument(doc.ui);
}

async function importSetupJson(file) {
  if (!file || isExporting) return;

  const text = await file.text();
  const doc = parseProjectDocument(text);

  const importBtn = $("btn-import-setup");
  const exportBtn = $("btn-export-setup");
  const prevLabel = importBtn?.textContent;

  isImporting = true;
  importBtn.disabled = true;
  exportBtn.disabled = true;
  if (importBtn) importBtn.textContent = "Importing…";

  try {
    await applyProjectDocument(doc);
    undoManager.reset();
    playbackStatus.textContent = "Setup imported from JSON";
  } catch (err) {
    console.error(err);
    alert(`Could not import setup: ${err.message}`);
    playbackStatus.textContent = "Setup import failed";
  } finally {
    isImporting = false;
    importBtn.disabled = false;
    exportBtn.disabled = false;
    if (importBtn && prevLabel != null) importBtn.textContent = prevLabel;
  }
}

async function exportSetupJson(options = {}) {
  if (isExporting) return;

  const {
    embedMedia = true,
    triggerBtn = null,
    savingLabel = "Exporting…",
    doneStatus = "Setup exported as JSON",
    filenamePrefix = "scrolldrop-setup",
  } = options;

  const buttons = [triggerBtn, $("btn-export-setup")].filter(Boolean);

  const prevLabels = new Map();
  buttons.forEach((btn) => {
    prevLabels.set(btn, btn.textContent);
    btn.disabled = true;
    if (btn === triggerBtn) btn.textContent = savingLabel;
  });

  try {
    const doc = await buildSetupDocument(embedMedia);

    const bytes = estimateProjectSize(doc);
    if (embedMedia && bytes > 25 * 1024 * 1024) {
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      const ok = confirm(
        `This setup file will be about ${mb} MB (media is embedded). Export anyway?`
      );
      if (!ok) return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    downloadProjectJson(doc, `${filenamePrefix}-${stamp}.json`);
    playbackStatus.textContent = doneStatus;
  } catch (err) {
    console.error(err);
    alert(`Could not export setup: ${err.message}`);
    playbackStatus.textContent = "Setup export failed";
  } finally {
    buttons.forEach((btn) => {
      btn.disabled = false;
      const prev = prevLabels.get(btn);
      if (prev != null) btn.textContent = prev;
    });
  }
}

function initExport() {
  $("btn-export").addEventListener("click", openExportChoiceDialog);

  const dialog = $("export-choice-dialog");
  dialog?.querySelector("form")?.addEventListener("submit", handleExportChoice);
  $("export-choice-cancel")?.addEventListener("click", () => dialog?.close());

  const importInput = $("import-setup-file");
  $("btn-import-setup").addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await importSetupJson(file);
  });

  $("btn-export-setup").addEventListener("click", () => {
    const embedMedia = $("export-setup-embed-media").checked;
    exportSetupJson({
      embedMedia,
      triggerBtn: $("btn-export-setup"),
      savingLabel: "Exporting…",
      doneStatus: "Setup exported as JSON",
      filenamePrefix: "scrolldrop-setup",
    });
  });
}

function initCollapsibles() {
  document.querySelectorAll(".collapsible").forEach((el) => {
    const key = `scrolldrop-${el.id}`;
    const saved = localStorage.getItem(key);
    if (saved === "open") el.open = true;
    if (saved === "closed") el.open = false;

    el.addEventListener("toggle", () => {
      localStorage.setItem(key, el.open ? "open" : "closed");
    });
  });
}

const CONTROL_TAB_IDS = ["text", "background", "audio", "settings"];

function activateControlTab(tabId) {
  if (!CONTROL_TAB_IDS.includes(tabId)) tabId = "text";

  document.querySelectorAll(".control-tab").forEach((tab) => {
    const on = tab.dataset.tab === tabId;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  });

  document.querySelectorAll(".control-tab-panel").forEach((panel) => {
    const on = panel.id === `tab-panel-${tabId}`;
    panel.classList.toggle("is-active", on);
    panel.hidden = !on;
  });

  localStorage.setItem("scrolldrop-active-tab", tabId);
}

function initControlTabs() {
  const tabs = document.querySelectorAll(".control-tab");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateControlTab(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      const idx = CONTROL_TAB_IDS.indexOf(tab.dataset.tab);
      if (idx < 0) return;
      let next = idx;
      if (e.key === "ArrowRight") next = (idx + 1) % CONTROL_TAB_IDS.length;
      else if (e.key === "ArrowLeft") {
        next = (idx - 1 + CONTROL_TAB_IDS.length) % CONTROL_TAB_IDS.length;
      } else return;
      e.preventDefault();
      const target = document.querySelector(
        `.control-tab[data-tab="${CONTROL_TAB_IDS[next]}"]`
      );
      target?.click();
      target?.focus();
    });
  });

  const saved = localStorage.getItem("scrolldrop-active-tab");
  activateControlTab(CONTROL_TAB_IDS.includes(saved) ? saved : "text");
}

function init() {
  initEditor();
  initUndo();
  initAlignButtons();
  initControls();
  initControlTabs();
  initCollapsibles();
  initPanelResize();
  applyMediaVolume(bgMusic, state.musicVolume);
  applyMediaVolume(bgVoice, state.voiceVolume);
  $("music-loop").checked = state.musicLoop;
  bgMusic.loop = state.musicLoop;
  initTimeline();
  initTransport();
  initExport();
  initRenderQueue();
  initAuthUi();
  setAspectRatio(state.aspectRatio);
  syncEngineDesignSpace();
  syncPreviewLayout();
  syncFromEditor();
  applyBackground();
  engine.speed = state.scrollSpeed;
  engine.startDelay = state.startDelay;
  updateScrollPositionControls();
  engine.applyTime(0);
  refreshDuration();
  requestAnimationFrame(() => {
    syncPreviewLayout();
    engine.applyTime(engine.timelineTime);
  });
  updatePlayPauseButton();
  updateStyleHint(false);
  refreshToolbarFromSelection();
  setEffectPanelEnabled("stroke-controls", state.strokeEnabled);
  setEffectPanelEnabled("shadow-controls", state.shadowEnabled);
  setEffectPanelEnabled("color-overlay-controls", state.colorOverlayEnabled);
  setEffectPanelEnabled("vignette-controls", state.vignetteEnabled);

  window.addEventListener("resize", () => {
    syncPreviewLayout();
    updateScrollPositionControls();
    refreshTimeline();
    applyBgEffects();
  });
}

init();
