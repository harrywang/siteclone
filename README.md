# SiteClone

Mirror any website into a self-contained static HTML/JS folder. Desktop app for
Mac and Windows. Same packaging pattern as
[AgentFit](https://github.com/harrywang/agentfit).

## Why

- Take a static snapshot of a site for archive / migration / offline reading
- Convert a small WordPress site to plain static HTML
- Capture a JS-rendered page (SPA, dynamic theme) — Playwright handles those
- Drop the result on any static host (S3, Netlify, GitHub Pages…)

End users get a simple `.dmg` (Mac) or `.exe` (Windows) — no npm, no command
line. The app spawns a local Next.js server and a browser window.

## Install

**As a desktop app** — download the latest installer from
[Releases](https://github.com/harrywang/siteclone/releases) (once published).

**From source**:

```bash
git clone https://github.com/harrywang/siteclone.git
cd siteclone
./setup.sh         # Mac / Linux
# or
setup.bat          # Windows
npm run electron:dev
```

For dynamic mode (JS-rendered sites), install Chromium once:

```bash
npx playwright install chromium
```

## Use

1. Paste a URL (e.g. `https://example.com`)
2. Pick depth (`0` = single page, `2` = page + linked pages + their links)
3. Choose Static (fast) or Dynamic (Chromium, for JS-heavy sites)
4. Click **Start clone** — watch live progress

Output goes to `~/Documents/SiteClone/<host>/` by default. Open `index.html`
directly, or upload the folder to any static host.

## Build installers

```bash
npm run electron:build:mac   # → dist-electron/SiteClone-<v>.dmg (Intel + Apple Silicon)
npm run electron:build:win   # → dist-electron/SiteClone Setup <v>.exe
```

## License

AGPL-3.0
