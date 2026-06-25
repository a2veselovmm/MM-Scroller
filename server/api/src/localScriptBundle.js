import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { collectProjectFontFamilies } from "../shared/fontValidation.js";
import { findFontByFamily, fontDisplayName } from "../shared/curatedFonts.js";

const require = createRequire(import.meta.url);
const archiverPkg = require("archiver");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createZipArchive(options) {
  if (typeof archiverPkg === "function") {
    return archiverPkg("zip", options);
  }
  if (typeof archiverPkg?.default === "function") {
    return archiverPkg.default("zip", options);
  }
  if (typeof archiverPkg?.ZipArchive === "function") {
    return new archiverPkg.ZipArchive(options);
  }
  throw new Error("Unsupported archiver export format.");
}

function safeName(name, fallback) {
  const raw = String(name || fallback || "file");
  const clean = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return clean || fallback || "file";
}

function fontFileBase(displayName) {
  return displayName.replace(/\s+/g, "-");
}

function resolveBundleFontsDir() {
  const candidates = [
    process.env.MM_LOCAL_BUNDLE_FONTS_DIR,
    path.join(__dirname, "../assets/fonts"),
    path.join(process.cwd(), "server/worker/assets/fonts"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Local bundle font assets directory not found. Expected worker fonts in API runtime image."
  );
}

function resolveRequiredFontFiles(projectDoc) {
  const fontsDir = resolveBundleFontsDir();
  const required = new Map();

  for (const family of collectProjectFontFamilies(projectDoc)) {
    const curated = findFontByFamily(family);
    if (!curated) {
      throw new Error(`Font "${family}" is not supported by the curated list.`);
    }

    const display = fontDisplayName(curated);
    const weights = String(curated.weights || "400")
      .split(";")
      .map((w) => Number(w))
      .filter((w) => Number.isFinite(w) && w > 0);

    for (const weight of weights) {
      const fileName = `${fontFileBase(display)}-${weight}.ttf`;
      const sourcePath = path.join(fontsDir, fileName);
      if (!existsSync(sourcePath)) {
        throw new Error(`Missing bundled font file "${fileName}" for family "${display}".`);
      }
      required.set(fileName, { fileName, sourcePath, family: display, weight });
    }
  }

  return [...required.values()];
}

function localRendererScript() {
  return readFileSync(path.join(__dirname, "localRendererRuntimeTemplate.mjs"), "utf8");
}

function rendererPackageJson() {
  return JSON.stringify(
    {
      name: "mm-scroller-local-renderer",
      private: true,
      type: "module",
      dependencies: {
        "@napi-rs/canvas": "latest",
      },
    },
    null,
    2
  );
}

function bundleReadme({ renderName = "", jobId, bundledFonts = [] }) {
  const title = renderName ? `${renderName}` : `Render ${jobId.slice(0, 8)}`;
  return [
    "MM-Scroller local render bundle",
    "==============================",
    "",
    `Render: ${title}`,
    `Job ID: ${jobId}`,
    "",
    "Contents:",
    "- project/project.json",
    "- media/*",
    "- renderer/render-local.mjs",
    "- renderer/package.json",
    "- renderer/fonts/*.ttf (subset required by this project)",
    "- scripts/run-macos.sh",
    "- scripts/run-windows.bat",
    "",
    "Prerequisites:",
    "- Node.js 20+",
    "- npm (ships with Node)",
    "- ffmpeg available in PATH",
    "- Internet access on first run (to install renderer dependency)",
    "",
    "How to use:",
    "1) Keep this unzipped folder intact.",
    "2) Run one of the scripts in ./scripts to generate an MP4.",
    "3) First run installs the local renderer dependency automatically.",
    "4) Output file is created in the bundle root by default.",
    "",
    "Bundled project fonts:",
    ...bundledFonts.map((font) => `- ${font.family} (${font.weight})`),
    "",
    "Notes:",
    "- This bundle is prepared by MM-Scroller API.",
    "- Cloud queue remains available if you prefer remote rendering.",
    "",
  ].join("\n");
}

function macScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'ROOT=\"$(cd \"$(dirname \"$0\")/..\" && pwd)\"',
    'echo \"MM-Scroller local bundle\"',
    'echo \"Bundle path: $ROOT\"',
    'echo \"Project: $ROOT/project/project.json\"',
    'echo \"Media dir: $ROOT/media\"',
    "",
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo \"Node.js is required (20+).\"',
    "  exit 1",
    "fi",
    'if ! command -v npm >/dev/null 2>&1; then',
    '  echo \"npm is required (included with Node.js).\"',
    "  exit 1",
    "fi",
    'if ! command -v ffmpeg >/dev/null 2>&1; then',
    '  echo \"ffmpeg is required in PATH.\"',
    "  exit 1",
    "fi",
    "",
    'if [ ! -d \"$ROOT/renderer/node_modules\" ]; then',
    '  echo \"Installing local renderer dependencies...\"',
    '  (cd \"$ROOT/renderer\" && npm install --no-fund --no-audit)',
    "fi",
    "",
    'OUT=\"${1:-$ROOT/local-render-output.mp4}\"',
    'echo \"Rendering to: $OUT\"',
    'node \"$ROOT/renderer/render-local.mjs\" --bundle \"$ROOT\" --output \"$OUT\"',
    'echo \"Done: $OUT\"',
    "exit 0",
    "",
  ].join("\n");
}

function windowsScript() {
  return [
    "@echo off",
    "setlocal",
    "",
    "set ROOT=%~dp0..",
    "echo MM-Scroller local bundle",
    "echo Bundle path: %ROOT%",
    "echo Project: %ROOT%\\project\\project.json",
    "echo Media dir: %ROOT%\\media",
    "",
    "where node >nul 2>&1",
    "if errorlevel 1 (",
    "  echo Node.js 20+ is required.",
    "  exit /b 1",
    ")",
    "where npm >nul 2>&1",
    "if errorlevel 1 (",
    "  echo npm is required (included with Node.js).",
    "  exit /b 1",
    ")",
    "where ffmpeg >nul 2>&1",
    "if errorlevel 1 (",
    "  echo ffmpeg is required in PATH.",
    "  exit /b 1",
    ")",
    "",
    "if not exist \"%ROOT%\\renderer\\node_modules\" (",
    "  echo Installing local renderer dependencies...",
    "  pushd \"%ROOT%\\renderer\"",
    "  call npm install --no-fund --no-audit",
    "  if errorlevel 1 (",
    "    popd",
    "    exit /b 1",
    "  )",
    "  popd",
    ")",
    "",
    "set OUT=%~1",
    "if \"%OUT%\"==\"\" set OUT=%ROOT%\\local-render-output.mp4",
    "echo Rendering to: %OUT%",
    "node \"%ROOT%\\renderer\\render-local.mjs\" --bundle \"%ROOT%\" --output \"%OUT%\"",
    "if errorlevel 1 exit /b 1",
    "echo Done: %OUT%",
    "exit /b 0",
    "",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {string} [opts.renderName]
 * @param {object} opts.projectDoc
 * @param {Array<{ field: string, fileName: string, mimeType: string, data: Buffer }>} opts.mediaFiles
 * @returns {Promise<Buffer>}
 */
export async function buildLocalScriptBundle({
  jobId,
  renderName = "",
  projectDoc,
  mediaFiles = [],
}) {
  const bundledFonts = resolveRequiredFontFiles(projectDoc);

  const out = new PassThrough();
  const chunks = [];
  out.on("data", (chunk) => chunks.push(chunk));

  const archive = createZipArchive({ zlib: { level: 9 } });
  archive.on("warning", (err) => {
    if (err?.code !== "ENOENT") throw err;
  });
  archive.pipe(out);
  const archiveError = new Promise((_, reject) => {
    archive.on("error", reject);
    out.on("error", reject);
  });

  archive.append(JSON.stringify(projectDoc, null, 2), {
    name: "project/project.json",
  });

  for (const media of mediaFiles) {
    const field = safeName(media.field, "media");
    const fileName = safeName(media.fileName, field);
    archive.append(media.data, { name: `media/${field}/${fileName}` });
  }

  for (const font of bundledFonts) {
    archive.append(readFileSync(font.sourcePath), {
      name: `renderer/fonts/${font.fileName}`,
    });
  }

  archive.append(localRendererScript(), { name: "renderer/render-local.mjs" });
  archive.append(rendererPackageJson(), { name: "renderer/package.json" });
  archive.append(macScript(), { name: "scripts/run-macos.sh", mode: 0o755 });
  archive.append(windowsScript(), { name: "scripts/run-windows.bat" });
  archive.append(bundleReadme({ renderName, jobId, bundledFonts }), { name: "README.txt" });

  await archive.finalize();
  await Promise.race([finished(out), archiveError]);
  return Buffer.concat(chunks);
}

