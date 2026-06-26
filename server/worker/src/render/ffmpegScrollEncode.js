import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

function parseProgressLine(line, totalDurationSec) {
  const trimmed = line.trim();
  if (trimmed.startsWith("out_time_ms=")) {
    const ms = Number(trimmed.slice("out_time_ms=".length));
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const pct = Math.min(99, Math.round((ms / 1_000_000 / totalDurationSec) * 100));
    return pct;
  }
  return null;
}

function runFfmpeg(args, { onSpawn, onProgress, totalDurationSec } = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = [...args, "-progress", "pipe:1", "-nostats"];
    const proc = spawn("ffmpeg", fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    onSpawn?.(proc);
    let err = "";
    let lastPct = -1;

    proc.stdout.on("data", (chunk) => {
      if (!onProgress) return;
      for (const line of chunk.toString().split("\n")) {
        const pct = parseProgressLine(line, totalDurationSec);
        if (pct != null && pct > lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    });

    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code, signal) => {
      if (code === 0) resolve();
      else if (signal === "SIGTERM" || signal === "SIGKILL") {
        const e = new Error("ffmpeg cancelled");
        e.name = "FfmpegCancelledError";
        reject(e);
      } else reject(new Error(err.slice(-800) || `ffmpeg exited ${code}`));
    });
  });
}

function modTime(value, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return ((value % duration) + duration) % duration;
}

async function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.slice(-800) || `ffprobe exited ${code}`));
    });
  });
}

export async function probeVideoDurationSec(filePath) {
  const out = await runFfprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(out);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not read background video duration.");
  }
  return duration;
}

export async function prepareBackgroundVideo({
  inputPath,
  outputPath,
  width,
  height,
  fitMode = "cover",
  onFfmpegSpawn,
}) {
  const w = Math.max(2, Math.round(Number(width) || 1080));
  const h = Math.max(2, Math.round(Number(height) || 1920));
  const fit = fitMode === "contain" ? "contain" : fitMode === "fill" ? "fill" : "cover";
  const scaleFilter =
    fit === "fill"
      ? `scale=${w}:${h}`
      : fit === "contain"
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
        : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;

  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-an",
      "-filter:v",
      `${scaleFilter},setpts=PTS-STARTPTS,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { onSpawn: onFfmpegSpawn }
  );
  return outputPath;
}

export async function createBoomerangVideo({
  inputPath,
  outputPath,
  onFfmpegSpawn,
}) {
  await runFfmpeg(
    [
      "-y",
      "-i",
      inputPath,
      "-an",
      "-filter_complex",
      "[0:v]setpts=PTS-STARTPTS,split[fwd][rev];[rev]reverse,setpts=PTS-STARTPTS[r];[fwd][r]concat=n=2:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { onSpawn: onFfmpegSpawn }
  );
  return outputPath;
}

function scrollYExpr({ startDelay, startY, endY, speedY, timeOffsetSec = 0 }) {
  const sd = Number(startDelay) || 0;
  const sy = Number(startY) || 0;
  const ey = Number(endY) || 0;
  const sp = Number(speedY) || 1;
  const t0 = Number(timeOffsetSec) || 0;
  return `if(lt(t+${t0}\\,${sd})\\,${sy}\\,max(${ey}\\,${sy}-((t+${t0})-${sd})*${sp}))`;
}

function videoEncodeArgs(preset, crf, { stillImage = true } = {}) {
  const args = [
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    preset,
    "-crf",
    crf,
    "-threads",
    "0",
    "-x264-params",
    "keyint=60:min-keyint=30",
    "-movflags",
    "+faststart",
  ];
  if (stillImage) {
    args.splice(6, 0, "-tune", "stillimage");
  }
  return args;
}

function buildScrollFilter(yExpr, textOffsetY = 0) {
  const y = Number(textOffsetY) ? `(${yExpr})-${Number(textOffsetY)}` : yExpr;
  return [
    `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[bg]`,
    `[bg][1:v]overlay=x=0:y='${y}':eval=frame:format=auto[vout]`,
  ].join(";");
}

function appendTextStripInputs(args, {
  textStripPath,
  textStripWidth,
  textStripHeight,
  textStripIsRaw,
  fps,
  dur,
}) {
  if (textStripIsRaw) {
    args.push(
      "-stream_loop",
      "-1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${textStripWidth}x${textStripHeight}`,
      "-framerate",
      String(fps),
      "-t",
      String(dur),
      "-i",
      textStripPath
    );
  } else {
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", textStripPath);
  }
}

function appendBackgroundInput(args, {
  bgImagePath,
  fps,
  dur,
  backgroundIsVideo = false,
  backgroundDurationSec = 0,
  timeOffsetSec = 0,
}) {
  if (!backgroundIsVideo) {
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", bgImagePath);
    return;
  }

  args.push("-stream_loop", "-1");
  const offset = modTime(Number(timeOffsetSec) || 0, Number(backgroundDurationSec) || 0);
  if (offset > 0) args.push("-ss", String(offset));
  args.push("-t", String(dur), "-i", bgImagePath);
}

/**
 * Encode one video-only scroll segment (no audio).
 */
export async function encodeScrollSegment({
  bgImagePath,
  backgroundIsVideo = false,
  backgroundDurationSec = 0,
  textStripPath,
  textStripWidth,
  textStripHeight,
  textStripIsRaw = false,
  outputPath,
  fps,
  segmentDuration,
  timeOffsetSec = 0,
  startDelay,
  startY,
  endY,
  speedY,
  textOffsetY = 0,
  onFfmpegSpawn,
  onEncodeProgress,
}) {
  const preset = process.env.CLOUD_ENCODE_PRESET || "ultrafast";
  const crf = process.env.CLOUD_ENCODE_CRF || "28";
  const dur = Math.max(0.1, Number(segmentDuration) || 1);
  const yExpr = scrollYExpr({ startDelay, startY, endY, speedY, timeOffsetSec });
  const filter = buildScrollFilter(yExpr, textOffsetY);

  const args = ["-y"];
  appendBackgroundInput(args, {
    bgImagePath,
    fps,
    dur,
    backgroundIsVideo,
    backgroundDurationSec,
    timeOffsetSec,
  });
  appendTextStripInputs(args, {
    textStripPath,
    textStripWidth,
    textStripHeight,
    textStripIsRaw,
    fps,
    dur,
  });

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    ...videoEncodeArgs(preset, crf, { stillImage: !backgroundIsVideo }),
    "-t",
    String(dur),
    outputPath
  );

  await runFfmpeg(args, {
    onSpawn: onFfmpegSpawn,
    onProgress: onEncodeProgress,
    totalDurationSec: dur,
  });
  return outputPath;
}

/**
 * Concat segment MP4s and mux music/voice onto the final output.
 */
export async function concatSegmentsAndMuxAudio({
  segmentPaths,
  outputPath,
  totalDuration,
  musicPath,
  voicePath,
  musicVolume = 100,
  voiceVolume = 100,
  musicLoop = true,
  concatListPath,
  videoOnlyPath,
  onFfmpegSpawn,
  onEncodeProgress,
}) {
  const listContent = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(concatListPath, listContent);

  await runFfmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", videoOnlyPath],
    { onSpawn: onFfmpegSpawn, totalDurationSec: totalDuration }
  );

  const hasMusic = !!musicPath;
  const hasVoice = !!voicePath;
  const dur = Math.max(0.1, Number(totalDuration) || 1);

  if (!hasMusic && !hasVoice) {
    await runFfmpeg(["-y", "-i", videoOnlyPath, "-c", "copy", "-movflags", "+faststart", outputPath], {
      totalDurationSec: dur,
    });
    return outputPath;
  }

  const args = ["-y", "-i", videoOnlyPath];
  if (hasMusic) {
    if (musicLoop) args.push("-stream_loop", "-1");
    args.push("-i", musicPath);
  }
  if (hasVoice) {
    args.push("-stream_loop", "-1", "-i", voicePath);
  }

  let filterComplex = "";
  let mapAudio = null;
  if (hasMusic || hasVoice) {
    const parts = [];
    if (hasMusic) {
      const mv = Math.max(0, Math.min(2, musicVolume / 100));
      parts.push(`[1:a]volume=${mv}[m]`);
      mapAudio = "[m]";
    }
    if (hasVoice) {
      const voiceIdx = hasMusic ? 2 : 1;
      const vv = Math.max(0, Math.min(2, voiceVolume / 100));
      if (hasMusic) {
        parts.push(`[${voiceIdx}:a]volume=${vv}[v]`, `[m][v]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
        mapAudio = "[aout]";
      } else {
        parts.push(`[${voiceIdx}:a]volume=${vv}[aout]`);
        mapAudio = "[aout]";
      }
    }
    filterComplex = parts.join(";");
  }

  args.push("-filter_complex", filterComplex, "-map", "0:v", "-map", mapAudio);
  args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", outputPath);

  await runFfmpeg(args, {
    onSpawn: onFfmpegSpawn,
    onProgress: onEncodeProgress,
    totalDurationSec: dur,
  });
  return outputPath;
}

/**
 * Scroll a pre-rendered text strip over a background image using ffmpeg overlay.
 */
export async function encodeScrollVideo({
  bgImagePath,
  backgroundIsVideo = false,
  backgroundDurationSec = 0,
  textStripPath,
  textStripWidth,
  textStripHeight,
  textStripIsRaw = false,
  outputPath,
  fps,
  totalDuration,
  startDelay,
  startY,
  endY,
  speedY,
  textOffsetY = 0,
  musicPath,
  voicePath,
  musicVolume = 100,
  voiceVolume = 100,
  musicLoop = true,
  onFfmpegSpawn,
  onEncodeProgress,
}) {
  const preset = process.env.CLOUD_ENCODE_PRESET || "ultrafast";
  const crf = process.env.CLOUD_ENCODE_CRF || "28";
  const yExpr = scrollYExpr({ startDelay, startY, endY, speedY });
  const dur = Math.max(0.1, Number(totalDuration) || 1);
  const filter = buildScrollFilter(yExpr, textOffsetY);

  const args = ["-y"];

  appendBackgroundInput(args, {
    bgImagePath,
    fps,
    dur,
    backgroundIsVideo,
    backgroundDurationSec,
    timeOffsetSec: 0,
  });

  appendTextStripInputs(args, {
    textStripPath,
    textStripWidth,
    textStripHeight,
    textStripIsRaw,
    fps,
    dur,
  });

  const hasMusic = !!musicPath;
  const hasVoice = !!voicePath;

  if (hasMusic) {
    if (musicLoop) args.push("-stream_loop", "-1");
    args.push("-i", musicPath);
  }
  if (hasVoice) {
    args.push("-stream_loop", "-1", "-i", voicePath);
  }

  let filterComplex = filter;
  let mapAudio = null;

  if (hasMusic || hasVoice) {
    const parts = [];
    if (hasMusic) {
      const mv = Math.max(0, Math.min(2, musicVolume / 100));
      parts.push(`[2:a]volume=${mv}[m]`);
      mapAudio = "[m]";
    }
    if (hasVoice) {
      const voiceIdx = hasMusic ? 3 : 2;
      const vv = Math.max(0, Math.min(2, voiceVolume / 100));
      if (hasMusic) {
        parts.push(`[${voiceIdx}:a]volume=${vv}[v]`, `[m][v]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
        mapAudio = "[aout]";
      } else {
        parts.push(`[${voiceIdx}:a]volume=${vv}[aout]`);
        mapAudio = "[aout]";
      }
    }
    filterComplex = `${filter};${parts.join(";")}`;
  }

  args.push("-filter_complex", filterComplex, "-map", "[vout]");
  if (mapAudio) args.push("-map", mapAudio);
  args.push(...videoEncodeArgs(preset, crf, { stillImage: !backgroundIsVideo }), "-t", String(dur));
  if (mapAudio) {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  }

  args.push(outputPath);
  await runFfmpeg(args, {
    onSpawn: onFfmpegSpawn,
    onProgress: onEncodeProgress,
    totalDurationSec: dur,
  });
  return outputPath;
}

export async function writePng(canvas, filePath) {
  await writeFile(filePath, canvas.toBuffer("image/png"));
  return filePath;
}

export async function writeJpeg(canvas, filePath, quality = 0.9) {
  await writeFile(filePath, canvas.toBuffer("image/jpeg", { quality }));
  return filePath;
}

export async function writeRawRgba(canvas, filePath) {
  await writeFile(filePath, canvas.toBuffer("raw"));
  return filePath;
}

export function localMediaPath(tmpDir, field, fileMeta) {
  const fileName = fileMeta?.[field]?.fileName || field;
  const ext = path.extname(fileName) || (field === "background" ? ".jpg" : field === "music" || field === "voiceover" ? ".mp3" : "");
  return path.join(tmpDir, `${field}${ext}`);
}
