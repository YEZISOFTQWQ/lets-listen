'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  signRequest,
  createStartBody,
  createEndBody,
} = require('../src/lib/bilibili-client.cjs');

test('produces deterministic Bilibili HMAC headers', () => {
  const body = JSON.stringify({ game_id: 'demo' });
  const headers = signRequest(body, 'demo-key', 'demo-secret', {
    timestamp: 1710000000,
    nonce: 'fixed-nonce',
  });
  assert.equal(headers['x-bili-content-md5'], 'cc1d0731a0c97bb0111709cb25de25f2');
  assert.equal(headers.Authorization, 'f08b008d4b385afdd853d7569543279b43a21ff75606f4f266136d8d79ad11d3');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('preserves int64 app ids without numeric conversion', () => {
  assert.equal(
    createStartBody('ABC', '9223372036854775807'),
    '{"code":"ABC","app_id":9223372036854775807}',
  );
  assert.equal(
    createEndBody('game', '9223372036854775807'),
    '{"game_id":"game","app_id":9223372036854775807}',
  );
});

test('rejects malformed app ids', () => {
  assert.throws(() => createStartBody('ABC', '1e6'), /纯数字/);
});

