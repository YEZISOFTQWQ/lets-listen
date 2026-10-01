'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectMediaFiles, readCoverFile, MAX_IMPORT_FILES } = require('./media-inspector.cjs');

const FORMAT = 'lets-listen-playlist';
const VERSION = 1;
const MAX_PLAYLIST_BYTES = 64 * 1024 * 1024;

function locationFor(filePath, playlistDirectory) {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(playlistDirectory, absolutePath);
  return {
    absolutePath,
    relativePath: path.isAbsolute(relativePath) ? '' : relativePath,
  };
}

async function resolveLocation(location, playlistDirectory) {
  if (!location || typeof location !== 'object') return '';
  const candidates = [];
  if (typeof location.relativePath === 'string' && location.relativePath) {
    candidates.push(path.resolve(playlistDirectory, location.relativePath));
  }
  if (typeof location.absolutePath === 'string' && path.isAbsolute(location.absolutePath)) {
    candidates.push(location.absolutePath);
  }
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // A moved playlist can still use its original absolute path.
    }
  }
  return '';
}

function savedTrack(track, playlistDirectory) {
  if (!track || typeof track.path !== 'string' || !path.isAbsolute(track.path)) {
    throw new Error(`“${String(track?.title || '未命名曲目')}”不是本地媒体文件，无法保存到歌单`);
  }
  const coverKind = track.hasCover ? (track.coverPath ? 'file' : 'embedded') : 'none';
  return {
    media: locationFor(track.path, playlistDirectory),
    title: String(track.title || '').trim().slice(0, 120),
    composer: String(track.composer || '').trim().slice(0, 80),
    submitter: String(track.submitter || '').trim().slice(0, 80),
    genre: String(track.genre || '').trim().slice(0, 80),
    description: String(track.description || ''),
    descriptionVisible: Boolean(track.descriptionVisible),
    cover: {
      kind: coverKind,
      ...(coverKind === 'file' ? { file: locationFor(track.coverPath, playlistDirectory) } : {}),
    },
  };
}

async function savePlaylistFile(filePath, snapshot) {
  if (!Array.isArray(snapshot?.tracks) || snapshot.tracks.length === 0) throw new Error('请先导入曲目再保存歌单');
  if (snapshot.tracks.length > MAX_IMPORT_FILES) throw new Error(`歌单最多保存 ${MAX_IMPORT_FILES} 首曲目`);
  const directory = path.dirname(filePath);
  const content = JSON.stringify({
    format: FORMAT,
    version: VERSION,
    currentIndex: Number.isInteger(snapshot.currentIndex) ? snapshot.currentIndex : 0,
    tracks: snapshot.tracks.map((track) => savedTrack(track, directory)),
  }, null, 2);
  if (Buffer.byteLength(content, 'utf8') > MAX_PLAYLIST_BYTES) throw new Error('歌单文件超过 64 MB，无法保存');
  await fs.writeFile(filePath, `${content}\n`, 'utf8');
  return { path: filePath, count: snapshot.tracks.length };
}

async function loadPlaylistFile(filePath) {
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size === 0 || info.size > MAX_PLAYLIST_BYTES) {
    throw new Error('歌单文件为空或超过 64 MB');
  }
  let document;
  try {
    document = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error('歌单 JSON 格式无效');
  }
  if (document?.format !== FORMAT || document.version !== VERSION || !Array.isArray(document.tracks)) {
    throw new Error('不是受支持的 lets-listen 歌单');
  }
  if (!document.tracks.length || document.tracks.length > MAX_IMPORT_FILES) {
    throw new Error(`歌单必须包含 1 到 ${MAX_IMPORT_FILES} 首曲目`);
  }
  const directory = path.dirname(filePath);
  const available = [];
  const missing = [];
  for (const [index, entry] of document.tracks.entries()) {
    const mediaPath = await resolveLocation(entry?.media, directory);
    if (mediaPath) available.push({ index, entry, mediaPath });
    else missing.push(String(entry?.title || `第 ${index + 1} 首`));
  }
  const inspected = await inspectMediaFiles(available.map((item) => item.mediaPath));
  const tracks = [];
  const originalIndexes = [];
  let missingCovers = 0;
  for (const [position, item] of available.entries()) {
    const media = inspected[position];
    if (!media || media.error) {
      missing.push(String(item.entry.title || `第 ${item.index + 1} 首`));
      continue;
    }
    const entry = item.entry;
    media.title = typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim().slice(0, 120) : media.title;
    media.composer = typeof entry.composer === 'string' ? entry.composer.trim().slice(0, 80) : media.composer;
    media.submitter = typeof entry.submitter === 'string' ? entry.submitter.trim().slice(0, 80) : '';
    media.genre = typeof entry.genre === 'string' ? entry.genre.trim().slice(0, 80) : media.genre;
    media.description = typeof entry.description === 'string' ? entry.description : '';
    media.descriptionVisible = Boolean(entry.descriptionVisible);
    if (entry.cover?.kind === 'none') {
      media.coverDataUrl = '';
    } else if (entry.cover?.kind === 'file') {
      const coverPath = await resolveLocation(entry.cover.file, directory);
      if (coverPath) {
        try {
          const cover = await readCoverFile(coverPath);
          media.coverDataUrl = cover.dataUrl;
          media.coverPath = cover.path;
        } catch {
          missingCovers += 1;
        }
      } else {
        missingCovers += 1;
      }
    }
    tracks.push(media);
    originalIndexes.push(item.index);
  }
  if (!tracks.length) throw new Error('歌单中的媒体文件均无法找到或读取，原播放队列未改变');
  const requestedIndex = Number.isInteger(document.currentIndex) ? document.currentIndex : 0;
  const selectedIndex = Math.max(0, originalIndexes.indexOf(requestedIndex));
  return { tracks, selectedIndex, missing, missingCovers, path: filePath };
}

module.exports = { savePlaylistFile, loadPlaylistFile };
