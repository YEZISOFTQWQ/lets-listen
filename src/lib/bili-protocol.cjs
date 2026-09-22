'use strict';

const zlib = require('node:zlib');

const HEADER_LENGTH = 16;

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

function parsePacketStream(input, depth = 0) {
  if (depth > 4) {
    throw new Error('Bilibili packet compression nesting is too deep');
  }

  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
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
      packets.push(...parsePacketStream(zlib.inflateSync(body), depth + 1));
    } else if (version === 3) {
      packets.push(...parsePacketStream(zlib.brotliDecompressSync(body), depth + 1));
    } else {
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
  Operation,
  encodePacket,
  parsePacketStream,
  parseJsonBody,
};

