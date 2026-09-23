'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

if (process.platform !== 'win32') throw new Error('此端到端测试需要 Windows 桌面');

const projectRoot = path.resolve(__dirname, '..');
const electron = require('electron');
const outputPath = path.join(os.tmpdir(), `lets-listen-e2e-${randomUUID()}.mp4`);

function run(executable, args, { timeoutMs = 30000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, env, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(executable)} 超时：${args.join(' ')}`));
    }, timeoutMs);
    const collect = (chunk) => { output = (output + chunk.toString()).slice(-200000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${path.basename(executable)} 退出码 ${code}\n${output}`));
      else resolve(output);
    });
  });
}

async function checkElectron(args, marker, options = {}) {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lets-listen-e2e-archive-'));
  try {
    const output = await run(electron, ['.', ...args], {
      ...options,
      env: { ...process.env, ...options.env, LETS_LISTEN_QA_ARCHIVE: archiveRoot },
    });
    assert.ok(output.includes(marker), `缺少自检标记 ${marker}\n${output}`);
    process.stdout.write(`✓ ${args.join(' ')}\n`);
  } finally {
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!path.resolve(archiveRoot).startsWith(temporaryRoot)
      || !path.basename(archiveRoot).startsWith('lets-listen-e2e-archive-')) {
      throw new Error('拒绝清理非本次测试存档');
    }
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
}

async function main() {
  await checkElectron(['--qa-demo', '--qa-description'], '[qa] backstage controls and description passed');
  await checkElectron(['--qa-demo', '--qa-program', '--qa-description'], '[qa] backstage controls and description passed');
  await checkElectron(['--qa-demo', '--qa-comments'], '[qa] fullscreen comments passed');
  await checkElectron(['--qa-demo', '--qa-video', '--qa-comments'], '[qa] fullscreen comments passed');
  const videoPath = path.join(os.tmpdir(), `lets-listen-e2e-video-${randomUUID()}.mp4`);
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', videoPath,
    ]);
    await checkElectron(['--qa-real-video'], '[qa] real video import and playback passed', {
      env: { ...process.env, LETS_LISTEN_QA_VIDEO: videoPath },
    });
  } finally {
    await fs.rm(videoPath, { force: true });
  }
  await checkElectron(['--qa-demo', '--qa-program', '--qa-stream-errors'], '[qa] stream error handling passed');
  await checkElectron(['--qa-live-exit'], '[qa] pending live session retried on quit');
  await checkElectron(['--qa-demo', '--qa-program', '--qa-stream', '--qa-keep-stream'],
    '[qa] stream container encoded', {
      timeoutMs: 45000,
      env: { ...process.env, LETS_LISTEN_QA_OUTPUT: outputPath },
    });

  const probe = JSON.parse(await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', outputPath,
  ]));
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.ok(Number(video.duration) >= 8, '录像时长不足 8 秒');
  assert.equal(audio?.codec_name, 'aac');

  const picture = await run('ffmpeg', [
    '-hide_banner', '-ss', '5', '-i', outputPath, '-frames:v', '1',
    '-vf', 'signalstats,metadata=print', '-f', 'null', 'NUL',
  ]);
  const maximumBrightness = Number(picture.match(/signalstats\.YMAX=(\d+)/)?.[1]);
  const maximumSaturation = Number(picture.match(/signalstats\.SATMAX=(\d+)/)?.[1]);
  assert.ok(maximumBrightness > 150 && maximumSaturation > 20,
    `录到的可能是空白画面：YMAX=${maximumBrightness}, SATMAX=${maximumSaturation}`);

  const sound = await run('ffmpeg', [
    '-hide_banner', '-i', outputPath, '-vn', '-af', 'volumedetect', '-f', 'null', 'NUL',
  ]);
  const maximumVolume = Number(sound.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/)?.[1]);
  assert.ok(maximumVolume > -35, `应用音频未进入录像：最大音量 ${maximumVolume} dB`);
  process.stdout.write(`✓ 真实节目帧和应用音轨：YMAX=${maximumBrightness}, SATMAX=${maximumSaturation}, max=${maximumVolume} dB\n`);

  const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!path.resolve(outputPath).startsWith(temporaryRoot) || !path.basename(outputPath).startsWith('lets-listen-e2e-')) {
    throw new Error('拒绝清理非本次临时录像');
  }
  await fs.rm(outputPath);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.stderr.write(`测试录像（如已生成）：${outputPath}\n`);
  process.exitCode = 1;
});
