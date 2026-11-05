# Sakura Music Desktop

The desktop client for Sakura Music — Windows / macOS / Linux.

Built with Electron + Vue 3 + TypeScript + Vite + Pinia. This is a **standalone repo** separate from the web client; both communicate with the same backend gateway over HTTP. The UI is designed ground-up for desktop and does not reuse web components.

## Current Status

Milestones **M0–M5 are implemented**; M6 (polish and release) is in progress.

**Foundations**
- Three-process Electron architecture: main process + preload + renderer
- Local BFF (bound to `127.0.0.1` only): `/api` reverse proxy, SSE passthrough, static hosting
- Session cookies encrypted at rest via `safeStorage` in the main process — the renderer never sees credentials
- First-run server configuration, self-signed certificate detection, and SHA-256 fingerprint display
- Login / register / logout, session persistence, automatic redirect to login on 401
- Frameless custom title bar with drag region and window controls; the login and server-setup pages use the same bar
- Desktop three-pane shell: sidebar, right-side player / queue / lyrics panels, bottom player bar
- Six color themes × light / dark / follow-system, sakura petals background, global toast system

**Browse & Playback**
- Home discovery, unified search, quality picker with per-quality file sizes
- Queue, shuffle, repeat, previous / next, media session / SMTC integration
- Full-screen lyrics with clickable artist and album links, plus a separate desktop lyric window
- Room / follow tracks are enriched on demand while playing: artist and album IDs, available qualities and their sizes

**Library & Offline**
- Favorites, play history, local playlists, offline playback of downloaded tracks
- User-initiated downloads have **no storage cap**; only automatically cached audio and cover art are LRU-bounded

**Listen Together & Devices**
- Server-authoritative playback in rooms: the local player is mirrored back every 250 ms, so transport actions are reported to the server instead of being applied locally
- Multi-device follow / remote control

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

## Development

```bash
npm install
npm run dev
```

In dev mode:

- Renderer: Vite at `http://localhost:5173`
- Main process BFF: `http://127.0.0.1:3210`
- Vite proxies `/api` to the BFF; the renderer uses only relative paths

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
- BFF binds to loopback only; in production, the initial page load requires a one-time `?k=<secret>` query param, which the server uses to issue an HttpOnly local-access cookie — preventing other local processes from calling `/api` directly
- Session cookies are encrypted and stored in the main process; `Set-Cookie` headers are never forwarded to the renderer
- Production static responses ship with CSP: scripts restricted to same-origin, audio restricted to same-origin + blob
- Self-signed certs are enabled explicitly per server; TLS verification is never disabled globally
- Third-party platform credentials are never stored locally — only server-side stored credentials are used (product decision)

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

`cdp-flow.mjs` assumes the app starts at the server-setup screen. To reset to a clean state, delete `%APPDATA%\Sakura Music\config.json` and `session.bin` (on macOS / Linux, the corresponding `app.getPath('userData')` directory).

## Known Limitations

- The taskbar thumbnail preview is Windows-only (Win10 / Win11) and depends on DWM
- No auto-update — users manually install new releases
- Not code-signed: Windows SmartScreen will warn, macOS requires right-click → Open
- "Local-only" credential mode is intentionally not supported (product decision)
- Gateway protocol specs are maintained in the gateway repository; this repo contains only the client implementation
- M6 polish and release work is still in progress

## Project Layout

```
src/
  main/        Main process: BFF, config, session, IPC
    windows/   Window creation, rounded corners, Windows taskbar thumbnail preview
  preload/     Minimal desktop capabilities exposed via contextBridge
  renderer/    Vue 3 desktop UI
  shared/      Types and constants shared between main and renderer
scripts/       Dev-time smoke-test helpers
build/         Icons and other packaging resources
```

## License

MIT
