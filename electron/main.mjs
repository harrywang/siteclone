import { app, BrowserWindow, shell, dialog, utilityProcess, ipcMain } from 'electron'
import { createServer } from 'net'
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import http from 'http'
import electronUpdaterPkg from 'electron-updater'
const { autoUpdater } = electronUpdaterPkg

const isPacked = app.isPackaged

// In packed app, asarUnpacked content lives at app.asar.unpacked
const SERVER_DIR = isPacked
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'server')
  : path.join(import.meta.dirname, 'server')

const USER_DATA = app.getPath('userData')
const DEFAULT_OUTPUT_ROOT = path.join(app.getPath('documents'), 'SiteClone')
const PREFERRED_PORT = 13751

let serverProcess = null
let mainWindow = null
let activePort = PREFERRED_PORT

function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(startPort, '127.0.0.1', () => {
      server.close(() => resolve(startPort))
    })
    server.on('error', () => resolve(findAvailablePort(startPort + 1)))
  })
}

function log(msg) {
  try {
    console.log(`[SiteClone] ${msg}`)
  } catch {
    // ignore EPIPE — no terminal in packaged app
  }
}

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})

async function startServer() {
  const serverJs = path.join(SERVER_DIR, 'server.js')
  if (!existsSync(serverJs)) {
    throw new Error(`Server not found at ${serverJs}. Run "npm run electron:prepare" first.`)
  }

  // Ensure default output dir exists so the UI default works on first launch.
  try { mkdirSync(DEFAULT_OUTPUT_ROOT, { recursive: true }) } catch { /* ignore */ }

  activePort = await findAvailablePort(PREFERRED_PORT)
  if (activePort !== PREFERRED_PORT) {
    log(`Port ${PREFERRED_PORT} is in use, using ${activePort} instead`)
  }
  log(`Starting server from ${serverJs}`)

  // utilityProcess.fork avoids spawning a second dock icon on macOS.
  serverProcess = utilityProcess.fork(serverJs, [], {
    cwd: SERVER_DIR,
    stdio: 'pipe',
    serviceName: 'siteclone-server',
    env: {
      ...process.env,
      PORT: String(activePort),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      SITECLONE_OUTPUT_ROOT: DEFAULT_OUTPUT_ROOT,
      SITECLONE_USER_DATA: USER_DATA,
    },
  })

  serverProcess.stdout?.on('data', (d) => log(d.toString().trim()))
  serverProcess.stderr?.on('data', (d) => log(d.toString().trim()))
  serverProcess.on('exit', (code) => {
    if (code !== null && code !== 0) log(`Server exited with code ${code}`)
  })

  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      attempts++
      http.get(`http://127.0.0.1:${activePort}`, () => resolve()).on('error', () => {
        if (attempts >= 60) reject(new Error('Server failed to start within 30s'))
        else setTimeout(check, 500)
      })
    }
    setTimeout(check, 1000)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'SiteClone',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.show()
  mainWindow.loadURL(`http://127.0.0.1:${activePort}`)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Folder picker bridged to the renderer via IPC.
ipcMain.handle('siteclone:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Choose output folder',
    defaultPath: DEFAULT_OUTPUT_ROOT,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('siteclone:revealFolder', async (_e, folder) => {
  if (typeof folder === 'string' && existsSync(folder)) {
    shell.openPath(folder)
  }
})

function setupAutoUpdate() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} }

  autoUpdater.on('error', (err) => log(`Updater error: ${err?.message || err}`))
  autoUpdater.on('update-available', (info) => log(`Update available: ${info?.version}`))
  autoUpdater.on('update-not-available', () => log('No update available'))
  autoUpdater.on('update-downloaded', async (info) => {
    log(`Update downloaded: ${info?.version}`)
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `SiteClone ${info?.version} is ready to install.`,
      detail: 'Restart the app to finish updating.',
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log(`Update check failed: ${err?.message || err}`))
  }, 5_000)
}

function showSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
  })
  splash.loadURL(`data:text/html,
    <html>
    <body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;background:rgba(0,0,0,0.85);color:white;border-radius:16px;-webkit-app-region:drag;">
      <div style="text-align:center">
        <h1 style="font-size:26px;margin-bottom:8px">SiteClone</h1>
        <p style="opacity:0.7;font-size:13px">Starting…</p>
      </div>
    </body>
    </html>
  `)
  return splash
}

app.whenReady().then(async () => {
  const splash = showSplash()
  try {
    await startServer()
    splash.close()
    createWindow()
    setupAutoUpdate()
  } catch (err) {
    splash.close()
    log(`Startup error: ${err.message}`)
    dialog.showErrorBox('SiteClone Startup Error', `Failed to start: ${err.message}`)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
  }
  app.quit()
})

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
  }
})

app.on('activate', () => {
  if (mainWindow === null) createWindow()
})
