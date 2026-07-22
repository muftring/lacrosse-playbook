const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('save-playbook', async (event, data) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Playbook',
    defaultPath: 'playbook.lax',
    filters: [{ name: 'Lacrosse Playbook', extensions: ['lax'] }]
  });
  if (canceled || !filePath) return { success: false };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { success: true, filePath };
});

ipcMain.handle('load-playbook', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Playbook',
    filters: [{ name: 'Lacrosse Playbook', extensions: ['lax'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return { success: false };
  const data = fs.readFileSync(filePaths[0], 'utf8');
  return { success: true, data: JSON.parse(data) };
});

ipcMain.handle('export-pdf', async (event, { pdfDataUrl, playName }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Play as PDF',
    defaultPath: `${playName || 'play'}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { success: false };
  const base64 = pdfDataUrl.replace(/^data:application\/pdf;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { success: true, filePath };
});
