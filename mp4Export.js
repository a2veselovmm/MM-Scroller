import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

function vendorAsset(file) {
  return new URL(`vendor/ffmpeg/${file}`, window.location.href).href;
}

async function blobUrlFor(path) {
  return toBlobURL(path, path.endsWith(".wasm") ? "application/wasm" : "text/javascript");
}

async function loadFfmpeg(ffmpeg) {
  const workerUrl = vendorAsset("worker.js");
  const check = await fetch(workerUrl, { method: "HEAD" });
  if (!check.ok) {
    throw new Error(
      "MP4 encoder files missing. Ensure vendor/ffmpeg/ is served (restart your local server from the project root)."
    );
  }

  await ffmpeg.load({
    classWorkerURL: workerUrl,
    coreURL: await blobUrlFor(vendorAsset("ffmpeg-core.js")),
    wasmURL: await blobUrlFor(vendorAsset("ffmpeg-core.wasm")),
  });
}

function toMp4Blob(data) {
  if (data instanceof Uint8Array) {
    return new Blob([data], { type: "video/mp4" });
  }
  if (data?.buffer instanceof ArrayBuffer) {
    return new Blob(
      [new Uint8Array(data.buffer, data.byteOffset, data.byteLength)],
      { type: "video/mp4" }
    );
  }
  throw new Error("Invalid MP4 output from encoder.");
}

function buildMp4Args(hasAudio) {
  const args = [
    "-i",
    "input.webm",
    "-map",
    "0:v:0",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-level",
    "3.0",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-r",
    "30",
    "-movflags",
    "+faststart",
    "-tag:v",
    "avc1",
  ];

  if (hasAudio) {
    args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  } else {
    args.push("-an");
  }

  args.push("output.mp4");
  return args;
}

export async function convertWebMToMp4(webmBlob, hooks = {}) {
  const { onStatus = () => {}, onProgress = () => {}, hasAudio = false } = hooks;

  if (!webmBlob || webmBlob.size < 1024) {
    throw new Error("Recording is empty or too short to convert to MP4.");
  }

  const ffmpeg = new FFmpeg();
  const logs = [];

  ffmpeg.on("log", ({ message }) => {
    if (message) logs.push(message);
  });

  ffmpeg.on("progress", ({ progress }) => {
    onProgress(Math.min(99, Math.round((progress ?? 0) * 100)));
  });

  onStatus("Loading MP4 encoder…");
  await loadFfmpeg(ffmpeg);

  onStatus("Encoding MP4…");
  await ffmpeg.writeFile("input.webm", await fetchFile(webmBlob));

  try {
    await ffmpeg.exec(buildMp4Args(hasAudio));
  } catch (err) {
    if (hasAudio) {
      onStatus("Retrying without audio track…");
      await ffmpeg.deleteFile("output.mp4").catch(() => {});
      await ffmpeg.exec(buildMp4Args(false));
    } else {
      const tail = logs.slice(-8).join("\n");
      throw new Error(`MP4 encoding failed.${tail ? `\n${tail}` : ""}`);
    }
  }

  const data = await ffmpeg.readFile("output.mp4");
  const mp4Blob = toMp4Blob(data);

  if (mp4Blob.size < 1024) {
    const tail = logs.slice(-8).join("\n");
    throw new Error(
      `MP4 file is empty or corrupt.${tail ? `\n${tail}` : ""} Try exporting as WebM, or use Chrome.`
    );
  }

  onProgress(100);
  return mp4Blob;
}
