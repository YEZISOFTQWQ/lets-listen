'use strict';

const zlib = require('node:zlib');

const HEADER_LENGTH = 16;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_PACKETS = 10_000;

const Operation = Object.freeze({
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8,
});

function encodePacket(operation, body = '', version = 0, sequence = 1) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const packet = Buffer.allocUnsafe(HEADER_LENGTH + bodyBuffer.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(HEADER_LENGTH, 4);
  packet.writeUInt16BE(version, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(sequence, 12);
  bodyBuffer.copy(packet, HEADER_LENGTH);
  return packet;
}

function parsePacketStream(input, depth = 0, budget = { expanded: 0, packets: 0 }) {
  if (depth > 4) {
    throw new Error('Bilibili packet compression nesting is too deep');
  }

  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length > (depth ? MAX_EXPANDED_BYTES : MAX_FRAME_BYTES)) {
    throw new Error('Bilibili packet frame is too large');
  }
  const packets = [];
  let offset = 0;

  while (offset + HEADER_LENGTH <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);
    const sequence = buffer.readUInt32BE(offset + 12);

    if (headerLength < HEADER_LENGTH || packetLength < headerLength) {
      throw new Error(`Invalid Bilibili packet header at offset ${offset}`);
    }
    if (offset + packetLength > buffer.length) {
      throw new Error(`Incomplete Bilibili packet at offset ${offset}`);
    }

    const body = buffer.subarray(offset + headerLength, offset + packetLength);

    if (version === 2) {
      const expanded = zlib.inflateSync(body, { maxOutputLength: MAX_EXPANDED_BYTES });
      budget.expanded += expanded.length;
      if (budget.expanded > MAX_TOTAL_EXPANDED_BYTES) throw new Error('Bilibili packet expansion limit exceeded');
      packets.push(...parsePacketStream(expanded, depth + 1, budget));
    } else if (version === 3) {
      const expanded = zlib.brotliDecompressSync(body, { maxOutputLength: MAX_EXPANDED_BYTES });
      budget.expanded += expanded.length;
      if (budget.expanded > MAX_TOTAL_EXPANDED_BYTES) throw new Error('Bilibili packet expansion limit exceeded');
      packets.push(...parsePacketStream(expanded, depth + 1, budget));
    } else {
      budget.packets += 1;
      if (budget.packets > MAX_PACKETS) throw new Error('Bilibili packet count limit exceeded');
      packets.push({ packetLength, headerLength, version, operation, sequence, body });
    }

    offset += packetLength;
  }

  if (offset !== buffer.length) {
    throw new Error(`Trailing bytes in Bilibili packet stream: ${buffer.length - offset}`);
  }

  return packets;
}

function parseJsonBody(packet) {
  const text = packet.body.toString('utf8').replace(/\0+$/g, '').trim();
  if (!text) return null;
  return JSON.parse(text);
}

module.exports = {
  HEADER_LENGTH,
  MAX_FRAME_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_PACKETS,
  Operation,
  encodePacket,
  parsePacketStream,
  parseJsonBody,
};
