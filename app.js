import { initFontPicker } from "./fonts.js";
import { createUndoManager } from "./undoHistory.js";
import { getDesignCanvasSize } from "./canvasDesign.js";
import { ScrollPreview } from "./preview.js";
import { applyBgEffectsToDom } from "./backgroundEffects.js";
import { exportRecording, downloadBlob } from "./export.js";
import {
  buildProjectDocument,
  downloadProjectJson,
  estimateProjectSize,
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
  applyGlowLayer,
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
  glowEnabled: false,
  glowColor: "#000000",
  glowOpacity: 0.6,
  glowRadius: 24,
  glowSharpness: 12,
  glowSoftness: 50,
  paddingH: 48,
  scrollSpeed: 80,
  startDelay: 0,
  /** Canvas Y (px): top edge of text at timeline start. */
  scrollFirstRow: null,
  /** Canvas Y (px): bottom edge of text at timeline end. */
  scrollLastRow: null,
  fitMode: "cover",
  blur: 0,
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
const textEl = $("text-content");
const textEditor = $("text-editor");
const textPlain = $("text-plain");
const textEditorWrap = $("text-editor-wrap");
const editModeHint = $("edit-mode-hint");
const editModeToggle = $("edit-mode-toggle");
const viewLabelPlain = $("view-label-plain");
const viewLabelStyled = $("view-label-styled");
const textContainer = $("text-scroll-container");
const textGlowBack = $("text-glow-back");
const bgImage = $("bg-image");
const bgMusic = $("bg-music");
const bgVoice = $("bg-voice");
const bgPlaceholder = $("bg-placeholder");

let bgMusicObjectUrl = null;
let bgVoiceObjectUrl = null;
const overlayLayer = $("overlay-layer");
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
let isExporting = false;
let isScrubbing = false;
let lastStyledHtml = "";
let plainOnModeEnter = "";
let fontPickerApi = null;

const undoManager = createUndoManager(captureUndoSnapshot, applyUndoSnapshot);

function pushUndo() {
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

  $("glow-enabled").checked = state.glowEnabled;
  $("glow-color").value = state.glowColor;
  $("glow-opacity").value = String(Math.round(state.glowOpacity * 100));
  $("glow-opacity-val").textContent = `${Math.round(state.glowOpacity * 100)}%`;
  $("glow-radius").value = String(state.glowRadius);
  $("glow-radius-val").textContent = `${state.glowRadius}px`;
  $("glow-sharpness").value = String(state.glowSharpness);
  $("glow-sharpness-val").textContent = `${state.glowSharpness}px`;
  $("glow-softness").value = String(state.glowSoftness);
  $("glow-softness-val").textContent = String(state.glowSoftness);

  $("blur").value = String(state.blur);
  $("blur-val").textContent = `${state.blur}px`;

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
  setEffectPanelEnabled("glow-controls", state.glowEnabled);
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
  if (state.glowEnabled && textGlowBack) {
    textGlowBack.style.transform = textEl.style.transform;
  }
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

function getLayoutStyles() {
  return {
    fontFamily: `"${state.fontFamily}", sans-serif`,
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

function syncGlowLayer() {
  applyGlowLayer(textGlowBack, state);
  if (!state.glowEnabled) return;

  textGlowBack.innerHTML = textEl.innerHTML;
  textGlowBack.style.transform = textEl.style.transform;
  textGlowBack.style.fontFamily = textEl.style.fontFamily;
  textGlowBack.style.fontSize = textEl.style.fontSize;
  textGlowBack.style.textAlign = textEl.style.textAlign;
  textGlowBack.style.lineHeight = textEl.style.lineHeight;
  textGlowBack.style.letterSpacing = textEl.style.letterSpacing;
  textGlowBack.style.paddingLeft = textEl.style.paddingLeft;
  textGlowBack.style.paddingRight = textEl.style.paddingRight;
  textGlowBack.style.width = textEl.style.width;

  canvas.dataset.glowColor = state.glowColor;
  canvas.dataset.glowRadius = String(state.glowRadius);
  canvas.dataset.glowSoftness = String(state.glowSoftness);
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
  syncGlowLayer();
  scheduleTimelineRefresh();
}

/** Apply control state to all text in styled mode when nothing is selected. */
function applyDefaultStylesToAllText() {
  if (state.editMode !== "styled") return;

  const color = hexToRgba(state.fontColor, state.fontOpacity);
  const fontFamily = `"${state.fontFamily}", sans-serif`;
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
    syncGlowLayer();
    scheduleTimelineRefresh();
    return;
  }

  lastStyledHtml = textEditor.innerHTML;
  applyLayoutStyles(textEditor, textEl, getLayoutStyles());
  syncEditorToPreview(textEditor, textEl);
  syncGlowLayer();
  scheduleTimelineRefresh();
}

function setEditMode(mode) {
  if (mode === state.editMode) return;
  if (!undoManager.isRestoring()) pushUndo();

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
  if (!undoManager.isRestoring()) pushUndo();
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
  if (!undoManager.isRestoring()) pushUndo();
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

function getPreviewDisplayScale() {
  const ch = canvas.clientHeight || textContainer.clientHeight || 1;
  const dh = getCanvasScrollHeight();
  return ch / dh;
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
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
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

  overlayLayer.dataset.blur = String(state.blur);
  overlayLayer.style.background = "transparent";
  overlayLayer.style.backdropFilter = state.blur > 0 ? `blur(${state.blur}px)` : "none";

  applyBgEffects();
  engine.applyTime(engine.timelineTime);
}

function setAspectRatio(ratio) {
  canvas.style.aspectRatio = ratio.replace("/", " / ");
  canvas.dataset.aspect = ratio;
}

function clearBackground() {
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgObjectUrl = null;
  state.bgUrl = null;
  state.hasBackgroundImage = false;
  bgImage.classList.add("hidden");
  bgImage.removeAttribute("src");
  bgPlaceholder.classList.remove("hidden");
  $("bg-filename").textContent = "No file — gradient placeholder";
}

async function loadBackground(file) {
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    alert("Background must be a still image (JPG, PNG, or WebP).");
    return;
  }

  if (!undoManager.isRestoring()) pushUndo();
  clearBackground();
  const url = URL.createObjectURL(file);
  bgObjectUrl = url;
  state.bgUrl = url;
  state.hasBackgroundImage = true;
  $("bg-filename").textContent = file.name;

  bgImage.onload = () => remeasureAndApply();
  bgImage.src = url;
  bgImage.classList.remove("hidden");
  bgPlaceholder.classList.add("hidden");
  requestAnimationFrame(() => remeasureAndApply());
  applyBackground();
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
    const text = e.clipboardData.getData("text/plain");
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
        fontFamily: `"${state.fontFamily}", sans-serif`,
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

  $("glow-enabled").addEventListener("change", (e) => {
    if (!undoManager.isRestoring()) pushUndo();
    state.glowEnabled = e.target.checked;
    setEffectPanelEnabled("glow-controls", state.glowEnabled);
    refreshPreview();
  });

  bindColorInput("glow-color", (e) => {
    state.glowColor = e.target.value;
    refreshPreview();
  });

  bindRange("glow-opacity", "glow-opacity-val", (v) => `${v}%`, (v) => {
    state.glowOpacity = v / 100;
    refreshPreview();
  });

  bindRange("glow-radius", "glow-radius-val", (v) => `${v}px`, (v) => {
    state.glowRadius = v;
    refreshPreview();
  });

  bindRange("glow-sharpness", "glow-sharpness-val", (v) => `${v}px`, (v) => {
    state.glowSharpness = v;
    refreshPreview();
  });

  bindRange("glow-softness", "glow-softness-val", (v) => String(v), (v) => {
    state.glowSoftness = v;
    refreshPreview();
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
  });

  bindRange("blur", "blur-val", (v) => `${v}px`, (v) => {
    state.blur = v;
    applyBackground();
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
        if (state.glowEnabled && textGlowBack) {
          syncGlowLayer();
        }
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
  return {
    editMode: state.editMode,
    styledHtml: lastStyledHtml || textEditor.innerHTML,
    plainText: textPlain.value,
  };
}

function serializeTimelineState() {
  return {
    position: engine.timelineTime,
    speed: engine.speed,
    startDelay: engine.startDelay,
    scrollFirstRow: engine.scrollFirstRow,
    scrollLastRow: engine.scrollLastRow,
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
  $("btn-export").addEventListener("click", runExport);
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

function initControlTabs() {
  const tabs = document.querySelectorAll(".control-tab");
  const panels = document.querySelectorAll(".control-tab-panel");
  const storageKey = "scrolldrop-active-tab";

  const activate = (tabId) => {
    if (!CONTROL_TAB_IDS.includes(tabId)) tabId = "text";

    tabs.forEach((tab) => {
      const on = tab.dataset.tab === tabId;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    });

    panels.forEach((panel) => {
      const on = panel.id === `tab-panel-${tabId}`;
      panel.classList.toggle("is-active", on);
      panel.hidden = !on;
    });

    localStorage.setItem(storageKey, tabId);
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.tab));
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

  const saved = localStorage.getItem(storageKey);
  activate(CONTROL_TAB_IDS.includes(saved) ? saved : "text");
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
  setAspectRatio(state.aspectRatio);
  syncEngineDesignSpace();
  syncFromEditor();
  applyBackground();
  engine.speed = state.scrollSpeed;
  engine.startDelay = state.startDelay;
  updateScrollPositionControls();
  engine.applyTime(0);
  refreshDuration();
  updatePlayPauseButton();
  updateStyleHint(false);
  refreshToolbarFromSelection();
  setEffectPanelEnabled("stroke-controls", state.strokeEnabled);
  setEffectPanelEnabled("shadow-controls", state.shadowEnabled);
  setEffectPanelEnabled("glow-controls", state.glowEnabled);
  setEffectPanelEnabled("color-overlay-controls", state.colorOverlayEnabled);
  setEffectPanelEnabled("vignette-controls", state.vignetteEnabled);

  window.addEventListener("resize", () => {
    updateScrollPositionControls();
    refreshTimeline();
    applyBgEffects();
  });
}

init();
