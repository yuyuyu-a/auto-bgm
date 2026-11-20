'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const MAX_SUBTITLE_CUES = 2000;

function subtitleTime(value) {
  const match = String(value || '').trim().match(/^(?:(\d{1,4}):)?(\d{2}):([0-5]\d)[,.](\d{1,3})$/);
  if (!match) throw new Error('SRT 字幕时间格式无效，应使用 时:分:秒,毫秒。');
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || !Number.isSafeInteger(hours)) throw new Error('SRT 字幕时间超出有效范围。');
  const milliseconds = Number(match[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function parseSrt(text, duration) {
  if (typeof text !== 'string') throw new Error('SRT 字幕内容必须为文本。');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效，无法校验 SRT 字幕时间。');
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error('SRT 字幕为空，请选择包含有效时间轴的字幕文件。');
  const blocks = normalized.split(/\n[ \t]*\n+/);
  if (blocks.length > MAX_SUBTITLE_CUES) throw new Error(`SRT 字幕超过 ${MAX_SUBTITLE_CUES} 条，请按集拆分。`);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeIndex = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const timeLine = lines[timeIndex]?.trim();
    const match = timeLine?.match(/^(.+?)\s+-->\s+(.+?)(?:\s+.*)?$/);
    if (!match) throw new Error('SRT 字幕块缺少有效的“开始时间 --> 结束时间”行。');
    const start = subtitleTime(match[1]);
    const end = subtitleTime(match[2]);
    if (end <= start) throw new Error('SRT 字幕结束时间必须晚于开始时间。');
    if (end > duration) throw new Error('SRT 字幕时间超过视频时长，请确认字幕与视频为同一剪辑版本。');
    if (segments.length && start < segments.at(-1).start) throw new Error('SRT 字幕时间顺序异常，请按开始时间检查字幕。');
    const cueText = lines.slice(timeIndex + 1).join(' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cueText) throw new Error('SRT 字幕包含没有对白内容的时间段。');
    segments.push({ start, end, text: cueText });
  }
  if (!segments.length) throw new Error('SRT 字幕为空，请选择包含有效时间轴的字幕文件。');
  return { segments, language: null };
}

async function collectSubtitleMatches(directory, stem) {
  const expected = stem.toLocaleLowerCase('en-US');
  const matches = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.srt' &&
          path.parse(entry.name).name.toLocaleLowerCase('en-US') === expected) matches.push(file);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

async function findSubtitleForVideo(videoPath, subtitlePath, videoCount, duration) {
  if (typeof subtitlePath !== 'string' || !subtitlePath.trim()) throw new Error('本地画面配乐需要选择 SRT 字幕文件或字幕目录。');
  const target = path.resolve(subtitlePath);
  let stat;
  try { stat = await fs.stat(target); } catch { throw new Error('SRT 字幕路径不可访问，请重新选择文件或目录。'); }
  let file;
  if (stat.isFile()) {
    if (path.extname(target).toLowerCase() !== '.srt') throw new Error('字幕文件格式仅支持 SRT。');
    if (videoCount !== 1) throw new Error('一个 SRT 文件只用于单个视频；批量处理请选择按视频同名整理的字幕目录。');
    file = target;
  } else if (stat.isDirectory()) {
    const matches = await collectSubtitleMatches(target, path.parse(videoPath).name);
    if (!matches.length) throw new Error(`找不到与视频“${path.parse(videoPath).name}”同名的 SRT 字幕。`);
    if (matches.length > 1) throw new Error(`视频“${path.parse(videoPath).name}”对应多个 SRT 字幕，请只保留一个版本。`);
    file = matches[0];
  } else {
    throw new Error('SRT 字幕路径必须是文件或目录。');
  }
  const fileStat = await fs.stat(file);
  if (fileStat.size > MAX_SUBTITLE_BYTES) throw new Error('SRT 字幕文件过大，请按集拆分后再导入。');
  let bytes;
  let text;
  try {
    bytes = await fs.readFile(file);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SRT 字幕编码无法识别，请另存为 UTF-8 后重试。');
  }
  return {
    path: file,
    source: 'srt',
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    ...parseSrt(text, duration),
  };
}

module.exports = { findSubtitleForVideo, parseSrt };
