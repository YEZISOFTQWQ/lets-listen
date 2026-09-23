'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { BilibiliLiveClient } = require('./lib/bilibili-client.cjs');
const { ArchiveStore } = require('./lib/archive-store.cjs');
const { StreamController, findFfmpeg } = require('./lib/stream-controller.cjs');

let mainWindow;
let backstageWindow;
let backstageState = {
  currentTrackId: '',
  tracks: [],
  playback: { currentTime: 0, duration: 0, paused: true, volume: 0.85, commentOpacity: 72, programMode: false, unparsedAsComment: true },
  connection: { status: 'disconnected', message: '模拟弹幕模式' },
  sessionId: '',
};
let liveClient;
let archiveStore;
const streamController = new StreamController();
let activeCaptureId = '';
let captureStartTimer;
let captureStopTimer;

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
    width: 640,
    height: 860,
    minWidth: 480,
    minHeight: 600,
    title: 'lets-listen · 直播后台',
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

function dialogOwner(event) {
  return BrowserWindow.fromWebContents(event.sender) || mainWindow;
}

function setupDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame !== mainWindow?.webContents.mainFrame || !activeCaptureId) return;
    const sourceId = mainWindow.getMediaSourceId();
    const sources = await desktopCapturer.getSources({ types: ['window'] });
    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      streamController.abort('无法捕获节目窗口，请确认节目窗口处于可见状态');
      return;
    }
    callback({ video: source });
  });
}

function requestCaptureStop() {
  if (!activeCaptureId) {
    streamController.finish();
    return;
  }
  if (captureStopTimer) return;
  const stoppingId = activeCaptureId;
  sendToRenderer('stream:stop-capture', { id: stoppingId });
  captureStopTimer = setTimeout(() => {
    captureStopTimer = null;
    if (activeCaptureId === stoppingId) streamController.abort('停止采集超时，编码进程已终止');
  }, 6000);
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
    if (activeCaptureId) streamController.abort('节目窗口已关闭，推流结束');
    mainWindow = null;
    if (backstageWindow && !backstageWindow.isDestroyed()) backstageWindow.close();
  });
  const screenshotArg = process.argv.find((argument) => argument.startsWith('--qa-screenshot='));
  const qaDemo = process.argv.includes('--qa-demo');
  const qaProgram = process.argv.includes('--qa-program');
  const qaVideo = process.argv.includes('--qa-video');
  const qaExit = process.argv.includes('--qa-exit');
  const qaDescription = process.argv.includes('--qa-description');
  const qaStream = process.argv.includes('--qa-stream');
  const qaComments = process.argv.includes('--qa-comments');
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
  } else if (qaComments) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`(() => {
            for (let index = 0; index < 24; index += 1) {
              processDanmaku({ open_id: 'qa-comment-' + index, uname: '观众' + index,
                msg: '#01评 第' + index + '条乐评，旋律和节奏都很有趣', msg_id: 'qa-comment-msg-' + index }, 'mock');
            }
            const normal = document.getElementById('commentStream').children.length;
            document.body.classList.add('program-mode');
            renderComments();
            const stream = document.getElementById('commentStream');
            return { normal, fullscreen: stream.children.length,
              clientHeight: stream.clientHeight, scrollHeight: stream.scrollHeight };
          })()`);
          if (result.fullscreen <= result.normal || result.fullscreen <= 4
            || result.scrollHeight > result.clientHeight + 2) {
            throw new Error(`全屏乐评未扩容或溢出: ${JSON.stringify(result)}`);
          }
          console.log(`[qa] fullscreen comments passed (${result.normal} -> ${result.fullscreen})`);
          app.quit();
        } catch (error) {
          console.error(`[qa] fullscreen comments failed: ${error.message}`);
          app.exit(1);
        }
      }, qaDemo ? 1800 : 1200);
    });
  } else if (qaStream) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const outputPath = path.join(app.getPath('temp'), `lets-listen-stream-qa-${randomUUID()}.mp4`);
        try {
          mainWindow.setFullScreen(true);
          openBackstageWindow();
          await new Promise((resolve) => backstageWindow.webContents.once('did-finish-load', resolve));
          const completed = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('测试录制超时')), 25000);
            const listener = (state) => {
              if (!['idle', 'error'].includes(state.status)) return;
              clearTimeout(timeout);
              streamController.off('state', listener);
              if (state.status === 'error') reject(new Error(state.message));
              else resolve();
            };
            streamController.on('state', listener);
          });
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.startStream(${JSON.stringify({ mode: 'test', filePath: outputPath, quality: '720p' })})`,
          );
          await completed;
          const result = await fs.stat(outputPath);
          if (result.size < 10000) throw new Error(`录像过小：${result.size} 字节`);
          console.log(`[qa] stream container encoded (${result.size} bytes; inspect visible picture/audio on the target desktop): ${outputPath}`);
          if (!process.argv.includes('--qa-keep-stream')) await fs.unlink(outputPath);
          app.quit();
        } catch (error) {
          console.error(`[qa] stream recording failed: ${error.message}`);
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
            cardText: document.getElementById('trackDescriptionCard')?.textContent.trim(),
            hidden: document.getElementById('trackDescriptionCard')?.hidden
          })`);
          if (!shown.label?.startsWith('TRACK') || shown.text !== '后台实时修改的歌曲简介'
            || shown.cardText !== shown.text || shown.hidden) {
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
          await backstageWindow.webContents.executeJavaScript(`(async () => {
            await window.backstageApi.command('volume', { value: 0.35 });
            await window.backstageApi.command('comment-opacity', { value: 47 });
            await window.backstageApi.command('seek', { progress: 500 });
            await window.backstageApi.command('unparsed-as-comment', { value: false });
            await window.backstageApi.command('mock-danmaku', { name: '后台观众', message: '#01 8.3' });
            await window.backstageApi.command('import', { items: [{
              id: 'qa-imported-track', path: 'qa-imported.wav', url: 'file:///qa-imported.wav',
              type: 'audio', title: '后台导入曲目', artist: '', duration: 0, coverDataUrl: ''
            }] });
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          const controls = await mainWindow.webContents.executeJavaScript(`({
            volume: document.getElementById('mediaElement').volume,
            opacity: Number(document.getElementById('commentOpacityInput').value),
            unparsed: document.getElementById('unparsedCommentInput').checked,
            playlistCount: document.querySelectorAll('.playlist-item').length,
            comments: document.getElementById('commentStream').textContent
          })`);
          if (Math.abs(controls.volume - 0.35) > 0.01 || controls.opacity !== 47
            || controls.unparsed || controls.playlistCount !== 2 || !controls.comments.includes('8.3')) {
            throw new Error(`后台控制未同步到节目: ${JSON.stringify(controls)}`);
          }
          const backstageCount = await backstageWindow.webContents.executeJavaScript(
            `document.querySelectorAll('.playlist-item').length`,
          );
          if (backstageCount !== 2) throw new Error('后台播放队列没有同步新增曲目');
          console.log('[qa] backstage controls and description passed');
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
        submitter: String(track.submitter || ''),
        hasCover: Boolean(track.hasCover),
        coverPath: String(track.coverPath || ''),
        duration: Number(track.duration || 0),
        type: track.type === 'video' ? 'video' : 'audio',
        description: String(track.description || '').slice(0, 500),
        descriptionVisible: Boolean(track.descriptionVisible),
      })),
      playback: {
        currentTime: Number(snapshot?.playback?.currentTime || 0),
        duration: Number(snapshot?.playback?.duration || 0),
        paused: Boolean(snapshot?.playback?.paused),
        volume: Number(snapshot?.playback?.volume ?? 0.85),
        commentOpacity: Number(snapshot?.playback?.commentOpacity ?? 72),
        programMode: Boolean(snapshot?.playback?.programMode),
        unparsedAsComment: Boolean(snapshot?.playback?.unparsedAsComment),
      },
      connection: {
        status: String(snapshot?.connection?.status || 'disconnected'),
        message: String(snapshot?.connection?.message || ''),
      },
      sessionId: String(snapshot?.sessionId || ''),
    };
    if (backstageWindow && !backstageWindow.isDestroyed()) {
      backstageWindow.webContents.send('backstage:state', backstageState);
    }
    if (activeCaptureId && !backstageState.playback.programMode) {
      requestCaptureStop();
    }
    return { ok: true };
  });
  ipcMain.handle('backstage:update-track', (event, update) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权修改曲目');
    const id = String(update?.id || '');
    if (!backstageState.tracks.some((track) => track.id === id)) throw new Error('曲目已不存在');
    const patch = { id };
    if (typeof update.title === 'string') {
      const title = update.title.trim().slice(0, 120);
      if (!title) throw new Error('曲目名称不能为空');
      patch.title = title;
    }
    if (typeof update.submitter === 'string') patch.submitter = update.submitter.trim().slice(0, 80);
    if (typeof update.description === 'string') patch.description = update.description.trim().slice(0, 500);
    if (typeof update.descriptionVisible === 'boolean') patch.descriptionVisible = update.descriptionVisible;
    if (typeof update.coverDataUrl === 'string') {
      if (update.coverDataUrl && !/^data:image\/(?:jpeg|png|webp|gif|bmp);base64,/.test(update.coverDataUrl)) {
        throw new Error('封面数据格式不受支持');
      }
      patch.coverDataUrl = update.coverDataUrl;
      patch.coverPath = String(update.coverPath || '');
    }
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('节目窗口已关闭');
    mainWindow.webContents.send('backstage:update-track', patch);
    return { ok: true };
  });
  ipcMain.handle('backstage:command', (event, command) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权操作节目');
    const allowed = new Set([
      'import', 'select-track', 'play-pause', 'previous', 'next', 'seek', 'volume',
      'comment-opacity', 'mock-danmaku', 'unparsed-as-comment', 'leave-program',
    ]);
    if (!allowed.has(command?.type)) throw new Error('不支持的后台操作');
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('节目窗口已关闭');
    mainWindow.webContents.send('backstage:command', { type: command.type, payload: command.payload });
    return { ok: true };
  });
  ipcMain.handle('backstage:feedback', (event, feedback) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权发送后台提示');
    if (backstageWindow && !backstageWindow.isDestroyed()) {
      backstageWindow.webContents.send('backstage:feedback', {
        message: String(feedback?.message || '').slice(0, 500),
        type: feedback?.type === 'error' ? 'error' : 'info',
      });
    }
    return { ok: true };
  });

  ipcMain.handle('media:select', async (event) => {
    const result = await dialog.showOpenDialog(dialogOwner(event), {
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
  ipcMain.handle('media:select-cover', async (event) => {
    const result = await dialog.showOpenDialog(dialogOwner(event), {
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
  ipcMain.handle('archive:export-csv', async (event, sessionId) => {
    const result = await dialog.showSaveDialog(dialogOwner(event), {
      title: '导出评论与评分',
      defaultPath: `品味大战-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return archiveStore.exportCsv(sessionId, result.filePath);
  });

  streamController.on('state', (state) => {
    if (backstageWindow && !backstageWindow.isDestroyed()) {
      backstageWindow.webContents.send('stream:state', state);
    }
    if (['idle', 'error'].includes(state.status) && activeCaptureId) {
      clearTimeout(captureStartTimer);
      clearTimeout(captureStopTimer);
      captureStopTimer = null;
      sendToRenderer('stream:stop-capture', { id: activeCaptureId });
      activeCaptureId = '';
    }
  });
  ipcMain.handle('stream:state', (event) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权查看推流状态');
    return streamController.status;
  });
  ipcMain.handle('stream:probe', async (event, ffmpegPath) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权检查推流环境');
    const executable = await findFfmpeg(String(ffmpegPath || ''));
    return { executable };
  });
  ipcMain.handle('stream:select-test-file', async (event) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权选择测试文件');
    const result = await dialog.showSaveDialog(dialogOwner(event), {
      title: '保存内置推流测试录像',
      defaultPath: `lets-listen-test-${new Date().toISOString().slice(0, 10)}.mp4`,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    });
    return result.canceled ? '' : result.filePath;
  });
  ipcMain.handle('stream:start', async (event, options) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权开始推流');
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('节目窗口已关闭');
    if (!backstageState.playback.programMode) throw new Error('请先在主窗口进入节目模式');
    if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
    await streamController.start(options || {});
    activeCaptureId = randomUUID();
    sendToRenderer('stream:start-capture', {
      id: activeCaptureId,
      mediaSourceId: mainWindow.getMediaSourceId(),
      testSeconds: options?.mode === 'test' ? 10 : 0,
    });
    captureStartTimer = setTimeout(() => {
      if (streamController.status.status === 'starting') {
        streamController.abort('启动采集超时，请确认节目窗口可见且允许窗口捕获');
      }
    }, 12000);
    return { ok: true };
  });
  ipcMain.handle('stream:stop', (event) => {
    if (event.sender !== backstageWindow?.webContents) throw new Error('无权停止推流');
    requestCaptureStop();
    return { ok: true };
  });
  ipcMain.on('stream:chunk', (event, id, bytes) => {
    if (event.sender !== mainWindow?.webContents || id !== activeCaptureId) return;
    streamController.writeChunk(bytes);
  });
  ipcMain.on('stream:capture-ready', (event, id) => {
    if (event.sender !== mainWindow?.webContents || id !== activeCaptureId) return;
    clearTimeout(captureStartTimer);
    streamController.update('live', streamController.mode === 'test'
      ? '正在录制 10 秒测试录像…' : '正在编码并推送节目画面与应用音频');
  });
  ipcMain.on('stream:capture-error', (event, id, message) => {
    if (event.sender !== mainWindow?.webContents || id !== activeCaptureId) return;
    streamController.abort(`采集失败：${String(message || '未知错误').slice(0, 300)}`);
  });
  ipcMain.on('stream:capture-stopped', (event, id) => {
    if (event.sender !== mainWindow?.webContents || id !== activeCaptureId) return;
    clearTimeout(captureStopTimer);
    captureStopTimer = null;
    streamController.finish();
  });
}

app.whenReady().then(() => {
  archiveStore = new ArchiveStore(path.join(app.getPath('documents'), '品味大战存档'));
  setupDisplayCapture();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (activeCaptureId) streamController.abort('软件退出，推流结束');
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
