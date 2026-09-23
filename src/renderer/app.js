'use strict';

const api = window.tasteArena;
const { parseDanmaku } = window.TasteCommands;

const state = {
  tracks: [],
  currentIndex: -1,
  scoresByRound: new Map(),
  comments: [],
  seenMessageIds: new Set(),
  sessionPromise: null,
  sessionId: null,
  sessionPath: '',
  connected: false,
  audioContext: null,
  analyser: null,
  mediaSource: null,
  dragDepth: 0,
  pendingCoverDataUrl: '',
  pendingCoverPath: '',
};

const elements = Object.fromEntries([
  'importButton', 'trackCount', 'playlist', 'settingsButton', 'connectionDot', 'connectionText',
  'exportButton', 'programModeButton', 'programFrame', 'mediaElement', 'trackNumber', 'coverFrame',
  'coverImage', 'trackTitle', 'trackArtist', 'visualizer', 'averageScore', 'scoreCount', 'scoreMeter',
  'trackDescriptionCard', 'trackDescriptionText',
  'commentStream', 'scoreHint', 'commentHint', 'previousButton', 'playButton', 'nextButton',
  'currentTime', 'progressInput', 'durationTime', 'volumeInput', 'mockNameInput', 'mockMessageInput',
  'commentOpacityInput', 'commentOpacityValue',
  'sendMockButton', 'unparsedCommentInput', 'dropOverlay', 'settingsDialog', 'appIdInput',
  'accessKeyInput', 'accessSecretInput', 'secretState', 'identityCodeInput', 'dialogStatus',
  'saveConfigButton', 'disconnectButton', 'connectButton', 'toastContainer', 'editTrackButton', 'backstageButton',
  'trackEditDialog', 'trackCoverPreview', 'chooseCoverButton', 'clearCoverButton',
  'trackTitleInput', 'trackSubmitterInput', 'trackDescriptionInput',
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

function trackForRound(roundId) {
  return state.tracks.find((track) => track.roundId === roundId) || null;
}

function publishBackstageState() {
  api.publishBackstageState({
    currentTrackId: currentTrack()?.id || '',
    tracks: state.tracks.map((track) => ({
      id: track.id,
      number: track.roundId,
      title: track.title,
      type: track.type,
      description: track.description || '',
      descriptionVisible: Boolean(track.descriptionVisible),
    })),
  }).catch((error) => console.error('backstage sync failed', error));
}

function renderTrackDescription() {
  const track = currentTrack();
  const visible = Boolean(track && track.type !== 'video' && track.descriptionVisible && track.description?.trim());
  elements.trackDescriptionCard.hidden = !visible;
  elements.trackDescriptionText.textContent = visible ? track.description : '';
  elements.programFrame.classList.toggle('has-description', visible);
}

function showToast(message, type = 'info', duration = 3600) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

async function ensureArchive() {
  if (!state.sessionPromise) {
    state.sessionPromise = api.startArchive({ app: '品味大战', schemaVersion: 2 });
  }
  const session = await state.sessionPromise;
  state.sessionId = session.sessionId;
  state.sessionPath = session.filePath;
  return session;
}

async function archive(entry) {
  try {
    const session = await ensureArchive();
    const record = { ...entry };
    if (Object.hasOwn(record, 'roundId')) {
      record.trackId = record.roundId;
      delete record.roundId;
    }
    await api.appendArchive(session.sessionId, record);
  } catch (error) {
    console.error('archive failed', error);
  }
}

function renderPlaylist() {
  elements.trackCount.textContent = `${state.tracks.length} 首`;
  elements.editTrackButton.disabled = !currentTrack();
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
    artist.textContent = track.submitter || track.artist || (track.type === 'video' ? '视频文件' : '未知投稿人');
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

async function addTracks(items) {
  const valid = items.filter((item) => item && !item.error && item.url);
  const failed = items.filter((item) => item?.error);
  for (const item of valid) {
    item.roundId = String(state.tracks.length + 1).padStart(2, '0');
    item.description = String(item.description || '').slice(0, 500);
    item.descriptionVisible = Boolean(item.descriptionVisible);
    state.tracks.push(item);
    archive({
      type: 'track_added',
      roundId: item.roundId,
      trackTitle: item.title,
      artist: item.artist,
      submitter: item.submitter || '',
      mediaType: item.type,
      sourcePath: item.path,
    });
  }
  renderPlaylist();
  if (state.currentIndex < 0 && valid.length) loadTrack(0, false);
  if (valid.length) showToast(`已加入 ${valid.length} 个媒体文件`, 'success');
  if (failed.length) showToast(`${failed.length} 个文件无法读取`, 'error');
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
  elements.trackArtist.textContent = track.submitter || track.artist || track.album || (track.type === 'video' ? '视频文件' : '未知投稿人');
  elements.scoreHint.textContent = `评分：#${track.roundId} 8.5`;
  elements.commentHint.textContent = `评论：#${track.roundId}评 你的观点`;
  elements.coverFrame.classList.toggle('has-cover', Boolean(track.coverDataUrl));
  elements.coverImage.src = track.coverDataUrl || '';
  elements.mediaElement.poster = track.posterDataUrl || track.coverDataUrl || '';
  renderTrackDescription();
  elements.durationTime.textContent = track.duration ? formatTime(track.duration) : '00:00';
  elements.currentTime.textContent = '00:00';
  elements.progressInput.value = '0';
  renderPlaylist();
  renderScore();
  renderComments();
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
    state.mediaSource.connect(state.analyser);
    state.analyser.connect(state.audioContext.destination);
  }
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();
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
  state.pendingCoverDataUrl = track.coverDataUrl || '';
  state.pendingCoverPath = track.coverPath || '';
  elements.trackTitleInput.value = track.title || '';
  elements.trackSubmitterInput.value = track.submitter || track.artist || '';
  elements.trackDescriptionInput.value = track.description || '';
  elements.trackDescriptionVisibleInput.checked = Boolean(track.descriptionVisible);
  renderTrackCoverPreview(state.pendingCoverDataUrl);
  elements.trackEditDialog.showModal();
}

async function chooseTrackCover() {
  try {
    const selected = await api.selectCover();
    if (!selected) return;
    state.pendingCoverDataUrl = selected.dataUrl || '';
    state.pendingCoverPath = selected.path || '';
    renderTrackCoverPreview(state.pendingCoverDataUrl);
  } catch (error) {
    showToast(`封面导入失败：${error.message}`, 'error');
  }
}

function saveTrackMetadata() {
  const track = currentTrack();
  if (!track) return;
  const title = elements.trackTitleInput.value.trim();
  if (!title) {
    showToast('曲目名称不能为空', 'error');
    elements.trackTitleInput.focus();
    return;
  }

  track.title = title;
  track.submitter = elements.trackSubmitterInput.value.trim();
  track.coverDataUrl = state.pendingCoverDataUrl;
  track.coverPath = state.pendingCoverPath;
  track.description = elements.trackDescriptionInput.value.trim();
  track.descriptionVisible = elements.trackDescriptionVisibleInput.checked;
  elements.trackTitle.textContent = track.title;
  elements.trackArtist.textContent = track.submitter || track.artist || track.album || (track.type === 'video' ? '视频文件' : '未知投稿人');
  elements.coverFrame.classList.toggle('has-cover', Boolean(track.coverDataUrl));
  elements.coverImage.src = track.coverDataUrl || '';
  elements.mediaElement.poster = track.posterDataUrl || track.coverDataUrl || '';
  renderTrackDescription();
  renderPlaylist();
  renderComments();
  archive({
    type: 'track_metadata_updated',
    roundId: track.roundId,
    trackTitle: track.title,
    submitter: track.submitter,
    coverPath: track.coverPath,
    description: track.description,
    descriptionVisible: track.descriptionVisible,
  });
  elements.trackEditDialog.close();
  showToast('曲目信息已更新', 'success');
}

function applyBackstageUpdate(update) {
  const track = state.tracks.find((item) => item.id === update.id);
  if (!track) return;
  const previousDescription = track.description || '';
  const previousVisible = Boolean(track.descriptionVisible);
  if (typeof update.description === 'string') track.description = update.description.trim().slice(0, 500);
  if (typeof update.descriptionVisible === 'boolean') track.descriptionVisible = update.descriptionVisible;
  if (track.description === previousDescription && track.descriptionVisible === previousVisible) return;
  if (track.id === currentTrack()?.id) renderTrackDescription();
  publishBackstageState();
  archive({
    type: 'track_description_updated',
    roundId: track.roundId,
    trackTitle: track.title,
    description: track.description,
    descriptionVisible: track.descriptionVisible,
  });
}

function addCommentToOutput(entry) {
  state.comments.push(entry);
  if (state.comments.length > 500) state.comments.shift();
  if (entry.roundId === currentTrack()?.roundId) renderComments();
}

function renderComments() {
  const roundId = currentTrack()?.roundId;
  const limit = elements.programFrame.classList.contains('video-mode') ? 6 : 4;
  const visible = state.comments.filter((item) => item.roundId === roundId).slice(-limit);
  elements.commentStream.innerHTML = '';
  if (!visible.length) {
    const placeholder = document.createElement('div');
    placeholder.className = 'comment-placeholder';
    placeholder.textContent = '弹幕评论将在这里滚动出现';
    elements.commentStream.appendChild(placeholder);
    return;
  }

  for (const entry of visible) {
    const item = document.createElement('div');
    item.className = `comment-item${entry.kind === 'score' ? ' score-comment' : ''}`;
    let avatar;
    if (entry.uface) {
      avatar = document.createElement('img');
      avatar.src = entry.uface;
      avatar.alt = '';
      avatar.referrerPolicy = 'no-referrer';
    } else {
      avatar = document.createElement('div');
      avatar.textContent = (entry.uname || '?').slice(0, 1).toUpperCase();
    }
    avatar.className = 'comment-avatar';

    const copy = document.createElement('div');
    copy.className = 'comment-copy';
    const name = document.createElement('strong');
    name.textContent = entry.uname || '匿名观众';
    const content = document.createElement('p');
    content.textContent = entry.kind === 'score' ? `为本曲目打出 ${entry.score.toFixed(1)} 分` : entry.comment;
    copy.append(name, content);
    item.append(avatar, copy);
    elements.commentStream.appendChild(item);
  }
}

function renderScore() {
  const roundId = currentTrack()?.roundId;
  const scores = roundId ? [...(state.scoresByRound.get(roundId)?.values() || [])] : [];
  if (!scores.length) {
    elements.averageScore.textContent = '--';
    elements.scoreCount.textContent = '0';
    elements.scoreMeter.firstElementChild.style.width = '0%';
    return;
  }
  const average = scores.reduce((total, entry) => total + entry.score, 0) / scores.length;
  elements.averageScore.textContent = average.toFixed(1);
  elements.scoreCount.textContent = String(scores.length);
  elements.scoreMeter.firstElementChild.style.width = `${average * 10}%`;
}

function processDanmaku(data, source = 'live') {
  const msgId = String(data.msg_id || `${source}-${Date.now()}-${Math.random()}`);
  if (state.seenMessageIds.has(msgId)) return;
  state.seenMessageIds.add(msgId);
  if (state.seenMessageIds.size > 10_000) {
    const oldest = state.seenMessageIds.values().next().value;
    state.seenMessageIds.delete(oldest);
  }

  const track = currentTrack();
  archive({
    type: 'raw_danmaku',
    source,
    msgId,
    openId: data.open_id || '',
    uname: data.uname || '',
    message: data.msg || '',
    platformTimestamp: data.timestamp || null,
    raw: data,
  });

  const parsed = parseDanmaku(data.msg, {
    currentRound: track?.roundId,
    unparsedAsComment: elements.unparsedCommentInput.checked,
  });
  if (parsed.type === 'invalid') {
    if (source === 'mock') showToast(parsed.reason, 'error');
    return;
  }
  if (!['score', 'comment'].includes(parsed.type)) return;

  const targetTrack = trackForRound(parsed.roundId);
  if (!targetTrack) {
    if (source === 'mock') showToast(`找不到编号 ${parsed.roundId} 的曲目`, 'error');
    return;
  }

  const openId = String(data.open_id || `${source}:${data.uname || 'anonymous'}`);
  const actor = {
    openId,
    uname: data.uname || '匿名观众',
    uface: data.uface || '',
    msgId,
    roundId: parsed.roundId,
    trackTitle: targetTrack.title,
  };

  if (parsed.type === 'score') {
    let roundScores = state.scoresByRound.get(parsed.roundId);
    if (!roundScores) {
      roundScores = new Map();
      state.scoresByRound.set(parsed.roundId, roundScores);
    }
    roundScores.set(openId, { ...actor, score: parsed.score });
    state.comments = state.comments.filter((entry) => !(
      entry.kind === 'score'
      && entry.roundId === parsed.roundId
      && entry.openId === openId
    ));
    addCommentToOutput({ ...actor, score: parsed.score, kind: 'score' });
    archive({ type: 'score', ...actor, score: parsed.score, rawMessage: parsed.raw });
    if (parsed.roundId === currentTrack()?.roundId) renderScore();
  } else {
    addCommentToOutput({ ...actor, comment: parsed.comment, kind: 'comment' });
    archive({ type: 'comment', ...actor, comment: parsed.comment, implicit: Boolean(parsed.implicit), rawMessage: parsed.raw });
  }
}

function sendMockDanmaku() {
  const message = elements.mockMessageInput.value.trim();
  if (!message) return;
  const name = elements.mockNameInput.value.trim() || '测试观众';
  processDanmaku({
    open_id: `mock-${hashName(name)}`,
    uname: name,
    msg: message,
    msg_id: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
  }, 'mock');
  elements.mockMessageInput.value = '';
  elements.mockMessageInput.focus();
}

function setConnectionState(status, message) {
  const connected = status === 'connected';
  state.connected = connected;
  elements.connectionDot.className = `status-dot ${connected ? 'connected' : status === 'error' ? 'error' : ''}`;
  elements.connectionText.textContent = message || (connected ? '已连接 B站直播间' : '模拟弹幕模式');
  elements.dialogStatus.textContent = message || '';
  elements.connectButton.disabled = ['starting', 'reconnecting'].includes(status);
  elements.disconnectButton.disabled = !connected && status !== 'reconnecting';
}

async function loadConfig() {
  const config = await api.getConfig();
  elements.appIdInput.value = config.appId || '';
  elements.accessKeyInput.value = config.accessKey || '';
  elements.secretState.textContent = config.hasSecret ? '已使用 Windows 系统凭据加密保存' : '尚未保存';
  elements.accessSecretInput.placeholder = config.hasSecret ? '留空继续使用已保存密钥' : '审核通过后邮件发放';
  return config;
}

async function saveConfig() {
  elements.saveConfigButton.disabled = true;
  try {
    const result = await api.saveConfig({
      appId: elements.appIdInput.value,
      accessKey: elements.accessKeyInput.value,
      accessSecret: elements.accessSecretInput.value,
    });
    elements.accessSecretInput.value = '';
    elements.secretState.textContent = result.hasSecret ? '已使用 Windows 系统凭据加密保存' : '尚未保存';
    showToast('开发者配置已安全保存', 'success');
    return result;
  } catch (error) {
    showToast(error.message, 'error');
    throw error;
  } finally {
    elements.saveConfigButton.disabled = false;
  }
}

async function connectLive() {
  elements.connectButton.disabled = true;
  try {
    await saveConfig();
    const identityCode = elements.identityCodeInput.value.trim();
    if (!identityCode) throw new Error('请输入本次直播使用的身份码');
    const result = await api.connectLive(identityCode);
    elements.identityCodeInput.value = '';
    const anchorName = result.anchorInfo?.uname || '主播';
    showToast(`已连接 ${anchorName} 的直播间`, 'success');
    elements.settingsDialog.close();
  } catch (error) {
    setConnectionState('error', error.message);
    showToast(error.message, 'error', 6000);
  } finally {
    elements.connectButton.disabled = false;
  }
}

async function disconnectLive() {
  elements.disconnectButton.disabled = true;
  try {
    await api.disconnectLive();
    setConnectionState('disconnected', '模拟弹幕模式');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    elements.disconnectButton.disabled = false;
  }
}

async function exportArchive() {
  try {
    const session = await ensureArchive();
    const result = await api.exportArchiveCsv(session.sessionId);
    if (result) showToast(`已导出 ${result.count} 条评论/评分`, 'success');
  } catch (error) {
    showToast(`导出失败：${error.message}`, 'error');
  }
}

async function enterProgramMode() {
  document.body.classList.add('program-mode');
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    // Electron window capture still works without OS fullscreen.
  }
  api.openBackstage().catch((error) => console.error('open backstage failed', error));
}

function leaveProgramMode() {
  document.body.classList.remove('program-mode');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function setupMediaEvents() {
  const media = elements.mediaElement;
  media.volume = Number(elements.volumeInput.value);
  media.addEventListener('play', () => {
    elements.playButton.textContent = 'Ⅱ';
    elements.programFrame.classList.add('playing');
  });
  media.addEventListener('pause', () => {
    elements.playButton.textContent = '▶';
    elements.programFrame.classList.remove('playing');
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
      gradient.addColorStop(0, '#d8ff3e');
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
  elements.editTrackButton.addEventListener('click', openTrackEditor);
  elements.backstageButton.addEventListener('click', () => {
    api.openBackstage().catch((error) => showToast(`后台窗口无法打开：${error.message}`, 'error'));
  });
  elements.chooseCoverButton.addEventListener('click', chooseTrackCover);
  elements.clearCoverButton.addEventListener('click', () => {
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
    elements.mediaElement.volume = Number(elements.volumeInput.value);
  });
  elements.commentOpacityInput.addEventListener('input', () => setCommentOpacity(elements.commentOpacityInput.value));
  elements.sendMockButton.addEventListener('click', sendMockDanmaku);
  elements.mockMessageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendMockDanmaku();
  });
  elements.settingsButton.addEventListener('click', async () => {
    await loadConfig();
    elements.settingsDialog.showModal();
  });
  elements.saveConfigButton.addEventListener('click', saveConfig);
  elements.connectButton.addEventListener('click', connectLive);
  elements.disconnectButton.addEventListener('click', disconnectLive);
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
    if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      togglePlayback();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('program-mode');
  });

  api.onLiveState((payload) => setConnectionState(payload.status, payload.message));
  api.onBackstageUpdate(applyBackstageUpdate);
  api.onDiagnostic((payload) => showToast(payload.message, payload.level === 'error' ? 'error' : 'info', 6000));
  api.onLiveMessage((payload) => {
    if (payload.cmd === 'LIVE_OPEN_PLATFORM_DM' && payload.data) processDanmaku(payload.data, 'live');
  });
}

async function initialize() {
  const query = new URLSearchParams(window.location.search);
  setCommentOpacity(localStorage.getItem('commentPanelOpacity') ?? 72, false);
  renderPlaylist();
  renderScore();
  renderComments();
  setupMediaEvents();
  setupVisualizer();
  setupDragAndDrop();
  bindEvents();
  ensureArchive().catch((error) => showToast(`无法创建存档：${error.message}`, 'error'));
  await loadConfig();
  if (query.get('qa') === '1') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#ff674d"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs><rect width="700" height="700" fill="url(#g)"/><circle cx="350" cy="350" r="225" fill="#101218"/><circle cx="350" cy="350" r="92" fill="#d8ff3e"/><text x="350" y="630" text-anchor="middle" font-family="sans-serif" font-size="44" font-weight="700" fill="white">NIGHT SIGNAL</text></svg>`;
    const silentWav = new Uint8Array(44 + 8000 * 2);
    const view = new DataView(silentWav.buffer);
    const write = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, silentWav.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data');
    view.setUint32(40, silentWav.length - 44, true);
    const qaVideo = query.get('video') === '1';
    await addTracks([{
      id: 'qa-track', path: 'qa-demo.wav', url: URL.createObjectURL(new Blob([silentWav], { type: 'audio/wav' })),
      type: qaVideo ? 'video' : 'audio', title: qaVideo ? 'Midnight Session' : 'Night Signal', artist: 'The Afterglow', album: 'QA Demo', duration: 1,
      submitter: '凌晨四点投稿',
      description: '一首从城市夜色里长出来的歌。留意后半段逐层叠起的低频与合成器。',
      descriptionVisible: !qaVideo,
      coverDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      posterDataUrl: qaVideo ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="v" x2="1" y2="1"><stop stop-color="#17204d"/><stop offset=".52" stop-color="#60305c"/><stop offset="1" stop-color="#df6c59"/></linearGradient></defs><rect width="1600" height="900" fill="url(#v)"/><circle cx="1220" cy="230" r="130" fill="#ffd98a" opacity=".9"/><path d="M0 690L270 470 500 650 780 340 1120 720 1400 500 1600 650V900H0Z" fill="#10131e"/><text x="90" y="120" font-family="sans-serif" font-size="36" fill="white" opacity=".7">MIDNIGHT SESSION</text></svg>`)}` : '',
    }]);
    processDanmaku({ open_id: 'qa-1', uname: '银河汽水', msg: '#01 9.2', msg_id: 'qa-score-1' }, 'mock');
    processDanmaku({ open_id: 'qa-2', uname: '纸飞机', msg: '#01 8.5', msg_id: 'qa-score-2' }, 'mock');
    processDanmaku({ open_id: 'qa-3', uname: '低频收藏家', msg: '#01 7.8', msg_id: 'qa-score-3' }, 'mock');
    processDanmaku({ open_id: 'qa-4', uname: '凌晨四点', msg: '#01评 低频的空间感很漂亮，后半段层次尤其好。', msg_id: 'qa-comment-1' }, 'mock');
    processDanmaku({ open_id: 'qa-5', uname: '柠檬唱片', msg: '#01评 主歌克制，副歌一下就打开了。', msg_id: 'qa-comment-2' }, 'mock');
    processDanmaku({ open_id: 'qa-1', uname: '银河汽水', msg: '#01 9.7', msg_id: 'qa-score-1-revised' }, 'mock');
    if (qaVideo) setCommentOpacity(46, false);
  }
  if (query.get('program') === '1') document.body.classList.add('program-mode');
}

initialize().catch((error) => showToast(`初始化失败：${error.message}`, 'error', 8000));
