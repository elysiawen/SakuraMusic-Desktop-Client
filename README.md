# Sakura Music Desktop

The desktop client for Sakura Music — Windows / macOS / Linux.

Built with Electron + Vue 3 + TypeScript + Vite + Pinia. This is a **standalone repo** separate from the web client; both communicate with the same backend gateway over HTTP. The UI is designed ground-up for desktop and does not reuse web components.

## Current Status

**M0 · Foundations & Login** is complete:

- Three-process Electron architecture: main process + preload + renderer
- Local BFF (bound to `127.0.0.1` only): `/api` reverse proxy, SSE passthrough, static hosting
- Session cookies encrypted at rest via `safeStorage` in the main process — the renderer never sees credentials
- First-run server configuration, self-signed certificate detection, and SHA-256 fingerprint display
- Login / register / logout, session persistence, automatic redirect to login on 401
- Desktop three-pane shell: custom title bar, sidebar, right-side player / queue / lyrics panels, bottom player bar
- Six color themes × light / dark / follow-system, sakura petals background, global toast system

Upcoming milestones: M1 Browse & Playback, M2 Bindings & Library, M3 Download & Cache, M4 Multi-Device (done), M5 Listen Together (done, two-party rooms), M6 Polish & Release.

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
npm run typecheck
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

- Audio playback, search, and library features are not yet wired up (M1/M2)
- No auto-update — users manually install new releases
- Not code-signed: Windows SmartScreen will warn, macOS requires right-click → Open
- "Local-only" credential mode is intentionally not supported (product decision)
- Gateway protocol details live in three spec documents under `docs/` (not yet copied into this repo)

## Project Layout

```
src/
  main/        Main process: BFF, config, session, windows, IPC
  preload/     Minimal desktop capabilities exposed via contextBridge
  renderer/    Vue 3 desktop UI
  shared/      Types and constants shared between main and renderer
scripts/       Dev-time smoke-test helpers
build/         Icons and other packaging resources
```

## License

MIT
