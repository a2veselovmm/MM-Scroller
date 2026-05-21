import { initFontPicker } from "./fonts.js";
import { ScrollPreview } from "./preview.js";
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
import {
  mapBackgroundTime,
  GifBackground,
  supportsGifTimeline,
} from "./backgroundMedia.js";
import {
  ExportVideoSource,
  seekVideoElementAsync,
} from "./exportMedia.js";

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
  brightness: 100,
  blur: 0,
  mediaRepeat: "loop",
  videoVolume: 0,
  audioVolume: 100,
  aspectRatio: "9/16",
  bgUrl: null,
  bgType: null,
  animatedGif: false,
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
const bgGifCanvas = $("bg-gif-canvas");
const bgVideo = $("bg-video");
const bgAudio = $("bg-audio");
const bgPlaceholder = $("bg-placeholder");
const bgMediaOptions = $("bg-media-options");
const bgVideoAudioOptions = $("bg-video-audio-options");
const bgRepeatSelect = $("bg-repeat");
const bgRepeatHint = $("bg-repeat-hint");

let gifBackground = null;
let bgAudioObjectUrl = null;
const overlayLayer = $("overlay-layer");
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
const exportVideoSource = new ExportVideoSource();
let isScrubbing = false;
let lastStyledHtml = "";
let plainOnModeEnter = "";

engine.onStatus = (s) => {
  playbackStatus.textContent = s;
  updatePlayPauseButton();
};
engine.onComplete = () => {
  pauseBackgroundMedia();
  updatePlayPauseButton();
};
engine.onTimeUpdate = (current, total) => {
  updateTimelineUI(current, total);
  if (state.glowEnabled && textGlowBack) {
    textGlowBack.style.transform = textEl.style.transform;
  }
  try {
    const isPlaying = engine.running && !engine.paused;
    syncBackgroundToTimeline(current, { isPlaying });
    syncBackgroundAudio(current, { isPlaying });
  } catch (err) {
    console.error("Background sync failed:", err);
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
    pauseBackgroundMedia();
    syncBackgroundToTimeline(engine.timelineTime);
    syncBackgroundAudio(engine.timelineTime);
  } else {
    engine.play();
    syncBackgroundToTimeline(engine.timelineTime, { isPlaying: true });
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
    `End video length · ${formatTime(total)}`;
}

function updateMediaOptionsUI() {
  const isVideo = state.bgType === "video";
  const isGif = state.bgType === "gif";
  const show = isVideo || isGif || (state.bgType === "image" && state.animatedGif);

  bgMediaOptions.classList.toggle("hidden", !show);
  bgVideoAudioOptions.classList.toggle("hidden", !isVideo);

  const onceOpt = bgRepeatSelect.querySelector('option[value="once"]');
  const legacyGif = state.bgType === "image" && state.animatedGif;

  if (onceOpt) {
    onceOpt.disabled = legacyGif;
    if (legacyGif && state.mediaRepeat === "once") {
      state.mediaRepeat = "loop";
      bgRepeatSelect.value = "loop";
    }
  }

  if (legacyGif && !supportsGifTimeline()) {
    bgRepeatHint.textContent =
      "Hold-last-frame needs Chrome, Edge, or Safari 17+ for synced GIF.";
    bgRepeatHint.classList.remove("hidden");
  } else if (legacyGif) {
    bgRepeatHint.textContent = "GIF uses the browser’s built-in loop (not synced to scroll).";
    bgRepeatHint.classList.remove("hidden");
  } else if (isVideo || isGif) {
    bgRepeatHint.textContent =
      "Keeps the background visible for the full scroll when the clip is shorter.";
    bgRepeatHint.classList.remove("hidden");
  } else {
    bgRepeatHint.classList.add("hidden");
  }
}

function applyVideoVolume() {
  if (state.bgType === "video" && bgVideo.src) {
    applyMediaVolume(bgVideo, state.videoVolume);
  }
}

function seekVideoTo(target) {
  const dur = bgVideo.duration;
  const t = Number.isFinite(dur) ? Math.max(0, Math.min(target, dur - 0.001)) : target;
  if (typeof bgVideo.fastSeek === "function") {
    try {
      bgVideo.fastSeek(t);
      return;
    } catch {
      /* fall through */
    }
  }
  bgVideo.currentTime = t;
}

async function syncBackgroundForExport(time, videoEl = exportVideoSource.el) {
  if (state.bgType === "video" && videoEl?.src) {
    const dur = videoEl.duration;
    if (!dur || !Number.isFinite(dur)) return;
    videoEl.pause();
    videoEl.loop = false;
    videoEl.playbackRate = 1;
    const target = mapBackgroundTime(time, dur, state.mediaRepeat);
    await seekVideoElementAsync(videoEl, target);
    return;
  }

  if (state.bgType === "gif" && gifBackground?.ready) {
    gifBackground.fit = state.fitMode;
    gifBackground.resizeToDisplaySize();
    gifBackground.renderAtTime(time, state.mediaRepeat);
  }
}

/** Clear ended state so play() works again after the clip reaches a boundary. */
function seekVideoToTimelineTarget(time) {
  const dur = bgVideo.duration;
  if (!dur || !Number.isFinite(dur)) return;
  const target = mapBackgroundTime(time, dur, state.mediaRepeat);
  seekVideoTo(target);
}

function resumeVideoPlayback(time, dur, isPlaying) {
  if (!isPlaying) return;

  const target = mapBackgroundTime(time, dur, state.mediaRepeat);
  applyVideoVolume();

  bgVideo.loop = state.mediaRepeat === "loop";
  bgVideo.playbackRate = 1;
  if (bgVideo.ended || bgVideo.paused) {
    seekVideoTo(target);
    bgVideo.play().catch(() => {});
  } else if (Math.abs(bgVideo.currentTime - target) > 0.3) {
    seekVideoTo(target);
  }
}

let videoRecovering = false;

function onBackgroundVideoEnded() {
  if (videoRecovering || !engine.running || engine.paused || state.bgType !== "video") {
    return;
  }
  if (state.mediaRepeat === "once") return;

  videoRecovering = true;
  seekVideoToTimelineTarget(engine.timelineTime);
  resumeVideoPlayback(engine.timelineTime, bgVideo.duration, true);
  requestAnimationFrame(() => {
    videoRecovering = false;
  });
}

function syncBackgroundAudio(time, { isPlaying = false } = {}) {
  if (!bgAudio.src) return;
  const dur = bgAudio.duration;
  if (!dur || !Number.isFinite(dur)) return;
  syncBgAudioToTimeline(
    bgAudio,
    time,
    dur,
    state.mediaRepeat,
    isPlaying,
    state.audioVolume
  );
}

function pauseBackgroundMedia() {
  pauseBackgroundVideo();
  if (bgAudio.src) bgAudio.pause();
}

function initBackgroundVideo() {
  bgVideo.addEventListener("ended", onBackgroundVideoEnded);
  bgVideo.addEventListener("pause", () => {
    if (!engine.running || engine.paused || state.bgType !== "video") return;
    if (state.mediaRepeat === "once") return;
    const dur = bgVideo.duration;
    if (!dur || !Number.isFinite(dur)) return;
    if (bgVideo.ended || bgVideo.currentTime >= dur - 0.05) {
      requestAnimationFrame(() => {
        if (engine.running && !engine.paused) {
          onBackgroundVideoEnded();
        }
      });
    }
  });
}

function syncBackgroundToTimeline(time, { isPlaying = false } = {}) {
  if (state.bgType === "video" && bgVideo.src) {
    const setFrame = () => {
      const dur = bgVideo.duration;
      if (!dur || !Number.isFinite(dur)) return;

      applyVideoVolume();

      if (state.mediaRepeat === "loop" && isPlaying) {
        resumeVideoPlayback(time, dur, true);
        return;
      }

      bgVideo.playbackRate = 1;
      bgVideo.loop = false;
      const target = mapBackgroundTime(time, dur, state.mediaRepeat);

      bgVideo.pause();

      if (Math.abs(bgVideo.currentTime - target) > 0.02) {
        if (typeof bgVideo.fastSeek === "function") {
          try {
            bgVideo.fastSeek(target);
          } catch {
            bgVideo.currentTime = target;
          }
        } else {
          bgVideo.currentTime = target;
        }
      }
    };

    if (bgVideo.readyState >= 1) {
      setFrame();
    } else {
      bgVideo.addEventListener("loadedmetadata", setFrame, { once: true });
    }
    return;
  }

  if (state.bgType === "gif" && gifBackground?.ready) {
    gifBackground.fit = state.fitMode;
    gifBackground.resizeToDisplaySize();
    gifBackground.renderAtTime(time, state.mediaRepeat);
  }
}

function pauseBackgroundVideo() {
  if (state.bgType === "video" && bgVideo.src) {
    bgVideo.pause();
  }
}

function clearBackgroundAudio() {
  if (bgAudioObjectUrl) URL.revokeObjectURL(bgAudioObjectUrl);
  bgAudioObjectUrl = null;
  bgAudio.pause();
  bgAudio.removeAttribute("src");
  $("bg-audio-filename").textContent = "No background audio";
}

function loadBackgroundAudio(file) {
  clearBackgroundAudio();
  const url = URL.createObjectURL(file);
  bgAudioObjectUrl = url;
  $("bg-audio-filename").textContent = file.name;
  bgAudio.src = url;
  bgAudio.addEventListener(
    "loadedmetadata",
    () => {
      applyMediaVolume(bgAudio, state.audioVolume);
      syncBackgroundAudio(engine.timelineTime, {
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
  syncBackgroundToTimeline(engine.timelineTime);
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

function applyBackground() {
  const fit = state.fitMode;
  bgImage.dataset.fit = fit;
  bgVideo.dataset.fit = fit;
  bgGifCanvas.dataset.fit = fit;
  bgImage.style.objectFit = fit === "fill" ? "fill" : fit;
  bgVideo.style.objectFit = fit === "fill" ? "fill" : fit;
  if (gifBackground) gifBackground.fit = fit;

  overlayLayer.dataset.brightness = String(state.brightness);
  overlayLayer.dataset.blur = String(state.blur);

  const darken = 1 - state.brightness / 100;
  overlayLayer.style.background = darken > 0 ? `rgba(0,0,0,${darken})` : "transparent";
  overlayLayer.style.backdropFilter = state.blur > 0 ? `blur(${state.blur}px)` : "none";
}

function setAspectRatio(ratio) {
  canvas.style.aspectRatio = ratio.replace("/", " / ");
  canvas.dataset.aspect = ratio;
}

function clearBackground() {
  if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
  bgObjectUrl = null;
  state.bgUrl = null;
  state.bgType = null;
  state.animatedGif = false;
  gifBackground?.dispose();
  gifBackground = null;
  bgImage.classList.add("hidden");
  bgGifCanvas.classList.add("hidden");
  bgVideo.classList.add("hidden");
  clearBackgroundAudio();
  bgImage.removeAttribute("src");
  bgVideo.pause();
  bgVideo.removeAttribute("src");
  bgPlaceholder.classList.remove("hidden");
  $("bg-filename").textContent = "No file — gradient placeholder";
  updateMediaOptionsUI();
}

async function loadBackground(file) {
  clearBackground();
  const url = URL.createObjectURL(file);
  bgObjectUrl = url;
  state.bgUrl = url;
  $("bg-filename").textContent = file.name;

  if (file.type.startsWith("video/")) {
    state.bgType = "video";
    bgVideo.loop = false;
    bgVideo.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");
    applyVideoVolume();
    updateMediaOptionsUI();

    const onReady = () => {
      bgVideo.pause();
      bgVideo.currentTime = 0;
      engine.applyTime(0);
      syncBackgroundToTimeline(0);
      refreshDuration();
      updateMediaOptionsUI();
    };

    bgVideo.addEventListener("loadeddata", onReady, { once: true });
    bgVideo.src = url;
  } else if (file.type === "image/gif" && supportsGifTimeline()) {
    state.bgType = "gif";
    $("bg-filename").textContent = `${file.name} (decoding…)`;
    bgGifCanvas.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");

    try {
      gifBackground = new GifBackground(bgGifCanvas);
      await gifBackground.load(url);
      $("bg-filename").textContent = file.name;
      engine.applyTime(0);
      syncBackgroundToTimeline(0);
      remeasureAndApply();
      updateMediaOptionsUI();
    } catch (err) {
      console.error(err);
      clearBackground();
      $("bg-filename").textContent = "GIF failed to load — try another file";
      alert("Could not decode this GIF. Try a smaller file or use MP4/WebM.");
    }
  } else {
    state.bgType = "image";
    state.animatedGif = file.type === "image/gif";
    bgImage.onload = () => {
      remeasureAndApply();
      updateMediaOptionsUI();
    };
    bgImage.src = url;
    bgImage.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");
    requestAnimationFrame(() => remeasureAndApply());
    if (state.animatedGif) updateMediaOptionsUI();
  }
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

  bindRange("brightness", "brightness-val", (v) => `${v}%`, (v) => {
    state.brightness = v;
    applyBackground();
  });

  bindRange("blur", "blur-val", (v) => `${v}px`, (v) => {
    state.blur = v;
    applyBackground();
  });

  bgRepeatSelect.addEventListener("change", (e) => {
    state.mediaRepeat = e.target.value;
    syncBackgroundToTimeline(engine.timelineTime, {
      isPlaying: engine.running && !engine.paused,
    });
    syncBackgroundAudio(engine.timelineTime, {
      isPlaying: engine.running && !engine.paused,
    });
  });

  bindRange("bg-video-volume", "bg-video-volume-val", (v) => `${v}%`, (v) => {
    state.videoVolume = v;
    applyVideoVolume();
  });

  bindRange("bg-audio-volume", "bg-audio-volume-val", (v) => `${v}%`, (v) => {
    state.audioVolume = v;
    applyMediaVolume(bgAudio, state.audioVolume);
  });

  $("bg-audio-upload").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) loadBackgroundAudio(file);
  });

  $("aspect-ratio").addEventListener("change", (e) => {
    state.aspectRatio = e.target.value;
    setAspectRatio(state.aspectRatio);
    requestAnimationFrame(() => remeasureAndApply());
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
    pauseBackgroundMedia();
    updatePlayPauseButton();
  });

  timelineScrub.addEventListener("input", () => {
    if (isExporting) return;
    const t = parseInt(timelineScrub.value, 10) / 10;
    engine.seek(t);
    syncBackgroundToTimeline(t);
    syncBackgroundAudio(t);
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
    if (state.bgType === "video" && bgVideo.src) {
      bgVideo.pause();
      bgVideo.currentTime = 0;
    }
    if (bgAudio.src) {
      bgAudio.pause();
      bgAudio.currentTime = 0;
    }
    syncBackgroundToTimeline(0);
    syncBackgroundAudio(0);
    refreshDuration();
    updatePlayPauseButton();
  });

  $("btn-preview").addEventListener("click", () => {
    if (isExporting) return;
    engine.reset();
    syncBackgroundToTimeline(0);
    engine.play();
    syncBackgroundToTimeline(0, { isPlaying: true });
    syncBackgroundAudio(0, { isPlaying: true });
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
  timelineScrub.disabled = true;
  progressEl.classList.remove("hidden");
  canvas.classList.add("is-recording");

  const savedOnTimeUpdate = engine.onTimeUpdate;
  engine.onTimeUpdate = () => {};

  try {
    syncFromEditor();
    engine.stop();
    pauseBackgroundMedia();
    engine.speed = state.scrollSpeed;
    engine.startDelay = state.startDelay;
    engine.scrollStartY = state.scrollStartY;
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    updateScrollStartControl();
    engine.reset();
    syncBackgroundToTimeline(0);

    progressLabel.textContent = "Preparing export…";
    const exportVideoEl =
      state.bgType === "video"
        ? await exportVideoSource.prepareFrom(bgVideo)
        : null;

    const format = $("export-format").value;
    const blob = await exportRecording(canvas, engine, {
      format,
      exportVideoEl,
      videoEl: state.bgType === "video" ? bgVideo : null,
      bgAudioEl: bgAudio.src ? bgAudio : null,
      videoVolume: state.videoVolume,
      audioVolume: state.audioVolume,
      mediaRepeat: state.mediaRepeat,
      onFrame: async (t) => {
        if (state.glowEnabled && textGlowBack) {
          syncGlowLayer();
        }
        await syncBackgroundForExport(t, exportVideoEl);
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
    pauseBackgroundMedia();
  } catch (err) {
    console.error(err);
    progressLabel.textContent = `Export failed: ${err.message}`;
    playbackStatus.textContent = "Export failed";
    alert(`Export failed: ${err.message}`);
  } finally {
    engine.onTimeUpdate = savedOnTimeUpdate;
    exportVideoSource.dispose();
    isExporting = false;
    exportBtn.disabled = false;
    btnPlayPause.disabled = false;
    $("btn-preview").disabled = false;
    $("btn-save-project").disabled = false;
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

async function collectProjectMedia() {
  let background = null;

  if (state.bgType === "video" && bgVideo.src) {
    background = await urlToDataPayload(
      bgVideo.currentSrc || bgVideo.src,
      cleanBgFileName($("bg-filename").textContent),
      { type: "video" }
    );
  } else if (state.bgType === "gif" && bgObjectUrl) {
    background = await urlToDataPayload(
      bgObjectUrl,
      cleanBgFileName($("bg-filename").textContent),
      { type: "gif" }
    );
  } else if (state.bgType === "image" && bgImage.src) {
    background = await urlToDataPayload(
      bgImage.currentSrc || bgImage.src,
      cleanBgFileName($("bg-filename").textContent),
      { type: "image", animatedGif: state.animatedGif }
    );
  }

  let audio = null;
  if (bgAudio.src) {
    const audioName = $("bg-audio-filename").textContent;
    if (!audioName.startsWith("No background")) {
      audio = await urlToDataPayload(bgAudio.currentSrc || bgAudio.src, audioName, {
        type: "audio",
      });
    }
  }

  return { background, audio };
}

async function saveProjectJson() {
  if (isExporting) return;

  const btn = $("btn-save-project");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Saving…";

  try {
    syncFromEditor();

    const media = await collectProjectMedia();
    const doc = await buildProjectDocument({
      settings: serializeSettings(),
      text: {
        editMode: state.editMode,
        styledHtml: lastStyledHtml || textEditor.innerHTML,
        plainText: textPlain.value,
      },
      media,
      timeline: {
        position: engine.timelineTime,
        speed: engine.speed,
        startDelay: engine.startDelay,
        scrollStartY: engine.scrollStartY,
      },
      ui: {
        exportFormat: $("export-format").value,
      },
    });

    const bytes = estimateProjectSize(doc);
    if (bytes > 25 * 1024 * 1024) {
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      const ok = confirm(
        `This project file will be about ${mb} MB (media is embedded). Save anyway?`
      );
      if (!ok) return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    downloadProjectJson(doc, `scrolldrop-project-${stamp}.json`);
    playbackStatus.textContent = "Project saved as JSON";
  } catch (err) {
    console.error(err);
    alert(`Could not save project: ${err.message}`);
    playbackStatus.textContent = "Project save failed";
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

function initExport() {
  $("btn-export").addEventListener("click", runExport);
  $("btn-save-project").addEventListener("click", saveProjectJson);
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

function init() {
  initEditor();
  initAlignButtons();
  initControls();
  initCollapsibles();
  initPanelResize();
  initBackgroundVideo();
  applyVideoVolume();
  applyMediaVolume(bgAudio, state.audioVolume);
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

  window.addEventListener("resize", () => remeasureAndApply());
}

init();
