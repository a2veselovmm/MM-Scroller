# MM-Scroller

Browser-based tool to place animated scrolling text over an image or video background, with music and voiceover. Supports browser export, GCP cloud queue rendering, and downloadable local render bundles.

## Features

- Multi-line text with blank-line spacers
- **Background media**: images (JPG, PNG, WebP) and videos (MP4, MOV)
- Video playback modes for shorter clips: loop or boomerang
- Queue render options: cloud render and downloadable local render bundle
- Boomerang queued renders (cloud/local) start from frame 0 of the uploaded background clip
- **Music** upload (MP3, WAV) with volume control
- **Voiceover** upload (MP3, WAV) with volume control
- Font picker (32 curated Google Fonts), size, color, opacity, alignment
- Line height, letter spacing, text shadow, horizontal padding
- Scroll speed (10–500 px/s) and start delay
- Background fit (cover / contain / stretch), color overlay & vignette
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

## Render options

### 1) Render in this tab (browser export)

- Best for short videos and quick iterations
- Uses ffmpeg.wasm in the browser

### 2) Send to cloud queue (GCP)

- Uploads project + media and renders on Cloud Run workers
- Best for longer renders and when you want background processing

### 3) Download render script (local bundle)

- Creates a ZIP bundle with project JSON, media, required fonts, renderer runtime, and OS scripts
- Best when you want to use your own machine resources for rendering
- Prerequisites on target machine:
  - Node.js 20+
  - npm
  - ffmpeg available in `PATH`
- Run:
  - macOS/Linux: `scripts/run-macos.sh`
  - Windows: `scripts/run-windows.bat`

Output MP4 is generated next to the bundle by default (`local-render-output.mp4`).

## Deploy to GCP

See `server/README.md` for the full backend guide. Quick path:

```bash
# one-time provisioning
chmod +x server/scripts/provision-gcp.sh server/scripts/deploy.sh server/scripts/enable-hosting-api.sh
./server/scripts/provision-gcp.sh

# deploy API + worker (Cloud Run) and patch firebase rewrite
./server/scripts/deploy.sh

# deploy frontend (Firebase Hosting)
npm run deploy:hosting
```

Cloud queue requires both Cloud Run services and Hosting rewrite to `/api/**`.

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
- MP4 export downloads ffmpeg.wasm on first use (~25 MB); needs COOP/COEP headers (configured in `firebase.json`)
- Export renders each frame at a fixed timeline position, then encodes at 30 fps
- Boomerang background preview in-browser is limited to around 10 FPS due to browser seek constraints

## License

MIT
