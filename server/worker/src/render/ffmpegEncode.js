import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function encodeMp4FromFrames({
  framesDir,
  outputPath,
  fps,
  musicPath,
  voicePath,
  musicVolume = 100,
  voiceVolume = 100,
  musicLoop = true,
  totalDuration,
}) {
  const staged = path.join(path.dirname(outputPath), "staged.mp4");
  await runFfmpeg([
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, "frame_%05d.jpg"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "fast",
    staged,
  ]);

  const hasMusic = !!musicPath;
  const hasVoice = !!voicePath;
  if (!hasMusic && !hasVoice) {
    const { rename } = await import("node:fs/promises");
    await rename(staged, outputPath);
    return outputPath;
  }

  const args = ["-y", "-i", staged];
  let filter = "";
  let mapAudio = "";

  if (hasMusic) {
    if (musicLoop) args.push("-stream_loop", "-1");
    args.push("-i", musicPath);
    const mv = Math.max(0, Math.min(2, musicVolume / 100));
    filter += `[1:a]volume=${mv}[m];`;
    mapAudio = "[m]";
  }
  if (hasVoice) {
    args.push("-stream_loop", "-1", "-i", voicePath);
    const idx = hasMusic ? 2 : 1;
    const vv = Math.max(0, Math.min(2, voiceVolume / 100));
    if (hasMusic) {
      filter += `[${idx}:a]volume=${vv}[v];[m][v]amix=inputs=2:duration=first[aout]`;
      mapAudio = "[aout]";
    } else {
      filter += `[${idx}:a]volume=${vv}[aout]`;
      mapAudio = "[aout]";
    }
  }

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "0:v",
    "-map",
    mapAudio,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(totalDuration),
    outputPath
  );

  try {
    await runFfmpeg(args);
    return outputPath;
  } catch {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(staged, outputPath);
    return outputPath;
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(-500) || `ffmpeg exited ${code}`));
    });
  });
}

export async function writeFrameJpegs(framesDir, frames) {
  await mkdir(framesDir, { recursive: true });
  let i = 0;
  for (const buf of frames) {
    const name = `frame_${String(i).padStart(5, "0")}.jpg`;
    await writeFile(path.join(framesDir, name), buf);
    i += 1;
  }
}

export async function cleanupDir(dir) {
  try {
    const files = await readdir(dir);
    await Promise.all(files.map((f) => import("node:fs/promises").then((fs) => fs.unlink(path.join(dir, f)))));
  } catch {
    /* ignore */
  }
}
