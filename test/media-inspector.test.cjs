'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectMediaFiles, readCoverFile, MAX_IMPORT_FILES, MAX_COVER_BYTES } = require('../src/lib/media-inspector.cjs');

function silentWav() {
  const wav = Buffer.alloc(44 + 8000 * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

test('imports a valid WAV but reports missing, empty, directory, and unsupported files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lets-listen-media-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const valid = path.join(root, 'song.wav');
  const empty = path.join(root, 'empty.mp3');
  const unsupported = path.join(root, 'note.txt');
  const directory = path.join(root, 'folder.wav');
  await fs.writeFile(valid, silentWav());
  await fs.writeFile(empty, '');
  await fs.writeFile(unsupported, 'text');
  await fs.mkdir(directory);
  const result = await inspectMediaFiles([valid, path.join(root, 'missing.mp3'), empty, directory, unsupported]);
  assert.equal(result[0].type, 'audio');
  assert.equal(result[0].title, 'song');
  assert.match(result[0].url, /^file:\/\//);
  for (const item of result.slice(1)) assert.ok(item.error, `expected error for ${item.path}`);
});

test('rejects invalid or oversized import batches', async () => {
  await assert.rejects(inspectMediaFiles('song.wav'), /数组/);
  await assert.rejects(inspectMediaFiles(Array(MAX_IMPORT_FILES + 1).fill('song.wav')), /最多导入/);
});

test('accepts a small cover and rejects empty, unsupported, or oversized covers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lets-listen-cover-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cover = path.join(root, 'cover.png');
  const empty = path.join(root, 'empty.png');
  const huge = path.join(root, 'huge.png');
  const text = path.join(root, 'note.txt');
  await fs.writeFile(cover, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64'));
  await fs.writeFile(empty, '');
  await fs.writeFile(huge, 'x');
  await fs.truncate(huge, MAX_COVER_BYTES + 1);
  await fs.writeFile(text, 'not an image');
  assert.match((await readCoverFile(cover)).dataUrl, /^data:image\/png;base64,/);
  await assert.rejects(readCoverFile(empty), /非空/);
  await assert.rejects(readCoverFile(huge), /10 MB/);
  await assert.rejects(readCoverFile(text), /不支持/);
});
