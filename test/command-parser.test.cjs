'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDanmaku, normalizeText } = require('../src/renderer/command-parser.js');

test('parses explicit round score commands', () => {
  assert.deepEqual(parseDanmaku('#07 8.5'), {
    type: 'score', roundId: '07', score: 8.5, raw: '#07 8.5',
  });
  assert.equal(parseDanmaku('曲7评分9').score, 9);
  assert.equal(parseDanmaku('Ｐ０７ 分 ６.５').score, 6.5);
});

test('parses current round score commands', () => {
  assert.deepEqual(parseDanmaku('评分 9.2', { currentRound: '3' }), {
    type: 'score', roundId: '03', score: 9.2, raw: '评分 9.2',
  });
  assert.equal(parseDanmaku('评分 11', { currentRound: '03' }).type, 'invalid');
  assert.equal(parseDanmaku('评分 8').type, 'invalid');
});

test('parses explicit and implicit comments', () => {
  assert.deepEqual(parseDanmaku('#12评 前奏很惊艳'), {
    type: 'comment', roundId: '12', comment: '前奏很惊艳', raw: '#12评 前奏很惊艳',
  });
  assert.equal(parseDanmaku('评论：鼓点很松弛', { currentRound: 2 }).comment, '鼓点很松弛');
  assert.equal(parseDanmaku('这首不错', { currentRound: 2 }).type, 'ignored');
  assert.equal(parseDanmaku('这首不错', { currentRound: 2, unparsedAsComment: true }).implicit, true);
});

test('normalizes full-width punctuation and digits', () => {
  assert.equal(normalizeText(' ＃０７： ８.５  '), '#07: 8.5');
});

