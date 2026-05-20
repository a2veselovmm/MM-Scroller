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
  const { videoSrc, bgAudioSrc, videoVolume, audioVolume } = audio;
  return (
    (videoSrc && videoVolume > 0) || (bgAudioSrc && audioVolume > 0)
  );
}

async function execWithTimeout(ffmpeg, args, timeoutMs = 120000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Video encoding timed out. Try a shorter scroll or MP4 format.")),
      timeoutMs
    );
  });
  try {
    await Promise.race([ffmpeg.exec(args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {number} opts.fps
 * @param {number} opts.frameCount
 * @param {number} opts.totalDuration — scroll timeline length in seconds
 * @param {'webm'|'mp4'} opts.format
 * @param {(frameIndex: number, timeSec: number) => Promise<Blob>} opts.renderFrame
 * @param {object} opts.audio
 */
export async function encodeFrameSequence(opts) {
  const {
    fps,
    frameCount,
    totalDuration,
    format,
    renderFrame,
    audio = {},
    onProgress = () => {},
    onStatus = () => {},
  } = opts;

  const totalFrames = frameCount + 1;
  const duration = Math.max(0.04, totalDuration);
  const frameBlobs = [];

  for (let i = 0; i <= frameCount; i++) {
    const t =
      frameCount > 0 ? (i / frameCount) * duration : 0;
    onStatus(`Capturing frame ${i + 1} / ${totalFrames}…`);
    const jpeg = await renderFrame(i, t);
    if (!jpeg || jpeg.size < 32) {
      throw new Error(`Frame ${i + 1} capture failed.`);
    }
    frameBlobs.push(jpeg);
    onProgress(Math.round(5 + (i / frameCount) * 50));
    await yieldToMain();
  }

  const ffmpeg = await getFfmpeg(onStatus);
  onProgress(58);

  ffmpeg.on("progress", ({ progress }) => {
    const encodePct = 70 + Math.round((progress ?? 0) * 28);
    onProgress(Math.min(99, encodePct));
  });

  for (let i = 0; i < frameBlobs.length; i++) {
    onStatus(`Preparing frame ${i + 1} / ${totalFrames}…`);
    await ffmpeg.writeFile(frameFileName(i), await fetchFile(frameBlobs[i]));
    frameBlobs[i] = null;
    onProgress(58 + Math.round((i / frameCount) * 10));
    await yieldToMain();
  }

  onStatus("Encoding video…");
  onProgress(70);

  const staged = format === "webm" ? "staged.webm" : "staged.mp4";
  const videoArgs =
    format === "webm"
      ? [
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
          "libvpx-vp8",
          "-pix_fmt",
          "yuv420p",
          "-b:v",
          "6M",
          "-an",
          staged,
        ]
      : [
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
          staged,
        ];

  let stagedPath = staged;
  try {
    await execWithTimeout(ffmpeg, videoArgs);
  } catch (err) {
    if (format !== "webm") throw err;
    onStatus("WebM codec unavailable — using H.264…");
    stagedPath = "staged.mp4";
    await execWithTimeout(ffmpeg, [
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
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      stagedPath,
    ]);
  }

  await cleanupFrames(ffmpeg, totalFrames);

  const outputName = format === "webm" ? "output.webm" : "output.mp4";

  if (!hasExportAudio(audio)) {
    await execWithTimeout(ffmpeg, ["-y", "-i", stagedPath, "-c", "copy", outputName], 60000);
    await ffmpeg.deleteFile(stagedPath).catch(() => {});
    const data = await ffmpeg.readFile(outputName);
    onProgress(100);
    return toBlob(data, format === "webm" ? "video/webm" : "video/mp4");
  }

  onStatus("Mixing audio…");
  onProgress(72);

  const inputs = ["-y", "-i", stagedPath];
  const filter = [];
  let audioInputIndex = 1;
  const mixLabels = [];

  if (audio.videoSrc && audio.videoVolume > 0) {
    await ffmpeg.writeFile("src_video", await fetchFile(audio.videoSrc));
    if (audio.mediaRepeat === "loop") {
      inputs.push("-stream_loop", "-1");
    }
    inputs.push("-i", "src_video");
    const vol = Math.max(0, Math.min(1, audio.videoVolume / 100));
    filter.push(`[${audioInputIndex}:a]volume=${vol}[va]`);
    mixLabels.push("[va]");
    audioInputIndex++;
  }

  if (audio.bgAudioSrc && audio.audioVolume > 0) {
    await ffmpeg.writeFile("src_audio", await fetchFile(audio.bgAudioSrc));
    if (audio.mediaRepeat === "loop") {
      inputs.push("-stream_loop", "-1");
    }
    inputs.push("-i", "src_audio");
    const vol = Math.max(0, Math.min(1, audio.audioVolume / 100));
    filter.push(`[${audioInputIndex}:a]volume=${vol}[ba]`);
    mixLabels.push("[ba]");
    audioInputIndex++;
  }

  let mapAudio = mixLabels[0];
  if (mixLabels.length === 2) {
    filter.push(
      `${mixLabels[0]}${mixLabels[1]}amix=inputs=2:duration=longest[aout]`
    );
    mapAudio = "[aout]";
  }

  const audioCodec = format === "webm" ? "libopus" : "aac";

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
    await execWithTimeout(ffmpeg, inputs, 90000);
  } catch {
    onStatus("Retrying without audio…");
    await execWithTimeout(ffmpeg, ["-y", "-i", stagedPath, "-c", "copy", outputName], 60000);
  }

  await ffmpeg.deleteFile(stagedPath).catch(() => {});
  await ffmpeg.deleteFile("src_video").catch(() => {});
  await ffmpeg.deleteFile("src_audio").catch(() => {});

  const data = await ffmpeg.readFile(outputName);
  const blob = toBlob(data, format === "webm" ? "video/webm" : "video/mp4");
  if (blob.size < 1024) {
    throw new Error("Export file is empty. Try Chrome or a shorter scroll duration.");
  }

  onProgress(100);
  return blob;
}
