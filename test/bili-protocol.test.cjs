'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  HEADER_LENGTH,
  MAX_FRAME_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_PACKETS,
  Operation,
  encodePacket,
  parsePacketStream,
  parseJsonBody,
} = require('../src/lib/bili-protocol.cjs');

test('encodes an official 16-byte big-endian packet header', () => {
  const packet = encodePacket(Operation.AUTH, '{"key":"value"}');
  assert.equal(packet.readUInt32BE(0), packet.length);
  assert.equal(packet.readUInt16BE(4), HEADER_LENGTH);
  assert.equal(packet.readUInt16BE(6), 0);
  assert.equal(packet.readUInt32BE(8), Operation.AUTH);
  assert.equal(packet.subarray(16).toString(), '{"key":"value"}');
});

test('parses multiple packets in one websocket frame', () => {
  const one = encodePacket(Operation.MESSAGE, JSON.stringify({ cmd: 'ONE' }));
  const two = encodePacket(Operation.MESSAGE, JSON.stringify({ cmd: 'TWO' }));
  const packets = parsePacketStream(Buffer.concat([one, two]));
  assert.equal(packets.length, 2);
  assert.equal(parseJsonBody(packets[0]).cmd, 'ONE');
  assert.equal(parseJsonBody(packets[1]).cmd, 'TWO');
});

test('recursively expands zlib-compressed version 2 packets', () => {
  const nested = Buffer.concat([
    encodePacket(Operation.MESSAGE, JSON.stringify({ cmd: 'A' })),
    encodePacket(Operation.MESSAGE, JSON.stringify({ cmd: 'B' })),
  ]);
  const compressed = encodePacket(Operation.MESSAGE, zlib.deflateSync(nested), 2);
  const packets = parsePacketStream(compressed);
  assert.deepEqual(packets.map(parseJsonBody).map((item) => item.cmd), ['A', 'B']);
});

test('expands Brotli-compressed version 3 packets', () => {
  const nested = encodePacket(Operation.MESSAGE, JSON.stringify({ cmd: 'LIVE_OPEN_PLATFORM_DM', data: { msg: '评分 8.5' } }));
  const compressed = encodePacket(Operation.MESSAGE, zlib.brotliCompressSync(nested), 3);
  const packets = parsePacketStream(compressed);
  assert.equal(packets.length, 1);
  assert.equal(parseJsonBody(packets[0]).data.msg, '评分 8.5');
});

test('rejects incomplete packet frames', () => {
  const packet = encodePacket(Operation.MESSAGE, '{}');
  assert.throws(() => parsePacketStream(packet.subarray(0, packet.length - 1)), /Incomplete/);
});

test('rejects oversized frames and compressed expansion bombs', () => {
  assert.throws(() => parsePacketStream(Buffer.alloc(MAX_FRAME_BYTES + 1)), /too large/);
  const bomb = encodePacket(Operation.MESSAGE, zlib.deflateSync(Buffer.alloc(MAX_EXPANDED_BYTES + 1)), 2);
  assert.throws(() => parsePacketStream(bomb), /larger|limit|too large/i);
  const brotliBomb = encodePacket(Operation.MESSAGE,
    zlib.brotliCompressSync(Buffer.alloc(MAX_EXPANDED_BYTES + 1)), 3);
  assert.throws(() => parsePacketStream(brotliBomb), /larger|limit|too large/i);
});

test('rejects an excessive number of nested message packets', () => {
  const many = Buffer.concat(Array.from({ length: MAX_PACKETS + 1 }, () => encodePacket(Operation.MESSAGE)));
  assert.throws(() => parsePacketStream(many), /count limit/);
});
