(function universalCommandParser(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TasteCommands = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function commandParserFactory() {
  'use strict';

  function normalizeText(input) {
    return String(input ?? '')
      .trim()
      .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
      .replace(/\s+/g, ' ');
  }

  function normalizeRound(value) {
    if (value == null || value === '') return null;
    const digits = String(value).replace(/^0+/, '') || '0';
    return digits.padStart(2, '0');
  }

  function parseDanmaku(input, options = {}) {
    const text = normalizeText(input);
    if (!text) return { type: 'empty', raw: text };

    const currentRound = normalizeRound(options.currentRound);
    let match;

    match = text.match(/^#?\s*(?:P|曲)?\s*(\d{1,3})\s*(?:评分|打分|分|score|s)?\s*[: ]?\s*(\d{1,2}(?:\.\d)?)\s*分?$/i);
    if (match) {
      const score = Number(match[2]);
      if (score < 0 || score > 10) {
        return { type: 'invalid', reason: '评分必须在 0–10 之间', raw: text };
      }
      return { type: 'score', roundId: normalizeRound(match[1]), score, raw: text };
    }

    match = text.match(/^(?:评分|打分|score|s)\s*[: ]?\s*(\d{1,2}(?:\.\d)?)\s*分?$/i);
    if (match) {
      const score = Number(match[1]);
      if (score < 0 || score > 10) {
        return { type: 'invalid', reason: '评分必须在 0–10 之间', raw: text };
      }
      if (!currentRound) return { type: 'invalid', reason: '当前没有播放曲目', raw: text };
      return { type: 'score', roundId: currentRound, score, raw: text };
    }

    match = text.match(/^#?\s*(?:P|曲)?\s*(\d{1,3})\s*(?:评论|点评|评|comment|c)\s*[: ]?\s*(.+)$/i);
    if (match) {
      return { type: 'comment', roundId: normalizeRound(match[1]), comment: match[2].trim(), raw: text };
    }

    match = text.match(/^(?:评论|点评|评|comment|c)\s*[: ]?\s*(.+)$/i);
    if (match) {
      if (!currentRound) return { type: 'invalid', reason: '当前没有播放曲目', raw: text };
      return { type: 'comment', roundId: currentRound, comment: match[1].trim(), raw: text };
    }

    match = text.match(/^#?\s*(?:P|曲)?\s*(\d{1,3})\s+(.+)$/i);
    if (match) {
      return { type: 'comment', roundId: normalizeRound(match[1]), comment: match[2].trim(), raw: text };
    }

    if (options.unparsedAsComment && currentRound) {
      return { type: 'comment', roundId: currentRound, comment: text, raw: text, implicit: true };
    }

    return { type: 'ignored', raw: text };
  }

  return { normalizeText, normalizeRound, parseDanmaku };
}));
