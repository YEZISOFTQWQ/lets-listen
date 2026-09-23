'use strict';

const api = window.backstageApi;
const elements = {
  trackSelect: document.getElementById('trackSelect'),
  currentIndicator: document.getElementById('currentIndicator'),
  descriptionInput: document.getElementById('descriptionInput'),
  visibleInput: document.getElementById('visibleInput'),
  videoNotice: document.getElementById('videoNotice'),
  saveButton: document.getElementById('saveButton'),
  status: document.getElementById('status'),
};
let snapshot = { currentTrackId: '', tracks: [] };
let selectedId = '';
let dirty = false;

function selectedTrack() {
  return snapshot.tracks.find((track) => track.id === selectedId) || null;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', error);
}

function render(snapshotNext) {
  const wasFollowingCurrent = !selectedId || selectedId === snapshot.currentTrackId;
  const previousSelection = selectedId;
  snapshot = snapshotNext;
  if (wasFollowingCurrent) selectedId = snapshot.currentTrackId;
  if (!snapshot.tracks.some((track) => track.id === selectedId)) {
    selectedId = snapshot.currentTrackId || snapshot.tracks[0]?.id || '';
  }

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
  elements.trackSelect.disabled = snapshot.tracks.length === 0;
  elements.trackSelect.value = selectedId;
  renderSelected(previousSelection !== selectedId);
}

function renderSelected(force = false) {
  const track = selectedTrack();
  const available = Boolean(track);
  elements.descriptionInput.disabled = !available;
  elements.visibleInput.disabled = !available || track.type === 'video';
  elements.saveButton.disabled = !available;
  elements.currentIndicator.textContent = !track
    ? '请先在主窗口导入音频'
    : track.id === snapshot.currentTrackId ? '当前播放曲目' : '队列中的其他曲目，切换播放后生效';
  elements.videoNotice.textContent = track?.type === 'video' ? '视频模式只显示评论栏' : '';
  if (force || !dirty) {
    elements.descriptionInput.value = track?.description || '';
    elements.visibleInput.checked = Boolean(track?.descriptionVisible);
    dirty = false;
  }
}

async function applyUpdate(includeDescription) {
  const track = selectedTrack();
  if (!track) return;
  const update = { id: track.id, descriptionVisible: elements.visibleInput.checked };
  if (includeDescription) update.description = elements.descriptionInput.value.trim();
  try {
    await api.updateTrack(update);
    dirty = false;
    setStatus(includeDescription ? '简介已保存并应用' : '展示状态已更新');
  } catch (error) {
    setStatus(error.message, true);
  }
}

elements.trackSelect.addEventListener('change', () => {
  selectedId = elements.trackSelect.value;
  dirty = false;
  renderSelected(true);
  setStatus('');
});
elements.descriptionInput.addEventListener('input', () => {
  dirty = true;
  setStatus('内容尚未保存');
});
elements.visibleInput.addEventListener('change', () => applyUpdate(dirty));
elements.saveButton.addEventListener('click', () => applyUpdate(true));
api.onState(render);
api.getState().then(render).catch((error) => setStatus(error.message, true));
