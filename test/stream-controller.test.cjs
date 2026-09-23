'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRtmpTarget, buildFfmpegArgs } = require('../src/lib/stream-controller.cjs');

test('joins RTMP server and stream key without a shell', () => {
  assert.equal(buildRtmpTarget('rtmp://example.test/live/', 'abc123'), 'rtmp://example.test/live/abc123');
  assert.equal(buildRtmpTarget('rtmps://example.test/live/', '?streamname=abc'), 'rtmps://example.test/live/?streamname=abc');
  assert.throws(() => buildRtmpTarget('https://example.test/live', 'abc'), /rtmp/);
  assert.throws(() => buildRtmpTarget('rtmp://example.test/live', ''), /密钥/);
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
