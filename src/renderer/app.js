'use strict';

const api = window.tasteArena;
const MAX_TRACKS = 500;
const MAX_OUTPUT_VOLUME = 1.25;
const DEFAULT_THEME = { color: '#ffffff', hover: '#e9e9e9', rgb: '255, 255, 255' };

const state = {
  tracks: [],
  currentIndex: -1,
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
  descriptionScrollFrame: null,
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
  audioEngine: 'foobar',
  foobarState: null,
  foobarTrackId: '',
  foobarWasPlaying: false,
  foobarCompletedId: '',
  loadRevision: 0,
  seekDragging: false,
  volumeDragging: false,
  shadowSyncing: false,
  shadowAnalysisUnavailable: false,
  titleResizeObserver: null,
};

const elements = Object.fromEntries([
  'importButton', 'openPlaylistButton', 'savePlaylistButton', 'trackCount', 'playlist',
  'exportButton', 'programModeButton', 'programFrame', 'mediaElement', 'trackNumber', 'coverFrame',
  'coverImage', 'coverBackdropImage', 'trackTitle', 'trackTitleText', 'trackTitleRepeat', 'trackArtist', 'trackSubmitter', 'visualizer',
  'descriptionCard', 'descriptionScroll', 'previousButton', 'playButton', 'nextButton',
  'currentTime', 'progressInput', 'durationTime', 'volumeInput',
  'commentOpacityInput', 'commentOpacityValue',
  'dropOverlay', 'toastContainer', 'editTrackButton', 'backstageButton',
  'trackEditDialog', 'trackCoverPreview', 'chooseCoverButton', 'clearCoverButton',
  'trackTitleInput', 'trackComposerInput', 'trackSubmitterInput', 'trackGenreInput', 'trackDescriptionInput',
  'trackDescriptionVisibleInput', 'saveTrackMetadataButton',
  'audioEngineSelect', 'trackGenreDisplay',
].map((id) => [id, document.getElementById(id)]));

function isFoobarTrack() {
  return state.audioEngine === 'foobar' && currentTrack()?.type === 'audio';
}

function externalName() {
  return 'foobar2000';
}

function externalOpen(filePath) {
  return api.foobarOpen(filePath);
}

function externalCommand(type, args) {
  return api.foobarCommand(type, args);
}

function playbackPosition() {
  return isFoobarTrack() && state.foobarTrackId === currentTrack()?.id
    ? Number(state.foobarState?.currentTime || 0) : elements.mediaElement.currentTime || 0;
}

function playbackDuration() {
  return isFoobarTrack() && state.foobarTrackId === currentTrack()?.id
    ? Number(state.foobarState?.duration || currentTrack()?.duration || 0)
    : Number.isFinite(elements.mediaElement.duration) ? elements.mediaElement.duration : currentTrack()?.duration || 0;
}

function playbackPaused() {
  return isFoobarTrack() ? (state.foobarState?.paused ?? true) : elements.mediaElement.paused;
}

function updatePlaybackDisplay(position, duration, paused) {
  elements.currentTime.textContent = formatTime(position);
  elements.durationTime.textContent = formatTime(duration);
  if (!state.seekDragging) elements.progressInput.value = duration > 0 ? String(Math.round(position / duration * 1000)) : '0';
  elements.playButton.textContent = paused ? '▶' : 'Ⅱ';
  elements.programFrame.classList.toggle('playing', !paused);
  publishBackstageState();
}

async function syncShadowPlayback(next) {
  if (!isFoobarTrack() || !state.foobarTrackId || state.shadowSyncing || state.shadowAnalysisUnavailable) return;
  const trackId = state.foobarTrackId;
  const media = elements.mediaElement;
  state.shadowSyncing = true;
  try {
    await ensureAudioGraph();
    if (!isFoobarTrack() || state.foobarTrackId !== trackId) return;
    state.volumeGain.gain.value = 0;
    if (media.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const limit = Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.05) : next.currentTime;
    const target = Math.max(0, Math.min(Number(next.currentTime) || 0, limit));
    if (Math.abs(media.currentTime - target) > 0.4) media.currentTime = target;
    if (next.paused) media.pause();
    else if (media.paused) await media.play();
  } catch (error) {
    if (!isFoobarTrack() || state.foobarTrackId !== trackId) return;
    const firstFailure = !state.shadowAnalysisUnavailable;
    state.shadowAnalysisUnavailable = true;
    media.pause();
    if (firstFailure) showToast('当前音频无法用于实时频谱分析，已改用动态效果', 'info', 6000);
    console.warn('External-player silent analysis unavailable', error);
  } finally {
    state.shadowSyncing = false;
  }
}

function applyFoobarState(next) {
  if (!isFoobarTrack()) return;
  if (next.unavailable) {
    const message = next.message || `${externalName()} 连接中断`;
    const lastPosition = Number(state.foobarState?.currentTime || 0);
    state.audioEngine = 'builtin';
    state.foobarTrackId = '';
    state.foobarState = null;
    elements.audioEngineSelect.value = 'builtin';
    api.foobarCommand('close').catch(() => {});
    elements.mediaElement.pause();
    if (state.volumeGain) state.volumeGain.gain.value = Number(elements.volumeInput.value);
    if (lastPosition > 0 && Number.isFinite(elements.mediaElement.duration)) {
      elements.mediaElement.currentTime = Math.min(lastPosition, elements.mediaElement.duration || 0);
    }
    showToast(`${message}；已切回内置播放器`, 'error', 7000);
    updatePlaybackDisplay(elements.mediaElement.currentTime || 0, playbackDuration(), true);
    return;
  }
  if (state.foobarTrackId !== currentTrack()?.id) return;
  const track = currentTrack();
  const previous = state.foobarState;
  const knownDuration = Number(next.duration || previous?.duration || track.duration || 0);
  const wrapped = state.foobarWasPlaying && previous && !previous.paused && !next.paused
    && knownDuration > 0 && previous.currentTime >= knownDuration - 1.5 && next.currentTime < 1;
  if (wrapped) {
    externalCommand('pause').catch((error) => showToast(`歌曲结束后暂停失败：${error.message}`, 'error'));
  }
  if (state.foobarCompletedId === track.id && !next.paused && next.currentTime < knownDuration - 1) {
    state.foobarCompletedId = '';
  }
  const reachedEnd = state.foobarWasPlaying && (next.idle || wrapped) && knownDuration > 0
    && (next.currentTime >= knownDuration - 1.5 || previous?.currentTime >= knownDuration - 1.5);
  if (reachedEnd && state.foobarCompletedId !== track.id) {
    state.foobarCompletedId = track.id;
    archive({ type: 'track_completed', roundId: track.roundId, trackTitle: track.title });
  }
  if (state.foobarCompletedId === track.id && (next.idle || wrapped)) {
    next = { ...next, currentTime: knownDuration, duration: knownDuration, paused: true, idle: true };
  }
  state.foobarState = next;
  if (next.duration > 0) track.duration = next.duration;
  if (Number.isFinite(next.volume) && !state.volumeDragging) {
    elements.volumeInput.value = String(Math.min(MAX_OUTPUT_VOLUME, Math.max(0, next.volume / 80)));
  }
  updatePlaybackDisplay(next.currentTime, next.duration || track.duration || 0, next.paused);
  syncShadowPlayback(next);
  if (!next.paused) state.foobarWasPlaying = true;
}

function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function currentTrack() {
  return state.tracks[state.currentIndex] || null;
}

function refreshTrackTitleScroll() {
  const viewport = elements.trackTitle;
  const text = elements.trackTitleText;
  viewport.classList.remove('title-scrolling');
  if (!viewport.clientWidth) return;
  const overflow = Math.ceil(text.scrollWidth - viewport.clientWidth);
  if (overflow <= 4) return;
  viewport.style.setProperty('--title-scroll-distance', `${-overflow}px`);
  viewport.style.setProperty('--title-scroll-duration', `${Math.max(8, 4 + overflow / 24).toFixed(1)}s`);
  viewport.classList.add('title-scrolling');
}

function setTrackTitle(title) {
  elements.trackTitleText.textContent = title;
  refreshTrackTitleScroll();
}

function trackCreator(track) {
  return track?.composer?.trim() || '作曲未标注';
}

function renderTrackCredits() {
  const track = currentTrack();
  elements.trackArtist.textContent = trackCreator(track);
  elements.trackSubmitter.textContent = track?.submitter || '投稿人待填写';
  const genre = track?.genre?.trim() || '';
  elements.trackGenreDisplay.textContent = genre;
  elements.trackGenreDisplay.hidden = !genre;
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
      currentTime: playbackPosition(),
      duration: playbackDuration(),
      paused: playbackPaused(),
      volume: Number(elements.volumeInput.value),
      audioEngine: state.audioEngine,
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
  cancelAnimationFrame(state.descriptionScrollFrame);
  state.descriptionScrollFrame = null;
  if (!visible) return;
  let lastTick = performance.now();
  let pauseUntil = lastTick + 2000;
  let atEnd = false;
  let position = 0;
  let renderedPosition = 0;
  const tick = (now) => {
    state.descriptionScrollFrame = requestAnimationFrame(tick);
    const elapsed = Math.min(100, now - lastTick);
    lastTick = now;
    const scroll = elements.descriptionScroll;
    const maximum = scroll.scrollHeight - scroll.clientHeight;
    if (elements.descriptionCard.hidden || maximum <= 1) return;
    if (Math.abs(scroll.scrollTop - renderedPosition) > .5) {
      position = Math.max(0, Math.min(maximum, scroll.scrollTop));
      renderedPosition = scroll.scrollTop;
      atEnd = false;
      pauseUntil = now + 1500;
    }
    if (now < pauseUntil) return;
    if (atEnd) {
      position = 0;
      scroll.scrollTop = 0;
      renderedPosition = 0;
      atEnd = false;
      pauseUntil = now + 2000;
      return;
    }
    position = Math.min(maximum, position + elapsed * 0.03);
    const nextPosition = Math.floor(position);
    if (nextPosition !== renderedPosition) {
      scroll.scrollTop = nextPosition;
      renderedPosition = scroll.scrollTop;
    }
    if (position >= maximum) {
      atEnd = true;
      pauseUntil = now + 2500;
    }
  };
  state.descriptionScrollFrame = requestAnimationFrame(tick);
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
      showToast('播放记录写入失败；请检查磁盘空间和存档目录权限。', 'error', 8000);
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

function reorderTrack(id, targetId, placement) {
  const from = state.tracks.findIndex((track) => track.id === id);
  const target = state.tracks.findIndex((track) => track.id === targetId);
  if (from < 0 || target < 0 || !['before', 'after'].includes(placement)) {
    throw new Error('无法调整播放顺序：曲目已变化');
  }
  let insertion = target + (placement === 'after' ? 1 : 0);
  if (from < insertion) insertion -= 1;
  if (from === insertion) return;
  const currentId = currentTrack()?.id;
  const [moved] = state.tracks.splice(from, 1);
  state.tracks.splice(insertion, 0, moved);
  state.tracks.forEach((track, index) => { track.roundId = String(index + 1).padStart(2, '0'); });
  state.currentIndex = state.tracks.findIndex((track) => track.id === currentId);
  if (state.currentIndex >= 0) elements.trackNumber.textContent = String(state.currentIndex + 1);
  archive({ type: 'track_reordered', trackId: moved.id, trackTitle: moved.title, from: from + 1, to: insertion + 1 });
  renderPlaylist();
  api.sendBackstageFeedback(`已将《${moved.title}》移到 TRACK ${insertion + 1}`, 'info').catch(() => {});
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
      trackTitle: previous.title, position: playbackPosition() });
    if (state.foobarTrackId) await externalCommand('close').catch(() => {});
    state.foobarTrackId = '';
    state.foobarState = null;
    elements.mediaElement.pause();
    elements.mediaElement.removeAttribute('src');
    elements.mediaElement.load();
    if (elements.trackEditDialog.open) elements.trackEditDialog.close();
    state.editingTrackId = '';
    state.coverSelectionRevision += 1;
    state.tracks = [];
    state.currentIndex = -1;
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
  const revision = ++state.loadRevision;
  const previous = currentTrack();
  if (previous && previous.id !== track.id) {
    archive({ type: 'track_leave', roundId: previous.roundId, trackTitle: previous.title, position: playbackPosition() });
  }

  elements.mediaElement.pause();
  state.shadowAnalysisUnavailable = false;
  if (state.foobarTrackId && (!autoplay || track.type === 'video' || state.audioEngine !== 'foobar')) {
    await externalCommand('close').catch(() => {});
    state.foobarTrackId = '';
    state.foobarState = null;
  }
  state.currentIndex = index;
  state.foobarCompletedId = '';
  state.foobarWasPlaying = false;
  if (isFoobarTrack()) { state.foobarTrackId = ''; state.foobarState = null; }
  if (state.volumeGain) state.volumeGain.gain.value = isFoobarTrack() ? 0 : Number(elements.volumeInput.value);
  elements.mediaElement.src = track.url;
  elements.mediaElement.load();
  elements.programFrame.classList.remove('no-media');
  elements.programFrame.classList.toggle('video-mode', track.type === 'video');
  elements.trackNumber.textContent = String(Number(track.roundId));
  setTrackTitle(track.title);
  elements.trackTitleRepeat.textContent = track.title;
  renderTrackCredits();
  renderTrackCover(track);
  renderTrackDescription();
  elements.durationTime.textContent = track.duration ? formatTime(track.duration) : '00:00';
  elements.currentTime.textContent = '00:00';
  elements.progressInput.value = '0';
  renderPlaylist();
  archive({ type: 'track_enter', roundId: track.roundId, trackTitle: track.title, autoplay });

  if (autoplay) {
    try {
      if (isFoobarTrack()) {
        const desiredVolume = Number(elements.volumeInput.value);
        const opened = await externalOpen(track.path);
        if (revision !== state.loadRevision) return;
        state.foobarTrackId = track.id;
        applyFoobarState(opened);
        await externalCommand('volume', { value: Math.round(desiredVolume * 80) });
      } else {
        await ensureAudioGraph();
        await elements.mediaElement.play();
      }
    } catch (error) {
      showToast(`无法播放：${error.message}`, 'error');
      if (isFoobarTrack()) {
        await externalCommand('close').catch(() => {});
        state.audioEngine = 'builtin';
        state.foobarTrackId = '';
        state.foobarState = null;
        if (state.volumeGain) state.volumeGain.gain.value = Number(elements.volumeInput.value);
        elements.audioEngineSelect.value = 'builtin';
        try { await ensureAudioGraph(); await elements.mediaElement.play(); }
        catch (fallbackError) { showToast(`内置播放器也无法播放：${fallbackError.message}`, 'error'); }
        publishBackstageState();
      }
    }
  }
}

async function ensureAudioGraph() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.analyser.minDecibels = -90;
    state.analyser.maxDecibels = 0;
    state.analyser.smoothingTimeConstant = 0.35;
    state.mediaSource = state.audioContext.createMediaElementSource(elements.mediaElement);
    state.volumeGain = state.audioContext.createGain();
    state.volumeGain.gain.value = isFoobarTrack() ? 0 : Number(elements.volumeInput.value);
    state.mediaSource.connect(state.analyser);
    state.analyser.connect(state.volumeGain);
    state.volumeGain.connect(state.audioContext.destination);
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
  if (state.volumeGain) state.volumeGain.gain.value = isFoobarTrack() ? 0 : volume;
  if (isFoobarTrack() && state.foobarTrackId) {
    externalCommand('volume', { value: Math.round(volume * 80) })
      .catch((error) => showToast(`${externalName()} 音量调整失败：${error.message}`, 'error'));
  }
  if (publish) publishBackstageState();
}

async function togglePlayback() {
  const track = currentTrack();
  if (!track) {
    showToast('请先导入媒体文件');
    return;
  }
  try {
    if (isFoobarTrack()) {
      if (!state.foobarTrackId) {
        await loadTrack(state.currentIndex, true);
      } else if (playbackPaused() && (state.foobarCompletedId === track.id
        || (playbackDuration() > 0 && playbackPosition() >= playbackDuration() - 0.2))) {
        await loadTrack(state.currentIndex, true);
      } else {
        await externalCommand(playbackPaused() ? 'play' : 'pause');
      }
      return;
    }
    await ensureAudioGraph();
    if (elements.mediaElement.paused) {
      if (elements.mediaElement.ended) elements.mediaElement.currentTime = 0;
      await elements.mediaElement.play();
    }
    else elements.mediaElement.pause();
  } catch (error) {
    showToast(`播放失败：${error.message}`, 'error');
  }
}

async function setAudioEngine(engine) {
  if (!['builtin', 'foobar'].includes(engine) || engine === state.audioEngine) return;
  const track = currentTrack();
  const position = playbackPosition();
  const wasPlaying = !playbackPaused();
  if (state.foobarTrackId) {
    await externalCommand('close').catch(() => {});
    state.foobarTrackId = '';
    state.foobarState = null;
  }
  if (engine !== 'builtin' && track?.type === 'audio') {
    const desiredVolume = Number(elements.volumeInput.value);
    elements.mediaElement.pause();
    state.audioEngine = engine;
    state.shadowAnalysisUnavailable = false;
    if (state.volumeGain) state.volumeGain.gain.value = 0;
    try {
      const opened = await externalOpen(track.path);
      state.foobarTrackId = track.id;
      applyFoobarState(opened);
      await externalCommand('volume', { value: Math.round(desiredVolume * 80) });
      if (position > 0) await externalCommand('seek', { seconds: position });
      if (!wasPlaying) await externalCommand('pause');
    } catch (error) {
      state.audioEngine = 'builtin';
      state.foobarTrackId = '';
      state.foobarState = null;
      if (state.volumeGain) state.volumeGain.gain.value = desiredVolume;
      await externalCommand('close').catch(() => {});
      elements.audioEngineSelect.value = 'builtin';
      if (wasPlaying) {
        await ensureAudioGraph().catch(() => {});
        await elements.mediaElement.play().catch(() => {});
      }
      publishBackstageState();
      throw error;
    }
  } else {
    state.audioEngine = engine;
    state.foobarTrackId = '';
    state.foobarState = null;
    if (state.volumeGain) state.volumeGain.gain.value = Number(elements.volumeInput.value);
    if (track?.type === 'audio' && engine === 'builtin') {
      if (Number.isFinite(elements.mediaElement.duration)) elements.mediaElement.currentTime = Math.min(position, elements.mediaElement.duration || 0);
      if (wasPlaying) { await ensureAudioGraph(); await elements.mediaElement.play(); }
    }
  }
  elements.audioEngineSelect.value = engine;
  updatePlaybackDisplay(playbackPosition(), playbackDuration(), playbackPaused());
  showToast(engine === 'builtin' ? '已切回内置播放器' : `音频已切换到 ${externalName()}；视频仍使用内置播放器`, 'success');
}

async function startStreamCapture({ id, mediaSourceId, testSeconds = 0 }) {
  if (isFoobarTrack()) throw new Error(`${externalName()} 音频不能接入内置推流；请使用 OBS 捕获桌面音频，或切回内置播放器`);
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
    setTrackTitle(track.title);
    elements.trackTitleRepeat.textContent = track.title;
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
    setTrackTitle(track.title);
    elements.trackTitleRepeat.textContent = track.title;
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

async function exportArchive() {
  try {
    await state.archiveQueue;
    const session = await ensureArchive();
    const result = await api.exportArchiveCsv(session.sessionId);
    if (result) showToast(result.incomplete
      ? `已导出 ${result.count} 条播放记录，但存档写入曾失败，文件可能不完整`
      : `已导出 ${result.count} 条播放记录`, result.incomplete ? 'error' : 'success', 8000);
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
    if (isFoobarTrack()) return;
    elements.playButton.textContent = 'Ⅱ';
    elements.programFrame.classList.add('playing');
    publishBackstageState();
  });
  media.addEventListener('pause', () => {
    if (isFoobarTrack()) return;
    elements.playButton.textContent = '▶';
    elements.programFrame.classList.remove('playing');
    publishBackstageState();
  });
  media.addEventListener('loadedmetadata', () => {
    const track = currentTrack();
    if (track && Number.isFinite(media.duration)) track.duration = media.duration;
    if (isFoobarTrack()) {
      if (state.foobarState) syncShadowPlayback(state.foobarState);
      return;
    }
    elements.durationTime.textContent = formatTime(media.duration);
    renderPlaylist();
  });
  media.addEventListener('timeupdate', () => {
    if (isFoobarTrack()) return;
    elements.currentTime.textContent = formatTime(media.currentTime);
    const progress = media.duration ? Math.round((media.currentTime / media.duration) * 1000) : 0;
    elements.progressInput.value = String(progress);
    if (Date.now() - state.lastProgressPublish > 400) {
      state.lastProgressPublish = Date.now();
      publishBackstageState();
    }
  });
  media.addEventListener('ended', () => {
    if (isFoobarTrack()) return;
    const track = currentTrack();
    if (!track) return;
    archive({ type: 'track_completed', roundId: track.roundId, trackTitle: track.title });
    updatePlaybackDisplay(media.duration || track.duration || 0, media.duration || track.duration || 0, true);
  });
  media.addEventListener('error', () => {
    if (isFoobarTrack()) {
      if (state.shadowAnalysisUnavailable) return;
      state.shadowAnalysisUnavailable = true;
      showToast('当前音频无法用于实时频谱分析，已改用动态效果', 'info', 6000);
      return;
    }
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
    case 'reorder-track':
      reorderTrack(String(payload.id || ''), String(payload.targetId || ''), payload.placement);
      break;
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
      const duration = playbackDuration();
      if (Number.isFinite(duration) && duration > 0) {
        const progress = Math.max(0, Math.min(1000, Number(payload.progress) || 0));
        if (progress < 1000) { state.foobarCompletedId = ''; state.foobarWasPlaying = false; }
        if (isFoobarTrack() && state.foobarTrackId) await externalCommand('seek', { seconds: duration * progress / 1000 });
        else if (!isFoobarTrack()) elements.mediaElement.currentTime = duration * progress / 1000;
        publishBackstageState();
      }
      break;
    }
    case 'audio-engine':
      await setAudioEngine(payload.engine);
      break;
    case 'volume': {
      setOutputVolume(payload.value);
      break;
    }
    case 'comment-opacity':
      setCommentOpacity(payload.value);
      break;
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
  const barCount = 48;
  const noiseGate = .12;
  const peakThreshold = .95;
  const displayCeiling = .9;
  const displayedLevels = new Float32Array(barCount);
  let spectrumValues = null;
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
    let values;
    if (state.analyser && state.audioContext?.state === 'running'
      && !playbackPaused() && (!isFoobarTrack() || (!state.shadowAnalysisUnavailable && !elements.mediaElement.paused))) {
      if (!spectrumValues || spectrumValues.length !== state.analyser.frequencyBinCount) {
        spectrumValues = new Uint8Array(state.analyser.frequencyBinCount);
      }
      state.analyser.getByteFrequencyData(spectrumValues);
      values = spectrumValues;
    }
    const gap = 2;
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
    const centerY = height / 2;
    const maxHalfHeight = height * .45;
    const moving = isFoobarTrack() && !playbackPaused();
    const fallback = moving && state.shadowAnalysisUnavailable;
    const analyser = state.analyser;
    const binWidth = analyser && state.audioContext ? state.audioContext.sampleRate / analyser.fftSize : 0;
    const maxHz = state.audioContext ? Math.min(14000, state.audioContext.sampleRate / 2) : 14000;
    for (let i = 0; i < barCount; i += 1) {
      const idle = fallback
        ? .18 + .48 * Math.pow((Math.sin(now / 260 + i * .58) + 1) / 2, 2)
        : (Math.sin(now / 520 + i * .6) + 1) * .025 + .025;
      let target = idle;
      if (values && binWidth > 0) {
        const lowHz = 40 * Math.pow(maxHz / 40, i / barCount);
        const highHz = 40 * Math.pow(maxHz / 40, (i + 1) / barCount);
        const first = Math.min(values.length - 1, Math.max(1, Math.floor(lowHz / binWidth)));
        const last = Math.min(values.length, Math.max(first + 1, Math.ceil(highHz / binWidth)));
        let power = 0;
        let peak = 0;
        for (let bin = first; bin < last; bin += 1) {
          const sample = values[bin] / 255;
          power += sample * sample;
          peak = Math.max(peak, sample);
        }
        const energy = .72 * Math.sqrt(power / (last - first)) + .28 * peak;
        const gated = Math.max(0, Math.min(1, (energy - noiseGate) / (peakThreshold - noiseGate)));
        target = Math.pow(gated, 1.05) * displayCeiling;
      }
      const previous = displayedLevels[i];
      displayedLevels[i] = previous + (target - previous) * (target > previous ? .78 : .18);
      const ratio = Math.max(.025, displayedLevels[i]);
      const halfBarHeight = Math.max(1, ratio * maxHalfHeight);
      const x = i * (barWidth + gap);
      context.fillStyle = 'rgba(255, 255, 255, .8)';
      context.beginPath();
      context.roundRect(x, centerY - halfBarHeight, barWidth, halfBarHeight * 2, 2);
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
  elements.audioEngineSelect.addEventListener('change', () => {
    setAudioEngine(elements.audioEngineSelect.value).catch((error) => showToast(`切换播放器失败：${error.message}`, 'error', 7000));
  });
  elements.previousButton.addEventListener('click', () => goRelative(-1));
  elements.nextButton.addEventListener('click', () => goRelative(1));
  elements.progressInput.addEventListener('input', () => {
    if (isFoobarTrack()) elements.currentTime.textContent = formatTime(Number(elements.progressInput.value) / 1000 * playbackDuration());
    else if (elements.mediaElement.duration) {
      elements.mediaElement.currentTime = (Number(elements.progressInput.value) / 1000) * elements.mediaElement.duration;
    }
  });
  elements.progressInput.addEventListener('pointerdown', () => { state.seekDragging = true; });
  elements.progressInput.addEventListener('pointerup', () => { state.seekDragging = false; });
  elements.progressInput.addEventListener('change', () => {
    state.seekDragging = false;
    if (isFoobarTrack() && state.foobarTrackId && playbackDuration()) {
      if (Number(elements.progressInput.value) < 1000) {
        state.foobarCompletedId = '';
        state.foobarWasPlaying = false;
      }
      externalCommand('seek', { seconds: Number(elements.progressInput.value) / 1000 * playbackDuration() })
        .catch((error) => showToast(`定位失败：${error.message}`, 'error'));
    }
  });
  elements.volumeInput.addEventListener('input', () => {
    setOutputVolume(elements.volumeInput.value);
  });
  elements.volumeInput.addEventListener('pointerdown', () => { state.volumeDragging = true; });
  elements.volumeInput.addEventListener('pointerup', () => { state.volumeDragging = false; });
  elements.volumeInput.addEventListener('change', () => { state.volumeDragging = false; });
  elements.commentOpacityInput.addEventListener('input', () => setCommentOpacity(elements.commentOpacityInput.value));
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
  api.onFoobarState((next) => {
    if (state.audioEngine === 'foobar') applyFoobarState(next);
  });
  api.onBackstageCommand((command) => {
    handleBackstageCommand(command).catch((error) => {
      showToast(error.message, 'error', 6000);
      api.sendBackstageFeedback(error.message, 'error').catch(() => {});
    });
  });
  api.onStreamStartCapture((payload) => {
    startStreamCapture(payload).catch((error) => api.sendStreamCaptureError(payload.id, error.message));
  });
  api.onStreamStopCapture((payload) => stopStreamCapture(payload.id));
}

async function initialize() {
  const query = new URLSearchParams(window.location.search);
  elements.audioEngineSelect.value = state.audioEngine;
  state.titleResizeObserver = new ResizeObserver(refreshTrackTitleScroll);
  state.titleResizeObserver.observe(elements.trackTitle);
  refreshTrackTitleScroll();
  setCommentOpacity(localStorage.getItem('commentPanelOpacity') ?? 72, false);
  renderPlaylist();
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
      type: qaVideo ? 'video' : 'audio', title: qaVideo ? 'Midnight Session' : 'Night Signal', artist: 'The Afterglow', composer: 'The Afterglow', album: 'QA Demo', duration: 1,
      submitter: '凌晨四点投稿',
      description: '一首从城市夜色里长出来的歌。留意后半段逐层叠起的低频与合成器。',
      descriptionVisible: true,
      coverDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      posterDataUrl: qaVideo ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="v" x2="1" y2="1"><stop stop-color="#17204d"/><stop offset=".52" stop-color="#60305c"/><stop offset="1" stop-color="#df6c59"/></linearGradient></defs><rect width="1600" height="900" fill="url(#v)"/><circle cx="1220" cy="230" r="130" fill="#ffd98a" opacity=".9"/><path d="M0 690L270 470 500 650 780 340 1120 720 1400 500 1600 650V900H0Z" fill="#10131e"/><text x="90" y="120" font-family="sans-serif" font-size="36" fill="white" opacity=".7">MIDNIGHT SESSION</text></svg>`)}` : '',
    }]);
    if (qaVideo) setCommentOpacity(46, false);
  }
  if (query.get('program') === '1') {
    document.body.classList.add('program-mode');
    publishBackstageState();
  }
}

initialize().catch((error) => showToast(`初始化失败：${error.message}`, 'error', 8000));
