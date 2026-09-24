'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ArchiveStore, csvCell } = require('../src/lib/archive-store.cjs');

test('escapes spreadsheet formulas in untrusted comment fields', () => {
  assert.equal(csvCell('=HYPERLINK("https://example.test")'), '"\'=HYPERLINK(""https://example.test"")"');
  assert.equal(csvCell('  @SUM(1,2)'), '"\'  @SUM(1,2)"');
  assert.equal(csvCell('普通乐评'), '"普通乐评"');
});

test('archives JSONL events and exports comment/score CSV', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taste-arena-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ArchiveStore(root);
  const session = await store.startSession({ title: 'test' });
  await store.append(session.sessionId, {
    type: 'comment', roundId: '01', trackTitle: 'Song', openId: 'u1', uname: 'Alice', comment: '好听', msgId: 'm1',
  });
  await store.append(session.sessionId, {
    type: 'score', trackId: '01', trackTitle: 'Song', openId: 'u1', uname: 'Alice', score: 8.5, msgId: 'm2',
  });
  const destination = path.join(root, 'export.csv');
  const result = await store.exportCsv(session.sessionId, destination);
  const csv = await fs.readFile(destination, 'utf8');
  assert.equal(result.count, 2);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines[0].split(',')[2], 'track_id');
  assert.match(lines[1], /"01"/);
  assert.match(lines[2], /"01"/);
  assert.match(csv, /Alice/);
  assert.match(csv, /8\.5/);
  assert.match(csv, /好听/);
});

test('serializes rapid comments and still exports after a truncated final JSONL line', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lets-listen-archive-burst-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ArchiveStore(root);
  const session = await store.startSession();
  await Promise.all(Array.from({ length: 100 }, (_, index) => store.append(session.sessionId, {
    type: 'comment', trackId: '01', comment: `乐评 ${index}`, msgId: `m-${index}`,
  })));
  await fs.appendFile(session.filePath, '{"type":"comment"');
  const output = path.join(root, 'comments.csv');
  const result = await store.exportCsv(session.sessionId, output);
  const rows = (await fs.readFile(output, 'utf8')).split('\r\n');
  assert.equal(result.count, 100);
  assert.match(rows[1], /乐评 0/);
  assert.match(rows[100], /乐评 99/);
});

test('refuses to overwrite the source archive during CSV export', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lets-listen-archive-overwrite-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ArchiveStore(root);
  const session = await store.startSession();
  await store.append(session.sessionId, { type: 'comment', trackId: '01', comment: '保留原始乐评' });
  const before = await fs.readFile(session.filePath, 'utf8');
  await assert.rejects(store.exportCsv(session.sessionId, session.filePath), /存档|覆盖/);
  const alias = path.join(root, 'source-alias.csv');
  await fs.link(session.filePath, alias);
  await assert.rejects(store.exportCsv(session.sessionId, alias), /存档|覆盖/);
  assert.equal(await fs.readFile(session.filePath, 'utf8'), before);
  const existingCsv = path.join(root, 'existing.csv');
  await fs.writeFile(existingCsv, '旧的 CSV');
  await store.exportCsv(session.sessionId, existingCsv);
  assert.match(await fs.readFile(existingCsv, 'utf8'), /保留原始乐评/);
  assert.equal(await fs.readFile(session.filePath, 'utf8'), before);
});
