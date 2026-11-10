const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const imagePattern = /\.(jpe?g)$/i;
// GPS EXIF lives in the JPEG header.  Do not load whole camera originals merely
// to read that metadata: large folder imports otherwise retain every image in
// both the main and renderer processes at once.
const EXIF_READ_LIMIT = 128 * 1024;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1050, minHeight: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

async function scanFolder(root) {
  const output = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && imagePattern.test(entry.name)) output.push({ path: fullPath, name: entry.name, relativePath: path.join(path.basename(root), path.relative(root, fullPath)) });
    }
  }
  await visit(root); return output;
}

ipcMain.handle('flight:pick-folders', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Select survey folders', properties: ['openDirectory', 'multiSelections'] });
  if (canceled) return [];
  return (await Promise.all(filePaths.map(scanFolder))).flat();
});
ipcMain.handle('flight:pick-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Select drone photos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'JPEG images', extensions: ['jpg', 'jpeg'] }] });
  return canceled ? [] : filePaths.map(filePath => ({ path: filePath, name: path.basename(filePath), relativePath: path.basename(filePath) }));
});
ipcMain.handle('flight:read-images', async (_event, images) => {
  if (!Array.isArray(images)) throw new Error('Expected an array of images.');
  const output = [];
  for (const image of images) {
    const handle = await fs.open(image.path, 'r');
    try {
      const { size } = await handle.stat();
      const bytes = Buffer.alloc(Math.min(size, EXIF_READ_LIMIT));
      await handle.read(bytes, 0, bytes.length, 0);
      const preview = nativeImage.createFromPath(image.path);
      const thumbnail = preview.isEmpty() ? null : preview.resize({ width: 240, height: 160, quality: 'good' }).toJPEG(75);
      output.push({ ...image, bytes, thumbnail });
    } finally {
      await handle.close();
    }
  }
  return output;
});
ipcMain.handle('flight:choose-output', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Choose folder for copied images', buttonLabel: 'Copy here', properties: ['openDirectory', 'createDirectory'] });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('flight:copy-images', async (_event, { outputFolder, images }) => {
  let copied = 0;
  const root = path.resolve(outputFolder);
  for (const image of images) {
    if (!image.sourcePath) continue;
    const relative = (image.relativePath || image.name).replace(/[\\/]+/g, path.sep);
    let target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Invalid output path.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const extension = path.extname(target), base = target.slice(0, -extension.length);
    for (let number = 2; ; number++) { try { await fs.access(target); target = `${base} (${number})${extension}`; } catch { break; } }
    await fs.copyFile(image.sourcePath, target); copied++;
  }
  return { copied };
});
