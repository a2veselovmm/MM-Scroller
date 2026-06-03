# MM-Scroller

Browser-based tool to place animated scrolling text over a still image background, with music and voiceover. No server, no install. Export as MP4.

## Features

- Multi-line text with blank-line spacers
- **Still image** background (JPG, PNG, WebP)
- **Music** upload (MP3, WAV) with volume control
- **Voiceover** upload (MP3, WAV) with volume control
- Font picker (32 curated Google Fonts), size, color, opacity, alignment
- Line height, letter spacing, text shadow, horizontal padding
- Scroll speed (10–500 px/s) and start delay
- Background fit (cover / contain / stretch), blur overlay, color overlay & vignette
- Aspect ratios: 16:9, 9:16, 1:1, 4:3
- Live preview with play / pause / reset
- Export to **MP4** via offline frame render + ffmpeg.wasm (stable 30 fps)
- **Export setup (JSON)** in Settings — all controls, text, and optional embedded media

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
2. In the [Vercel dashboard](https://vercel.com), import the project.
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
├── projectIO.js        # Save project JSON
├── audioSync.js        # Preview audio routing
├── backgroundMedia.js  # Audio timeline helpers
└── fonts.js            # Google Fonts loader
```

## Browser notes

- Best export experience: **Chrome** or **Edge**
- MP4 export downloads ffmpeg.wasm on first use (~25 MB); needs COOP/COEP headers (`vercel.json` included for Vercel deploys)
- Export renders each frame at a fixed timeline position, then encodes at 30 fps

## License

MIT
