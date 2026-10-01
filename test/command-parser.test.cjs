'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScore, normalizeText } = require('../src/renderer/command-parser.js');

test('parses explicit track score commands', () => {
  assert.deepEqual(parseScore('#07 8.5'), {
    type: 'score', roundId: '07', score: 8.5, raw: '#07 8.5',
  });
  assert.equal(parseScore('曲7评分9').score, 9);
  assert.equal(parseScore('TRACK 07 9').score, 9);
  assert.equal(parseScore('Ｐ０７ 分 ６.５').score, 6.5);
});

test('parses current track score commands', () => {
  assert.deepEqual(parseScore('评分 9.2', { currentRound: '3' }), {
    type: 'score', roundId: '03', score: 9.2, raw: '评分 9.2',
  });
  assert.equal(parseScore('评分 11', { currentRound: '03' }).type, 'invalid');
  assert.equal(parseScore('评分 8').type, 'invalid');
});

test('never treats free text or comment commands as scores', () => {
  assert.equal(parseScore('#12评 前奏很惊艳').type, 'ignored');
  assert.equal(parseScore('评论：鼓点很松弛', { currentRound: 2 }).type, 'ignored');
  assert.equal(parseScore('这首不错', { currentRound: 2 }).type, 'ignored');
});

test('normalizes full-width punctuation and digits', () => {
  assert.equal(normalizeText(' ＃０７： ８.５  '), '#07: 8.5');
});
