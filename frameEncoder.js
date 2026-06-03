/**
 * Remotion-style offline render: capture frames first, then ffmpeg at fixed FPS.
 * @see https://www.remotion.dev/docs/ai/skills
 */

import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";
import { yieldToMain } from "./exportMedia.js";

function vendorAsset(file) {
  return new URL(`vendor/ffmpeg/${file}`, window.location.href).href;
}

async function blobUrlFor(path) {
  return toBlobURL(path, path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
}

let sharedFfmpeg = null;
let sharedFfmpegLoad = null;

async function getFfmpeg(onStatus) {
  if (sharedFfmpeg) return sharedFfmpeg;
  if (sharedFfmpegLoad) return sharedFfmpegLoad;

  sharedFfmpegLoad = (async () => {
    const ffmpeg = new FFmpeg();
    const workerUrl = vendorAsset("worker.js");
    const check = await fetch(workerUrl, { method: "HEAD" });
    if (!check.ok) {
      throw new Error(
        "Encoder files missing. Serve vendor/ffmpeg/ from the project root."
      );
    }

    onStatus("Loading encoder…");
    await ffmpeg.load({
      classWorkerURL: workerUrl,
      coreURL: await blobUrlFor(vendorAsset("ffmpeg-core.js")),
      wasmURL: await blobUrlFor(vendorAsset("ffmpeg-core.wasm")),
    });

    sharedFfmpeg = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await sharedFfmpegLoad;
  } finally {
    sharedFfmpegLoad = null;
  }
}

function frameFileName(index) {
  return `frame_${String(index + 1).padStart(5, "0")}.jpg`;
}

async function cleanupFrames(ffmpeg, count) {
  for (let i = 0; i < count; i++) {
    await ffmpeg.deleteFile(frameFileName(i)).catch(() => {});
  }
}

function toBlob(data, mime) {
  if (data instanceof Uint8Array) {
    return new Blob([data], { type: mime });
  }
  if (data?.buffer instanceof ArrayBuffer) {
    return new Blob(
      [new Uint8Array(data.buffer, data.byteOffset, data.byteLength)],
      { type: mime }
    );
  }
  throw new Error("Invalid encoder output.");
}

function hasExportAudio(audio) {
  const { musicSrc, voiceSrc, musicVolume, voiceVolume } = audio;
  return (
    (musicSrc && musicVolume > 0) || (voiceSrc && voiceVolume > 0)
  );
}

/** Wasm encode is slow (~100–200 ms/frame); scale limit with output length. */
function encodingTimeoutMs(totalFrames) {
  const n = Math.max(1, totalFrames);
  return Math.min(1_800_000, Math.max(300_000, n * 200));
}

async function execWithTimeout(ffmpeg, args, timeoutMs, label = "Encoding") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const sec = Math.round(timeoutMs / 1000);
      reject(
        new Error(
          `${label} timed out (${sec}s). Try a shorter scroll, MP4 format, or less text.`
        )
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([ffmpeg.exec(args, timeoutMs), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const X264_FAST = ["-preset", "ultrafast", "-tune", "fastdecode"];

/**
 * @param {object} opts
 * @param {number} opts.fps
 * @param {number} opts.frameCount
 * @param {number} opts.totalDuration — scroll timeline length in seconds
 * @param {(frameIndex: number, timeSec: number) => Promise<Blob>} opts.renderFrame
 * @param {object} opts.audio
 */
export async function encodeFrameSequence(opts) {
  const {
    fps,
    frameCount,
    totalDuration,
    renderFrame,
    audio = {},
    onProgress = () => {},
    onStatus = () => {},
  } = opts;

  const totalFrames = frameCount + 1;
  const duration = Math.max(0.04, totalDuration);
  const encodeTimeout = encodingTimeoutMs(totalFrames);
  const muxTimeout = encodeTimeout + 120_000;

  const ffmpeg = await getFfmpeg(onStatus);

  ffmpeg.on("progress", ({ progress }) => {
    const encodePct = 68 + Math.round((progress ?? 0) * 30);
    onProgress(Math.min(99, encodePct));
  });

  for (let i = 0; i <= frameCount; i++) {
    const t = frameCount > 0 ? (i / frameCount) * duration : 0;
    onStatus(`Rendering frame ${i + 1} / ${totalFrames}…`);
    const jpeg = await renderFrame(i, t);
    if (!jpeg || jpeg.size < 32) {
      throw new Error(`Frame ${i + 1} capture failed.`);
    }
    await ffmpeg.writeFile(frameFileName(i), await fetchFile(jpeg));
    onProgress(Math.round((i / frameCount) * 65));
    await yieldToMain();
  }

  onStatus(`Encoding video (${totalFrames} frames)…`);
  onProgress(68);

  const stagedPath = "staged.mp4";
  const videoArgs = [
    "-y",
    "-framerate",
    String(fps),
    "-start_number",
    "1",
    "-i",
    "frame_%05d.jpg",
    "-frames:v",
    String(totalFrames),
    "-r",
    String(fps),
    "-vsync",
    "cfr",
    "-c:v",
    "libx264",
    ...X264_FAST,
    "-profile:v",
    "baseline",
    "-level",
    "3.0",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-tag:v",
    "avc1",
    "-an",
    stagedPath,
  ];

  await execWithTimeout(ffmpeg, videoArgs, encodeTimeout, "Video encoding");

  await cleanupFrames(ffmpeg, totalFrames);

  const outputName = "output.mp4";

  if (!hasExportAudio(audio)) {
    await execWithTimeout(
      ffmpeg,
      ["-y", "-i", stagedPath, "-c", "copy", outputName],
      120_000,
      "Finalizing video"
    );
    await ffmpeg.deleteFile(stagedPath).catch(() => {});
    const data = await ffmpeg.readFile(outputName);
    onProgress(100);
    return toBlob(data, "video/mp4");
  }

  onStatus("Mixing audio…");
  onProgress(72);

  const inputs = ["-y", "-i", stagedPath];
  const filter = [];
  let audioInputIndex = 1;
  const mixLabels = [];

  if (audio.musicSrc && audio.musicVolume > 0) {
    await ffmpeg.writeFile("src_music", await fetchFile(audio.musicSrc));
    if (audio.musicLoop !== false) {
      inputs.push("-stream_loop", "-1", "-i", "src_music");
    } else {
      inputs.push("-i", "src_music");
    }
    const vol = Math.max(0, Math.min(1, audio.musicVolume / 100));
    filter.push(`[${audioInputIndex}:a]volume=${vol}[music]`);
    mixLabels.push("[music]");
    audioInputIndex++;
  }

  if (audio.voiceSrc && audio.voiceVolume > 0) {
    await ffmpeg.writeFile("src_voice", await fetchFile(audio.voiceSrc));
    inputs.push("-stream_loop", "-1", "-i", "src_voice");
    const vol = Math.max(0, Math.min(1, audio.voiceVolume / 100));
    filter.push(`[${audioInputIndex}:a]volume=${vol}[voice]`);
    mixLabels.push("[voice]");
    audioInputIndex++;
  }

  let mapAudio = mixLabels[0];
  if (mixLabels.length === 2) {
    filter.push(
      `${mixLabels[0]}${mixLabels[1]}amix=inputs=2:duration=longest[aout]`
    );
    mapAudio = "[aout]";
  }

  const audioCodec = "aac";

  inputs.push(
    "-t",
    String(duration),
    "-filter_complex",
    filter.join(";"),
    "-map",
    "0:v",
    "-map",
    mapAudio,
    "-c:v",
    "copy",
    "-c:a",
    audioCodec,
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-shortest",
    outputName
  );

  try {
    await execWithTimeout(ffmpeg, inputs, muxTimeout, "Audio mixing");
  } catch {
    onStatus("Retrying without audio…");
    await execWithTimeout(
      ffmpeg,
      ["-y", "-i", stagedPath, "-c", "copy", outputName],
      120_000,
      "Finalizing video"
    );
  }

  await ffmpeg.deleteFile(stagedPath).catch(() => {});
  await ffmpeg.deleteFile("src_music").catch(() => {});
  await ffmpeg.deleteFile("src_voice").catch(() => {});

  const data = await ffmpeg.readFile(outputName);
  const blob = toBlob(data, "video/mp4");
  if (blob.size < 1024) {
    throw new Error("Export file is empty. Try Chrome or a shorter scroll duration.");
  }

  onProgress(100);
  return blob;
}
