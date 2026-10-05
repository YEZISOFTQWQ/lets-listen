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
    if (typeof destination !== 'string' || path.extname(destination).toLowerCase() !== '.csv') {
      throw new Error('导出目标必须是 .csv 文件，不能覆盖原始存档');
    }
    if (this.pendingWrites.has(sessionId)) await this.pendingWrites.get(sessionId);
    const sourceInfo = await fs.stat(filePath);
    let destinationInfo;
    try {
      destinationInfo = await fs.stat(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (destinationInfo && sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino) {
      throw new Error('导出目标指向原始存档，不能覆盖');
    }
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const records = [];
    for (const [index, line] of lines.entries()) {
      try {
        const record = JSON.parse(line);
        if (typeof record.type === 'string' && (record.type === 'playlist_loaded' || record.type.startsWith('track_'))) {
          records.push(record);
        }
      } catch (error) {
        if (index !== lines.length - 1) throw error;
        // A crash can leave the final JSONL line unfinished; keep earlier records exportable.
      }
    }
    const header = ['type', 'at', 'track_id', 'track_title', 'artist', 'composer', 'submitter', 'genre', 'media_type', 'source_path', 'position', 'description', 'description_visible', 'cover_path'];
    const rows = records.map((record) => [
      record.type,
      record.at,
      record.trackId ?? record.roundId,
      record.trackTitle,
      record.artist,
      record.composer,
      record.submitter,
      record.genre,
      record.mediaType,
      record.sourcePath,
      record.position,
      record.description,
      record.descriptionVisible,
      record.coverPath,
    ].map(csvCell).join(','));
    const csv = `\uFEFF${header.join(',')}\r\n${rows.join('\r\n')}`;
    await fs.writeFile(destination, csv, 'utf8');
    return { destination, count: rows.length };
  }
}

module.exports = { ArchiveStore, csvCell };
