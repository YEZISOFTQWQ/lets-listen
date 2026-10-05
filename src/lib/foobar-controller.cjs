'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const API_HOST = '127.0.0.1';
const API_PORT = 8880;

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: API_HOST, port: API_PORT, path: `/api${route}`, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 2500,
    }, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        response += chunk;
        if (response.length > 1024 * 1024) req.destroy(new Error('Beefweb 响应过大'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Beefweb ${method} ${route} 请求失败（HTTP ${res.statusCode}）`);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        try { resolve(response ? JSON.parse(response) : null); }
        catch { reject(new Error('Beefweb 返回了无效数据')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Beefweb 响应超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isFoobarResponse = (response) => /foobar2000/i.test(String(response?.player?.info?.name || ''))
  && typeof response?.player?.playbackState === 'string';

class FoobarController {
  constructor(onState) {
    this.onState = onState;
    this.playlistId = '';
    this.timer = null;
    this.generation = 0;
    this.lastState = null;
    this.lastVolumeInfo = null;
    this.openQueue = Promise.resolve();
  }

  async connect(executable) {
    try {
      const response = await request('GET', '/player');
      if (isFoobarResponse(response)) return response;
    }
    catch { /* Start foobar2000 if its local API is not available yet. */ }
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await delay(250);
      try {
        const response = await request('GET', '/player');
        if (isFoobarResponse(response)) return response;
      }
      catch { /* Component may still be starting. */ }
    }
    throw new Error('无法连接 foobar2000 的 Beefweb。请安装并启用 Beefweb Remote Control，确认本机 127.0.0.1:8880 可访问');
  }

  normalize(response) {
    const player = response?.player;
    if (!player || typeof player !== 'object') throw new Error('Beefweb 播放状态无效');
    const item = player.activeItem || {};
    const volume = player.volume || {};
    this.lastVolumeInfo = volume;
    const id = String(item.playlistId || '');
    if (this.playlistId && id && id !== this.playlistId && player.playbackState !== 'stopped') {
      return { unavailable: true, message: 'foobar2000 已切换到其他播放列表' };
    }
    let level = NaN;
    if (volume.type === 'linear' && Number.isFinite(volume.value) && volume.max > volume.min) {
      level = 100 * (volume.value - volume.min) / (volume.max - volume.min);
    } else if (volume.type === 'db' && Number.isFinite(volume.value)) {
      level = volume.value <= volume.min ? 0 : 100 * Math.pow(10, volume.value / 20);
    }
    const previous = this.lastState;
    let currentTime = Math.max(0, Number(item.position) || 0);
    let duration = Math.max(0, Number(item.duration) || 0);
    if (player.playbackState === 'stopped' && previous && !previous.idle) {
      duration ||= previous.duration;
      currentTime = previous.currentTime >= duration - 1.5 ? duration : previous.currentTime;
    }
    return {
      currentTime, duration, paused: player.playbackState !== 'playing',
      idle: player.playbackState === 'stopped',
      volume: volume.isMuted ? 0 : level,
    };
  }

  async readState() {
    const previous = this.lastState;
    let state = this.normalize(await request('GET', '/player'));
    if (previous && !previous.paused && !state.unavailable && state.duration > 0
      && previous.currentTime >= state.duration - 1.5 && state.currentTime < 1 && !state.idle) {
      await request('POST', '/player/stop');
      state = { ...state, currentTime: state.duration, paused: true, idle: true };
    }
    this.lastState = state;
    return state;
  }

  startPolling() {
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (this.polling || !this.playlistId) return;
      const generation = this.generation;
      this.polling = true;
      try {
        const state = await this.readState();
        if (generation === this.generation) this.onState(state);
      }
      catch (error) {
        if (generation === this.generation) {
          this.onState({ unavailable: true, message: `foobar2000 连接中断：${error.message}` });
          clearInterval(this.timer);
          this.timer = null;
        }
      } finally { this.polling = false; }
    }, 200);
  }

  open(executable, filePath) {
    const generation = ++this.generation;
    clearInterval(this.timer);
    this.timer = null;
    this.lastState = null;
    const pending = this.openQueue.then(() => this.openCurrent(executable, filePath, generation));
    this.openQueue = pending.catch(() => {});
    return pending;
  }

  async openCurrent(executable, filePath, generation) {
    const initial = await this.connect(executable);
    if (generation !== this.generation) return { unavailable: true, message: '曲目已切换' };
    if (initial?.player?.permissions?.changePlaylists === false) {
      throw new Error('Beefweb 未允许修改播放列表，请在组件设置中开启播放列表控制');
    }
    const queue = await request('GET', '/playqueue');
    if (Array.isArray(queue?.playQueue) && queue.playQueue.length) {
      throw new Error('foobar2000 播放队列中已有待播曲目。请先在 foobar2000 中清空队列，以免歌曲结束后自动播放其他曲目');
    }
    const browser = await request('GET', '/browser/roots');
    if (Array.isArray(browser?.roots) && browser.roots.length === 0) {
      throw new Error('Beefweb 尚未设置可访问的音乐目录。请在 foobar2000 的“文件 → 首选项 → 工具 → Beefweb Remote Control”中，把歌曲所在文件夹加入 Music directories');
    }
    if (!this.playlistId) {
      const created = await request('POST', '/playlists/add', { title: `lets-listen ${randomUUID().slice(0, 8)}`, setCurrent: true });
      if (!created?.id) throw new Error('Beefweb 未返回专用播放列表 ID');
      this.playlistId = String(created.id);
    }
    if (generation !== this.generation) return { unavailable: true, message: '曲目已切换' };
    try {
      await request('POST', `/playlists/${encodeURIComponent(this.playlistId)}/items/add`, {
        items: [filePath], replace: true, play: true, async: false,
      });
    } catch (error) {
      if (error.statusCode === 403) {
        throw new Error('Beefweb 拒绝读取这首歌：请在 foobar2000 的“文件 → 首选项 → 工具 → Beefweb Remote Control → Music directories”中加入歌曲所在文件夹');
      }
      throw error;
    }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (generation !== this.generation) return { unavailable: true, message: '曲目已切换' };
      const response = await request('GET', '/player');
      if (String(response?.player?.activeItem?.playlistId || '') === this.playlistId
        && response?.player?.playbackState !== 'stopped') {
        const state = this.normalize(response);
        this.lastState = state;
        this.startPolling();
        return state;
      }
      await delay(250);
    }
    throw new Error('foobar2000 未开始播放这首音频，请确认文件格式受支持');
  }

  async command(type, args = {}) {
    if (!this.playlistId) throw new Error('foobar2000 尚未加载 lets-listen 曲目');
    const response = await request('GET', '/player');
    if (String(response?.player?.activeItem?.playlistId || '') !== this.playlistId) {
      if (type === 'play' && response?.player?.playbackState === 'stopped') {
        const playlists = await request('GET', '/playlists');
        const own = playlists?.playlists?.find((playlist) => String(playlist.id) === this.playlistId);
        if (own?.isCurrent && own.itemCount > 0) {
          await request('POST', `/player/play/${encodeURIComponent(this.playlistId)}/0`);
          const resumed = await this.readState();
          this.onState(resumed);
          return resumed;
        }
      }
      throw new Error('foobar2000 当前正在播放其他列表，未执行操作');
    }
    if (type === 'volume') {
      const info = response.player?.volume;
      if (!info || info.type === 'upDown') throw new Error('foobar2000 当前音量模式不支持精确调节');
      const ratio = Math.max(0, Math.min(1, Number(args.value) / 100));
      const value = info.type === 'db'
        ? (ratio === 0 ? info.min : Math.max(info.min, Math.min(info.max, 20 * Math.log10(ratio))))
        : info.min + ratio * (info.max - info.min);
      await request('POST', '/player', { volume: value, isMuted: ratio === 0 });
    } else {
      if (type === 'seek') await request('POST', '/player', { position: Math.max(0, Number(args.seconds) || 0) });
      else if (type === 'play' || type === 'pause') await request('POST', `/player/${type}`);
      else throw new Error('不支持的 foobar2000 操作');
    }
    const state = await this.readState();
    this.onState(state);
    return state;
  }

  async close() {
    ++this.generation;
    clearInterval(this.timer);
    this.timer = null;
    const id = this.playlistId;
    this.playlistId = '';
    this.lastState = null;
    if (!id) return;
    try {
      const response = await request('GET', '/player');
      if (String(response?.player?.activeItem?.playlistId || '') === id) {
        await request('POST', '/player/stop');
      }
      await request('POST', `/playlists/remove/${encodeURIComponent(id)}`);
    } catch (error) { console.warn('foobar2000 专用播放列表清理失败', error.message); }
  }
}

module.exports = { FoobarController };
