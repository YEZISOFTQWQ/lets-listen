'use strict';

const api = window.backstageApi;
const ids = [
  'trackCount', 'importButton', 'openPlaylistButton', 'savePlaylistButton', 'exportButton', 'playlist', 'exitProgramButton',
  'previousButton', 'playButton', 'nextButton', 'playingLabel', 'currentTime',
  'progressInput', 'durationTime', 'volumeInput', 'volumeValue',
  'commentOpacityInput', 'commentOpacityValue', 'trackSelect', 'currentIndicator',
  'titleInput', 'composerInput', 'submitterInput', 'genreInput', 'coverState', 'chooseCoverButton', 'clearCoverButton',
  'descriptionInput', 'visibleInput', 'saveButton', 'mockNameInput',
  'mockMessageInput', 'sendMockButton', 'status',
  'streamStatus', 'ffmpegPathInput', 'ffmpegStatus', 'streamQualityInput',
  'streamServerInput', 'streamKeyInput', 'streamTestButton', 'streamStartButton', 'streamStopButton',
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let snapshot = { currentTrackId: '', tracks: [], playback: {}, sessionId: '' };
let selectedId = '';
let dirty = false;
let pendingCover = null;
let coverSelectionRevision = 0;
let editRevision = 0;
let playlistSignature = '';
let dragDepth = 0;
let themeSignature = '';

function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function selectedTrack() {
  return snapshot.tracks.find((track) => track.id === selectedId) || null;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
}

function renderTheme(accent, hover) {
  const color = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#d8ff3e';
  const hoverColor = /^#[0-9a-f]{6}$/i.test(hover) ? hover : '#e5ff72';
  const signature = `${color}:${hoverColor}`;
  if (signature === themeSignature) return;
  themeSignature = signature;
  const root = document.documentElement.style;
  root.setProperty('--acid', color);
  root.setProperty('--accent-hover', hoverColor);
  root.setProperty('--accent-rgb', [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16)).join(', '));
}

async function command(type, payload) {
  try {
    await api.command(type, payload);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderPlaylist() {
  elements.savePlaylistButton.disabled = snapshot.tracks.length === 0;
  const signature = snapshot.tracks.map((track) =>
    [track.id, track.number, track.title, track.composer, track.artist, track.duration].join(':')
  ).join('|') + `|${snapshot.currentTrackId}`;
  if (signature === playlistSignature) return;
  playlistSignature = signature;
  elements.trackCount.textContent = `${snapshot.tracks.length} 首`;
  elements.playlist.innerHTML = '';
  if (!snapshot.tracks.length) {
    const empty = document.createElement('p');
    empty.textContent = '请导入音频或视频文件';
    elements.playlist.appendChild(empty);
    return;
  }
  for (const track of snapshot.tracks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `playlist-item${track.id === snapshot.currentTrackId ? ' active' : ''}`;
    const number = document.createElement('span');
    number.className = 'playlist-number';
    number.textContent = track.number;
    const copy = document.createElement('span');
    copy.className = 'playlist-copy';
    const title = document.createElement('strong');
    title.textContent = track.title;
    const submitter = document.createElement('small');
    submitter.textContent = track.composer || track.artist || (track.type === 'video' ? '视频文件' : '未标注艺人');
    copy.append(title, submitter);
    const duration = document.createElement('span');
    duration.className = 'playlist-duration';
    duration.textContent = track.duration ? formatTime(track.duration) : '--:--';
    button.append(number, copy, duration);
    button.addEventListener('click', () => command('select-track', { id: track.id }));
    elements.playlist.appendChild(button);
  }
}

function renderSelected(force = false) {
  const track = selectedTrack();
  const available = Boolean(track);
  for (const id of ['titleInput', 'composerInput', 'submitterInput', 'genreInput', 'descriptionInput', 'chooseCoverButton', 'clearCoverButton', 'saveButton']) {
    elements[id].disabled = !available;
  }
  elements.visibleInput.disabled = !available;
  elements.currentIndicator.textContent = !track
    ? '请先导入音频或视频'
    : track.id === snapshot.currentTrackId ? '当前播放曲目' : '队列中的其他曲目，切换播放后生效';
  if (force || !dirty) {
    elements.titleInput.value = track?.title || '';
    elements.composerInput.value = track?.composer || '';
    elements.submitterInput.value = track?.submitter || '';
    elements.genreInput.value = track?.genre || '';
    elements.descriptionInput.value = track?.description || '';
    elements.visibleInput.checked = Boolean(track?.descriptionVisible);
    elements.coverState.textContent = track?.coverPath
      ? `封面：${track.coverPath.split(/[\\/]/).pop()}`
      : track?.hasCover ? '已读取封面' : '暂无封面';
    pendingCover = null;
    dirty = false;
  }
}

function render(snapshotNext) {
  const wasFollowingCurrent = !dirty && (!selectedId || selectedId === snapshot.currentTrackId);
  const previousSelection = selectedId;
  snapshot = snapshotNext;
  renderTheme(snapshot.themeAccent, snapshot.themeHover);
  if (wasFollowingCurrent) selectedId = snapshot.currentTrackId;
  if (!snapshot.tracks.some((track) => track.id === selectedId)) {
    selectedId = snapshot.currentTrackId || snapshot.tracks[0]?.id || '';
  }
  if (selectedId !== previousSelection) coverSelectionRevision += 1;

  renderPlaylist();
  const optionSignature = snapshot.tracks.map((track) => `${track.id}:${track.number}:${track.title}`).join('|');
  if (elements.trackSelect.dataset.signature !== optionSignature) {
    elements.trackSelect.dataset.signature = optionSignature;
    elements.trackSelect.innerHTML = '';
    for (const track of snapshot.tracks) {
      const option = document.createElement('option');
      option.value = track.id;
      option.textContent = `TRACK ${track.number} · ${track.title}`;
      elements.trackSelect.appendChild(option);
    }
    if (!snapshot.tracks.length) {
      const option = document.createElement('option');
      option.textContent = '暂无曲目';
      elements.trackSelect.appendChild(option);
    }
  }
  elements.trackSelect.disabled = snapshot.tracks.length === 0;
  elements.trackSelect.value = selectedId;
  renderSelected(previousSelection !== selectedId);

  const playback = snapshot.playback || {};
  const current = snapshot.tracks.find((track) => track.id === snapshot.currentTrackId);
  const hasTrack = Boolean(current);
  elements.playingLabel.textContent = current
    ? `TRACK ${current.number} · ${current.title}` : '尚未选择曲目';
  elements.playButton.textContent = playback.paused ? '▶' : 'Ⅱ';
  for (const id of ['previousButton', 'playButton', 'nextButton', 'progressInput']) {
    elements[id].disabled = !hasTrack;
  }
  elements.exitProgramButton.disabled = !playback.programMode;
  elements.currentTime.textContent = formatTime(playback.currentTime);
  elements.durationTime.textContent = formatTime(playback.duration);
  if (document.activeElement !== elements.progressInput) {
    elements.progressInput.value = playback.duration
      ? String(Math.round(playback.currentTime / playback.duration * 1000)) : '0';
  }
  if (document.activeElement !== elements.volumeInput) elements.volumeInput.value = String(playback.volume ?? 0.85);
  elements.volumeValue.value = `${Math.round(Number(elements.volumeInput.value) * 100)}%`;
  if (document.activeElement !== elements.commentOpacityInput) {
    elements.commentOpacityInput.value = String(playback.commentOpacity ?? 72);
  }
  elements.commentOpacityValue.value = `${elements.commentOpacityInput.value}%`;
  elements.exportButton.disabled = !snapshot.sessionId;
}

async function saveMetadata() {
  const track = selectedTrack();
  if (!track) return;
  const selectionAtSave = selectedId;
  const revisionAtSave = editRevision;
  const coverAtSave = pendingCover;
  const title = elements.titleInput.value.trim();
  if (!title) {
    setStatus('曲目名称不能为空', true);
    elements.titleInput.focus();
    return;
  }
  const update = {
    id: track.id,
    title,
    composer: elements.composerInput.value.trim(),
    submitter: elements.submitterInput.value.trim(),
    genre: elements.genreInput.value.trim(),
    description: elements.descriptionInput.value.trim(),
    descriptionVisible: elements.visibleInput.checked,
  };
  if (coverAtSave) {
    update.coverDataUrl = coverAtSave.dataUrl;
    update.coverPath = coverAtSave.path;
  }
  try {
    await api.updateTrack(update);
    const savedTrack = snapshot.tracks.find((item) => item.id === update.id);
    if (savedTrack && editRevision === revisionAtSave) Object.assign(savedTrack, {
      title: update.title,
      composer: update.composer,
      submitter: update.submitter,
      genre: update.genre,
      description: update.description,
      descriptionVisible: update.descriptionVisible,
      ...(coverAtSave ? { hasCover: Boolean(coverAtSave.dataUrl), coverPath: coverAtSave.path } : {}),
    });
    if (selectedId === selectionAtSave && editRevision === revisionAtSave) {
      dirty = false;
      pendingCover = null;
      setStatus('曲目信息已应用');
    } else if (dirty) {
      setStatus('先前修改已保存，当前更改尚未保存');
    } else {
      setStatus('曲目信息已应用');
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function importMedia(itemsPromise) {
  try {
    const items = await itemsPromise;
    if (items?.length) await command('import', { items });
  } catch (error) {
    setStatus(`导入失败：${error.message}`, true);
  }
}

function renderStreamState(state) {
  elements.streamStatus.textContent = state.message || '未推流';
  elements.streamStatus.classList.toggle('error', state.status === 'error');
  const busy = ['starting', 'live', 'stopping'].includes(state.status);
  elements.streamTestButton.disabled = busy;
  elements.streamStartButton.disabled = busy;
  elements.streamStopButton.disabled = !['starting', 'live'].includes(state.status);
}

async function probeStream() {
  try {
    const result = await api.probeStream(elements.ffmpegPathInput.value.trim());
    elements.ffmpegStatus.textContent = `FFmpeg 已就绪：${result.executable}`;
  } catch (error) {
    elements.ffmpegStatus.textContent = error.message;
  }
}

function streamOptions(mode, filePath = '') {
  return {
    mode,
    filePath,
    ffmpegPath: elements.ffmpegPathInput.value.trim(),
    quality: elements.streamQualityInput.value,
    server: elements.streamServerInput.value.trim(),
    key: elements.streamKeyInput.value.trim(),
  };
}

elements.importButton.addEventListener('click', () => importMedia(api.selectMedia()));
elements.openPlaylistButton.addEventListener('click', () => {
  if (dirty) {
    setStatus('请先保存当前曲目信息，再导入歌单', true);
    return;
  }
  command('open-playlist');
});
elements.savePlaylistButton.addEventListener('click', () => {
  if (dirty) {
    setStatus('请先保存当前曲目信息，再保存歌单', true);
    return;
  }
  command('save-playlist');
});
elements.exportButton.addEventListener('click', async () => {
  if (!snapshot.sessionId) return;
  try {
    const result = await api.exportArchiveCsv(snapshot.sessionId);
    if (result) setStatus(result.incomplete
      ? `已导出 ${result.count} 条，但存档写入曾失败，文件可能不完整`
      : `已导出 ${result.count} 条评分`, Boolean(result.incomplete));
  } catch (error) {
    setStatus(`导出失败：${error.message}`, true);
  }
});
elements.previousButton.addEventListener('click', () => command('previous'));
elements.playButton.addEventListener('click', () => command('play-pause'));
elements.nextButton.addEventListener('click', () => command('next'));
elements.exitProgramButton.addEventListener('click', () => command('leave-program'));
elements.progressInput.addEventListener('input', () => {
  const duration = snapshot.playback?.duration || 0;
  elements.currentTime.textContent = formatTime(duration * Number(elements.progressInput.value) / 1000);
});
elements.progressInput.addEventListener('change', () =>
  command('seek', { progress: Number(elements.progressInput.value) }));
elements.volumeInput.addEventListener('input', () => {
  elements.volumeValue.value = `${Math.round(Number(elements.volumeInput.value) * 100)}%`;
  command('volume', { value: Number(elements.volumeInput.value) });
});
elements.commentOpacityInput.addEventListener('input', () => {
  elements.commentOpacityValue.value = `${elements.commentOpacityInput.value}%`;
  command('comment-opacity', { value: Number(elements.commentOpacityInput.value) });
});
elements.trackSelect.addEventListener('change', () => {
  if (dirty && !window.confirm('当前曲目信息尚未保存，确定放弃更改并切换曲目吗？')) {
    elements.trackSelect.value = selectedId;
    setStatus('未保存的曲目信息已保留，请先保存或确认放弃');
    return;
  }
  selectedId = elements.trackSelect.value;
  coverSelectionRevision += 1;
  editRevision += 1;
  dirty = false;
  renderSelected(true);
  setStatus('');
});
for (const id of ['titleInput', 'composerInput', 'submitterInput', 'genreInput', 'descriptionInput']) {
  elements[id].addEventListener('input', () => {
    editRevision += 1;
    dirty = true;
    setStatus('曲目信息尚未保存');
  });
}
elements.chooseCoverButton.addEventListener('click', async () => {
  const selectionAtOpen = selectedId;
  const selectionRevision = ++coverSelectionRevision;
  try {
    const selected = await api.selectCover();
    if (!selected) return;
    await window.validateCoverImage(selected.dataUrl);
    if (coverSelectionRevision !== selectionRevision) return;
    if (selectedId !== selectionAtOpen) {
      setStatus('选择封面期间切换了曲目，请重新选择封面', true);
      return;
    }
    editRevision += 1;
    pendingCover = selected;
    dirty = true;
    elements.coverState.textContent = `待保存：${selected.path.split(/[\\/]/).pop()}`;
    setStatus('封面尚未保存');
  } catch (error) {
    if (coverSelectionRevision !== selectionRevision) return;
    setStatus(`选择封面失败：${error.message}`, true);
  }
});
elements.clearCoverButton.addEventListener('click', () => {
  coverSelectionRevision += 1;
  editRevision += 1;
  pendingCover = { path: '', dataUrl: '' };
  dirty = true;
  elements.coverState.textContent = '保存后移除封面';
  setStatus('封面更改尚未保存');
});
elements.visibleInput.addEventListener('change', () => {
  editRevision += 1;
  dirty = true;
  saveMetadata();
});
elements.saveButton.addEventListener('click', saveMetadata);
elements.sendMockButton.addEventListener('click', () => {
  const message = elements.mockMessageInput.value.trim();
  if (!message) return;
  command('submit-score', { name: elements.mockNameInput.value.trim(), message });
  elements.mockMessageInput.value = '';
});
elements.mockMessageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') elements.sendMockButton.click();
});
elements.ffmpegPathInput.value = localStorage.getItem('ffmpegPath') || '';
elements.ffmpegPathInput.addEventListener('change', () => {
  localStorage.setItem('ffmpegPath', elements.ffmpegPathInput.value.trim());
  probeStream();
});
elements.streamTestButton.addEventListener('click', async () => {
  try {
    const filePath = await api.selectStreamTestFile();
    if (filePath) await api.startStream(streamOptions('test', filePath));
  } catch (error) {
    setStatus(error.message, true);
  }
});
elements.streamStartButton.addEventListener('click', async () => {
  try {
    await api.startStream(streamOptions('live'));
    elements.streamKeyInput.value = '';
  } catch (error) {
    setStatus(error.message, true);
  }
});
elements.streamStopButton.addEventListener('click', async () => {
  try {
    await api.stopStream();
  } catch (error) {
    setStatus(error.message, true);
  }
});
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  if (paths.length) importMedia(api.inspectMedia(paths));
});

api.onState(render);
api.onFeedback((feedback) => setStatus(feedback.message, feedback.type === 'error'));
api.onStreamState(renderStreamState);
api.getState().then(render).catch((error) => setStatus(error.message, true));
api.getStreamState().then(renderStreamState).catch((error) => setStatus(error.message, true));
probeStream();
