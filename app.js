import { initFontPicker } from "./fonts.js";
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
  scrollStartY: null,
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
  musicVolume: 100,
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

/** Push styled HTML to preview/export — never plain text */
function syncPreviewFromStyled() {
  const html = getStyledHtmlForPreview();
  applyLayoutStyles(textEditor, textEl, getLayoutStyles());
  textEl.innerHTML = html;
  syncGlowLayer();
  remeasureAndApply();
}

function applyEffectToSelectionOrDefault(effectFn) {
  if (state.editMode !== "styled") {
    syncPreviewFromStyled();
    return false;
  }
  if (hasSelectionIn(textEditor)) {
    effectFn();
    syncFromEditor();
    updateStyleHint(true);
    return true;
  }
  syncFromEditor();
  updateStyleHint(false);
  return false;
}

function syncFromEditor() {
  if (state.editMode === "plain") {
    syncPreviewFromStyled();
    return;
  }

  lastStyledHtml = textEditor.innerHTML;
  applyLayoutStyles(textEditor, textEl, getLayoutStyles());
  syncEditorToPreview(textEditor, textEl);
  syncGlowLayer();
  remeasureAndApply();
}

function setEditMode(mode) {
  if (mode === state.editMode) return;

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

  if (hasSelectionIn(textEditor)) {
    styleFn();
    syncFromEditor();
    updateStyleHint(true);
    return true;
  }
  applyLayoutStyles(textEditor, textEl, getLayoutStyles());
  syncEditorToPreview(textEditor, textEl);
  remeasureAndApply();
  updateStyleHint(false);
  return false;
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

function refreshDuration() {
  engine.measure();
  const total = engine.getTotalDuration();
  const max = Math.max(1, Math.round(total * 10));
  timelineScrub.max = String(max);
  timelineScrub.value = String(Math.round(engine.timelineTime * 10));
  updateTimelineUI(engine.timelineTime, total);
  return total;
}

function updateTimelineUI(current, total) {
  if (isScrubbing) return;
  timeCurrent.textContent = formatTime(current);
  timeTotal.textContent = formatTime(total);
  timelineScrub.value = String(Math.round(current * 10));
  $("timeline-duration-label").textContent =
    `Scroll duration · ${formatTime(total)}`;
}

function syncAudioTrack(el, time, volume, { isPlaying = false } = {}) {
  if (!el?.src) return;
  const dur = el.duration;
  if (!dur || !Number.isFinite(dur)) return;
  syncBgAudioToTimeline(el, time, dur, "loop", isPlaying, volume);
}

function syncTimelineAudio(time, { isPlaying = false } = {}) {
  syncAudioTrack(bgMusic, time, state.musicVolume, { isPlaying });
  syncAudioTrack(bgVoice, time, state.voiceVolume, { isPlaying });
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
  clearMusic();
  const url = URL.createObjectURL(file);
  bgMusicObjectUrl = url;
  $("bg-music-filename").textContent = file.name;
  bgMusic.src = url;
  bgMusic.addEventListener(
    "loadedmetadata",
    () => {
      applyMediaVolume(bgMusic, state.musicVolume);
      syncTimelineAudio(engine.timelineTime, {
        isPlaying: engine.running && !engine.paused,
      });
    },
    { once: true }
  );
}

function loadVoiceover(file) {
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

function updateScrollStartControl() {
  engine.measure();
  const ch = engine.containerHeight || textContainer.clientHeight || 400;
  const th = engine.textHeight || textEl.offsetHeight || 100;
  const slider = $("scroll-start");

  slider.min = String(-Math.round(th));
  slider.max = String(Math.max(200, ch + Math.round(th * 0.5)));

  if (state.scrollStartY == null) {
    state.scrollStartY = ch;
  }

  const min = parseInt(slider.min, 10);
  const max = parseInt(slider.max, 10);
  state.scrollStartY = Math.min(max, Math.max(min, Math.round(state.scrollStartY)));
  engine.scrollStartY = state.scrollStartY;

  slider.value = String(state.scrollStartY);
  $("scroll-start-val").textContent = `${state.scrollStartY}px`;

  engine.measure();
}

function remeasureAndApply() {
  updateScrollStartControl();
  engine.applyTime(engine.timelineTime);
  refreshDuration();
}

function bindRange(id, valId, format, onChange) {
  const input = $(id);
  const val = $(valId);
  const update = () => {
    const v = input.type === "range" ? parseFloat(input.value) : input.value;
    if (val) val.textContent = format(v);
    onChange(v);
  };
  input.addEventListener("input", update);
  update();
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
    colorOverlayEnabled: state.colorOverlayEnabled,
    colorOverlayColor: state.colorOverlayColor,
    colorOverlayOpacity: state.colorOverlayOpacity,
  });
}

function applyBackground() {
  const fit = state.fitMode;
  bgImage.dataset.fit = fit;
  bgImage.style.objectFit = fit === "fill" ? "fill" : fit;

  overlayLayer.dataset.blur = String(state.blur);
  overlayLayer.style.background = "transparent";
  overlayLayer.style.backdropFilter = state.blur > 0 ? `blur(${state.blur}px)` : "none";

  applyBgEffects();
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

  textEditor.addEventListener("input", () => {
    lastStyledHtml = textEditor.innerHTML;
    syncFromEditor();
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
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  // Plain edits do not update preview — preview stays on lastStyledHtml

  editModeToggle.addEventListener("change", () => {
    setEditMode(editModeToggle.checked ? "styled" : "plain");
  });
}

function initAlignButtons() {
  document.querySelectorAll("[data-align]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-align]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.textAlign = btn.dataset.align;
      syncFromEditor();
    });
  });
}

function initControls() {
  initFontPicker($("font-picker"), (font) => {
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

  $("font-color").addEventListener("input", (e) => {
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
    if (state.editMode !== "styled") return;
    const selStyle = getSelectionStyles(textEditor);
    const turnOn = selStyle?.bold !== true;
    if (hasSelectionIn(textEditor)) {
      applyStyleToSelection(textEditor, {
        fontWeight: turnOn ? "700" : "400",
      });
      syncFromEditor();
      refreshToolbarFromSelection();
    }
  });

  $("btn-italic").addEventListener("click", () => {
    if (state.editMode !== "styled") return;
    const selStyle = getSelectionStyles(textEditor);
    const turnOn = selStyle?.italic !== true;
    if (hasSelectionIn(textEditor)) {
      applyStyleToSelection(textEditor, {
        fontStyle: turnOn ? "italic" : "normal",
      });
      syncFromEditor();
      refreshToolbarFromSelection();
    }
  });

  bindRange("line-height", "line-height-val", (v) => String(v), (v) => {
    state.lineHeight = v;
    syncFromEditor();
  });

  bindRange("letter-spacing", "letter-spacing-val", (v) => `${v}px`, (v) => {
    state.letterSpacing = v;
    syncFromEditor();
  });

  $("stroke-enabled").addEventListener("change", (e) => {
    state.strokeEnabled = e.target.checked;
    setEffectPanelEnabled("stroke-controls", state.strokeEnabled);
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, strokeStylePayload(state));
    });
  });

  $("stroke-color").addEventListener("input", (e) => {
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
    state.shadowEnabled = e.target.checked;
    setEffectPanelEnabled("shadow-controls", state.shadowEnabled);
    applyEffectToSelectionOrDefault(() => {
      applyStyleToSelection(textEditor, shadowStylePayload(state));
    });
  });

  $("shadow-color").addEventListener("input", (e) => {
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
    state.glowEnabled = e.target.checked;
    setEffectPanelEnabled("glow-controls", state.glowEnabled);
    syncFromEditor();
  });

  $("glow-color").addEventListener("input", (e) => {
    state.glowColor = e.target.value;
    syncFromEditor();
  });

  bindRange("glow-opacity", "glow-opacity-val", (v) => `${v}%`, (v) => {
    state.glowOpacity = v / 100;
    syncFromEditor();
  });

  bindRange("glow-radius", "glow-radius-val", (v) => `${v}px`, (v) => {
    state.glowRadius = v;
    syncFromEditor();
  });

  bindRange("glow-sharpness", "glow-sharpness-val", (v) => `${v}px`, (v) => {
    state.glowSharpness = v;
    syncFromEditor();
  });

  bindRange("glow-softness", "glow-softness-val", (v) => String(v), (v) => {
    state.glowSoftness = v;
    syncFromEditor();
  });

  bindRange("padding-h", "padding-h-val", (v) => `${v}px`, (v) => {
    state.paddingH = v;
    syncFromEditor();
  });

  bindRange("scroll-speed", "scroll-speed-val", (v) => `${v} px/s`, (v) => {
    state.scrollSpeed = v;
    engine.speed = v;
    refreshDuration();
    engine.applyTime(engine.timelineTime);
  });

  bindRange("start-delay", "start-delay-val", (v) => `${v}s`, (v) => {
    state.startDelay = v;
    engine.startDelay = v;
    refreshDuration();
    engine.applyTime(engine.timelineTime);
  });

  bindRange("scroll-start", "scroll-start-val", (v) => `${v}px`, (v) => {
    state.scrollStartY = v;
    engine.scrollStartY = v;
    engine.measure();
    engine.applyTime(engine.timelineTime);
    syncGlowLayer();
    refreshDuration();
  });

  $("fit-mode").addEventListener("change", (e) => {
    state.fitMode = e.target.value;
    applyBackground();
  });

  bindRange("blur", "blur-val", (v) => `${v}px`, (v) => {
    state.blur = v;
    applyBackground();
  });

  $("color-overlay-enabled").addEventListener("change", (e) => {
    state.colorOverlayEnabled = e.target.checked;
    setEffectPanelEnabled("color-overlay-controls", state.colorOverlayEnabled);
    applyBgEffects();
  });

  $("color-overlay-color").addEventListener("input", (e) => {
    state.colorOverlayColor = e.target.value;
    applyBgEffects();
  });

  bindRange("color-overlay-opacity", "color-overlay-opacity-val", (v) => `${v}%`, (v) => {
    state.colorOverlayOpacity = v;
    applyBgEffects();
  });

  $("vignette-enabled").addEventListener("change", (e) => {
    state.vignetteEnabled = e.target.checked;
    setEffectPanelEnabled("vignette-controls", state.vignetteEnabled);
    applyBgEffects();
  });

  $("vignette-color").addEventListener("input", (e) => {
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

  bindRange("bg-music-volume", "bg-music-volume-val", (v) => `${v}%`, (v) => {
    state.musicVolume = v;
    applyMediaVolume(bgMusic, state.musicVolume);
  });

  bindRange("bg-voice-volume", "bg-voice-volume-val", (v) => `${v}%`, (v) => {
    state.voiceVolume = v;
    applyMediaVolume(bgVoice, state.voiceVolume);
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
    state.aspectRatio = e.target.value;
    setAspectRatio(state.aspectRatio);
    requestAnimationFrame(() => {
      remeasureAndApply();
      applyBgEffects();
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

  $("btn-preview").addEventListener("click", () => {
    if (isExporting) return;
    engine.reset();
    engine.play();
    syncTimelineAudio(0, { isPlaying: true });
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
  $("btn-preview").disabled = true;
  $("btn-save-project").disabled = true;
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
    engine.scrollStartY = state.scrollStartY;
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    updateScrollStartControl();
    engine.reset();

    progressLabel.textContent = "Preparing export…";

    const format = $("export-format").value;
    const blob = await exportRecording(canvas, engine, {
      format,
      musicEl: bgMusic.src ? bgMusic : null,
      voiceEl: bgVoice.src ? bgVoice : null,
      musicVolume: state.musicVolume,
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

    downloadBlob(
      blob,
      format === "mp4" ? "scrolldrop-export.mp4" : "scrolldrop-export.webm"
    );
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
    $("btn-preview").disabled = false;
    $("btn-save-project").disabled = false;
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
    scrollStartY: state.scrollStartY,
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
    scrollStartY: engine.scrollStartY,
  };
}

function serializeUiState() {
  const collapsibles = {};
  document.querySelectorAll(".collapsible").forEach((el) => {
    if (el.id) collapsibles[el.id] = el.open;
  });
  const panelW = appMain.style.getPropertyValue("--panel-w");
  return {
    exportFormat: $("export-format").value,
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

  const buttons = [
    triggerBtn,
    $("btn-save-project"),
    $("btn-export-setup"),
  ].filter(Boolean);

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

async function saveProjectJson() {
  await exportSetupJson({
    embedMedia: true,
    triggerBtn: $("btn-save-project"),
    savingLabel: "Saving…",
    doneStatus: "Project saved as JSON",
    filenamePrefix: "scrolldrop-project",
  });
}

function initExport() {
  $("btn-export").addEventListener("click", runExport);
  $("btn-save-project").addEventListener("click", saveProjectJson);
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
  initAlignButtons();
  initControls();
  initControlTabs();
  initCollapsibles();
  initPanelResize();
  applyMediaVolume(bgMusic, state.musicVolume);
  applyMediaVolume(bgVoice, state.voiceVolume);
  initTimeline();
  initTransport();
  initExport();
  setAspectRatio(state.aspectRatio);
  syncFromEditor();
  applyBackground();
  engine.speed = state.scrollSpeed;
  engine.startDelay = state.startDelay;
  updateScrollStartControl();
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
    remeasureAndApply();
    applyBgEffects();
  });
}

init();
