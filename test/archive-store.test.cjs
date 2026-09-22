'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ArchiveStore } = require('../src/lib/archive-store.cjs');

test('archives JSONL events and exports comment/score CSV', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taste-arena-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ArchiveStore(root);
  const session = await store.startSession({ title: 'test' });
  await store.append(session.sessionId, {
    type: 'comment', roundId: '01', trackTitle: 'Song', openId: 'u1', uname: 'Alice', comment: '好听', msgId: 'm1',
  });
  await store.append(session.sessionId, {
    type: 'score', roundId: '01', trackTitle: 'Song', openId: 'u1', uname: 'Alice', score: 8.5, msgId: 'm2',
  });
  const destination = path.join(root, 'export.csv');
  const result = await store.exportCsv(session.sessionId, destination);
  const csv = await fs.readFile(destination, 'utf8');
  assert.equal(result.count, 2);
  assert.match(csv, /Alice/);
  assert.match(csv, /8\.5/);
  assert.match(csv, /好听/);
});

