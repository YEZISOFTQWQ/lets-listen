'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function ffmpegCandidates(customPath = '') {
  const bundled = path.join(process.resourcesPath || '', 'ffmpeg.exe');
  return [String(customPath || '').trim(), process.env.FFMPEG_PATH || '', fs.existsSync(bundled) ? bundled : '', 'ffmpeg']
    .filter(Boolean);
}

function probeExecutable(candidate) {
  return new Promise((resolve) => {
    const child = spawn(candidate, ['-hide_banner', '-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(0, 500); });
    child.on('error', () => { clearTimeout(timeout); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && output.startsWith('ffmpeg version'));
    });
  });
}

async function findFfmpeg(customPath = '') {
  for (const candidate of ffmpegCandidates(customPath)) {
    if (await probeExecutable(candidate)) return candidate;
  }
  throw new Error('未找到 FFmpeg。请安装 FFmpeg 并加入 PATH，或在直播后台指定 ffmpeg.exe');
}

function buildRtmpTarget(server, key) {
  const address = String(server || '').trim();
  const secret = String(key || '').trim();
  if (!/^rtmps?:\/\/[^\s]+$/i.test(address)) throw new Error('请输入以 rtmp:// 或 rtmps:// 开头的推流服务器地址');
  if (!secret || /[\s\u0000-\u001f\u007f]/u.test(secret)
    || /[\u0000-\u001f\u007f]/u.test(address)) throw new Error('请输入有效的串流密钥或推流地址');
  return secret.startsWith('?') ? `${address}${secret}` : `${address.replace(/\/+$/, '')}/${secret.replace(/^\/+/, '')}`;
}

function buildFfmpegArgs({ target, mode, quality = '720p' }) {
  const hd = quality === '1080p';
  const width = hd ? 1920 : 1280;
  const height = hd ? 1080 : 720;
  const bitrate = hd ? '6000k' : '3500k';
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts',
    '-f', 'webm', '-i', 'pipe:0',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-r', '30', '-g', '60', '-b:v', bitrate, '-maxrate', bitrate,
    '-bufsize', hd ? '12000k' : '7000k',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
  ];
  if (mode === 'test') return [...args, '-y', '-movflags', '+faststart', '-f', 'mp4', target];
  return [...args, '-f', 'flv', target];
}

class StreamController extends EventEmitter {
  constructor({ resolveExecutable = findFfmpeg, spawnProcess = spawn } = {}) {
    super();
    this.resolveExecutable = resolveExecutable;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.starting = false;
    this.generation = 0;
    this.status = { status: 'idle', message: '未推流' };
    this.target = '';
    this.mode = '';
    this.stopTimer = null;
    this.intentionalStop = false;
  }

  update(status, message) {
    this.status = { status, message };
    this.emit('state', this.status);
  }

  async start(options = {}) {
    if (this.child || this.starting) throw new Error('已有推流或测试录制正在运行');
    const mode = options.mode === 'test' ? 'test' : 'live';
    const target = mode === 'test'
      ? String(options.filePath || '')
      : buildRtmpTarget(options.server, options.key);
    if (!target) throw new Error('未选择测试录制文件');
    this.starting = true;
    const generation = ++this.generation;
    this.update('starting', '正在检查 FFmpeg…');
    try {
    const executable = await this.resolveExecutable(String(options.ffmpegPath || ''));
    if (generation !== this.generation) throw new Error('推流启动已取消');
    this.target = target;
    this.mode = mode;
    this.intentionalStop = false;
    const child = this.spawnProcess(executable, buildFfmpegArgs({ target, mode, quality: options.quality }), {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.child = child;
    this.starting = false;
    this.update('starting', mode === 'test' ? '正在启动本地测试录制…' : '正在启动内置推流…');
    let lastError = '';
    child.stderr.on('data', (data) => {
      lastError = data.toString().trim().slice(-500) || lastError;
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.target = '';
      this.mode = '';
      this.update('error', `FFmpeg 启动失败：${error.message}`);
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
      if (code === 0 && this.intentionalStop) {
        this.update('idle', mode === 'test' ? `测试录制已保存：${path.basename(target)}` : '推流已停止');
      } else {
        let safeError = lastError.replaceAll(target, '[推流地址已隐藏]');
        if (options.key) safeError = safeError.replaceAll(String(options.key), '[密钥已隐藏]');
        this.update('error', `推流进程退出（${code ?? '未知'}）：${safeError || '请检查推流地址、网络和编码设置'}`);
      }
      this.target = '';
      this.mode = '';
    });
    return { executable, mode };
    } catch (error) {
      if (generation === this.generation) {
        this.starting = false;
        this.target = '';
        this.mode = '';
        this.update('error', error.message);
      }
      throw error;
    }
  }

  writeChunk(bytes) {
    if (!this.child || this.child.stdin.destroyed) return;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
      this.abort('录制数据无效或单块过大，推流已停止');
      return;
    }
    if (this.child.stdin.writableLength > 8 * 1024 * 1024) {
      this.abort('编码速度跟不上画面，请降低画质或关闭占用性能的程序');
      return;
    }
    try {
      this.child.stdin.write(Buffer.from(bytes));
    } catch (error) {
      this.abort(`编码输入失败：${error.message}`);
    }
  }

  finish() {
    if (this.starting && !this.child) {
      this.abort('推流启动已取消');
      return;
    }
    if (!this.child) return;
    if (this.child.stdin.destroyed) {
      this.abort('编码输入已经关闭，推流已停止');
      return;
    }
    this.intentionalStop = true;
    this.update('stopping', '正在结束编码并保存文件…');
    this.child.stdin.end();
    this.stopTimer = setTimeout(() => this.child?.kill(), 10000);
  }

  abort(message = '推流已中止') {
    this.generation += 1;
    this.starting = false;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.update('error', message);
    this.target = '';
    this.mode = '';
  }
}

module.exports = { StreamController, findFfmpeg, buildRtmpTarget, buildFfmpegArgs };
