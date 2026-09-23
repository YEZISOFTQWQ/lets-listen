'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi']);
const MAX_IMPORT_FILES = 500;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const COVER_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);
const COVER_EXTENSIONS = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

async function readCoverFile(filePath) {
  const mimeType = COVER_EXTENSIONS[path.extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error('不支持的封面图片类型');
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_COVER_BYTES) {
    throw new Error('封面必须是小于 10 MB 的非空图片文件');
  }
  const data = await fs.readFile(filePath);
  return { path: filePath, dataUrl: `data:${mimeType};base64,${data.toString('base64')}` };
}

async function inspectMediaFiles(filePaths) {
  if (!Array.isArray(filePaths)) throw new Error('导入列表必须是文件路径数组');
  if (filePaths.length > MAX_IMPORT_FILES) throw new Error(`一次最多导入 ${MAX_IMPORT_FILES} 个文件`);
  const { parseFile } = await import('music-metadata');
  const inspected = [];
  for (const filePath of filePaths) {
    try {
      if (typeof filePath !== 'string' || !filePath) throw new Error('文件路径无效');
      const extension = path.extname(filePath).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
        throw new Error('不支持的文件类型');
      }
      const info = await fs.stat(filePath);
      if (!info.isFile() || info.size === 0) throw new Error('不是可播放的文件或文件为空');
      const type = VIDEO_EXTENSIONS.has(extension) ? 'video' : 'audio';
      let metadata = {};
      let coverDataUrl = '';
      try {
        metadata = await parseFile(filePath, { duration: true, skipPostHeaders: true });
        const picture = metadata.common?.picture?.[0];
        if (picture?.data?.length && picture.data.length <= MAX_COVER_BYTES && COVER_MIME_TYPES.has(picture.format)) {
          coverDataUrl = `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`;
        }
      } catch {
        // Tags are optional: Electron may still play unusual but supported containers.
      }
      inspected.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        path: filePath,
        url: pathToFileURL(filePath).href,
        type,
        title: metadata.common?.title || path.basename(filePath, extension),
        artist: metadata.common?.artist || '',
        submitter: metadata.common?.artist || '',
        album: metadata.common?.album || '',
        duration: Number(metadata.format?.duration || 0),
        coverDataUrl,
        description: '',
        descriptionVisible: false,
      });
    } catch (error) {
      inspected.push({ path: String(filePath || ''), error: error.message });
    }
  }
  return inspected;
}

module.exports = { inspectMediaFiles, readCoverFile, MAX_IMPORT_FILES, MAX_COVER_BYTES };
