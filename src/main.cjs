'use strict';

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BilibiliLiveClient } = require('./lib/bilibili-client.cjs');
const { ArchiveStore } = require('./lib/archive-store.cjs');
const { StreamController, findFfmpeg } = require('./lib/stream-controller.cjs');
const { inspectMediaFiles, readCoverFile, MAX_COVER_BYTES } = require('./lib/media-inspector.cjs');

let mainWindow;
let backstageWindow;
let backstageState = {
  currentTrackId: '',
  tracks: [],
  playback: { currentTime: 0, duration: 0, paused: true, volume: 0.85, commentOpacity: 72, programMode: false, unparsedAsComment: true },
  connection: { status: 'disconnected', message: '模拟弹幕模式', canDisconnect: false },
  sessionId: '',
};
let liveClient;
let liveOperation;
let shutdownCleanupStarted = false;
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
    if (streamController.starting || streamController.child) {
      streamController.abort('节目窗口已关闭，推流结束');
    }
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
  const qaStreamErrors = process.argv.includes('--qa-stream-errors');
  const qaRealVideo = process.argv.includes('--qa-real-video');
  const qaRealAudio = process.argv.includes('--qa-real-audio');
  const qaLiveExit = process.argv.includes('--qa-live-exit');
  const qaComments = process.argv.includes('--qa-comments');
  const qaArchiveErrors = process.argv.includes('--qa-archive-errors');
  mainWindow.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    qaDemo || qaProgram || qaVideo ? { query: { qa: qaDemo ? '1' : '0', program: qaProgram ? '1' : '0', video: qaVideo ? '1' : '0', tone: qaStream ? '1' : '0' } } : undefined,
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
            renderComments();
            const stable = [...stream.querySelectorAll('.comment-item')]
              .every((item) => getComputedStyle(item).animationName === 'none');
            processDanmaku({ open_id: 'qa-comment-new', uname: '新观众',
              msg: '#01评 新来的乐评', msg_id: 'qa-comment-new' }, 'mock');
            const entering = getComputedStyle(stream.querySelector('[data-message-id="qa-comment-new"]'))
              .animationName === 'comment-enter';
            const unchanged = [...stream.querySelectorAll('.comment-item')]
              .filter((item) => item.dataset.messageId !== 'qa-comment-new')
              .every((item) => getComputedStyle(item).animationName === 'none');
            return { normal, fullscreen: stream.children.length,
              clientHeight: stream.clientHeight, scrollHeight: stream.scrollHeight,
              stable, entering, unchanged,
              videoMode: document.getElementById('programFrame').classList.contains('video-mode'),
              trackHidden: getComputedStyle(document.querySelector('.track-zone')).display === 'none',
              scoreHidden: getComputedStyle(document.querySelector('.score-card')).display === 'none',
              instructionsHidden: getComputedStyle(document.querySelector('.instruction-strip')).display === 'none',
              commentsVisible: getComputedStyle(document.querySelector('.comments-card')).display !== 'none' };
          })()`);
          if (result.fullscreen <= result.normal || result.fullscreen <= 4
            || !result.stable || !result.entering || !result.unchanged
            || result.scrollHeight > result.clientHeight + 2) {
            throw new Error(`全屏乐评未扩容或溢出: ${JSON.stringify(result)}`);
          }
          if (qaVideo && (!result.videoMode || !result.trackHidden || !result.scoreHidden
            || !result.instructionsHidden || !result.commentsVisible)) {
            throw new Error(`视频模式未只保留评论栏: ${JSON.stringify(result)}`);
          }
          console.log(`[qa] fullscreen comments passed (${result.normal} -> ${result.fullscreen})`);
          app.quit();
        } catch (error) {
          console.error(`[qa] fullscreen comments failed: ${error.message}`);
          app.exit(1);
        }
      }, qaDemo ? 1800 : 1200);
    });
  } else if (qaLiveExit) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        let stopCount = 0;
        liveClient = {
          gameId: 'qa-pending-session',
          closedByUser: true,
          async stop() { stopCount += 1; this.gameId = ''; },
          removeAllListeners() {},
        };
        app.once('will-quit', () => {
          if (stopCount === 1) console.log('[qa] pending live session retried on quit');
          else {
            console.error(`[qa] live exit cleanup failed: stopCount=${stopCount}`);
            process.exitCode = 1;
          }
        });
        app.quit();
      }, 1200);
    });
  } else if (qaRealAudio) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const audioPath = process.env.LETS_LISTEN_QA_AUDIO;
          if (!audioPath) throw new Error('缺少测试音频路径');
          const inspected = await inspectMediaFiles([audioPath]);
          if (inspected.length !== 1 || inspected[0].error || inspected[0].type !== 'audio') {
            throw new Error(`音频导入检查失败：${JSON.stringify(inspected)}`);
          }
          await mainWindow.webContents.executeJavaScript(`addTracks(${JSON.stringify(inspected)})`);
          const result = await mainWindow.webContents.executeJavaScript(`(async () => {
            await loadTrack(0, true);
            let peak = 0;
            for (let retry = 0; retry < 20 && peak === 0; retry += 1) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const levels = new Uint8Array(state.analyser.frequencyBinCount);
              state.analyser.getByteFrequencyData(levels);
              peak = Math.max(...levels);
            }
            const media = document.getElementById('mediaElement');
            return { paused: media.paused, time: media.currentTime, duration: media.duration,
              peak, videoMode: document.getElementById('programFrame').classList.contains('video-mode'),
              title: document.getElementById('trackTitle').textContent };
          })()`);
          if (result.paused || result.time <= 0 || !Number.isFinite(result.duration)
            || result.duration < 3 || result.peak <= 0
            || result.videoMode || !result.title) {
            throw new Error(`真实音频播放或频谱异常：${JSON.stringify(result)}`);
          }
          console.log('[qa] real audio import and playback passed');
          app.quit();
        } catch (error) {
          console.error(`[qa] real audio import and playback failed: ${error.message}`);
          app.exit(1);
        }
      }, 1200);
    });
  } else if (qaRealVideo) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const videoPath = process.env.LETS_LISTEN_QA_VIDEO;
          if (!videoPath) throw new Error('缺少测试视频路径');
          const inspected = await inspectMediaFiles([videoPath]);
          if (inspected.length !== 1 || inspected[0].error || inspected[0].type !== 'video') {
            throw new Error(`视频导入检查失败：${JSON.stringify(inspected)}`);
          }
          await mainWindow.webContents.executeJavaScript(`addTracks(${JSON.stringify(inspected)})`);
          mainWindow.setFullScreen(true);
          const result = await mainWindow.webContents.executeJavaScript(`(async () => {
            document.body.classList.add('program-mode');
            setCommentOpacity(46, false);
            processDanmaku({ open_id: 'qa-video-viewer', uname: '视频观众',
              msg: '#01评 视频画面清楚', msg_id: 'qa-video-comment' }, 'mock');
            await loadTrack(0, true);
            await new Promise((resolve) => setTimeout(resolve, 650));
            const media = document.getElementById('mediaElement');
            return {
              paused: media.paused, time: media.currentTime, width: media.videoWidth, height: media.videoHeight,
              videoMode: document.getElementById('programFrame').classList.contains('video-mode'),
              videoVisible: getComputedStyle(media).display !== 'none',
              ambientHidden: getComputedStyle(document.querySelector('.ambient')).display === 'none',
              trackHidden: getComputedStyle(document.querySelector('.track-zone')).display === 'none',
              scoreHidden: getComputedStyle(document.querySelector('.score-card')).display === 'none',
              instructionsHidden: getComputedStyle(document.querySelector('.instruction-strip')).display === 'none',
              commentsVisible: getComputedStyle(document.querySelector('.comments-card')).display !== 'none',
              controlsHidden: getComputedStyle(document.querySelector('.control-surface')).display === 'none',
              comment: document.getElementById('commentStream').textContent,
              opacity: getComputedStyle(document.documentElement).getPropertyValue('--comment-panel-alpha').trim(),
            };
          })()`);
          if (result.paused || result.time <= 0 || result.width < 640 || result.height < 360
            || !result.videoMode || !result.videoVisible || !result.ambientHidden
            || !result.trackHidden || !result.scoreHidden
            || !result.instructionsHidden || !result.commentsVisible
            || !result.controlsHidden
            || !result.comment.includes('视频画面清楚') || result.opacity !== '0.46') {
            throw new Error(`真实视频播放或节目布局错误：${JSON.stringify(result)}`);
          }
          console.log('[qa] real video import and playback passed');
          app.quit();
        } catch (error) {
          console.error(`[qa] real video import and playback failed: ${error.message}`);
          app.exit(1);
        }
      }, 1200);
    });
  } else if (qaStreamErrors) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          openBackstageWindow();
          await new Promise((resolve) => backstageWindow.webContents.once('did-finish-load', resolve));
          const invalid = await backstageWindow.webContents.executeJavaScript(`
            window.backstageApi.startStream({ mode: 'live', server: 'https://invalid.test', key: 'secret' })
              .then(() => '', (error) => error.message)`);
          if (!invalid.includes('rtmp://')) throw new Error(`无效推流地址未被拒绝：${invalid}`);
          const originalResolve = streamController.resolveExecutable;
          let releaseProbe;
          streamController.resolveExecutable = () => new Promise((resolve) => { releaseProbe = resolve; });
          try {
            const options = { mode: 'test', filePath: path.join(app.getPath('temp'), 'lets-listen-cancel-qa.mp4') };
            const begin = `window.backstageApi.startStream(${JSON.stringify(options)})
              .then(() => ({ ok: true }), (error) => ({ ok: false, message: error.message }))`;
            const first = backstageWindow.webContents.executeJavaScript(begin);
            for (let retry = 0; retry < 40 && !releaseProbe; retry += 1) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (!releaseProbe) throw new Error(`推流启动未进入 FFmpeg 检查：${JSON.stringify(await first)}`);
            const duplicate = await backstageWindow.webContents.executeJavaScript(begin);
            if (duplicate.ok || !duplicate.message.includes('已有推流')) {
              throw new Error(`重复开始推流未被拒绝：${JSON.stringify(duplicate)}`);
            }
            await backstageWindow.webContents.executeJavaScript('window.backstageApi.stopStream()');
            releaseProbe('ffmpeg');
            const canceled = await first;
            if (canceled.ok || !canceled.message.includes('取消') || streamController.child || activeCaptureId) {
              throw new Error(`启动中停止后仍有推流：${JSON.stringify(canceled)}`);
            }
            releaseProbe = null;
            const leaving = backstageWindow.webContents.executeJavaScript(begin);
            for (let retry = 0; retry < 40 && !releaseProbe; retry += 1) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (!releaseProbe) throw new Error('退出节目模式测试未进入 FFmpeg 检查');
            await backstageWindow.webContents.executeJavaScript(
              `window.backstageApi.command('leave-program')`,
            );
            for (let retry = 0; retry < 40 && streamController.starting; retry += 1) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (backstageState.playback.programMode || streamController.starting) {
              throw new Error('退出节目模式后未取消正在启动的推流');
            }
            releaseProbe('ffmpeg');
            const leaveCanceled = await leaving;
            if (leaveCanceled.ok || !leaveCanceled.message.includes('取消')
              || streamController.child || activeCaptureId) {
              throw new Error(`退出节目模式后仍有推流：${JSON.stringify(leaveCanceled)}`);
            }
          } finally {
            streamController.resolveExecutable = originalResolve;
            releaseProbe?.('ffmpeg');
          }
          console.log('[qa] stream error handling passed');
          app.quit();
        } catch (error) {
          console.error(`[qa] stream error handling failed: ${error.message}`);
          app.exit(1);
        }
      }, qaDemo ? 1800 : 1200);
    });
  } else if (qaStream) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const outputPath = process.env.LETS_LISTEN_QA_OUTPUT
          || path.join(app.getPath('temp'), `lets-listen-stream-qa-${randomUUID()}.mp4`);
        try {
          mainWindow.setFullScreen(true);
          const playing = await mainWindow.webContents.executeJavaScript(`(async () => {
            const media = document.getElementById('mediaElement');
            media.loop = true;
            await ensureAudioGraph();
            await media.play();
            return !media.paused;
          })()`);
          if (!playing) throw new Error('QA 测试音无法播放');
          let visualizer;
          for (let retry = 0; retry < 20; retry += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            visualizer = await mainWindow.webContents.executeJavaScript(`(() => {
              const levels = new Uint8Array(state.analyser.frequencyBinCount);
              state.analyser.getByteFrequencyData(levels);
              const canvas = document.getElementById('visualizer');
              const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
              let drawn = false;
              for (let index = 3; index < pixels.length; index += 4) {
                if (pixels[index] > 0) { drawn = true; break; }
              }
              return { level: Math.max(...levels), width: canvas.width, height: canvas.height, drawn };
            })()`);
            if (visualizer.level > 0 && visualizer.drawn) break;
          }
          if (visualizer.level <= 0 || visualizer.width <= 1 || visualizer.height <= 1 || !visualizer.drawn) {
            throw new Error(`音频可视化没有绘制有效频谱：${JSON.stringify(visualizer)}`);
          }
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
  } else if (qaArchiveErrors) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const originalAppend = archiveStore.append;
        const originalSaveDialog = dialog.showSaveDialog;
        const exportPath = path.join(app.getPath('temp'), `lets-listen-archive-error-${randomUUID()}.csv`);
        let failed = false;
        try {
          openBackstageWindow();
          await new Promise((resolve) => backstageWindow.webContents.once('did-finish-load', resolve));
          await mainWindow.webContents.executeJavaScript('state.archiveQueue');
          const sessionId = backstageState.sessionId;
          if (!sessionId) throw new Error('未创建测试存档');
          archiveStore.append = (id, entry) => entry?.type === 'comment' && entry.msgId === 'qa-archive-fail'
            ? Promise.reject(new Error('QA 模拟磁盘写入失败'))
            : originalAppend.call(archiveStore, id, entry);
          const observed = await mainWindow.webContents.executeJavaScript(`(async () => {
            processDanmaku({ open_id: 'qa-archive-viewer', uname: '存档测试观众',
              msg: '#01评 这条评论的归档将失败', msg_id: 'qa-archive-fail' }, 'mock');
            await state.archiveQueue;
            return { error: state.archiveError,
              visible: document.getElementById('commentStream').textContent,
              toast: document.getElementById('toastContainer').textContent };
          })()`);
          if (!observed.error.includes('QA 模拟磁盘写入失败')
            || !observed.visible.includes('这条评论的归档将失败')
            || !observed.toast.includes('存档写入失败')) {
            throw new Error(`存档失败未向节目提示：${JSON.stringify(observed)}`);
          }
          archiveStore.append = originalAppend;
          await new Promise((resolve) => setTimeout(resolve, 150));
          const feedback = await backstageWindow.webContents.executeJavaScript(
            `document.getElementById('status').textContent`,
          );
          if (!feedback.includes('存档写入失败')) throw new Error(`后台没有存档失败提示：${feedback}`);
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
          const exported = await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.exportArchiveCsv(${JSON.stringify(sessionId)})`,
          );
          const csv = await fs.readFile(exportPath, 'utf8');
          if (!exported.incomplete || csv.includes('qa-archive-fail')) {
            throw new Error(`不完整存档被错误导出：${JSON.stringify(exported)}`);
          }
          await backstageWindow.webContents.executeJavaScript(
            `document.getElementById('exportButton').click()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          const warning = await backstageWindow.webContents.executeJavaScript(`({
            text: document.getElementById('status').textContent,
            error: document.getElementById('status').classList.contains('error'),
          })`);
          if (!warning.error || !warning.text.includes('不完整')) {
            throw new Error(`后台把不完整导出误报为成功：${JSON.stringify(warning)}`);
          }
          console.log('[qa] archive failure warning passed');
        } catch (error) {
          failed = true;
          console.error(`[qa] archive failure warning failed: ${error.stack || error.message}`);
        } finally {
          archiveStore.append = originalAppend;
          dialog.showSaveDialog = originalSaveDialog;
          await fs.rm(exportPath, { force: true });
          if (failed) app.exit(1);
          else app.quit();
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
          if (Math.abs(controls.volume - 0.35) > 0.01
            || controls.opacity !== 47
            || controls.unparsed || controls.playlistCount !== 2 || !controls.comments.includes('8.3')) {
            throw new Error(`后台控制未同步到节目: ${JSON.stringify(controls)}`);
          }
          await mainWindow.webContents.executeJavaScript(
            `document.getElementById('mediaElement').pause()`,
          );
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.command('seek', { progress: 500 })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          const seek = await mainWindow.webContents.executeJavaScript(`({
            time: document.getElementById('mediaElement').currentTime,
            duration: document.getElementById('mediaElement').duration,
            paused: document.getElementById('mediaElement').paused,
          })`);
          if (!seek.paused || Math.abs(seek.time - seek.duration / 2) > 0.1) {
            throw new Error(`后台进度调整没有定位到一半：${JSON.stringify(seek)}`);
          }
          await mainWindow.webContents.executeJavaScript(
            `document.getElementById('mediaElement').loop = true`,
          );
          await backstageWindow.webContents.executeJavaScript(`window.backstageApi.command('next')`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const nextIndex = await mainWindow.webContents.executeJavaScript(`state.currentIndex`);
          await backstageWindow.webContents.executeJavaScript(`window.backstageApi.command('previous')`);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const previousIndex = await mainWindow.webContents.executeJavaScript(`state.currentIndex`);
          if (nextIndex !== 1 || previousIndex !== 0) {
            throw new Error(`后台上一首/下一首未切换曲目：${nextIndex} -> ${previousIndex}`);
          }
          await backstageWindow.webContents.executeJavaScript(`window.backstageApi.command('play-pause')`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          const paused = await mainWindow.webContents.executeJavaScript(
            `document.getElementById('mediaElement').paused`,
          );
          await backstageWindow.webContents.executeJavaScript(`window.backstageApi.command('play-pause')`);
          await new Promise((resolve) => setTimeout(resolve, 100));
          const resumed = await mainWindow.webContents.executeJavaScript(
            `document.getElementById('mediaElement').paused`,
          );
          if (!paused || resumed) throw new Error(`后台播放/暂停没有生效：${paused} -> ${resumed}`);
          const backstageCount = await backstageWindow.webContents.executeJavaScript(
            `document.querySelectorAll('.playlist-item').length`,
          );
          if (backstageCount !== 2) throw new Error('后台播放队列没有同步新增曲目');
          await backstageWindow.webContents.executeJavaScript(`(() => {
            const title = document.getElementById('titleInput');
            const submitter = document.getElementById('submitterInput');
            title.value = '后台更新的曲名';
            submitter.value = '后台投稿人';
            title.dispatchEvent(new Event('input', { bubbles: true }));
            submitter.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('saveButton').click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          const metadata = await mainWindow.webContents.executeJavaScript(`({
            title: document.getElementById('trackTitle').textContent,
            submitter: document.getElementById('trackArtist').textContent,
            playlistTitle: document.querySelector('.playlist-item strong')?.textContent,
          })`);
          if (metadata.title !== '后台更新的曲名' || metadata.submitter !== '后台投稿人'
            || metadata.playlistTitle !== '后台更新的曲名') {
            throw new Error(`后台曲目信息未同步: ${JSON.stringify(metadata)}`);
          }
          const pendingEdit = await backstageWindow.webContents.executeJavaScript(`(async () => {
            const input = document.getElementById('descriptionInput');
            const original = input.value;
            input.value = '第一版简介';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const saving = saveMetadata();
            input.value = '保存期间继续输入的简介';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await saving;
            render(await window.backstageApi.getState());
            const result = { draft: input.value, dirty, original };
            input.value = original;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await saveMetadata();
            return result;
          })()`);
          if (!pendingEdit.dirty || pendingEdit.draft !== '保存期间继续输入的简介') {
            throw new Error(`保存期间继续编辑的简介丢失：${JSON.stringify(pendingEdit)}`);
          }
          const rapidSaves = await backstageWindow.webContents.executeJavaScript(`(async () => {
            const input = document.getElementById('descriptionInput');
            input.value = '快速保存第一版';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const first = saveMetadata();
            input.value = '快速保存第二版';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const second = saveMetadata();
            await Promise.all([first, second]);
            await new Promise((resolve) => setTimeout(resolve, 150));
            render(await window.backstageApi.getState());
            const result = { draft: input.value, dirty,
              saved: snapshot.tracks.find((track) => track.id === 'qa-track')?.description };
            input.value = '后台实时修改的歌曲简介';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await saveMetadata();
            return result;
          })()`);
          if (rapidSaves.dirty || rapidSaves.draft !== '快速保存第二版'
            || rapidSaves.saved !== '快速保存第二版') {
            throw new Error(`连续保存没有保留最后一版简介：${JSON.stringify(rapidSaves)}`);
          }
          const unsavedSwitch = await backstageWindow.webContents.executeJavaScript(`(() => {
            const title = document.getElementById('titleInput');
            const select = document.getElementById('trackSelect');
            const originalConfirm = window.confirm;
            try {
              title.value = '尚未保存的曲名';
              title.dispatchEvent(new Event('input', { bubbles: true }));
              window.confirm = () => false;
              select.value = 'qa-imported-track';
              select.dispatchEvent(new Event('change', { bubbles: true }));
              const canceled = { selected: select.value, title: title.value };
              window.confirm = () => true;
              select.value = 'qa-imported-track';
              select.dispatchEvent(new Event('change', { bubbles: true }));
              const discarded = { selected: select.value, title: title.value };
              select.value = 'qa-track';
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return { canceled, discarded };
            } finally { window.confirm = originalConfirm; }
          })()`);
          if (unsavedSwitch.canceled.selected !== 'qa-track'
            || unsavedSwitch.canceled.title !== '尚未保存的曲名'
            || unsavedSwitch.discarded.selected !== 'qa-imported-track'
            || unsavedSwitch.discarded.title !== '后台导入曲目') {
            throw new Error(`切换曲目时未保护未保存资料：${JSON.stringify(unsavedSwitch)}`);
          }
          const invalidTitleRejected = await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.updateTrack({ id: 'qa-track', title: '  ' }).then(() => false, () => true)`,
          );
          if (!invalidTitleRejected) throw new Error('后台允许保存空曲名');
          const coverDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zQAAAABJRU5ErkJggg==';
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.updateTrack(${JSON.stringify({ id: 'qa-track', coverDataUrl, coverPath: 'qa-cover.png' })})`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          const cover = await mainWindow.webContents.executeJavaScript(`({
            trackCover: state.tracks[0].coverDataUrl,
            displayedCover: document.getElementById('coverImage').getAttribute('src'),
          })`);
          if (cover.trackCover !== coverDataUrl || cover.displayedCover !== coverDataUrl) {
            throw new Error('后台导入的封面没有同步到节目画面');
          }
          const revisedScore = await mainWindow.webContents.executeJavaScript(`(() => {
            processDanmaku({ open_id: 'qa-repeat', uname: '重复评分观众', msg: '#01 5.0', msg_id: 'qa-repeat-1' }, 'mock');
            processDanmaku({ open_id: 'qa-repeat', uname: '重复评分观众', msg: '#01 9.0', msg_id: 'qa-repeat-2' }, 'mock');
            processDanmaku({ open_id: 'qa-repeat', uname: '重复评分观众', msg: '#01 1.0', msg_id: 'qa-repeat-2' }, 'mock');
            processDanmaku({ open_id: 'qa-repeat', uname: '重复评分观众', msg: '#02 6.0', msg_id: 'qa-repeat-3' }, 'mock');
            return {
              bubbles: state.comments.filter((entry) => entry.kind === 'score' && entry.openId === 'qa-repeat').length,
              score: state.scoresByRound.get('01')?.get('qa-repeat')?.score,
              otherTrackScore: state.scoresByRound.get('02')?.get('qa-repeat')?.score,
              count: document.getElementById('scoreCount').textContent,
              average: document.getElementById('averageScore').textContent,
              visible: document.getElementById('commentStream').textContent,
            };
          })()`);
          if (revisedScore.bubbles !== 2 || revisedScore.score !== 9 || revisedScore.otherTrackScore !== 6
            || revisedScore.count !== '5' || revisedScore.average !== '8.7'
            || revisedScore.visible.includes('5.0 分') || revisedScore.visible.includes('6.0 分')
            || revisedScore.visible.includes('1.0 分') || !revisedScore.visible.includes('9.0 分')) {
            throw new Error(`重复评分未覆盖旧消息: ${JSON.stringify(revisedScore)}`);
          }
          const exportPath = path.join(app.getPath('temp'), `lets-listen-export-qa-${randomUUID()}.csv`);
          const originalSaveDialog = dialog.showSaveDialog;
          try {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath });
            const exportResult = await backstageWindow.webContents.executeJavaScript(
              `window.backstageApi.exportArchiveCsv(${JSON.stringify(backstageState.sessionId)})`,
            );
            const csv = await fs.readFile(exportPath, 'utf8');
            if (exportResult.count < 2 || !csv.includes('qa-repeat-1') || !csv.includes('qa-repeat-2')) {
              throw new Error('后台立即导出遗漏了尚在写入队列中的评分');
            }
          } finally {
            dialog.showSaveDialog = originalSaveDialog;
            await fs.rm(exportPath, { force: true });
          }
          await mainWindow.webContents.executeJavaScript(`state.archiveQueue`);
          const archivePath = archiveStore.sessions.get(backstageState.sessionId);
          const archiveText = await fs.readFile(archivePath, 'utf8');
          if (!archiveText.includes('qa-repeat-1') || !archiveText.includes('qa-repeat-2')) {
            throw new Error('重复评分没有完整写入原始存档');
          }
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.updateTrack(${JSON.stringify({
              id: 'qa-imported-track', title: '候播曲目', submitter: '候播投稿人',
              description: '候播曲目的简介', descriptionVisible: true,
              coverDataUrl, coverPath: 'qa-queued-cover.png',
            })})`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          const queued = await mainWindow.webContents.executeJavaScript(`({
            title: state.tracks[1].title,
            submitter: state.tracks[1].submitter,
            description: state.tracks[1].description,
            currentTitle: document.getElementById('trackTitle').textContent,
          })`);
          if (queued.title !== '候播曲目' || queued.submitter !== '候播投稿人'
            || queued.description !== '候播曲目的简介' || queued.currentTitle !== '后台更新的曲名') {
            throw new Error(`候播曲目信息提前影响了当前曲目或没有保存：${JSON.stringify(queued)}`);
          }
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.command('select-track', { id: 'qa-imported-track' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
          const badMedia = await mainWindow.webContents.executeJavaScript(`({
            index: state.currentIndex,
            paused: document.getElementById('mediaElement').paused,
            toast: document.getElementById('toastContainer').textContent,
            title: document.getElementById('trackTitle').textContent,
            submitter: document.getElementById('trackArtist').textContent,
            description: document.getElementById('trackDescriptionText').textContent,
            cover: document.getElementById('coverImage').getAttribute('src'),
          })`);
          if (badMedia.index !== 1 || !badMedia.paused
            || !/无法播放|媒体无法播放/.test(badMedia.toast)
            || badMedia.title !== '候播曲目' || badMedia.submitter !== '候播投稿人'
            || badMedia.description !== '候播曲目的简介' || badMedia.cover !== coverDataUrl) {
            throw new Error(`无效媒体播放未安全报错: ${JSON.stringify(badMedia)}`);
          }
          const playbackFeedback = await backstageWindow.webContents.executeJavaScript(`({
            message: document.getElementById('status').textContent,
            error: document.getElementById('status').classList.contains('error'),
          })`);
          if (!playbackFeedback.error || !/无法播放|媒体无法播放/.test(playbackFeedback.message)) {
            throw new Error(`坏媒体播放未提示后台：${JSON.stringify(playbackFeedback)}`);
          }
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.command('select-track', { id: 'qa-track' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
          const editingId = await mainWindow.webContents.executeJavaScript(`(() => {
            openTrackEditor();
            document.getElementById('trackTitleInput').value = '弹窗绑定原曲目';
            return state.editingTrackId;
          })()`);
          if (editingId !== 'qa-track') throw new Error(`编辑弹窗绑定了错误曲目：${editingId}`);
          const editorSpace = await mainWindow.webContents.executeJavaScript(`(async () => {
            const media = document.getElementById('mediaElement');
            const description = document.getElementById('trackDescriptionInput');
            media.pause();
            description.focus();
            const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
            description.dispatchEvent(space);
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { focused: document.activeElement === description,
              prevented: space.defaultPrevented, paused: media.paused };
          })()`);
          if (!editorSpace.focused || editorSpace.prevented || !editorSpace.paused) {
            throw new Error(`编辑简介时空格误触发播放：${JSON.stringify(editorSpace)}`);
          }
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.command('select-track', { id: 'qa-imported-track' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
          const editorSave = await mainWindow.webContents.executeJavaScript(`(() => {
            saveTrackMetadata();
            return {
              original: state.tracks[0].title,
              next: state.tracks[1].title,
              displayed: document.getElementById('trackTitle').textContent,
              currentIndex: state.currentIndex,
              dialogOpen: document.getElementById('trackEditDialog').open,
            };
          })()`);
          if (editorSave.original !== '弹窗绑定原曲目' || editorSave.next !== '候播曲目'
            || editorSave.displayed !== '候播曲目' || editorSave.currentIndex !== 1 || editorSave.dialogOpen) {
            throw new Error(`切歌后编辑弹窗误改曲目：${JSON.stringify(editorSave)}`);
          }
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.command('select-track', { id: 'qa-track' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 200));
          await mainWindow.webContents.executeJavaScript(`(() => {
            openTrackEditor();
            document.getElementById('trackTitleInput').value = '旧弹窗填写的标题';
          })()`);
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.updateTrack({ id: 'qa-track', title: '后台并发新标题' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          const concurrentEdit = await mainWindow.webContents.executeJavaScript(`(() => {
            saveTrackMetadata();
            const result = {
              title: state.tracks[0].title,
              stale: state.editingTrackStale,
              dialogOpen: document.getElementById('trackEditDialog').open,
            };
            document.getElementById('trackEditDialog').close();
            return result;
          })()`);
          if (concurrentEdit.title !== '后台并发新标题'
            || !concurrentEdit.stale || !concurrentEdit.dialogOpen) {
            throw new Error(`旧编辑弹窗覆盖了后台并发修改：${JSON.stringify(concurrentEdit)}`);
          }
          const spaceShortcut = await mainWindow.webContents.executeJavaScript(`(async () => {
            const media = document.getElementById('mediaElement');
            media.pause();
            document.activeElement?.blur();
            const repeated = new KeyboardEvent('keydown', {
              key: ' ', code: 'Space', repeat: true, bubbles: true, cancelable: true,
            });
            document.dispatchEvent(repeated);
            await new Promise((resolve) => setTimeout(resolve, 100));
            const repeatedPaused = media.paused;
            const first = new KeyboardEvent('keydown', {
              key: ' ', code: 'Space', bubbles: true, cancelable: true,
            });
            document.dispatchEvent(first);
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { repeatedPaused, repeatedPrevented: repeated.defaultPrevented,
              firstPrevented: first.defaultPrevented, playing: !media.paused };
          })()`);
          if (!spaceShortcut.repeatedPaused || spaceShortcut.repeatedPrevented
            || !spaceShortcut.firstPrevented || !spaceShortcut.playing) {
            throw new Error(`空格播放快捷键或长按保护异常：${JSON.stringify(spaceShortcut)}`);
          }
          await backstageWindow.webContents.executeJavaScript(
            `window.backstageApi.command('select-track', { id: 'missing-qa-track' })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          const backstageError = await backstageWindow.webContents.executeJavaScript(`({
            message: document.getElementById('status').textContent,
            error: document.getElementById('status').classList.contains('error'),
          })`);
          if (!backstageError.error || !backstageError.message.includes('曲目已不存在')) {
            throw new Error(`后台误操作未收到错误提示：${JSON.stringify(backstageError)}`);
          }
          sendToRenderer('live:state', {
            status: 'error', message: '关闭互动场次失败，请重试', gameId: 'qa-retry-game',
          });
          await new Promise((resolve) => setTimeout(resolve, 150));
          const retryButtons = {
            main: await mainWindow.webContents.executeJavaScript(
              `document.getElementById('disconnectButton').disabled`,
            ),
            backstage: await backstageWindow.webContents.executeJavaScript(
              `document.getElementById('disconnectButton').disabled`,
            ),
          };
          if (retryButtons.main || retryButtons.backstage) {
            throw new Error(`结束接口失败后无法重新断开：${JSON.stringify(retryButtons)}`);
          }
          if (qaProgram) {
            const previousBackstage = backstageWindow;
            const closed = new Promise((resolve) => previousBackstage.once('closed', resolve));
            previousBackstage.close();
            await closed;
            await mainWindow.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {
              ctrlKey: true, shiftKey: true, code: 'KeyD', bubbles: true,
            }))`);
            for (let retry = 0; retry < 40 && !backstageWindow; retry += 1) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            if (!backstageWindow || backstageWindow.isDestroyed() || !backstageWindow.isVisible()) {
              throw new Error('节目模式快捷键未重新打开直播后台');
            }
          }
          console.log('[qa] backstage controls and description passed');
          app.quit();
        } catch (error) {
          console.error(`[qa] backstage description failed: ${error.stack || error.message}`);
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

function runLiveOperation(work) {
  if (liveOperation) throw new Error('直播连接操作正在进行，请稍后重试');
  const operation = Promise.resolve().then(work);
  liveOperation = operation;
  operation.finally(() => {
    if (liveOperation === operation) liveOperation = null;
  }).catch(() => {});
  return operation;
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
        canDisconnect: Boolean(snapshot?.connection?.canDisconnect),
      },
      sessionId: String(snapshot?.sessionId || ''),
    };
    if (backstageWindow && !backstageWindow.isDestroyed()) {
      backstageWindow.webContents.send('backstage:state', backstageState);
    }
    if ((activeCaptureId || streamController.starting) && !backstageState.playback.programMode) {
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
      if (update.coverDataUrl.length > Math.ceil(MAX_COVER_BYTES * 4 / 3) + 100) {
        throw new Error('封面图片不能超过 10 MB');
      }
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
    return readCoverFile(result.filePaths[0]);
  });
  ipcMain.handle('config:get', () => readStoredConfig(false));
  ipcMain.handle('config:save', (_event, config) => writeStoredConfig(config));

  ipcMain.handle('live:connect', (_event, identityCode) => runLiveOperation(async () => {
    if (liveClient) {
      const previous = liveClient;
      await previous.stop();
      previous.removeAllListeners();
      if (liveClient === previous) liveClient = null;
    }
    const config = await readStoredConfig(true);
    const client = new BilibiliLiveClient(config);
    liveClient = client;
    attachLiveClient(client);
    try {
      return await client.start(identityCode);
    } catch (error) {
      if (!client.gameId) {
        if (liveClient === client) liveClient = null;
        client.removeAllListeners();
      }
      sendToRenderer('live:state', { status: 'error', message: error.message, gameId: client.gameId || null });
      throw error;
    }
  }));

  ipcMain.handle('live:disconnect', () => runLiveOperation(async () => {
    if (!liveClient) return { ok: true };
    const client = liveClient;
    await client.stop();
    client.removeAllListeners();
    if (liveClient === client) liveClient = null;
    return { ok: true };
  }));

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
    let archiveError = '';
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      archiveError = await mainWindow.webContents.executeJavaScript(`(async () => {
        if (typeof state === 'undefined') return '';
        await state.archiveQueue;
        return state.archiveError || '';
      })()`);
    }
    const exported = await archiveStore.exportCsv(sessionId, result.filePath);
    return { ...exported, incomplete: Boolean(archiveError) };
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
    if (!mainWindow || mainWindow.isDestroyed() || !backstageState.playback.programMode) {
      if (streamController.child || streamController.starting) {
        streamController.abort('节目模式已退出，推流启动已取消');
      }
      throw new Error('节目模式已退出，推流启动已取消');
    }
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
  const qaArchiveRoot = process.argv.some((argument) => argument.startsWith('--qa-'))
    ? process.env.LETS_LISTEN_QA_ARCHIVE : '';
  archiveStore = new ArchiveStore(qaArchiveRoot || path.join(app.getPath('documents'), '品味大战存档'));
  setupDisplayCapture();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  if (streamController.starting || streamController.child) {
    streamController.abort('软件退出，推流结束');
  }
  if (shutdownCleanupStarted || ((!liveClient || !liveClient.gameId) && !liveOperation)) return;
  event.preventDefault();
  shutdownCleanupStarted = true;
  Promise.resolve(liveOperation).catch(() => {}).then(async () => {
    const client = liveClient;
    if (client?.gameId) await client.stop().catch(() => {});
    client?.removeAllListeners();
    liveClient = null;
  }).finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
