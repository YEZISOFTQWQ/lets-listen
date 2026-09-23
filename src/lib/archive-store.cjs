'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet apps may execute formulas even when the CSV cell is quoted.
  if (/^\s*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

class ArchiveStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.sessions = new Map();
    this.pendingWrites = new Map();
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
    try {
      await this.append(sessionId, {
        type: 'session_start',
        at: now.toISOString(),
        sessionId,
        ...metadata,
      });
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
    return { sessionId, filePath };
  }

  async append(sessionId, entry) {
    const filePath = this.sessions.get(sessionId);
    if (!filePath) throw new Error('存档会话不存在或已结束');
    const record = {
      at: new Date().toISOString(),
      ...entry,
    };
    const previous = this.pendingWrites.get(sessionId) || Promise.resolve();
    const write = previous.catch(() => {}).then(() => fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8'));
    this.pendingWrites.set(sessionId, write);
    try {
      await write;
    } finally {
      if (this.pendingWrites.get(sessionId) === write) this.pendingWrites.delete(sessionId);
    }
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
    if (this.pendingWrites.has(sessionId)) await this.pendingWrites.get(sessionId);
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const [index, line] of lines.entries()) {
      try {
        const record = JSON.parse(line);
        if (['comment', 'score'].includes(record.type)) records.push(record);
      } catch (error) {
        if (index !== lines.length - 1) throw error;
        // A crash can leave the final JSONL line unfinished; keep earlier records exportable.
      }
    }
    const header = ['type', 'at', 'track_id', 'track_title', 'open_id', 'uname', 'score', 'comment', 'msg_id'];
    const rows = records.map((record) => [
      record.type,
      record.at,
      record.trackId ?? record.roundId,
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
