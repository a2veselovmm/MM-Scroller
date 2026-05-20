# ScrollDrop

Browser-based tool to place animated scrolling text over any background — image, GIF, or video. No server, no install. Export as WebM.

## Features

- Multi-line text with blank-line spacers
- Background upload (JPG, PNG, WebP, GIF, MP4, WebM)
- Font picker (10 curated Google Fonts), size, color, opacity, alignment
- Line height, letter spacing, text shadow, horizontal padding
- Scroll speed (10–500 px/s) and start delay
- Background fit (cover / contain / stretch), brightness & blur overlay
- Aspect ratios: 16:9, 9:16, 1:1, 4:3
- Live preview with play / pause / reset
- Export to `.webm` via MediaRecorder

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
├── export.js     # WebM export
└── fonts.js      # Google Fonts loader
```

## Browser notes

- Best export experience: **Chrome** or **Edge**
- Safari has limited MediaRecorder WebM support
- Phase 3 (optional): ffmpeg.wasm for MP4 — requires COOP/COEP headers (already set in `vercel.json` for future use)

## License

MIT
