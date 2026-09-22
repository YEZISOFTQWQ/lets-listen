'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  HEADER_LENGTH,
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

test('rejects incomplete packet frames', () => {
  const packet = encodePacket(Operation.MESSAGE, '{}');
  assert.throws(() => parsePacketStream(packet.subarray(0, packet.length - 1)), /Incomplete/);
});

