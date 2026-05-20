# ScrollDrop

Browser-based tool to place animated scrolling text over any background — image, GIF, or video. No server, no install. Export as WebM or MP4.

## Features

- Multi-line text with blank-line spacers
- Background upload (JPG, PNG, WebP, GIF, MP4, WebM)
- Background audio upload (MP3, WAV) with volume control
- Video volume control when using a video background
- Font picker (32 curated Google Fonts), size, color, opacity, alignment
- Line height, letter spacing, text shadow, horizontal padding
- Scroll speed (10–500 px/s) and start delay
- Background fit (cover / contain / stretch), brightness & blur overlay
- Loop / play-once when scroll is longer than the clip
- Aspect ratios: 16:9, 9:16, 1:1, 4:3
- Live preview with play / pause / reset
- Export to **WebM** or **MP4** via offline frame render + ffmpeg.wasm (stable 30 fps)

## Local development

Serve the folder with any static server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` (or the port shown). ES modules require HTTP — `file://` will not work.

## Deploy to Vercel

1. Push this repo to GitHub.
2. In the [Vercel dashboard](https://vercel.com), import the project under **anton.veselov@maneuvermarketing.com**.
3. Framework preset: **Other** (static site, no build).
4. Root directory: `.` — output is the repo root (`index.html` at top level).

Or from the CLI (after `vercel login`):

```bash
vercel
vercel --prod
```

## Project structure

```
├── index.html    # App shell
├── style.css     # UI styles
├── app.js        # Controls & state
├── preview.js    # rAF scroll engine
├── export.js           # Frame capture + export orchestration
├── frameEncoder.js     # ffmpeg.wasm frame sequence → WebM/MP4
├── mp4Export.js        # Legacy WebM→MP4 transcode helper
├── audioSync.js        # Preview & export audio routing
├── backgroundMedia.js  # GIF timeline + media time mapping
└── fonts.js            # Google Fonts loader
```

## Browser notes

- Best export experience: **Chrome** or **Edge**
- MP4 export downloads ffmpeg.wasm on first use (~25 MB); needs COOP/COEP headers (`vercel.json` included for Vercel deploys)
- Export renders each frame at a fixed timeline position (same idea as [Remotion](https://www.remotion.dev/docs/ai/skills) `useCurrentFrame()`), then encodes at 30 fps — not realtime screen recording
- Optional: `npx skills add remotion-dev/skills` for Remotion project conventions when extending this app

## License

MIT
