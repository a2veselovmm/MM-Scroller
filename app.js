import { initFontPicker } from "./fonts.js";
import { ScrollPreview } from "./preview.js";
import { exportToWebM, downloadBlob } from "./export.js";
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
  brightness: 100,
  blur: 0,
  loop: true,
  mute: true,
  aspectRatio: "9/16",
  bgUrl: null,
  bgType: null,
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
const bgVideo = $("bg-video");
const bgPlaceholder = $("bg-placeholder");
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
let isScrubbing = false;
let lastStyledHtml = "";
let plainOnModeEnter = "";

engine.onStatus = (s) => {
  playbackStatus.textContent = s;
  updatePlayPauseButton();
};
engine.onComplete = () => {
  pauseBackgroundVideo();
  updatePlayPauseButton();
};
engine.onTimeUpdate = (current, total) => {
  updateTimelineUI(current, total);
  if (state.glowEnabled && textGlowBack) {
    textGlowBack.style.transform = textEl.style.transform;
  }
  if (state.bgType === "video") {
    syncVideoToTimeline(current, {
      allowPlay: engine.running && !engine.paused,
    });
  }
};

function updatePlayPauseButton() {
  const playing = engine.running && !engine.paused;
  btnPlayPause.textContent = playing ? "⏸ Pause" : "▶ Play";
  btnPlayPause.setAttribute("aria-label", playing ? "Pause" : "Play");
  btnPlayPause.classList.toggle("is-playing", playing);
}

function togglePlayPause() {
  if (engine.running && !engine.paused) {
    engine.pause();
    pauseBackgroundVideo();
  } else {
    playBackgroundVideo();
    engine.play();
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

function syncVideoToTimeline(time, { allowPlay = false } = {}) {
  if (state.bgType !== "video" || !bgVideo.src) return;

  const setFrame = () => {
    const dur = bgVideo.duration;
    if (!dur || !Number.isFinite(dur)) return;
    bgVideo.pause();
    if (state.loop) {
      bgVideo.currentTime = time % dur;
    } else {
      bgVideo.currentTime = Math.min(time, Math.max(0, dur - 0.05));
    }
  };

  if (bgVideo.readyState >= 1) {
    setFrame();
  } else {
    bgVideo.addEventListener("loadedmetadata", setFrame, { once: true });
  }

  if (allowPlay) {
    bgVideo.play().catch(() => {});
  }
}

function pauseBackgroundVideo() {
  if (state.bgType === "video" && bgVideo.src) {
    bgVideo.pause();
  }
}

function playBackgroundVideo() {
  if (state.bgType !== "video" || !bgVideo.src) return;
  bgVideo.loop = state.loop;
  bgVideo.muted = state.mute;
  syncVideoToTimeline(engine.timelineTime, { allowPlay: true });
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
  syncVideoToTimeline(engine.timelineTime);
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
  bgImage.style.objectFit = fit === "fill" ? "fill" : fit;
  bgVideo.style.objectFit = fit === "fill" ? "fill" : fit;

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
  bgImage.classList.add("hidden");
  bgVideo.classList.add("hidden");
  bgImage.removeAttribute("src");
  bgVideo.pause();
  bgVideo.removeAttribute("src");
  bgPlaceholder.classList.remove("hidden");
  $("bg-filename").textContent = "No file — gradient placeholder";
}

function loadBackground(file) {
  clearBackground();
  const url = URL.createObjectURL(file);
  bgObjectUrl = url;
  state.bgUrl = url;
  $("bg-filename").textContent = file.name;

  if (file.type.startsWith("video/")) {
    state.bgType = "video";
    bgVideo.loop = state.loop;
    bgVideo.muted = state.mute;
    bgVideo.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");

    const onReady = () => {
      bgVideo.pause();
      bgVideo.currentTime = 0;
      engine.applyTime(0);
      syncVideoToTimeline(0);
      refreshDuration();
    };

    bgVideo.addEventListener("loadeddata", onReady, { once: true });
    bgVideo.src = url;
  } else {
    state.bgType = "image";
    bgImage.onload = () => remeasureAndApply();
    bgImage.src = url;
    bgImage.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");
    requestAnimationFrame(() => remeasureAndApply());
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

  $("bg-loop").addEventListener("change", (e) => {
    state.loop = e.target.checked;
    bgVideo.loop = state.loop;
  });

  $("bg-mute").addEventListener("change", (e) => {
    state.mute = e.target.checked;
    bgVideo.muted = state.mute;
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
    isScrubbing = true;
    if (engine.running) engine.pause();
    pauseBackgroundVideo();
    updatePlayPauseButton();
  });

  timelineScrub.addEventListener("input", () => {
    const t = parseInt(timelineScrub.value, 10) / 10;
    engine.seek(t);
    syncVideoToTimeline(t);
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
    refreshDuration();
    updatePlayPauseButton();
  });

  $("btn-preview").addEventListener("click", () => {
    engine.reset();
    if (state.bgType === "video" && bgVideo.src) {
      bgVideo.currentTime = 0;
      bgVideo.pause();
    }
    playBackgroundVideo();
    engine.play();
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
  progressEl.classList.remove("hidden");
  canvas.classList.add("is-recording");

  try {
    syncFromEditor();
    engine.speed = state.scrollSpeed;
    engine.startDelay = state.startDelay;
    engine.reset();
    playBackgroundVideo();

    const blob = await exportToWebM(
      canvas,
      () => engine.runToCompletion(),
      {
        onProgress: (pct) => {
          progressFill.style.width = `${pct}%`;
        },
        onStatus: (msg) => {
          progressLabel.textContent = msg;
        },
      }
    );

    downloadBlob(blob);
    progressLabel.textContent = "Export complete — download started";
    playbackStatus.textContent = "Export complete";
    pauseBackgroundVideo();
  } catch (err) {
    console.error(err);
    progressLabel.textContent = `Export failed: ${err.message}`;
    playbackStatus.textContent = "Export failed";
    alert(`Export failed: ${err.message}`);
  } finally {
    isExporting = false;
    exportBtn.disabled = false;
    canvas.classList.remove("is-recording");
    setTimeout(() => progressEl.classList.add("hidden"), 3000);
  }
}

function initExport() {
  $("btn-export").addEventListener("click", runExport);
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
