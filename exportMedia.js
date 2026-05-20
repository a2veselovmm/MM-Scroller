/**
 * Isolated media for export — never shares the preview <video> so Play cannot corrupt seeks.
 */

export function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export function waitForVideoFrameReady(video, timeoutMs = 800) {
  return Promise.race([
    new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === "function") {
        try {
          video.requestVideoFrameCallback(() => resolve(), { once: true });
          return;
        } catch {
          /* fall through */
        }
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function seekVideoElement(video, target) {
  const dur = video.duration;
  const t = Number.isFinite(dur)
    ? Math.max(0, Math.min(target, dur - 0.001))
    : target;
  if (typeof video.fastSeek === "function") {
    try {
      video.fastSeek(t);
      return;
    } catch {
      /* fall through */
    }
  }
  video.currentTime = t;
}

export async function seekVideoElementAsync(video, target) {
  const dur = video.duration;
  const t = Number.isFinite(dur)
    ? Math.max(0, Math.min(target, dur - 0.001))
    : target;

  video.pause();

  if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.033) {
    await waitForVideoFrameReady(video);
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 600);
    video.addEventListener("seeked", finish, { once: true });
    seekVideoElement(video, t);
  });

  await waitForVideoFrameReady(video);
}

/**
 * Hidden clone of the preview video used only during export.
 */
export class ExportVideoSource {
  constructor() {
    this.el = null;
  }

  async prepareFrom(sourceVideo) {
    if (!sourceVideo?.src) {
      this.dispose();
      return null;
    }

    if (this.el && this.el.src === sourceVideo.src) {
      return this.el;
    }

    this.dispose();
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    el.crossOrigin = sourceVideo.crossOrigin || "anonymous";
    el.style.cssText =
      "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(el);
    el.src = sourceVideo.src;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Background video load timed out for export.")),
        20000
      );
      el.addEventListener(
        "loadeddata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
      el.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Could not load background video for export."));
        },
        { once: true }
      );
    });

    this.el = el;
    return el;
  }

  dispose() {
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
      this.el.remove();
      this.el = null;
    }
  }
}
