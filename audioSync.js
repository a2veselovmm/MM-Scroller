import { mapBackgroundTime } from "./backgroundMedia.js";

export function applyMediaVolume(el, volumePercent) {
  if (!el) return;
  const v = Math.max(0, Math.min(100, volumePercent)) / 100;
  el.volume = v;
  el.muted = v === 0;
}

export function syncBgAudioToTimeline(
  audioEl,
  time,
  duration,
  mode,
  isPlaying,
  volumePercent
) {
  if (!audioEl?.src || !duration || !Number.isFinite(duration)) return;

  applyMediaVolume(audioEl, volumePercent);
  const target = mapBackgroundTime(time, duration, mode);
  audioEl.loop = mode === "loop";

  if (!isPlaying) {
    audioEl.pause();
    audioEl.currentTime = target;
    return;
  }

  if (mode === "loop") {
    if (audioEl.paused || audioEl.ended) {
      audioEl.currentTime = target;
      audioEl.play().catch(() => {});
    } else if (Math.abs(audioEl.currentTime - target) > 0.25) {
      audioEl.currentTime = target;
    }
    return;
  }

  audioEl.loop = false;
  const onceTarget = mapBackgroundTime(time, duration, "once");

  if (time >= duration) {
    audioEl.pause();
    audioEl.currentTime = Math.max(0, duration - 0.001);
    return;
  }

  if (audioEl.paused || audioEl.ended) {
    audioEl.currentTime = onceTarget;
    audioEl.play().catch(() => {});
  } else if (Math.abs(audioEl.currentTime - onceTarget) > 0.25) {
    audioEl.currentTime = onceTarget;
  }
}

/** Fresh media element for export (avoids createMediaElementSource “already connected” error). */
async function cloneForExport(sourceEl, tag) {
  const el = document.createElement(tag);
  el.src = sourceEl.currentSrc || sourceEl.src;
  el.crossOrigin = sourceEl.crossOrigin || "anonymous";
  el.muted = true;
  el.preload = "auto";

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Failed to load media for export"));
    };
    const timer = setTimeout(fail, 12000);
    el.addEventListener("loadeddata", finish, { once: true });
    el.addEventListener("error", fail, { once: true });
  });

  return el;
}

/**
 * Mix video + optional background audio for MediaRecorder (one-shot per export).
 */
export async function createExportMediaStream(videoStream, {
  videoEl,
  bgAudioEl,
  videoVolume,
  audioVolume,
}) {
  const tracks = [...videoStream.getVideoTracks()];
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  let hasAudio = false;

  const connect = async (sourceEl, tag, vol) => {
    if (!sourceEl?.src || vol <= 0) return;
    try {
      const el = await cloneForExport(sourceEl, tag);
      const src = audioCtx.createMediaElementSource(el);
      const gain = audioCtx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, vol / 100));
      src.connect(gain);
      gain.connect(dest);
      hasAudio = true;
      el.play().catch(() => {});
    } catch (err) {
      console.warn("Could not route audio for export:", err);
    }
  };

  await connect(videoEl, "video", videoVolume);
  await connect(bgAudioEl, "audio", audioVolume);

  if (hasAudio) {
    tracks.push(...dest.stream.getAudioTracks());
  }

  return { stream: new MediaStream(tracks), audioCtx };
}
