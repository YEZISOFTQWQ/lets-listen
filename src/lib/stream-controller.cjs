'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function ffmpegCandidates(customPath = '') {
  const bundled = path.join(process.resourcesPath || '', 'ffmpeg.exe');
  return [customPath.trim(), process.env.FFMPEG_PATH || '', fs.existsSync(bundled) ? bundled : '', 'ffmpeg']
    .filter(Boolean);
}

function probeExecutable(candidate) {
  return new Promise((resolve) => {
    const child = spawn(candidate, ['-hide_banner', '-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk) => { output += chunk.toString().slice(0, 500); });
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
  if (!secret || /\s/.test(secret)) throw new Error('请输入有效的串流密钥');
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
  constructor() {
    super();
    this.child = null;
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

  async start(options) {
    if (this.child) throw new Error('已有推流或测试录制正在运行');
    const executable = await findFfmpeg(String(options.ffmpegPath || ''));
    const mode = options.mode === 'test' ? 'test' : 'live';
    const target = mode === 'test'
      ? String(options.filePath || '')
      : buildRtmpTarget(options.server, options.key);
    if (!target) throw new Error('未选择测试录制文件');
    this.target = target;
    this.mode = mode;
    this.intentionalStop = false;
    const child = spawn(executable, buildFfmpegArgs({ target, mode, quality: options.quality }), {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.child = child;
    this.update('starting', mode === 'test' ? '正在启动本地测试录制…' : '正在启动内置推流…');
    let lastError = '';
    child.stderr.on('data', (data) => {
      lastError = data.toString().trim().slice(-500) || lastError;
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
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
  }

  writeChunk(bytes) {
    if (!this.child || this.child.stdin.destroyed) return;
    if (this.child.stdin.writableLength > 8 * 1024 * 1024) {
      this.abort('编码速度跟不上画面，请降低画质或关闭占用性能的程序');
      return;
    }
    this.child.stdin.write(Buffer.from(bytes));
  }

  finish() {
    if (!this.child || this.child.stdin.destroyed) return;
    this.intentionalStop = true;
    this.update('stopping', '正在结束编码并保存文件…');
    this.child.stdin.end();
    this.stopTimer = setTimeout(() => this.child?.kill(), 10000);
  }

  abort(message = '推流已中止') {
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
