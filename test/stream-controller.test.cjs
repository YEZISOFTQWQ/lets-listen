'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamController, buildRtmpTarget, buildFfmpegArgs } = require('../src/lib/stream-controller.cjs');

test('joins RTMP server and stream key without a shell', () => {
  assert.equal(buildRtmpTarget('rtmp://example.test/live/', 'abc123'), 'rtmp://example.test/live/abc123');
  assert.equal(buildRtmpTarget('rtmps://example.test/live/', '?streamname=abc'), 'rtmps://example.test/live/?streamname=abc');
  assert.throws(() => buildRtmpTarget('https://example.test/live', 'abc'), /rtmp/);
  assert.throws(() => buildRtmpTarget('rtmp://example.test/live', ''), /密钥/);
  assert.throws(() => buildRtmpTarget('rtmp://example.test/live', 'bad\0key'), /有效/);
});

test('encodes WebM input to 720p RTMP FLV or local MP4', () => {
  const live = buildFfmpegArgs({ mode: 'live', target: 'rtmp://example.test/live/key' });
  assert.deepEqual(live.slice(-3), ['-f', 'flv', 'rtmp://example.test/live/key']);
  assert.ok(live.includes('libx264'));
  assert.ok(live.includes('aac'));
  assert.ok(live.some((value) => value.includes('scale=1280:720')));
  const local = buildFfmpegArgs({ mode: 'test', target: 'test.mp4', quality: '1080p' });
  assert.deepEqual(local.slice(-5), ['-movflags', '+faststart', '-f', 'mp4', 'test.mp4']);
  assert.ok(local.some((value) => value.includes('scale=1920:1080')));
});

test('rejects concurrent starts and cancels a pending FFmpeg probe without spawning', async () => {
  let releaseProbe;
  let spawns = 0;
  const controller = new StreamController({
    resolveExecutable: () => new Promise((resolve) => { releaseProbe = resolve; }),
    spawnProcess: () => { spawns += 1; throw new Error('should not spawn'); },
  });
  const first = controller.start({ mode: 'test', filePath: 'qa.mp4' });
  await assert.rejects(controller.start({ mode: 'test', filePath: 'other.mp4' }), /已有推流/);
  controller.finish();
  releaseProbe('ffmpeg');
  await assert.rejects(first, /已取消/);
  assert.equal(spawns, 0);
  assert.equal(controller.starting, false);
  assert.equal(controller.child, null);
});

test('invalid or oversized media chunks stop the encoder without throwing into Electron', () => {
  let killed = 0;
  const controller = new StreamController();
  controller.child = {
    stdin: { destroyed: false, writableLength: 0, write() { throw new Error('should not write'); } },
    kill() { killed += 1; },
  };
  assert.doesNotThrow(() => controller.writeChunk(null));
  assert.equal(killed, 1);
  assert.equal(controller.status.status, 'error');
  controller.child = {
    stdin: { destroyed: false, writableLength: 0, write() { throw new Error('should not write'); } },
    kill() { killed += 1; },
  };
  assert.doesNotThrow(() => controller.writeChunk(Buffer.alloc(8 * 1024 * 1024 + 1)));
  assert.equal(killed, 2);
});
