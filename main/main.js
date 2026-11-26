'use strict';
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, net, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createCore } = require('./registry');
const { createAltTabHook } = require('./windows/alt-tab');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const NM = path.join(ROOT, 'node_modules');
const ORIGIN = 'app://phantom';
const DEV = process.argv.includes('--dev');

// Static mounts served over the privileged app:// scheme. Nothing outside these roots is reachable.
const MOUNTS = [
  ['/vendor/monaco/', path.join(NM, 'monaco-editor', 'min')],
  ['/vendor/xterm/', path.join(NM, '@xterm', 'xterm')],
  ['/vendor/xterm-fit/', path.join(NM, '@xterm', 'addon-fit')],
  ['/vendor/xterm-search/', path.join(NM, '@xterm', 'addon-search')],
  ['/vendor/xterm-links/', path.join(NM, '@xterm', 'addon-web-links')],
  ['/vendor/marked/', path.join(NM, 'marked')],
  ['/vendor/dompurify/', path.join(NM, 'dompurify')],
  ['/', RENDERER]
];

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
]);

app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let core = null;
const altTabHook = createAltTabHook({
  onCycle: (direction) => core && core.emit('app:cycleWindows', direction),
  onExit: () => leaveHardFullscreen(),
  onFailure: (error) => {
    if (core) {
      core.log('error', `Hard fullscreen keyboard hook failed: ${error.message}`, 'WINDOW');
      core.emit('app:kioskError', error.message);
    }
    leaveHardFullscreen();
  }
});

function leaveHardFullscreen() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setKiosk(false);
    mainWindow.setFullScreen(false);
  }
  altTabHook.stop();
}

async function toggleFullscreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (process.platform !== 'win32') {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return true;
  }
  if (mainWindow.isKiosk()) {
    leaveHardFullscreen();
    return false;
  }
  await altTabHook.start();
  if (!altTabHook.isRunning()) throw new Error('The Windows keyboard hook stopped before hard fullscreen could start.');
  try {
    mainWindow.setKiosk(true);
    mainWindow.setFullScreen(true);
  } catch (error) {
    leaveHardFullscreen();
    throw error;
  }
  return true;
}

function resolveAsset(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  for (const [prefix, dir] of MOUNTS) {
    if (!clean.startsWith(prefix)) continue;
    const rel = clean.slice(prefix.length) || 'index.html';
    const full = path.normalize(path.join(dir, rel));
    if (full !== dir && !full.startsWith(dir + path.sep)) return null; // traversal attempt
    return full;
  }
  return null;
}

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const u = new URL(req.url);
    if (u.host !== 'phantom') return new Response('not found', { status: 404 });
    const file = resolveAsset(u.pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600, height: 960, minWidth: 900, minHeight: 560,
    backgroundColor: '#050807',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: true
    }
  });
  mainWindow.once('ready-to-show', () => { mainWindow.show(); if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' }); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  mainWindow.on('maximize', () => core && core.emit('app:windowState', { maximized: true }));
  mainWindow.on('unmaximize', () => core && core.emit('app:windowState', { maximized: false }));
  mainWindow.on('closed', () => {
    altTabHook.stop();
    mainWindow = null;
  });
  mainWindow.loadURL(ORIGIN + '/index.html');
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read'));
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!details.url.startsWith(ORIGIN)) return cb({ responseHeaders: details.responseHeaders });
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
          "font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"
        ]
      }
    });
  });
}

app.whenReady().then(() => {
  // PHANTOM owns all keybindings (Ctrl+W, Ctrl+R… are editor/WM shortcuts). macOS keeps a minimal
  // menu so system clipboard shortcuts and Cmd+Q keep working.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  registerProtocol();
  hardenSession();

  core = createCore({
    dataDir: app.getPath('userData'),
    emit: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
    platformHooks: {
      trash: (p) => shell.trashItem(p),
      reveal: (p) => shell.showItemInFolder(p),
      openExternal: (url) => shell.openExternal(url),
      openPath: (p) => shell.openPath(p),
      pickFolder: async (title) => {
        const r = await dialog.showOpenDialog(mainWindow, { title: title || 'Open folder', properties: ['openDirectory', 'createDirectory'] });
        return r.canceled ? null : r.filePaths[0];
      },
      pickFile: async (title, filters) => {
        const r = await dialog.showOpenDialog(mainWindow, { title: title || 'Open file', properties: ['openFile'], filters });
        return r.canceled ? null : r.filePaths[0];
      },
      saveFile: async (title, defaultPath) => {
        const r = await dialog.showSaveDialog(mainWindow, { title, defaultPath });
        return r.canceled ? null : r.filePath;
      },
      window: {
        minimize: () => mainWindow.minimize(),
        toggleMaximize: () => (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()),
        close: () => mainWindow.close(),
        devtools: () => mainWindow.webContents.toggleDevTools(),
        fullscreen: () => toggleFullscreen(),
        isMaximized: () => mainWindow.isMaximized()
      },
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }
    }
  });

  for (const [channel, fn] of core.handlers) {
    ipcMain.handle(channel, async (event, ...args) => {
      // Only our own top-level page may call the backend.
      const url = event.senderFrame && event.senderFrame.url;
      if (!url || !url.startsWith(ORIGIN + '/')) return { __err: 'forbidden origin' };
      try { return { __ok: true, v: await fn(...args) }; }
      catch (err) { return { __err: (err && err.message) || String(err) }; }
    });
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.on('web-contents-created', (_e, wc) => { wc.on('will-attach-webview', (ev) => ev.preventDefault()); });

let quitting = false;
app.on('before-quit', async (e) => {
  if (quitting || !core) return;
  e.preventDefault();
  quitting = true;
  altTabHook.stop();
  await core.shutdown();
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
