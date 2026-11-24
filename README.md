# ✂ VyroClipper

**AI clipping studio for [Vyro](https://app.vyro.com) campaigns** — pick the campaigns you want, VyroClipper reads each brief and its rules, downloads the campaign's *Content to Use*, finds the viral moments, edits them into short-form clips (captions, hook titles, face-tracked reframing, zooms, jump cuts, logo/on-screen text) and exports many ready-to-post clips **with a virality score and a compliance checklist** for every one.

Everything heavy runs **client-side in your browser** (WebGPU/WASM Whisper, MediaPipe, WebCodecs). It ships as:

| | |
|---|---|
| 🧩 **Chrome extension** | Captures campaigns from your logged-in app.vyro.com session, one-click “Clip this campaign”, bundled studio that downloads footage from any host. |
| 🌐 **Web studio** | Same studio as a static web app, deployable with Docker. |
| 🐳 **Docker server** | Serves the studio, proxies CORS-blocked downloads, fetches YouTube/TikTok/IG/X links with yt-dlp and **auto-redeploys on every git commit**. |

---

## Features (Opus Clip / Klap / QuickReel / InVideo-style premium features)

**Finding the viral moments**
- **Virality Score™-style scoring (0–99)** with Hook / Flow / Value / Trend sub-scores, campaign *On-brief* relevance and plain-language reasons (“Opens with a question”, “Energetic opening (+38% louder)”, “Story arc (setup → payoff)”…).
- Built-in engine works **offline**: sentence-aligned candidates scored from the transcript (hooks, curiosity gaps, numbers/stakes, emotion, storytelling, pacing, completeness) and the audio loudness envelope; non-overlapping top picks.
- **ClipAnything-style prompts** (“find moments about money challenges”), clip count, length range and timeframe controls.
- Titles and hook cards are picked from the clip's most specific, punchiest line, and are never repeated within a batch.
- Optional **LLM clip picking** with any OpenAI-compatible model (OpenAI, Groq, OpenRouter, Ollama, LM Studio) — the LLM returns sentence indices (no hallucinated timestamps), scores are blended 60/40 with the signal-based engine.
- Fallback for no-speech sources (gameplay/music) using audio energy.

**Editing (all automatic, all adjustable)**
- In-browser **Whisper** transcription with word timestamps (WebGPU, falls back to WASM) or cloud speech-to-text (OpenAI/Groq-compatible); SRT/VTT import.
- **AI reframe**: MediaPipe face tracking → smooth virtual camera with dead-zone, easing and hard cuts on speaker switches; layouts *fill*, *fit* (blurred background) and *split* (two speakers).
- **10 animated caption styles** (Bold Pop, Beast, Karaoke, Boxed, Neon, Typewriter, Minimal, Subtitle, Marker, Comic) with word-by-word highlighting, keyword colours, **auto-emojis**, profanity masking, custom colours/size/position.
- **Source-aware overlays**: sampled frames are scanned for text already burned into the footage. Pre-captioned edits don't get a second set of captions (they count as subtitles in the checklist), and captions/hook titles are kept clear of lower-thirds and logos.
- **AI hook title** card in the first seconds, **dynamic zoom** punch-ins, alternating zoom on cuts, **jump cuts** (silence removal), **filler-word removal**, progress bar, CTA end card, logo/watermark, **brand kit**.
- **Text-based editing**: click words to seek, select words and cut them; trim by word.
- **Magic box** natural-language edits: “captions yellow and bigger, beast style, zoom more, remove filler words, title: I quit my job”.
- Background music with **auto-ducking** under speech, profanity **bleep**, loudness normalisation, click-free splices.
- Formats 9:16 · 1:1 · 4:5 · 16:9, 720p/1080p, 30/60 fps.

**Vyro campaign rules → compliance**
- Imports the real Vyro campaign schema: brief, CPM, budget, platforms, *Content to Use* links, **min video length, required caption, hashtags (≤5), text on screen, logo, FTC disclosure (#ad), required platform sound, subtitles, collab rules**.
- **Content to Use is fetched automatically** — including Frame.io shares (`f.io/…`): files are listed with duration/size/thumbnail, **full-length episodes are clipped first** (pre-cut shorts stay one click away), and 4K / ProRes / multi-GB originals are swapped for Frame.io's 1080p H.264 copy (e.g. 11 GB → 1.3 GB).
- New clips are generated compliant by default (on-screen text, logo, subtitles, length); every clip gets a **checklist**: pass ✓ / fail ✕ / to-do-when-posting ☐ (e.g. add the campaign sound in-app, paid-partnership toggle).
- Brief parsing extracts do's & don'ts, durations, hashtags, @mentions, keywords and focus topics.
- Post captions per platform (TikTok/Instagram/YouTube Shorts title/X) with required caption, hashtags and disclosure — never truncated.

**Export & posting**
- Renders **MP4 (H.264/AAC)** in the browser with WebCodecs + Mediabunny — batch export to a folder, downloads or ZIP.
- Package per clip: `.mp4`, caption `.txt` (with checklist), `.srt`, cover `.jpg`, **EDL** (Premiere/Resolve/Avid) and **FCPXML** (Final Cut/Resolve).
- **Posting plan** that respects Vyro limits (≤5 posts/account/campaign/24h, ≤3 pending before first approval, one post per platform per clip) with `.ics` calendar export and a link to Vyro's submit page.

---

## Quick start

### 1. Docker (recommended)

```bash
docker compose up -d --build        # http://localhost:8080   (PORT=8090 docker compose up -d to change)
```

The compose file mounts this repository read-only at `/repo` and enables **auto-update**: every commit on `main` is pulled, built and deployed automatically (see below). Data (releases, media cache) lives in the `vyroclipper-data` volume.

**Remote host / Portainer:** create a *Git repository* stack from `https://github.com/panhavad/vyro-clipper` with compose path `docker-compose.portainer.yml`. It publishes port `8019` (override with `PORT`), joins the external `tunnel_net` network shared with the Cloudflare tunnel (create it first with `docker network create tunnel_net`, or set `TUNNEL_NETWORK` to another name), and the container watches the GitHub repo itself, so every push to `main` is deployed without redeploying the stack.

### 2. Chrome extension

1. `npm install && npm run build` (or use the auto-exported `build/extension` folder from Docker, download `http://localhost:8080/extension.zip`, or grab `vyroclipper-extension.zip` from the [`extension-latest` release](https://github.com/panhavad/vyro-clipper/releases/tag/extension-latest), which CI rebuilds on every push to `main`).
   > Chrome blocks downloads from plain-HTTP sites other than localhost (*“the file may have been tampered with”*). The zip is safe. When the studio is opened as `http://<server-ip>:8019`, `/extension.zip` shows a page that links to the HTTPS GitHub release instead. To download directly from your server, give it an HTTPS hostname (e.g. a Cloudflare tunnel).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/extension` (or `build/extension`).
3. Open <https://app.vyro.com> and log in. A small ✂ VyroClipper panel appears: **Sync all** imports every campaign; on a campaign page click **✂ Clip this campaign**.
4. The extension popup lists captured campaigns — tick the ones you want and press **Clip selected**. The studio opens (bundled, or your hosted Docker studio if set in the popup ⚙).

> When loaded from `build/extension`, the extension **reloads itself** whenever Docker deploys a new build.

### 3. Using the studio

1. **Campaigns** → select campaigns → **Generate clips for selected** (or open a campaign → *Source videos* → **📂 Browse files** / **✂ Clip this** / drop the video file). *Clip campaign videos* takes up to 4 videos per share, full-length ones first.
2. Processing: download → burned-in caption check → transcription (the speech model downloads once, ~75–420 MB) → viral moments → AI reframe. Progress is persisted; interrupted jobs can be resumed.
3. Review clips sorted by virality score, open the editor to tweak, check **Checks**, then **Export** (single, batch to folder, or ZIP).
4. Post with the generated caption, then submit the live URL on Vyro (the editor links straight to the campaign's submit page).

---

## How the Vyro integration works

app.vyro.com is a React app talking to `https://api.vyro.com` with an in-memory Bearer token. The extension injects a tiny **MAIN-world** script at `document_start` that observes the app's own requests:

- campaign JSON the app loads (`/catalog/campaigns`, `/campaigns`, `/enrollments`) is captured and normalised (`src/core/vyro.ts`);
- the request headers are remembered so **Sync all** can page through `GET /catalog/campaigns?sort=startDate.desc&limit=…&page=…` and `GET /catalog/campaigns/slug/:slug` — **read-only** requests, nothing is ever posted to your account.

Campaign fields used: `name`, `workspace`/`displayOption` (brand), `headlineRate`/`payoutModel.payRate` (CPM), `budget`, `targeting.platforms/languages`, `requirements.{brief, text.{caption,hashtags,textOnScreen,ftcDisclosureHashtags}, logo, audio.links, video.minLength, subtitles.required, collaboration}`, `media.links` (*Content to Use*).

Without the extension you can paste any Vyro API response JSON (*Add campaign → Paste Vyro JSON*) or write a brief manually.

**Content to Use on Frame.io.** Vyro campaigns share footage as Frame.io links. The share's public GraphQL API (`api.frame.io/graphql`, authenticated with the share id) lists the files with signed download URLs, durations and H.264 transcodes, and both the API and the downloads allow cross-origin requests, so the browser downloads straight from Frame.io. Only the `f.io` short-link redirect is not CORS-enabled: the extension follows it itself, and the web studio asks the server (`GET /api/resolve?url=`).

---

## Auto-update on git commit

`server/supervisor.ts` (the container's entrypoint) keeps the app current:

```
git commit ─▶ poll (GIT_POLL_SECONDS) or POST /api/hooks/git ─▶ git fetch/reset ─▶ npm ci (if lockfile changed)
          ─▶ npm run build ─▶ /data/releases/<commit> ─▶ switch current ─▶ restart server ─▶ export extension
```

- **Local repo** (default compose): commits in this folder are deployed within `GIT_POLL_SECONDS` (30 s).
- **Remote repo**: set `GIT_REPO_URL=https://github.com/you/vyroclipper.git` (+ `GIT_BRANCH`). Add a push webhook to `https://your-host/api/hooks/git` with `WEBHOOK_SECRET` for instant deploys (GitHub/Gitea `X-Hub-Signature-256`, GitLab `X-Gitlab-Token`, or `?secret=`).
- A failing build never replaces the live release. The last `KEEP_RELEASES` (3) builds are kept.
- **Clients update too**: the studio polls `build-info.json` and shows *“New version deployed — Reload”* (or reloads automatically when idle, see Settings); the unpacked extension reloads itself when its build changes.
- **CI/CD alternative**: `.github/workflows/ci.yml` type-checks, tests, builds and pushes `ghcr.io/<owner>/<repo>:latest` on every push — pair it with Watchtower if you prefer image-based updates.

### Server environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `AUTO_UPDATE` | `true` | Watch git and redeploy |
| `REPO_DIR` / `GIT_REPO_URL` / `GIT_BRANCH` | `/repo` / – / `main` | What to watch |
| `GIT_POLL_SECONDS` | `60` (compose: 30) | Poll interval |
| `WEBHOOK_SECRET` | – | Enables `POST /api/hooks/git` |
| `API_TOKEN` | – | Protects `/api/proxy` and `/api/media/*` (`x-vyroclipper-token`) |
| `EXTENSION_EXPORT_DIR` | – | Copy each extension build here (compose: `./build/extension`) |
| `EXTENSION_DOWNLOAD_PAGE` | GitHub `extension-latest` release of `GIT_REPO_URL` | HTTPS download page offered when `/extension.zip` is opened over plain HTTP |
| `ALLOW_PRIVATE_NETWORK` | `false` | Allow the proxy to reach private IPs (SSRF guard) |
| `MEDIA_CACHE_MAX_GB` / `MEDIA_CACHE_TTL_HOURS` | `10` / `24` | yt-dlp download cache |

API: `GET /api/health`, `GET /api/version`, `GET /api/proxy?url=` (Range-aware streaming proxy), `GET /api/resolve?url=` (follows redirects, e.g. `f.io` short links → `{url}`), `POST /api/media/jobs {url}` → `GET /api/media/jobs/:id[/file]` (yt-dlp), `POST /api/hooks/git`, `GET /extension.zip`. `/api/proxy`, `/api/resolve` and `/api/media/*` reject private-network targets unless `ALLOW_PRIVATE_NETWORK=true` (including IPv6 spellings of private IPv4 addresses such as `[::ffff:127.0.0.1]`, re-checked on every redirect hop).

---

## Architecture

```
src/core/       pure TypeScript, unit-tested: Vyro normaliser, brief parser, transcript, virality engine,
                captions, timeline (jump cuts), reframe, effects, compliance, hooks/captions, schedule,
                exporters (EDL/FCPXML/SRT), LLM prompts, magic commands
src/engine/     browser media engine: OPFS/IndexedDB storage, fetcher, Mediabunny probe/decode, resampler,
                Whisper worker (Transformers.js), MediaPipe faces, compositor (canvas), MP4 renderer, pipeline
src/studio/     React UI (campaigns, workspace, clip grid, editor, schedule, brand kit, settings)
src/extension/  MV3: MAIN-world Vyro hook, content overlay, background worker, popup, studio bridge
server/         Node HTTP server (no npm deps) + auto-update supervisor
scripts/        extension build, icon generator, build info
tests/unit      Vitest (core, audio DSP, server SSRF guard)   tests/e2e   real-Chrome end-to-end (Playwright)
```

Privacy: campaigns, transcripts and videos stay in the browser (IndexedDB + Origin Private File System). Only model weights are fetched (Hugging Face) and, if you configure them, your own API providers.

---

## Development

```bash
npm install          # Node ≥ 22.18 (TypeScript runs natively)
npm run dev          # studio at http://localhost:5173
npm run build        # dist/web + dist/extension
npm run typecheck && npm test
npm start            # serve dist/web on :8080 (no auto-update)
npm run serve        # supervisor (auto-update) locally, e.g. REPO_DIR=. npm run serve
```

End-to-end tests (real browsers via `playwright-core`; run `npm run build` first):

```bash
node tests/e2e/run.ts         # studio in Chrome: transcribe → clips → editor → export (E2E_VIDEO=path.mp4)
npx playwright-core install chromium
node tests/e2e/extension.ts   # extension in Playwright Chromium (branded Chrome ignores --load-extension)
# Real campaign against a running studio: import a Vyro API JSON → browse Frame.io → clip → export
E2E_CAMPAIGN_JSON=catalog.json E2E_CAMPAIGN="Joy 101" STUDIO_URL=http://127.0.0.1:8080 node tests/e2e/campaign-source.ts
#   options: E2E_FILE="Harry Connick" (pick a file), E2E_PERSISTENT=1 (normal profile), E2E_EXPECT_BURNED_IN=0|1,
#            E2E_EVICT=1 (delete the stored source before export: it must be downloaded again), E2E_TIMEOUT_MIN=55
```

## Notes & limits

- Use the latest **Chrome/Edge** (WebCodecs, WebGPU, OPFS). First transcription downloads the speech model once.
- In-browser Whisper runs at roughly 1.5–3× real time on a typical GPU (a 47-min episode ≈ 30 min). For long sources, cloud speech-to-text (OpenAI/Groq-compatible, *Settings*) is much faster.
- Videos are kept in the browser's private storage. **Incognito windows allow only ~1 GB per site**: big Frame.io sources then fall back to Frame.io's smaller H.264 copies automatically. If the browser ever evicts a stored video (or you clear site data), projects created from a link **download their source again** when you process, preview or export.
- YouTube/TikTok/Instagram/X source links need the Docker server (yt-dlp). Google Drive *folders*, web pages and password-protected Frame.io shares must be downloaded manually and dropped in.
- Burned-in caption detection is heuristic (tuned on real campaign footage); if it guesses wrong, flip **Animated captions** in the editor.
- Platform sounds required by a campaign must be added in the TikTok/Instagram app when posting (the checklist reminds you).
- Respect Vyro's terms and each campaign's brief; VyroClipper only reads campaign data and never submits posts for you.
