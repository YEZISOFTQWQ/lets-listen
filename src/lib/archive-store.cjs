'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

class ArchiveStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.sessions = new Map();
  }

  async ensureRoot() {
    await fs.mkdir(this.rootDirectory, { recursive: true });
  }

  async startSession(metadata = {}) {
    await this.ensureRoot();
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const sessionId = crypto.randomUUID();
    const filePath = path.join(this.rootDirectory, `${stamp}-${sessionId.slice(0, 8)}.jsonl`);
    this.sessions.set(sessionId, filePath);
    await this.append(sessionId, {
      type: 'session_start',
      at: now.toISOString(),
      sessionId,
      ...metadata,
    });
    return { sessionId, filePath };
  }

  async append(sessionId, entry) {
    const filePath = this.sessions.get(sessionId);
    if (!filePath) throw new Error('存档会话不存在或已结束');
    const record = {
      at: new Date().toISOString(),
      ...entry,
    };
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async finishSession(sessionId, summary = {}) {
    const filePath = this.sessions.get(sessionId);
    if (!filePath) return null;
    await this.append(sessionId, { type: 'session_end', summary });
    this.sessions.delete(sessionId);
    return filePath;
  }

  async exportCsv(sessionId, destination) {
    const filePath = this.sessions.get(sessionId);
    if (!filePath) throw new Error('找不到当前存档文件');
    const content = await fs.readFile(filePath, 'utf8');
    const records = content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => ['comment', 'score'].includes(record.type));
    const header = ['type', 'at', 'round_id', 'track_title', 'open_id', 'uname', 'score', 'comment', 'msg_id'];
    const rows = records.map((record) => [
      record.type,
      record.at,
      record.roundId,
      record.trackTitle,
      record.openId,
      record.uname,
      record.score,
      record.comment,
      record.msgId,
    ].map(csvCell).join(','));
    const csv = `\uFEFF${header.join(',')}\r\n${rows.join('\r\n')}`;
    await fs.writeFile(destination, csv, 'utf8');
    return { destination, count: rows.length };
  }
}

module.exports = { ArchiveStore, csvCell };

