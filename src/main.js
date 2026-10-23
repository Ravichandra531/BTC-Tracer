const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { runTrace } = require('./tracer');

const isDev = !app.isPackaged && process.env.NODE_ENV === 'development';

function rendererIndex() {
  return path.join(__dirname, '..', 'renderer-dist', 'index.html');
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 1100, minHeight: 680,
    frame: false,
    backgroundColor: '#07090f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const fail = (msg) => {
    console.error(msg);
    if (win && !win.isDestroyed()) win.show();
  };

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    fail(`Failed to load UI (${code}): ${desc} ${url || ''}`);
  });

  if (isDev) {
    win.loadURL('http://localhost:5173').catch(err => fail(err.message));
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const index = rendererIndex();
    if (!fs.existsSync(index) && !index.includes('app.asar')) {
      fail(`UI file missing: ${index}`);
    }
    win.loadFile(index).catch(err => fail(err.message));
  }

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('win-minimize',  () => win?.minimize());
ipcMain.on('win-maximize',  () => win?.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('win-close',     () => win?.close());

ipcMain.handle('trace', async (_evt, payload) => {
  const send = (msg) => {
    if (win && !win.isDestroyed())
      win.webContents.send('trace-progress', msg);
  };
  return runTrace({ ...payload, onProgress: send });
});

ipcMain.handle('open-csv', async () => {
  if (!win || win.isDestroyed()) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Load Labels CSV',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  try { return fs.readFileSync(filePaths[0], 'utf8'); }
  catch { return null; }
});

ipcMain.handle('export-json', async (_, payload) => {
  if (!win || win.isDestroyed()) return false;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Trace Result',
    defaultPath: `btc-trace-${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return true;
});
