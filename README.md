**English** | [简体中文](README.zh-CN.md)

# Sakura Music Desktop

The desktop client for Sakura Music — Windows / macOS / Linux.

Built with Electron + Vue 3 + TypeScript + Vite + Pinia. This is a **standalone repo** separate from the web client; both communicate with the same backend gateway over HTTP. The UI is designed ground-up for desktop and does not reuse web components.

## Current Status

Milestones **M0–M5 are implemented**; M6 (polish and release) is in progress.

**Foundations**
- Three-process Electron architecture: main process + preload + renderer
- Local BFF (bound to `127.0.0.1` only): `/api` reverse proxy, SSE passthrough, media streaming with HTTP Range. The page itself is served from the `sakura://app` custom scheme in both dev and release
- Session cookies and "local-only" platform credentials are encrypted at rest via `safeStorage` and kept in the local SQLite database — the renderer never sees credentials
- First-run server configuration, self-signed certificate detection, and SHA-256 fingerprint display
- Login / register / logout, session persistence, automatic redirect to login on 401
- Frameless custom title bar with drag region and window controls; the login and server-setup pages use the same bar
- Desktop three-pane shell: sidebar, right-side player / queue / lyrics panels, bottom player bar
- Six color themes × light / dark / follow-system, sakura petals background, global toast system

**Browse & Playback**
- Home discovery, unified search, quality picker with per-quality file sizes
- Queue, shuffle, repeat, previous / next, media session / SMTC integration
- Full-screen lyrics with clickable artist and album links, shown as an in-app overlay by default or in a **separate full-screen player window**; a compact **desktop lyric bar** (borderless, always-on-top, transparent) is also available and can be locked (click-through) with its position remembered across launches
- Room / follow tracks are enriched on demand while playing: artist and album IDs, available qualities and their sizes

**Now Playing styles**
Five full-screen layouts, switchable from the player bar's style menu and lazy-loaded on first use:
- **经典 (Classic)** — cover and lyrics side by side, colors follow the active theme
- **沉浸 (Immersive)** — oversized centered lyrics over a real-time WebGL2 fluid field and spectrum
- **雾笺 (Nebbia)** — rain running down a window; lyrics are written onto the glass stroke by stroke
- **绘光 (Lumiere)** — stage spotlights and light beams sweeping the lyrics (PixiJS)
- **町景 (Machi)** — a 3D night street (convenience store / gas station / Kowloon bar) with lyrics painted on in-scene screens (three.js), plus a camera / focus / depth-of-field control bar

All five share one shell for expand / collapse and cross-fade. Everything is rendered locally; no audio or lyric data leaves the machine.

The five full-screen layouts can also be opened in a **standalone player window** (`?window=nowplaying`) — at most one at a time, frameless on Windows and hidden-inset on macOS; it shares playback state with the main window and is mutually exclusive with the in-app overlay.

**Library & Offline**
- Favorites, play history, local playlists, offline playback of downloaded tracks
- User-initiated downloads are written to a local library with a per-track index (key, platform, requested and actual quality, size). Files are fetched over the same path as playback — a CDN direct link with anti-leech headers, falling back to the gateway stream — and written to a `.part` file first, then renamed only on success, so an interrupted download never leaves a half-indexed file. The real audio container is sniffed from the file header, so lossless streams mislabeled `application/octet-stream` land as `.flac` rather than `.bin`. Downloaded tracks stream back to the player from the local BFF (`/offline/stream/<key>`).
- User-initiated downloads have **no storage cap**; only automatically cached audio and cover art are LRU-bounded

**Listen Together & Devices**
- Server-authoritative playback in rooms: the local player is mirrored back every 250 ms, so transport actions are reported to the server instead of being applied locally
- Multi-device presence rides a single SSE connection. State is broadcast sparsely (only on play / pause / track / queue / mode / volume / follow changes, plus a drift-correcting resync) and progress is inferred from a server-clock offset, so there is no periodic resync traffic. Remote control of another device covers play / pause / next / previous / seek / volume / mode, queue operations (jump, remove, append) and **take-over** (the target hands its queue and position back). **Follow** mirrors another device's playback; follow chains resolve to the source so mirrors don't stack, and a 15 s grace period tolerates momentary reconnects without breaking sync.
- Personal radio is mutually exclusive with Listen Together **only on the device holding the room seat**: a spectator device (another device on the same account is playing) can still start and continue its own radio; creating / joining / taking the seat back still requires leaving the radio first

**Interaction conventions**
- All browsing lists share one track row implementation: a three-dot button or right-click opens the same menu, with "Add to playlist" kept in a submenu
- Sidebar playlists support right-click / three-dot as well (open, edit info, delete with confirmation)
- Errors — including login / register and server-setup failures — go through the global toast instead of inline boxes

## Windows Taskbar Preview

Windows only. Hovering the taskbar icon shows a self-drawn 320×200 card (cover, title, artist) and a thumbnail toolbar with previous / play-pause / next buttons.

- The main process uses `koffi` FFI to call DWM (`DwmSetWindowAttribute`, `DwmSetIconicThumbnail`) and `ITaskbarList3::ThumbBarAddButtons` / `ThumbBarUpdateButtons`. `WM_COMMAND` arrives through `BrowserWindow.hookWindowMessage`, so Chromium's own window procedure is left intact.
- The renderer paints the card on a canvas, converts pixels to bottom-up premultiplied BGRA, and pushes them over IPC; the main process scales them into a 32 bpp DIB section sized to DWM's request.
- Button commands go through the same `useTransport` layer as the in-app controls — including in Listen Together rooms, where the server is authoritative, so a taskbar click never gets reverted by the room mirror.
- Toggle in `Settings → Taskbar Preview` and in the tray menu (Windows only); enabled by default.
- Verifying requires a real Windows session: DWM only sends `WM_DWMSENDICONICTHUMBNAIL` while the thumbnail is actually visible.
- macOS / Linux keep the system title bar and have no thumbnail toolbar; this feature is skipped entirely.

## Local Data & Storage

All main-process state lives in a single SQLite database, `sakura.db`, under Electron's `userData` directory. It uses Electron's built-in `node:sqlite` (WAL mode) — no native modules, rebuilds or `asarUnpack` needed — and on POSIX the file is created with `0600` permissions. Renderer UI preferences still use `localStorage`.

| Table | Contents |
| --- | --- |
| `kv` | Desktop config (server URL, cache limits, device id, window bounds / position / maximized state), session token, and "local-only" platform credentials. Credential values are still encrypted with `safeStorage`. |
| `offline_items` | Download index: platform / track ids, quality, size and the relative filename. |
| `response_cache` | Lyric and detail JSON responses with TTLs, kept for offline fallback. |
| `media_cache` | Audio / cover metadata only: total length, MIME type, bytes and last-accessed time. |

**Media files are never stored in the database.** Audio prefixes, cover images and downloaded tracks remain on disk (`sakura-cache/audio/*.audio`, `sakura-cache/cover/*.img`, and the chosen download folder) and are still served by the local BFF over HTTP Range. Cache size reporting and LRU eviction run on SQL instead of scanning directories; downloads still write a `.part` file first and are renamed only on success.

The app has not been released, so there is no import or cleanup for pre-release JSON files. To reset to a clean state, delete `sakura.db` (or the whole `userData` directory).

## Tech Stack

- **Shell**: Electron 38 (main + preload + renderer), electron-vite, electron-builder
- **UI**: Vue 3.5 (`<script setup>`), Pinia, Vue Router, TypeScript
- **Graphics**: hand-written WebGL2 shaders (沉浸 / 雾笺), PixiJS v8 (绘光), three.js (町景)
- **Native**: koffi FFI for Windows DWM / taskbar thumbnails; `safeStorage` for encrypted sessions
- **Storage**: SQLite via Electron's built-in `node:sqlite` (WAL); media files stay on disk
- **Quality**: `vue-tsc` + `tsc` type checks, CDP smoke scripts under `scripts/`

## Development

```bash
npm install
npm run dev
```

In dev mode:

- The page is loaded from `sakura://app` in both dev and release — same origin, same CSP, stable `localStorage`
- In dev, the main-process protocol handler forwards static requests to Vite at `http://localhost:5173` (HMR still works) and API / media / SSE requests to the in-process BFF at `http://127.0.0.1:3210`
- The renderer never talks to Vite or the BFF directly; neither port is visible to the page

## Build

```bash
npm run typecheck   # runs both typecheck:node (tsc) and typecheck:web (vue-tsc)
npm run build
npm start            # preview the built output
npm run pack         # generate an unpacked directory for the current platform
npm run dist         # generate installers for the current platform
```

Packaging config lives in `electron-builder.yml`; artifacts land in `release/`.

App icons are derived from the Android client (`client-android`): `build/icon-source.png` is the foreground layer of the adaptive icon. Regenerate `build/icon.png` after changes:

```bash
python scripts/make-icon.py     # requires Pillow and NumPy
```

## Security Design

- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- BFF binds to loopback only and rejects every request without a per-launch random token, injected by the main-process `sakura://app` handler into the internal `x-sakura-bff` header. The token never reaches the page, so other local processes cannot call `/api` even if they discover the port
- Session cookies are encrypted with `safeStorage` and stored in the main-process SQLite database; `Set-Cookie` headers are never forwarded to the renderer
- CSP lives in `index.html` as a meta tag (the same file in dev and release): scripts restricted to same-origin, audio restricted to same-origin + blob
- Self-signed certs are enabled explicitly per server; TLS verification is never disabled globally
- "Local-only" third-party platform credentials are encrypted at rest in the same database and injected by the main process per request — the renderer never sees the raw cookie

## Smoke Tests

Helper scripts live under `scripts/`:

```bash
# Minimal gateway stub (login / session / health check)
node scripts/mock-gateway.mjs

# Launch Electron with remote debugging enabled
node_modules/electron/dist/electron.exe --remote-debugging-port=9222 .

# Read page state and capture a screenshot
node scripts/cdp-smoke.mjs smoke.png

# Server setup → login → home → theme → logout flow
node scripts/cdp-flow.mjs
```

`cdp-flow.mjs` assumes the app starts at the server-setup screen. To reset to a clean state, delete `sakura.db` from the app's `userData` directory (`%APPDATA%\Sakura Music\` on Windows; the corresponding `app.getPath('userData')` directory on macOS / Linux). Media caches under `sakura-cache/` and downloaded tracks are files outside the database and can be removed separately.

## Known Limitations

- The taskbar thumbnail preview is Windows-only (Win10 / Win11) and depends on DWM
- No auto-update — users manually install new releases
- Not code-signed: Windows SmartScreen will warn, macOS requires right-click → Open
- "Local-only" platform credentials are stored on this device only and are not synced across devices
- Gateway protocol specs are maintained in the gateway repository; this repo contains only the client implementation
- M6 polish and release work is still in progress

## Project Layout

```
src/
  main/        Main process: BFF, config, session, IPC, offline download + desktop lyric / now-playing windows
    db/        Local SQLite: kv (config / credentials), offline index, response + media cache metadata
    windows/   Window creation, rounded corners, Windows taskbar thumbnail preview
  preload/     Minimal desktop capabilities exposed via contextBridge
  renderer/    Vue 3 desktop UI
    components/nowPlaying/
               Full-screen player styles (nowPlaying/modes, machi, nebbia, lumiere, pixi)
  shared/      Types and constants shared between main and renderer
scripts/       Dev-time smoke-test helpers
build/         Icons and other packaging resources
```

## Open Source & Acknowledgements

This client is assembled from a lot of excellent open-source work. Thanks to the maintainers and contributors of:

**Runtime & tooling**
- [Electron](https://www.electronjs.org/) — desktop shell (MIT)
- [Vue.js](https://vuejs.org/) and [Vue Router](https://router.vuejs.org/) — renderer framework (MIT)
- [Pinia](https://pinia.vuejs.org/) — state stores (MIT)
- [Vite](https://vitejs.dev/) and [electron-vite](https://electron-vite.org/) — dev server and build pipeline (MIT)
- [TypeScript](https://www.typescriptlang.org/) — type system (Apache-2.0)
- [electron-builder](https://www.electron.build/) — packaging and installers (MIT)

**Graphics**
- [PixiJS](https://pixijs.com/) — 绘光 (Lumiere) rendering (MIT)
- [three.js](https://threejs.org/) — 町景 (Machi) street scenes (MIT)
- [@chenglou/pretext](https://github.com/chenglou/pretext) — text layout used by 绘光 (MIT)

**Native**
- [koffi](https://koffi.dev/) — FFI used for Windows DWM and taskbar thumbnail APIs (MIT)

**Data**
- [AnimCJK](https://github.com/animCJK) — stroke outlines used by 雾笺 (Nebbia) for stroke-order handwriting. The graphics data derive from the Arphic PL KaitiM fonts and are distributed under the **Arphic Public License**. The license texts ship with the stroke data at [`nebbia/licenses/nebbia-strokes/`](src/renderer/src/components/nowPlaying/nebbia/licenses/nebbia-strokes).

**Visualizer styles**
The 雾笺 (Nebbia), 绘光 (Lumiere) and 町景 (Machi) visualizers are ported from the **[Folia](https://github.com/chthollyphile/folia-major)** desktop music visualizer project (`folia-major`). Many thanks to its author for the WebGL2 / PixiJS / three.js engines, the scene design, and the thoughtful details in each scene. The ports keep the rendering code faithful; only the React shell was rewritten for Vue.

## License

MIT
