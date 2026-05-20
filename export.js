/**
 * Export preview to WebM via MediaRecorder + canvas captureStream.
 * Frames are captured in sync with the scroll engine tick.
 */

const FPS = 30;

function pickMimeType() {
  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/**
 * Record the preview while `runAnimation` drives scroll (same timing as preview).
 * @param {HTMLElement} canvasEl
 * @param {() => Promise<void>} runAnimation - plays scroll to completion
 * @param {{ onProgress?: (pct: number) => void, onStatus?: (msg: string) => void }} hooks
 */
export async function exportToWebM(canvasEl, runAnimation, hooks = {}) {
  const { onProgress = () => {}, onStatus = () => {} } = hooks;

  if (!window.MediaRecorder) {
    throw new Error("MediaRecorder is not supported in this browser.");
  }

  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error("No supported WebM codec found for recording.");
  }

  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(2, Math.round(rect.width));
  const h = Math.max(2, Math.round(rect.height));

  const recordCanvas = document.createElement("canvas");
  recordCanvas.width = w;
  recordCanvas.height = h;
  const ctx = recordCanvas.getContext("2d");

  const stream = recordCanvas.captureStream(FPS);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
  });

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const blobPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType.split(";")[0] }));
    };
    recorder.onerror = () => reject(new Error("Recording failed"));
  });

  async function captureFrame() {
    const bgImg = canvasEl.querySelector("#bg-image:not(.hidden)");
    const bgVideo = canvasEl.querySelector("#bg-video:not(.hidden)");
    const placeholder = canvasEl.querySelector("#bg-placeholder:not(.hidden)");
    const overlay = canvasEl.querySelector("#overlay-layer");
    const textContent = canvasEl.querySelector("#text-content");

    ctx.fillStyle = "#111118";
    ctx.fillRect(0, 0, w, h);

    const drawMedia = (el, fit) => {
      if (!el) return;
      const mw = el.videoWidth || el.naturalWidth;
      const mh = el.videoHeight || el.naturalHeight;
      if (!mw || !mh) return;

      let dw = w;
      let dh = h;
      let dx = 0;
      let dy = 0;

      if (fit === "contain") {
        const scale = Math.min(w / mw, h / mh);
        dw = mw * scale;
        dh = mh * scale;
        dx = (w - dw) / 2;
        dy = (h - dh) / 2;
      } else if (fit === "fill") {
        dw = w;
        dh = h;
      } else {
        const scale = Math.max(w / mw, h / mh);
        dw = mw * scale;
        dh = mh * scale;
        dx = (w - dw) / 2;
        dy = (h - dh) / 2;
      }

      try {
        ctx.drawImage(el, dx, dy, dw, dh);
      } catch {
        /* cross-origin taint */
      }
    };

    const fit = bgImg?.dataset.fit || bgVideo?.dataset.fit || "cover";

    if (bgVideo && !bgVideo.classList.contains("hidden")) {
      drawMedia(bgVideo, fit);
    } else if (bgImg && !bgImg.classList.contains("hidden")) {
      drawMedia(bgImg, fit);
    } else if (placeholder) {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "#1a1a2e");
      grad.addColorStop(0.5, "#16213e");
      grad.addColorStop(1, "#0f3460");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    const brightness = parseInt(overlay?.dataset.brightness ?? "100", 10);
    const blur = parseFloat(overlay?.dataset.blur ?? "0");
    const darken = 1 - brightness / 100;
    if (darken > 0) {
      ctx.fillStyle = `rgba(0,0,0,${darken})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (textContent) {
      const style = getComputedStyle(textContent);
      const pad = parseInt(style.paddingLeft, 10) || 0;
      const fontSize = parseFloat(style.fontSize);
      const lineHeightPx = fontSize * parseFloat(style.lineHeight);

      ctx.save();
      ctx.font = `${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
      ctx.fillStyle = style.color;
      ctx.textAlign = style.textAlign;
      ctx.textBaseline = "top";

      if (style.textShadow && style.textShadow !== "none") {
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
      }

      const transform = textContent.style.transform;
      const match = transform.match(/translateY\((-?[\d.]+)px\)/);
      const ty = match ? parseFloat(match[1]) : h;

      const lines = textContent.textContent.split("\n");
      let y = ty;
      for (const line of lines) {
        let x = pad;
        if (style.textAlign === "center") x = w / 2;
        else if (style.textAlign === "right") x = w - pad;
        ctx.fillText(line, x, y);
        y += lineHeightPx;
      }
      ctx.restore();
    }

    if (blur > 0) {
      const snap = ctx.getImageData(0, 0, w, h);
      ctx.filter = `blur(${blur}px)`;
      ctx.putImageData(snap, 0, 0);
      ctx.filter = "none";
    }
  }

  onStatus("Recording…");
  recorder.start(100);

  let recording = true;
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress = Math.min(95, progress + 2);
    onProgress(progress);
  }, 200);

  const captureLoop = async () => {
    while (recording) {
      await captureFrame();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  captureLoop();

  await runAnimation();

  recording = false;
  clearInterval(progressInterval);
  onProgress(100);
  onStatus("Finalizing…");

  await new Promise((r) => setTimeout(r, 300));
  recorder.stop();

  return blobPromise;
}

export function downloadBlob(blob, filename = "scrolldrop-export.webm") {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
