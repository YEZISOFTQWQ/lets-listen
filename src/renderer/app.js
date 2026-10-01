'use strict';

const api = window.tasteArena;
const { parseScore } = window.TasteCommands;
const MAX_TRACKS = 500;
const MAX_OUTPUT_VOLUME = 1.25;
const DEFAULT_THEME = { color: '#d8ff3e', hover: '#e5ff72', rgb: '216, 255, 62' };
const NEUTRAL_THEME = { color: '#c4cbd4', hover: '#e0e4ea', rgb: '196, 203, 212' };

const state = {
  tracks: [],
  currentIndex: -1,
  scoresByRound: new Map(),
  seenMessageIds: new Set(),
  sessionPromise: null,
  archiveQueue: Promise.resolve(),
  archiveError: '',
  archiveWarningAt: 0,
  sessionId: null,
  sessionPath: '',
  lastProgressPublish: 0,
  audioContext: null,
  analyser: null,
  mediaSource: null,
  volumeGain: null,
  captureDestination: null,
  descriptionScrollTimer: null,
  streamCapture: null,
  pendingStreamId: null,
  cancelledStreamCaptures: new Set(),
  dragDepth: 0,
  pendingCoverDataUrl: '',
  pendingCoverPath: '',
  coverSelectionRevision: 0,
  editingTrackId: '',
  editingTrackStale: false,
  theme: DEFAULT_THEME,
  themeRevision: 0,
};

const elements = Object.fromEntries([
  'importButton', 'openPlaylistButton', 'savePlaylistButton', 'trackCount', 'playlist',
  'exportButton', 'programModeButton', 'programFrame', 'mediaElement', 'trackNumber', 'coverFrame',
  'coverImage', 'coverBackdropImage', 'trackTitle', 'trackArtist', 'trackSubmitter', 'trackGenre', 'visualizer', 'averageScore',
  'descriptionCard', 'descriptionScroll', 'previousButton', 'playButton', 'nextButton',
  'currentTime', 'progressInput', 'durationTime', 'volumeInput', 'mockNameInput', 'mockMessageInput',
  'commentOpacityInput', 'commentOpacityValue',
  'sendMockButton', 'dropOverlay', 'toastContainer', 'editTrackButton', 'backstageButton',
  'trackEditDialog', 'trackCoverPreview', 'chooseCoverButton', 'clearCoverButton',
  'trackTitleInput', 'trackComposerInput', 'trackSubmitterInput', 'trackGenreInput', 'trackDescriptionInput',
  'trackDescriptionVisibleInput', 'saveTrackMetadataButton',
].map((id) => [id, document.getElementById(id)]));

function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function hashName(value) {
  let hash = 5381;
  for (const char of value) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  return (hash >>> 0).toString(16);
}

function currentTrack() {
  return state.tracks[state.currentIndex] || null;
}

function trackCreator(track) {
  if (track?.composer?.trim()) return `作曲：${track.composer}`;
  if (track?.artist?.trim()) return `艺人：${track.artist}`;
  return '作曲 / 艺人：未标注';
}

function renderTrackCredits() {
  const track = currentTrack();
  elements.trackArtist.textContent = trackCreator(track);
  elements.trackSubmitter.textContent = track?.submitter || '待填写';
  elements.trackGenre.textContent = track?.genre || '待填写';
}

function themeFromHsl(hue, saturation, lightness) {
  function rgbAt(level) {
    const chroma = (1 - Math.abs(2 * level - 1)) * saturation;
    const secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const offset = level - chroma / 2;
    const sextant = Math.floor(hue / 60) % 6;
    const channels = [
      [chroma, secondary, 0], [secondary, chroma, 0], [0, chroma, secondary],
      [0, secondary, chroma], [secondary, 0, chroma], [chroma, 0, secondary],
    ][sextant];
    return channels.map((channel) => Math.round((channel + offset) * 255));
  }
  const relativeLuminance = (channels) => channels.reduce((sum, channel, index) => {
    const value = channel / 255;
    const linear = value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    return sum + linear * [.2126, .7152, .0722][index];
  }, 0);
  let adjustedLightness = lightness;
  let rgb = rgbAt(adjustedLightness);
  while (relativeLuminance(rgb) < .33 && adjustedLightness < .86) {
    adjustedLightness = Math.min(.86, adjustedLightness + .02);
    rgb = rgbAt(adjustedLightness);
  }
  const hex = (channels) => `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  return { color: hex(rgb), hover: hex(rgbAt(Math.min(.91, adjustedLightness + .08))), rgb: rgb.join(', ') };
}

function impressionTheme(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return DEFAULT_THEME;
  context.drawImage(image, 0, 0, 48, 48);
  const pixels = context.getImageData(0, 0, 48, 48).data;
  const bins = Array.from({ length: 18 }, () => ({ weight: 0, x: 0, y: 0, saturation: 0, lightness: 0 }));
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha < .5) continue;
    const red = pixels[index] / 255;
    const green = pixels[index + 1] / 255;
    const blue = pixels[index + 2] / 255;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const difference = maximum - minimum;
    const lightness = (maximum + minimum) / 2;
    const saturation = difference / (1 - Math.abs(2 * lightness - 1) || 1);
    if (saturation < .22 || lightness < .12 || lightness > .91) continue;
    let hue;
    if (maximum === red) hue = ((green - blue) / difference) % 6;
    else if (maximum === green) hue = (blue - red) / difference + 2;
    else hue = (red - green) / difference + 4;
    hue = (hue * 60 + 360) % 360;
    const weight = alpha * Math.pow(saturation, 1.3) * Math.sin(Math.PI * lightness);
    const bin = bins[Math.floor(hue / 20) % bins.length];
    bin.weight += weight;
    bin.x += Math.cos(hue * Math.PI / 180) * weight;
    bin.y += Math.sin(hue * Math.PI / 180) * weight;
    bin.saturation += saturation * weight;
    bin.lightness += lightness * weight;
  }
  let bestIndex = -1;
  let bestWeight = 0;
  for (let index = 0; index < bins.length; index += 1) {
    const score = bins[index].weight + .55 * (bins[(index + 17) % 18].weight + bins[(index + 1) % 18].weight);
    if (score > bestWeight) { bestWeight = score; bestIndex = index; }
  }
  if (bestIndex < 0) return NEUTRAL_THEME;
  let totalWeight = 0;
  let x = 0;
  let y = 0;
  let saturation = 0;
  let lightness = 0;
  for (const offset of [-1, 0, 1]) {
    const bin = bins[(bestIndex + offset + 18) % 18];
    const share = offset === 0 ? 1 : .55;
    totalWeight += bin.weight * share;
    x += bin.x * share;
    y += bin.y * share;
    saturation += bin.saturation * share;
    lightness += bin.lightness * share;
  }
  const hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const vividness = Math.max(.62, Math.min(.88, saturation / totalWeight * 1.15));
  const brightness = Math.max(.62, Math.min(.7, .65 + (lightness / totalWeight - .5) * .12));
  return themeFromHsl(hue, vividness, brightness);
}

function applyTheme(theme) {
  if (state.theme.color === theme.color) return;
  state.theme = theme;
  const root = document.documentElement.style;
  root.setProperty('--acid', theme.color);
  root.setProperty('--accent-rgb', theme.rgb);
  root.setProperty('--accent-hover', theme.hover);
  publishBackstageState();
}

function updateThemeFromCover(track) {
  const revision = ++state.themeRevision;
  const cover = track?.coverDataUrl || '';
  if (!cover) { applyTheme(DEFAULT_THEME); return; }
  if (track.themeCover === cover && track.theme) { applyTheme(track.theme); return; }
  const image = new Image();
  image.src = cover;
  image.decode().then(() => {
    if (revision !== state.themeRevision || currentTrack() !== track || track.coverDataUrl !== cover) return;
    const theme = impressionTheme(image);
    track.themeCover = cover;
    track.theme = theme;
    applyTheme(theme);
  }).catch(() => {
    if (revision === state.themeRevision && currentTrack() === track) applyTheme(DEFAULT_THEME);
  });
}

function renderTrackCover(track) {
  const cover = track?.coverDataUrl || '';
  elements.coverFrame.classList.toggle('has-cover', Boolean(cover));
  elements.programFrame.classList.toggle('has-cover-ambient', track?.type === 'audio' && Boolean(cover));
  if (cover) {
    elements.coverImage.src = cover;
    elements.coverBackdropImage.src = cover;
  } else {
    elements.coverImage.removeAttribute('src');
    elements.coverBackdropImage.removeAttribute('src');
  }
  elements.mediaElement.poster = track?.posterDataUrl || cover;
  updateThemeFromCover(track);
}

function trackForRound(roundId) {
  return state.tracks.find((track) => track.roundId === roundId) || null;
}

function publishBackstageState() {
  api.publishBackstageState({
    currentTrackId: currentTrack()?.id || '',
    sessionId: state.sessionId || '',
    themeAccent: state.theme.color,
    themeHover: state.theme.hover,
    tracks: state.tracks.map((track) => ({
      id: track.id,
      number: track.roundId,
      title: track.title,
      artist: track.artist || '',
      composer: track.composer || '',
      submitter: track.submitter || '',
      genre: track.genre || '',
      hasCover: Boolean(track.coverDataUrl),
      coverPath: track.coverPath || '',
      duration: track.duration || 0,
      type: track.type,
      description: track.description || '',
      descriptionVisible: Boolean(track.descriptionVisible),
    })),
    playback: {
      currentTime: elements.mediaElement.currentTime || 0,
      duration: Number.isFinite(elements.mediaElement.duration) ? elements.mediaElement.duration : currentTrack()?.duration || 0,
      paused: elements.mediaElement.paused,
      volume: Number(elements.volumeInput.value),
      commentOpacity: Number(elements.commentOpacityInput.value),
      programMode: document.body.classList.contains('program-mode'),
    },
  }).catch((error) => console.error('backstage sync failed', error));
}

function renderTrackDescription() {
  const track = currentTrack();
  const visible = Boolean(track && track.descriptionVisible && track.description?.trim());
  elements.descriptionCard.hidden = !visible;
  elements.descriptionScroll.textContent = visible ? track.description : '';
  elements.descriptionScroll.scrollTop = 0;
  clearInterval(state.descriptionScrollTimer);
  state.descriptionScrollTimer = null;
  if (!visible) return;
  let lastTick = performance.now();
  let pauseUntil = lastTick + 2000;
  let atEnd = false;
  state.descriptionScrollTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.min(100, now - lastTick);
    lastTick = now;
    const scroll = elements.descriptionScroll;
    const maximum = scroll.scrollHeight - scroll.clientHeight;
    if (elements.descriptionCard.hidden || maximum <= 1 || now < pauseUntil) return;
    if (atEnd) {
      scroll.scrollTop = 0;
      atEnd = false;
      pauseUntil = now + 2000;
      return;
    }
    scroll.scrollTop = Math.min(maximum, scroll.scrollTop + elapsed * 0.03);
    if (scroll.scrollTop >= maximum - 1) {
      atEnd = true;
      pauseUntil = now + 2500;
    }
  }, 50);
}

function showToast(message, type = 'info', duration = 3600) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
  api.sendBackstageFeedback(message, type).catch((error) => console.error('backstage feedback failed', error));
}

async function ensureArchive() {
  if (!state.sessionPromise) {
    state.sessionPromise = api.startArchive({ app: '品味大战', schemaVersion: 2 }).catch((error) => {
      state.sessionPromise = null;
      throw error;
    });
  }
  const session = await state.sessionPromise;
  const isNewSession = state.sessionId !== session.sessionId;
  state.sessionId = session.sessionId;
  state.sessionPath = session.filePath;
  if (isNewSession) publishBackstageState();
  return session;
}

function archive(entry) {
  state.archiveQueue = state.archiveQueue.then(async () => {
    const session = await ensureArchive();
    const record = { ...entry };
    if (Object.hasOwn(record, 'roundId')) {
      record.trackId = record.roundId;
      delete record.roundId;
    }
    await api.appendArchive(session.sessionId, record);
  }).catch((error) => {
    console.error('archive failed', error);
    state.archiveError = error.message || String(error);
    if (Date.now() - state.archiveWarningAt > 30_000) {
      state.archiveWarningAt = Date.now();
      showToast('存档写入失败：评分仍会显示，但导出可能不完整。请检查磁盘空间和存档目录权限。', 'error', 8000);
    }
  });
  return state.archiveQueue;
}

function renderPlaylist() {
  elements.trackCount.textContent = `${state.tracks.length} 首`;
  elements.editTrackButton.disabled = !currentTrack();
  elements.savePlaylistButton.disabled = state.tracks.length === 0;
  elements.playlist.innerHTML = '';
  elements.playlist.classList.toggle('empty', state.tracks.length === 0);

  if (!state.tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-playlist';
    empty.innerHTML = '<div class="drop-icon">⇩</div><strong>把媒体文件拖到这里</strong><span>支持 MP3 / FLAC / WAV / MP4 / WEBM</span>';
    elements.playlist.appendChild(empty);
    publishBackstageState();
    return;
  }

  state.tracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = `playlist-item${index === state.currentIndex ? ' active' : ''}`;
    item.dataset.index = String(index);

    const number = document.createElement('div');
    number.className = 'playlist-number';
    number.textContent = track.roundId;

    const copy = document.createElement('div');
    copy.className = 'playlist-copy';
    const title = document.createElement('strong');
    title.textContent = track.title;
    const artist = document.createElement('span');
    artist.textContent = track.composer || track.artist || (track.type === 'video' ? '视频文件' : '未标注艺人');
    copy.append(title, artist);

    const duration = document.createElement('span');
    duration.className = 'playlist-duration';
    duration.textContent = track.duration ? formatTime(track.duration) : '--:--';

    item.append(number, copy, duration);
    item.addEventListener('click', () => loadTrack(index, true));
    elements.playlist.appendChild(item);
  });
  publishBackstageState();
}

async function addTracks(items, { initialIndex = 0, announce = true } = {}) {
  if (!Array.isArray(items)) throw new Error('导入列表无效');
  const candidates = items.filter((item) => item && !item.error && item.url);
  const valid = candidates.slice(0, Math.max(0, MAX_TRACKS - state.tracks.length));
  const failed = items.filter((item) => item?.error);
  for (const item of valid) {
    item.roundId = String(state.tracks.length + 1).padStart(2, '0');
    item.composer = String(item.composer || '');
    item.submitter = String(item.submitter || '');
    item.genre = String(item.genre || '');
    item.description = String(item.description || '');
    item.descriptionVisible = Boolean(item.descriptionVisible);
    state.tracks.push(item);
    archive({
      type: 'track_added',
      roundId: item.roundId,
      trackTitle: item.title,
      artist: item.artist,
      composer: item.composer,
      submitter: item.submitter || '',
      genre: item.genre,
      mediaType: item.type,
      sourcePath: item.path,
    });
  }
  renderPlaylist();
  if (state.currentIndex < 0 && valid.length) loadTrack(Math.max(0, Math.min(valid.length - 1, initialIndex)), false);
  if (valid.length && announce) showToast(`已加入 ${valid.length} 个媒体文件`, 'success');
  if (candidates.length > valid.length) showToast(`播放队列最多 ${MAX_TRACKS} 首，多余文件未导入`, 'error');
  if (failed.length) showToast(`${failed.length} 个文件无法读取`, 'error');
}

async function savePlaylist() {
  if (!state.tracks.length) return;
  if (elements.trackEditDialog.open) {
    showToast('请先保存或关闭曲目信息编辑窗口，再保存歌单', 'error');
    return;
  }
  const snapshot = {
    currentIndex: state.currentIndex,
    tracks: state.tracks.map((track) => ({
      path: track.path,
      title: track.title,
      composer: track.composer,
      submitter: track.submitter,
      genre: track.genre,
      description: track.description,
      descriptionVisible: track.descriptionVisible,
      hasCover: Boolean(track.coverDataUrl),
      coverPath: track.coverPath || '',
    })),
  };
  try {
    const result = await api.savePlaylist(snapshot);
    if (result) showToast(`已保存 ${result.count} 首曲目的歌单`, 'success');
  } catch (error) {
    showToast(`保存歌单失败：${error.message}`, 'error', 6000);
  }
}

async function openPlaylist() {
  try {
    const loaded = await api.openPlaylist();
    if (!loaded) return;
    if (!Array.isArray(loaded.tracks) || !loaded.tracks.length) throw new Error('歌单没有可导入的曲目');
    const previous = currentTrack();
    if (previous) archive({ type: 'track_leave', roundId: previous.roundId,
      trackTitle: previous.title, position: elements.mediaElement.currentTime || 0 });
    elements.mediaElement.pause();
    elements.mediaElement.removeAttribute('src');
    elements.mediaElement.load();
    if (elements.trackEditDialog.open) elements.trackEditDialog.close();
    state.editingTrackId = '';
    state.coverSelectionRevision += 1;
    state.tracks = [];
    state.currentIndex = -1;
    state.scoresByRound.clear();
    state.seenMessageIds.clear();
    archive({ type: 'playlist_loaded', sourcePath: loaded.path, trackCount: loaded.tracks.length });
    await addTracks(loaded.tracks, { initialIndex: loaded.selectedIndex, announce: false });
    showToast(`已恢复 ${loaded.tracks.length} 首曲目及其资料${loaded.missing.length ? `；跳过 ${loaded.missing.length} 首缺失媒体` : ''}${loaded.missingCovers ? `；${loaded.missingCovers} 张封面未找到` : ''}`, 'success', 7000);
  } catch (error) {
    showToast(`导入歌单失败：${error.message}`, 'error', 7000);
  }
}

async function loadTrack(index, autoplay = false) {
  const track = state.tracks[index];
  if (!track) return;
  const previous = currentTrack();
  if (previous && previous.id !== track.id) {
    archive({ type: 'track_leave', roundId: previous.roundId, trackTitle: previous.title, position: elements.mediaElement.currentTime || 0 });
  }

  elements.mediaElement.pause();
  state.currentIndex = index;
  elements.mediaElement.src = track.url;
  elements.mediaElement.load();
  elements.programFrame.classList.remove('no-media');
  elements.programFrame.classList.toggle('video-mode', track.type === 'video');
  elements.trackNumber.textContent = track.roundId;
  elements.trackTitle.textContent = track.title;
  renderTrackCredits();
  renderTrackCover(track);
  renderTrackDescription();
  elements.durationTime.textContent = track.duration ? formatTime(track.duration) : '00:00';
  elements.currentTime.textContent = '00:00';
  elements.progressInput.value = '0';
  renderPlaylist();
  renderScore();
  archive({ type: 'track_enter', roundId: track.roundId, trackTitle: track.title, autoplay });

  if (autoplay) {
    try {
      await ensureAudioGraph();
      await elements.mediaElement.play();
    } catch (error) {
      showToast(`无法播放：${error.message}`, 'error');
    }
  }
}

async function ensureAudioGraph() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 256;
    state.analyser.smoothingTimeConstant = 0.78;
    state.mediaSource = state.audioContext.createMediaElementSource(elements.mediaElement);
    state.volumeGain = state.audioContext.createGain();
    state.volumeGain.gain.value = Number(elements.volumeInput.value);
    state.mediaSource.connect(state.volumeGain);
    state.volumeGain.connect(state.analyser);
    state.analyser.connect(state.audioContext.destination);
    state.captureDestination = state.audioContext.createMediaStreamDestination();
    state.volumeGain.connect(state.captureDestination);
  }
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
}

function setOutputVolume(value, publish = true) {
  const number = Number(value);
  const volume = Number.isFinite(number) ? Math.max(0, Math.min(MAX_OUTPUT_VOLUME, number)) : 0.85;
  elements.volumeInput.value = String(volume);
  elements.mediaElement.volume = 1;
  if (state.volumeGain) state.volumeGain.gain.value = volume;
  if (publish) publishBackstageState();
}

async function togglePlayback() {
  if (!currentTrack()) {
    showToast('请先导入媒体文件');
    return;
  }
  try {
    await ensureAudioGraph();
    if (elements.mediaElement.paused) await elements.mediaElement.play();
    else elements.mediaElement.pause();
  } catch (error) {
    showToast(`播放失败：${error.message}`, 'error');
  }
}

async function startStreamCapture({ id, mediaSourceId, testSeconds = 0 }) {
  if (state.streamCapture || state.pendingStreamId) throw new Error('已有画面采集正在运行');
  state.pendingStreamId = id;
  let displayStream;
  try {
    await ensureAudioGraph();
    try {
      if (!mediaSourceId) throw new Error('节目窗口缺少捕获标识');
      displayStream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: mediaSourceId, maxFrameRate: 30 } },
        audio: false,
      });
    } catch (error) {
      // Chromium versions differ in support for exact-window getUserMedia constraints.
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    }
    const videoTrack = displayStream.getVideoTracks()[0];
    if (state.cancelledStreamCaptures.delete(id)) throw new Error('采集已取消');
    const audioTrack = state.captureDestination.stream.getAudioTracks()[0];
    if (!videoTrack || !audioTrack) throw new Error('无法取得节目画面或应用音频');
    const combined = new MediaStream([videoTrack, audioTrack]);
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('当前 Chromium 不支持 WebM 实时编码');
    const recorder = new MediaRecorder(combined, {
      mimeType, videoBitsPerSecond: 4500000, audioBitsPerSecond: 160000,
    });
    const capture = { id, recorder, displayStream, pending: Promise.resolve(), timer: null };
    state.streamCapture = capture;
    state.pendingStreamId = null;
    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data.size) return;
      capture.pending = capture.pending.then(async () => {
        api.sendStreamChunk(id, new Uint8Array(await event.data.arrayBuffer()));
      });
    });
    recorder.addEventListener('error', (event) => api.sendStreamCaptureError(id, event.error?.message || '录制器发生错误'));
    recorder.addEventListener('stop', async () => {
      clearTimeout(capture.timer);
      displayStream.getTracks().forEach((track) => track.stop());
      try {
        await capture.pending;
        api.sendStreamCaptureStopped(id);
      } catch (error) {
        api.sendStreamCaptureError(id, error.message);
      }
      if (state.streamCapture === capture) state.streamCapture = null;
    });
    videoTrack.addEventListener('ended', () => stopStreamCapture(id));
    recorder.start(500);
    api.sendStreamCaptureReady(id);
    if (testSeconds) capture.timer = setTimeout(() => stopStreamCapture(id), testSeconds * 1000);
  } catch (error) {
    state.pendingStreamId = null;
    state.cancelledStreamCaptures.delete(id);
    displayStream?.getTracks().forEach((track) => track.stop());
    api.sendStreamCaptureError(id, error.message);
  }
}

function stopStreamCapture(id) {
  const capture = state.streamCapture;
  if (!capture || capture.id !== id) {
    if (state.pendingStreamId === id) state.cancelledStreamCaptures.add(id);
    return;
  }
  if (capture.recorder.state !== 'inactive') capture.recorder.stop();
}

function goRelative(offset) {
  if (!state.tracks.length) return;
  const next = (state.currentIndex + offset + state.tracks.length) % state.tracks.length;
  loadTrack(next, true);
}

function renderTrackCoverPreview(dataUrl) {
  elements.trackCoverPreview.innerHTML = '';
  if (!dataUrl) {
    const placeholder = document.createElement('span');
    placeholder.textContent = '暂无封面';
    elements.trackCoverPreview.appendChild(placeholder);
    return;
  }
  const image = document.createElement('img');
  image.src = dataUrl;
  image.alt = '待保存的曲目封面';
  elements.trackCoverPreview.appendChild(image);
}

function openTrackEditor() {
  const track = currentTrack();
  if (!track) {
    showToast('请先导入并选择一首曲目');
    return;
  }
  state.editingTrackId = track.id;
  state.coverSelectionRevision += 1;
  state.editingTrackStale = false;
  state.pendingCoverDataUrl = track.coverDataUrl || '';
  state.pendingCoverPath = track.coverPath || '';
  elements.trackTitleInput.value = track.title || '';
  elements.trackComposerInput.value = track.composer || '';
  elements.trackSubmitterInput.value = track.submitter || '';
  elements.trackGenreInput.value = track.genre || '';
  elements.trackDescriptionInput.value = track.description || '';
  elements.trackDescriptionVisibleInput.checked = Boolean(track.descriptionVisible);
  renderTrackCoverPreview(state.pendingCoverDataUrl);
  elements.trackEditDialog.showModal();
}

async function chooseTrackCover() {
  const editingTrackId = state.editingTrackId;
  const coverSelectionRevision = ++state.coverSelectionRevision;
  try {
    const selected = await api.selectCover();
    if (!selected) return;
    await window.validateCoverImage(selected.dataUrl);
    if (!elements.trackEditDialog.open || state.editingTrackId !== editingTrackId
      || state.coverSelectionRevision !== coverSelectionRevision) return;
    state.pendingCoverDataUrl = selected.dataUrl || '';
    state.pendingCoverPath = selected.path || '';
    renderTrackCoverPreview(state.pendingCoverDataUrl);
  } catch (error) {
    if (!elements.trackEditDialog.open || state.editingTrackId !== editingTrackId
      || state.coverSelectionRevision !== coverSelectionRevision) return;
    showToast(`封面导入失败：${error.message}`, 'error');
  }
}

function saveTrackMetadata() {
  const track = state.tracks.find((item) => item.id === state.editingTrackId);
  if (!track) {
    showToast('正在编辑的曲目已不存在', 'error');
    return;
  }
  if (state.editingTrackStale) {
    showToast('该曲目已在后台修改，请关闭编辑窗口并重新打开后再保存', 'error');
    return;
  }
  const title = elements.trackTitleInput.value.trim();
  if (!title) {
    showToast('曲目名称不能为空', 'error');
    elements.trackTitleInput.focus();
    return;
  }

  track.title = title;
  track.composer = elements.trackComposerInput.value.trim().slice(0, 80);
  track.submitter = elements.trackSubmitterInput.value.trim();
  track.genre = elements.trackGenreInput.value.trim();
  track.coverDataUrl = state.pendingCoverDataUrl;
  track.coverPath = state.pendingCoverPath;
  track.description = elements.trackDescriptionInput.value.trim();
  track.descriptionVisible = elements.trackDescriptionVisibleInput.checked;
  if (track.id === currentTrack()?.id) {
    elements.trackTitle.textContent = track.title;
    renderTrackCredits();
    renderTrackCover(track);
    renderTrackDescription();
  }
  renderPlaylist();
  archive({
    type: 'track_metadata_updated',
    roundId: track.roundId,
    trackTitle: track.title,
    composer: track.composer,
    submitter: track.submitter,
    genre: track.genre,
    coverPath: track.coverPath,
    description: track.description,
    descriptionVisible: track.descriptionVisible,
  });
  elements.trackEditDialog.close();
  state.editingTrackId = '';
  state.editingTrackStale = false;
  showToast('曲目信息已更新', 'success');
}

function applyBackstageUpdate(update) {
  const track = state.tracks.find((item) => item.id === update.id);
  if (!track) return;
  const previousTitle = track.title;
  const previousComposer = track.composer || '';
  const previousSubmitter = track.submitter || '';
  const previousGenre = track.genre || '';
  const previousCover = track.coverDataUrl || '';
  const previousDescription = track.description || '';
  const previousVisible = Boolean(track.descriptionVisible);
  if (typeof update.title === 'string' && update.title.trim()) track.title = update.title.trim().slice(0, 120);
  if (typeof update.composer === 'string') track.composer = update.composer.trim().slice(0, 80);
  if (typeof update.submitter === 'string') track.submitter = update.submitter.trim().slice(0, 80);
  if (typeof update.genre === 'string') track.genre = update.genre.trim().slice(0, 80);
  if (typeof update.coverDataUrl === 'string') {
    track.coverDataUrl = update.coverDataUrl;
    track.coverPath = update.coverPath || '';
  }
  if (typeof update.description === 'string') track.description = update.description.trim();
  if (typeof update.descriptionVisible === 'boolean') track.descriptionVisible = update.descriptionVisible;
  const metadataChanged = track.title !== previousTitle
    || (track.composer || '') !== previousComposer
    || (track.submitter || '') !== previousSubmitter
    || (track.genre || '') !== previousGenre
    || (track.coverDataUrl || '') !== previousCover;
  if (!metadataChanged && track.description === previousDescription && track.descriptionVisible === previousVisible) return;
  if (track.id === state.editingTrackId && elements.trackEditDialog.open) {
    state.editingTrackStale = true;
    showToast('该曲目已在后台修改，当前编辑窗口需要重新打开', 'error');
  }
  if (track.id === currentTrack()?.id) {
    elements.trackTitle.textContent = track.title;
    renderTrackCredits();
    renderTrackCover(track);
    renderTrackDescription();
  }
  renderPlaylist();
  archive({
    type: metadataChanged ? 'track_metadata_updated' : 'track_description_updated',
    roundId: track.roundId,
    trackTitle: track.title,
    composer: track.composer || '',
    submitter: track.submitter || '',
    genre: track.genre || '',
    coverPath: track.coverPath || '',
    description: track.description,
    descriptionVisible: track.descriptionVisible,
  });
}

function renderScore() {
  const roundId = currentTrack()?.roundId;
  const scores = roundId ? [...(state.scoresByRound.get(roundId)?.values() || [])] : [];
  if (!scores.length) {
    elements.averageScore.textContent = '--';
    return;
  }
  const average = scores.reduce((total, entry) => total + entry.score, 0) / scores.length;
  elements.averageScore.textContent = average.toFixed(1);
}

function processScoreInput(data) {
  const msgId = String(data.msg_id || crypto.randomUUID());
  if (state.seenMessageIds.has(msgId)) return;
  state.seenMessageIds.add(msgId);
  if (state.seenMessageIds.size > 10_000) {
    const oldest = state.seenMessageIds.values().next().value;
    state.seenMessageIds.delete(oldest);
  }

  const parsed = parseScore(data.msg, { currentRound: currentTrack()?.roundId });
  if (parsed.type === 'invalid') {
    showToast(parsed.reason, 'error');
    return;
  }
  if (parsed.type !== 'score') {
    showToast('请输入评分，例如 #01 8.5 或 评分 8.5', 'error');
    return;
  }

  const targetTrack = trackForRound(parsed.roundId);
  if (!targetTrack) {
    showToast(`找不到编号 ${parsed.roundId} 的曲目`, 'error');
    return;
  }

  const openId = String(data.open_id || `local:${data.uname || 'anonymous'}`);
  const actor = {
    openId,
    uname: data.uname || '匿名评分人',
    msgId,
    roundId: parsed.roundId,
    trackTitle: targetTrack.title,
  };
  let roundScores = state.scoresByRound.get(parsed.roundId);
  if (!roundScores) {
    roundScores = new Map();
    state.scoresByRound.set(parsed.roundId, roundScores);
  }
  roundScores.set(openId, { ...actor, score: parsed.score });
  archive({ type: 'score', ...actor, score: parsed.score, rawMessage: parsed.raw });
  if (parsed.roundId === currentTrack()?.roundId) renderScore();
}

function submitLocalScore() {
  const message = elements.mockMessageInput.value.trim();
  if (!message) return;
  const name = elements.mockNameInput.value.trim() || '测试观众';
  emitLocalScore(name, message);
  elements.mockMessageInput.value = '';
  elements.mockMessageInput.focus();
}

function emitLocalScore(name, message) {
  processScoreInput({
    open_id: `mock-${hashName(name)}`,
    uname: name,
    msg: message,
    msg_id: crypto.randomUUID(),
  });
}

async function exportArchive() {
  try {
    await state.archiveQueue;
    const session = await ensureArchive();
    const result = await api.exportArchiveCsv(session.sessionId);
    if (result) showToast(result.incomplete
      ? `已导出 ${result.count} 条评分，但存档写入曾失败，文件可能不完整`
      : `已导出 ${result.count} 条评分`, result.incomplete ? 'error' : 'success', 8000);
  } catch (error) {
    showToast(`导出失败：${error.message}`, 'error');
  }
}

async function enterProgramMode() {
  document.body.classList.add('program-mode');
  publishBackstageState();
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    // Electron window capture still works without OS fullscreen.
  }
  api.openBackstage().catch((error) => console.error('open backstage failed', error));
}

function leaveProgramMode() {
  document.body.classList.remove('program-mode');
  publishBackstageState();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function setupMediaEvents() {
  const media = elements.mediaElement;
  setOutputVolume(elements.volumeInput.value, false);
  media.addEventListener('play', () => {
    elements.playButton.textContent = 'Ⅱ';
    elements.programFrame.classList.add('playing');
    publishBackstageState();
  });
  media.addEventListener('pause', () => {
    elements.playButton.textContent = '▶';
    elements.programFrame.classList.remove('playing');
    publishBackstageState();
  });
  media.addEventListener('loadedmetadata', () => {
    const track = currentTrack();
    if (track && Number.isFinite(media.duration)) track.duration = media.duration;
    elements.durationTime.textContent = formatTime(media.duration);
    renderPlaylist();
  });
  media.addEventListener('timeupdate', () => {
    elements.currentTime.textContent = formatTime(media.currentTime);
    const progress = media.duration ? Math.round((media.currentTime / media.duration) * 1000) : 0;
    elements.progressInput.value = String(progress);
    if (Date.now() - state.lastProgressPublish > 400) {
      state.lastProgressPublish = Date.now();
      publishBackstageState();
    }
  });
  media.addEventListener('ended', () => {
    archive({ type: 'track_completed', roundId: currentTrack()?.roundId, trackTitle: currentTrack()?.title });
    goRelative(1);
  });
  media.addEventListener('error', () => {
    const code = media.error?.code || '?';
    showToast(`媒体无法播放（错误 ${code}），可能是不支持的编码格式`, 'error', 6000);
  });
}

function setCommentOpacity(value, persist = true) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  const alpha = percent / 100;
  elements.commentOpacityInput.value = String(percent);
  elements.commentOpacityValue.value = `${Math.round(percent)}%`;
  document.documentElement.style.setProperty('--comment-panel-alpha', alpha.toFixed(2));
  document.documentElement.style.setProperty('--comment-panel-blur', `${Math.round(alpha * 14)}px`);
  document.documentElement.style.setProperty('--comment-panel-border-alpha', (alpha * .15).toFixed(3));
  if (persist) localStorage.setItem('commentPanelOpacity', String(percent));
  publishBackstageState();
}

async function handleBackstageCommand(command) {
  const payload = command.payload || {};
  switch (command.type) {
    case 'import':
      if (!Array.isArray(payload.items)) throw new Error('导入列表无效');
      await addTracks(payload.items);
      break;
    case 'save-playlist':
      await savePlaylist();
      break;
    case 'open-playlist':
      await openPlaylist();
      break;
    case 'select-track': {
      const index = state.tracks.findIndex((track) => track.id === payload.id);
      if (index < 0) throw new Error('曲目已不存在');
      await loadTrack(index, true);
      break;
    }
    case 'play-pause':
      await togglePlayback();
      break;
    case 'previous':
      goRelative(-1);
      break;
    case 'next':
      goRelative(1);
      break;
    case 'seek': {
      const duration = elements.mediaElement.duration;
      if (Number.isFinite(duration) && duration > 0) {
        const progress = Math.max(0, Math.min(1000, Number(payload.progress) || 0));
        elements.mediaElement.currentTime = duration * progress / 1000;
        publishBackstageState();
      }
      break;
    }
    case 'volume': {
      setOutputVolume(payload.value);
      break;
    }
    case 'comment-opacity':
      setCommentOpacity(payload.value);
      break;
    case 'submit-score': {
      const message = String(payload.message || '').trim();
      if (!message) throw new Error('请输入评分');
      emitLocalScore(String(payload.name || '').trim() || '测试观众', message);
      break;
    }
    case 'leave-program':
      leaveProgramMode();
      break;
    default:
      throw new Error('不支持的后台操作');
  }
}

function setupVisualizer() {
  const canvas = elements.visualizer;
  const context = canvas.getContext('2d');
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  function draw(now) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    context.clearRect(0, 0, width, height);
    const barCount = 26;
    let values;
    if (state.analyser) {
      values = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(values);
    }
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
    for (let i = 0; i < barCount; i += 1) {
      const sampleIndex = values ? Math.floor((i / barCount) * values.length * 0.72) : 0;
      const idle = (Math.sin(now / 520 + i * .6) + 1) * .05 + .05;
      const ratio = values ? Math.max(.035, values[sampleIndex] / 255) : idle;
      const barHeight = Math.max(2, ratio * height * .9);
      const gradient = context.createLinearGradient(0, height - barHeight, 0, height);
      gradient.addColorStop(0, state.theme.color);
      gradient.addColorStop(1, '#ff674d');
      context.fillStyle = gradient;
      context.beginPath();
      context.roundRect(i * (barWidth + gap), height - barHeight, barWidth, barHeight, 2);
      context.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

function setupDragAndDrop() {
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    state.dragDepth += 1;
    elements.dropOverlay.classList.add('visible');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) elements.dropOverlay.classList.remove('visible');
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    elements.dropOverlay.classList.remove('visible');
    const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    try {
      await addTracks(await api.inspectMedia(paths));
    } catch (error) {
      showToast(`导入失败：${error.message}`, 'error');
    }
  });
}

function bindEvents() {
  elements.importButton.addEventListener('click', async () => {
    try { await addTracks(await api.selectMedia()); }
    catch (error) { showToast(`导入失败：${error.message}`, 'error'); }
  });
  elements.openPlaylistButton.addEventListener('click', openPlaylist);
  elements.savePlaylistButton.addEventListener('click', savePlaylist);
  elements.editTrackButton.addEventListener('click', openTrackEditor);
  elements.backstageButton.addEventListener('click', () => {
    api.openBackstage().catch((error) => showToast(`后台窗口无法打开：${error.message}`, 'error'));
  });
  elements.chooseCoverButton.addEventListener('click', chooseTrackCover);
  elements.clearCoverButton.addEventListener('click', () => {
    state.coverSelectionRevision += 1;
    state.pendingCoverDataUrl = '';
    state.pendingCoverPath = '';
    renderTrackCoverPreview('');
  });
  elements.saveTrackMetadataButton.addEventListener('click', saveTrackMetadata);
  elements.playButton.addEventListener('click', togglePlayback);
  elements.previousButton.addEventListener('click', () => goRelative(-1));
  elements.nextButton.addEventListener('click', () => goRelative(1));
  elements.progressInput.addEventListener('input', () => {
    if (elements.mediaElement.duration) {
      elements.mediaElement.currentTime = (Number(elements.progressInput.value) / 1000) * elements.mediaElement.duration;
    }
  });
  elements.volumeInput.addEventListener('input', () => {
    setOutputVolume(elements.volumeInput.value);
  });
  elements.commentOpacityInput.addEventListener('input', () => setCommentOpacity(elements.commentOpacityInput.value));
  elements.sendMockButton.addEventListener('click', submitLocalScore);
  elements.mockMessageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitLocalScore();
  });
  elements.exportButton.addEventListener('click', exportArchive);
  elements.programModeButton.addEventListener('click', enterProgramMode);
  elements.programFrame.addEventListener('dblclick', () => {
    if (!document.body.classList.contains('program-mode')) enterProgramMode();
  });
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyD') {
      event.preventDefault();
      api.openBackstage().catch((error) => console.error('open backstage failed', error));
    }
    if (event.key === 'Escape' && document.body.classList.contains('program-mode')) leaveProgramMode();
    const focused = document.activeElement;
    const typingOrDialog = focused?.closest('input, textarea, select, button, [contenteditable], [role="textbox"]')
      || document.querySelector('dialog[open]');
    if (event.code === 'Space' && !event.repeat && !event.defaultPrevented && !typingOrDialog) {
      event.preventDefault();
      togglePlayback();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('program-mode');
    publishBackstageState();
  });

  api.onBackstageUpdate(applyBackstageUpdate);
  api.onBackstageCommand((command) => {
    handleBackstageCommand(command).catch((error) => showToast(error.message, 'error', 6000));
  });
  api.onStreamStartCapture((payload) => {
    startStreamCapture(payload).catch((error) => api.sendStreamCaptureError(payload.id, error.message));
  });
  api.onStreamStopCapture((payload) => stopStreamCapture(payload.id));
}

async function initialize() {
  const query = new URLSearchParams(window.location.search);
  setCommentOpacity(localStorage.getItem('commentPanelOpacity') ?? 72, false);
  renderPlaylist();
  renderScore();
  setupMediaEvents();
  setupVisualizer();
  setupDragAndDrop();
  bindEvents();
  ensureArchive().catch((error) => showToast(`无法创建存档：${error.message}`, 'error'));
  if (query.get('qa') === '1') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#ff674d"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs><rect width="700" height="700" fill="url(#g)"/><circle cx="350" cy="350" r="225" fill="#101218"/><circle cx="350" cy="350" r="92" fill="#d8ff3e"/><text x="350" y="630" text-anchor="middle" font-family="sans-serif" font-size="44" font-weight="700" fill="white">NIGHT SIGNAL</text></svg>`;
    const silentWav = new Uint8Array(44 + 8000 * 2);
    const view = new DataView(silentWav.buffer);
    const write = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, silentWav.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
    view.setUint32(40, silentWav.length - 44, true);
    if (query.get('tone') === '1') {
      for (let sample = 0; sample < 8000; sample += 1) {
        view.setInt16(44 + sample * 2, Math.round(Math.sin(2 * Math.PI * 440 * sample / 8000) * 12000), true);
      }
    }
    const qaVideo = query.get('video') === '1';
    await addTracks([{
      id: 'qa-track', path: 'qa-demo.wav', url: URL.createObjectURL(new Blob([silentWav], { type: 'audio/wav' })),
      type: qaVideo ? 'video' : 'audio', title: qaVideo ? 'Midnight Session' : 'Night Signal', artist: 'The Afterglow', album: 'QA Demo', duration: 1,
      submitter: '凌晨四点投稿',
      description: '一首从城市夜色里长出来的歌。留意后半段逐层叠起的低频与合成器。',
      descriptionVisible: true,
      coverDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      posterDataUrl: qaVideo ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="v" x2="1" y2="1"><stop stop-color="#17204d"/><stop offset=".52" stop-color="#60305c"/><stop offset="1" stop-color="#df6c59"/></linearGradient></defs><rect width="1600" height="900" fill="url(#v)"/><circle cx="1220" cy="230" r="130" fill="#ffd98a" opacity=".9"/><path d="M0 690L270 470 500 650 780 340 1120 720 1400 500 1600 650V900H0Z" fill="#10131e"/><text x="90" y="120" font-family="sans-serif" font-size="36" fill="white" opacity=".7">MIDNIGHT SESSION</text></svg>`)}` : '',
    }]);
    processScoreInput({ open_id: 'qa-1', uname: '银河汽水', msg: '#01 9.2', msg_id: 'qa-score-1' });
    processScoreInput({ open_id: 'qa-2', uname: '纸飞机', msg: '#01 8.5', msg_id: 'qa-score-2' });
    processScoreInput({ open_id: 'qa-3', uname: '低频收藏家', msg: '#01 7.8', msg_id: 'qa-score-3' });
    processScoreInput({ open_id: 'qa-1', uname: '银河汽水', msg: '#01 9.7', msg_id: 'qa-score-1-revised' });
    if (qaVideo) setCommentOpacity(46, false);
  }
  if (query.get('program') === '1') {
    document.body.classList.add('program-mode');
    publishBackstageState();
  }
}

initialize().catch((error) => showToast(`初始化失败：${error.message}`, 'error', 8000));
