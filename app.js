import { initFontPicker } from "./fonts.js";
import { ScrollPreview } from "./preview.js";
import { exportToWebM, downloadBlob } from "./export.js";

/** @typedef {Object} AppState */
const state = {
  text: "",
  fontFamily: "Inter",
  fontSize: 32,
  fontColor: "#ffffff",
  fontOpacity: 1,
  textAlign: "center",
  lineHeight: 1.5,
  letterSpacing: 0,
  textShadow: false,
  shadowColor: "#000000",
  paddingH: 48,
  scrollSpeed: 80,
  startDelay: 0,
  fitMode: "cover",
  brightness: 100,
  blur: 0,
  loop: true,
  mute: true,
  aspectRatio: "16/9",
  bgUrl: null,
  bgType: null,
};

const $ = (id) => document.getElementById(id);

const canvas = $("preview-canvas");
const textEl = $("text-content");
const textContainer = $("text-scroll-container");
const bgImage = $("bg-image");
const bgVideo = $("bg-video");
const bgPlaceholder = $("bg-placeholder");
const overlayLayer = $("overlay-layer");
const playbackStatus = $("playback-status");

const engine = new ScrollPreview(canvas, textEl, textContainer);
engine.onStatus = (s) => {
  playbackStatus.textContent = s;
};
engine.onComplete = () => {};

let bgObjectUrl = null;
let isExporting = false;

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

function applyTextStyles() {
  const rgba = hexToRgba(state.fontColor, state.fontOpacity);
  textEl.style.fontFamily = `"${state.fontFamily}", sans-serif`;
  textEl.style.fontSize = `${state.fontSize}px`;
  textEl.style.color = rgba;
  textEl.style.textAlign = state.textAlign;
  textEl.style.lineHeight = String(state.lineHeight);
  textEl.style.letterSpacing = `${state.letterSpacing}px`;
  textEl.style.paddingLeft = `${state.paddingH}px`;
  textEl.style.paddingRight = `${state.paddingH}px`;
  textEl.style.width = "100%";
  textEl.style.boxSizing = "border-box";

  if (state.textShadow) {
    textEl.style.textShadow = `2px 2px 8px ${state.shadowColor}`;
  } else {
    textEl.style.textShadow = "none";
  }

  textEl.textContent = state.text || " ";
  engine.measure();
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
    bgVideo.src = url;
    bgVideo.loop = state.loop;
    bgVideo.muted = state.mute;
    bgVideo.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");
    bgVideo.play().catch(() => {});
  } else {
    state.bgType = "image";
    bgImage.src = url;
    bgImage.classList.remove("hidden");
    bgPlaceholder.classList.add("hidden");
  }
  applyBackground();
}

function initAlignButtons() {
  document.querySelectorAll("[data-align]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-align]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.textAlign = btn.dataset.align;
      applyTextStyles();
    });
  });
}

function initControls() {
  $("text-input").addEventListener("input", (e) => {
    state.text = e.target.value;
    applyTextStyles();
  });

  initFontPicker($("font-family"), (font) => {
    state.fontFamily = font.family.replace(/\+/g, " ");
    applyTextStyles();
  });

  bindRange("font-size", "font-size-val", (v) => `${v}px`, (v) => {
    state.fontSize = v;
    applyTextStyles();
  });

  $("font-color").addEventListener("input", (e) => {
    state.fontColor = e.target.value;
    applyTextStyles();
  });

  bindRange("font-opacity", "font-opacity-val", (v) => `${v}%`, (v) => {
    state.fontOpacity = v / 100;
    applyTextStyles();
  });

  bindRange("line-height", "line-height-val", (v) => String(v), (v) => {
    state.lineHeight = v;
    applyTextStyles();
  });

  bindRange("letter-spacing", "letter-spacing-val", (v) => `${v}px`, (v) => {
    state.letterSpacing = v;
    applyTextStyles();
  });

  $("text-shadow").addEventListener("change", (e) => {
    state.textShadow = e.target.checked;
    $("shadow-color").disabled = !state.textShadow;
    applyTextStyles();
  });

  $("shadow-color").addEventListener("input", (e) => {
    state.shadowColor = e.target.value;
    applyTextStyles();
  });

  bindRange("padding-h", "padding-h-val", (v) => `${v}px`, (v) => {
    state.paddingH = v;
    applyTextStyles();
  });

  bindRange("scroll-speed", "scroll-speed-val", (v) => `${v} px/s`, (v) => {
    state.scrollSpeed = v;
    engine.speed = v;
  });

  bindRange("start-delay", "start-delay-val", (v) => `${v}s`, (v) => {
    state.startDelay = v;
    engine.startDelay = v;
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
    requestAnimationFrame(() => engine.measure());
  });

  $("bg-upload").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) loadBackground(file);
  });
}

function initTransport() {
  $("btn-play").addEventListener("click", () => engine.play());
  $("btn-pause").addEventListener("click", () => engine.pause());
  $("btn-reset").addEventListener("click", () => engine.reset());
  $("btn-preview").addEventListener("click", () => {
    engine.reset();
    engine.play();
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
    engine.speed = state.scrollSpeed;
    engine.startDelay = state.startDelay;
    engine.measure();
    engine.reset();
    if (state.bgType === "video" && bgVideo.src) {
      bgVideo.currentTime = 0;
      await bgVideo.play().catch(() => {});
    }

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

function init() {
  state.text = $("text-input").value;
  initAlignButtons();
  initControls();
  initTransport();
  initExport();
  setAspectRatio(state.aspectRatio);
  applyTextStyles();
  applyBackground();
  engine.speed = state.scrollSpeed;
  engine.startDelay = state.startDelay;
  engine.measure();

  window.addEventListener("resize", () => engine.measure());
}

init();
