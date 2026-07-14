# SiteClone

Desktop app that mirrors any website into a self-contained static HTML/JS folder.
Mac and Windows. Same packaging pattern as `agentfit`.

## Architecture

```
┌─────────────┐         http://127.0.0.1:13751
│ Electron    │ ───┐    (utility process, not a child Electron)
│ main.mjs    │    ├──> Next.js standalone server ──┐
│ (BrowserWin)│    │    │  app/        UI (React)   │
└─────────────┘    │    │  app/api/    REST + SSE   │
                   │    │  lib/cloner/ engine       │
                   │    └───────────────────────────┘
                   └──> ipcMain.handle('siteclone:pickFolder', …)
```

- **Renderer**: Next.js App Router. URL form on `/`, live job page on `/jobs/[id]`.
- **API**: `POST /api/clone`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`,
  `GET /api/jobs/:id/stream` (SSE), `GET /api/defaults`.
- **Engine** (`lib/cloner/engine.ts`): BFS crawler, same-origin only, depth-limited,
  with N parallel workers. Two modes:
  - **Static** (default): `fetch` + cheerio → rewrite HTML/CSS asset refs to local paths.
  - **Dynamic**: playwright-core (Chromium) renders the page, then we rewrite the
    post-JS DOM. Network responses captured during render are also queued as assets.
- **Electron wrapper** (`electron/main.mjs`): boots the standalone server on a free
  port (default 13751, falls back if taken), shows a splash, opens a window pointed
  at it. `app.getPath('userData')` for caches; `~/Documents/SiteClone/<host>` is
  the suggested output dir.

No DB, no Prisma — the cloner is stateless. Job state lives in-memory in the
server process; closing the app discards it.

## Dev

```bash
npm install                  # only required once
npm run dev                  # Next.js dev server on :3000
# OR
npm run electron:dev         # build + open as Electron app
```

For dynamic mode, install Chromium once:

```bash
npx playwright install chromium
```

Or set `PLAYWRIGHT_CHROMIUM_PATH` to an existing Chrome/Edge binary.

## Building installers

```bash
npm run electron:build:mac   # → dist-electron/SiteClone-<v>.dmg (x64 + arm64)
npm run electron:build:win   # → dist-electron/SiteClone Setup <v>.exe
npm run electron:build:all   # both
```

End users do NOT need Node.js or npm — they just download and run the installer.

## Output layout

For `https://example.com` cloned to `~/Documents/SiteClone/example.com/`:

```
example.com/
├── index.html              # rewritten to use ./styles.css, ./about/index.html, …
├── about/
│   └── index.html
├── styles.css              # url(...) refs rewritten to ./fonts/foo.woff2
├── fonts/foo.woff2
├── js/app.js
└── img/hero.png
```

The folder is self-contained — open `index.html` directly in a browser, or serve
with any static host (S3, Netlify, `python -m http.server`, etc).

## Conventions

- TypeScript strict mode. ESM throughout (`"type": "module"`).
- Server-side modules in `lib/cloner/` use Node built-ins (`node:fs`, `node:path`).
- React Server Components for layout/static; Client Components for forms + SSE.
- Don't add Prisma / a database — the cloner has no persistent state by design.
