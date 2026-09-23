'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BilibiliLiveClient } = require('./lib/bilibili-client.cjs');
const { ArchiveStore } = require('./lib/archive-store.cjs');

let mainWindow;
let backstageWindow;
let backstageState = { currentTrackId: '', tracks: [] };
let liveClient;
let archiveStore;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function encryptSecret(value) {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存 access_secret，请检查 Windows 凭据服务');
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decryptSecret(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

async function readStoredConfig(includeSecret = false) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    const secret = decryptSecret(raw.accessSecretEncrypted);
    const result = {
      appId: raw.appId || '',
      accessKey: raw.accessKey || '',
      hasSecret: Boolean(secret),
    };
    if (includeSecret) result.accessSecret = secret;
    return result;
  } catch {
    return { appId: '', accessKey: '', accessSecret: '', hasSecret: false };
  }
}

async function writeStoredConfig(input) {
  const previous = await readStoredConfig(true);
  const secret = String(input.accessSecret || '').trim() || previous.accessSecret;
  const config = {
    appId: String(input.appId || '').trim(),
    accessKey: String(input.accessKey || '').trim(),
    accessSecretEncrypted: encryptSecret(secret),
  };
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
  return {
    appId: config.appId,
    accessKey: config.accessKey,
    hasSecret: Boolean(secret),
  };
}

async function inspectMediaFiles(filePaths) {
  const { parseFile } = await import('music-metadata');
  const inspected = [];
  for (const filePath of filePaths) {
    try {
      const extension = path.extname(filePath).toLowerCase();
      const type = ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi'].includes(extension)
        ? 'video'
        : 'audio';
      let metadata = {};
      let coverDataUrl = '';
      try {
        metadata = await parseFile(filePath, { duration: true, skipPostHeaders: true });
        const picture = metadata.common?.picture?.[0];
        if (picture?.data?.length) {
          coverDataUrl = `data:${picture.format || 'image/jpeg'};base64,${Buffer.from(picture.data).toString('base64')}`;
        }
      } catch {
        // Video containers and uncommon codecs may not expose tags; playback can still work.
      }
      inspected.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        path: filePath,
        url: pathToFileURL(filePath).href,
        type,
        title: metadata.common?.title || path.basename(filePath, extension),
        artist: metadata.common?.artist || '',
        submitter: metadata.common?.artist || '',
        album: metadata.common?.album || '',
        duration: Number(metadata.format?.duration || 0),
        coverDataUrl,
        description: '',
        descriptionVisible: false,
      });
    } catch (error) {
      inspected.push({ path: filePath, error: error.message });
    }
  }
  return inspected;
}

function openBackstageWindow() {
  if (backstageWindow && !backstageWindow.isDestroyed()) {
    backstageWindow.show();
    backstageWindow.focus();
    return;
  }
  backstageWindow = new BrowserWindow({
    width: 460,
    height: 550,
    minWidth: 380,
    minHeight: 440,
    title: 'lets-listen · 简介后台',
    backgroundColor: '#0c0e13',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'backstage-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  backstageWindow.on('closed', () => { backstageWindow = null; });
  backstageWindow.webContents.once('did-finish-load', () => {
    backstageWindow?.webContents.send('backstage:state', backstageState);
  });
  backstageWindow.loadFile(path.join(__dirname, 'renderer', 'backstage.html'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#090b10',
    title: '品味大战',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[renderer] load failed ${code}: ${description}`);
  });
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (typeof details === 'object') {
      console.log(`[renderer:${details.level}] ${details.message}`);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (backstageWindow && !backstageWindow.isDestroyed()) backstageWindow.close();
  });
  const screenshotArg = process.argv.find((argument) => argument.startsWith('--qa-screenshot='));
  const qaDemo = process.argv.includes('--qa-demo');
  const qaProgram = process.argv.includes('--qa-program');
  const qaVideo = process.argv.includes('--qa-video');
  const qaExit = process.argv.includes('--qa-exit');
  const qaDescription = process.argv.includes('--qa-description');
  mainWindow.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    qaDemo || qaProgram || qaVideo ? { query: { qa: qaDemo ? '1' : '0', program: qaProgram ? '1' : '0', video: qaVideo ? '1' : '0' } } : undefined,
  );
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (screenshotArg) {
    const screenshotPath = screenshotArg.slice('--qa-screenshot='.length);
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          mainWindow.show();
          const image = await mainWindow.webContents.capturePage();
          const png = image.toPNG();
          if (!png.length) throw new Error('capturePage returned an empty image');
          await fs.writeFile(screenshotPath, png);
          console.log(`[qa] screenshot saved: ${screenshotPath}`);
          app.quit();
        } catch (error) {
          console.error(`[qa] screenshot failed: ${error.message}`);
          app.exit(1);
        }
      }, qaDemo ? 1800 : 1200);
    });
  } else if (qaDescription) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          openBackstageWindow();
          await new Promise((resolve) => backstageWindow.webContents.once('did-finish-load', resolve));
          await backstageWindow.webContents.executeJavaScript(`(() => {
            const input = document.getElementById('descriptionInput');
            input.value = '后台实时修改的歌曲简介';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('saveButton').click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          const shown = await mainWindow.webContents.executeJavaScript(`({
            label: document.querySelector('.track-pill')?.textContent.trim(),
            text: document.getElementById('trackDescriptionText')?.textContent,
            hidden: document.getElementById('trackDescriptionCard')?.hidden
          })`);
          if (!shown.label?.startsWith('TRACK') || shown.text !== '后台实时修改的歌曲简介' || shown.hidden) {
            throw new Error(`简介未同步到节目画面: ${JSON.stringify(shown)}`);
          }
          if (!qaProgram) {
            mainWindow.setSize(1120, 720);
            await new Promise((resolve) => setTimeout(resolve, 250));
            const layout = await mainWindow.webContents.executeJavaScript(`(() => {
              const zone = document.querySelector('.track-zone').getBoundingClientRect();
              const title = document.querySelector('.now-playing').getBoundingClientRect();
              const card = document.getElementById('trackDescriptionCard').getBoundingClientRect();
              return { zoneBottom: zone.bottom, titleBottom: title.bottom, cardTop: card.top, cardBottom: card.bottom };
            })()`);
            if (layout.cardTop < layout.titleBottom - 1 || layout.cardBottom > layout.zoneBottom + 1) {
              throw new Error(`最小窗口下简介布局溢出: ${JSON.stringify(layout)}`);
            }
          }
          await backstageWindow.webContents.executeJavaScript(`(() => {
            const toggle = document.getElementById('visibleInput');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          const hidden = await mainWindow.webContents.executeJavaScript(
            `document.getElementById('trackDescriptionCard').hidden`,
          );
          if (!hidden) throw new Error('后台关闭简介后节目画面仍在展示');
          console.log('[qa] backstage description edit and visibility passed');
          app.quit();
        } catch (error) {
          console.error(`[qa] backstage description failed: ${error.message}`);
          app.exit(1);
        }
      }, qaDemo ? 1800 : 1200);
    });
  } else if (qaExit) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        console.log('[qa] packaged renderer loaded successfully');
        app.quit();
      }, 1200);
    });
  }
}

function attachLiveClient(client) {
  client.on('state', (payload) => sendToRenderer('live:state', payload));
  client.on('message', (payload) => sendToRenderer('live:message', payload));
  client.on('diagnostic', (payload) => sendToRenderer('live:diagnostic', payload));
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataPath: app.getPath('userData') }));
  ipcMain.handle('backstage:open', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('仅节目窗口可打开简介后台');
    openBackstageWindow();
    return { ok: true };
  });
  ipcMain.handle('backstage:get-state', (event) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权读取后台状态');
    return backstageState;
  });
  ipcMain.handle('backstage:publish-state', (event, snapshot) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权发布后台状态');
    backstageState = {
      currentTrackId: String(snapshot?.currentTrackId || ''),
      tracks: (Array.isArray(snapshot?.tracks) ? snapshot.tracks : []).slice(0, 500).map((track) => ({
        id: String(track.id || ''),
        number: String(track.number || ''),
        title: String(track.title || ''),
        type: track.type === 'video' ? 'video' : 'audio',
        description: String(track.description || '').slice(0, 500),
        descriptionVisible: Boolean(track.descriptionVisible),
      })),
    };
    if (backstageWindow && !backstageWindow.isDestroyed()) {
      backstageWindow.webContents.send('backstage:state', backstageState);
    }
    return { ok: true };
  });
  ipcMain.handle('backstage:update-track', (event, update) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权修改曲目');
    const id = String(update?.id || '');
    if (!backstageState.tracks.some((track) => track.id === id)) throw new Error('曲目已不存在');
    const patch = { id };
    if (typeof update.description === 'string') patch.description = update.description.trim().slice(0, 500);
    if (typeof update.descriptionVisible === 'boolean') patch.descriptionVisible = update.descriptionVisible;
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('节目窗口已关闭');
    mainWindow.webContents.send('backstage:update-track', patch);
    return { ok: true };
  });

  ipcMain.handle('media:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入音频或视频',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体文件', extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'mp4', 'webm', 'mkv', 'mov', 'm4v'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return inspectMediaFiles(result.filePaths);
  });

  ipcMain.handle('media:inspect', (_event, paths) => inspectMediaFiles(paths));
  ipcMain.handle('media:select-cover', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择曲目封面',
      properties: ['openFile'],
      filters: [{ name: '封面图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const extension = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    };
    const data = await fs.readFile(filePath);
    return {
      path: filePath,
      dataUrl: `data:${mimeTypes[extension] || 'application/octet-stream'};base64,${data.toString('base64')}`,
    };
  });
  ipcMain.handle('config:get', () => readStoredConfig(false));
  ipcMain.handle('config:save', (_event, config) => writeStoredConfig(config));

  ipcMain.handle('live:connect', async (_event, identityCode) => {
    if (liveClient) await liveClient.stop().catch(() => {});
    const config = await readStoredConfig(true);
    liveClient = new BilibiliLiveClient(config);
    attachLiveClient(liveClient);
    try {
      return await liveClient.start(identityCode);
    } catch (error) {
      sendToRenderer('live:state', { status: 'error', message: error.message });
      throw error;
    }
  });

  ipcMain.handle('live:disconnect', async () => {
    if (!liveClient) return { ok: true };
    await liveClient.stop();
    liveClient.removeAllListeners();
    liveClient = null;
    return { ok: true };
  });

  ipcMain.handle('archive:start', (_event, metadata) => archiveStore.startSession(metadata));
  ipcMain.handle('archive:append', (_event, sessionId, entry) => archiveStore.append(sessionId, entry));
  ipcMain.handle('archive:finish', (_event, sessionId, summary) => archiveStore.finishSession(sessionId, summary));
  ipcMain.handle('archive:export-csv', async (_event, sessionId) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出评论与评分',
      defaultPath: `品味大战-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return archiveStore.exportCsv(sessionId, result.filePath);
  });
}

app.whenReady().then(() => {
  archiveStore = new ArchiveStore(path.join(app.getPath('documents'), '品味大战存档'));
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (!liveClient || liveClient.closedByUser) return;
  event.preventDefault();
  liveClient.stop().catch(() => {}).finally(() => {
    liveClient = null;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
