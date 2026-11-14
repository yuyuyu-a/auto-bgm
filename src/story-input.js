'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const STORY_EXTENSIONS = new Set(['.txt', '.md', '.json', '.docx']);
const MAX_STORY_CHARS = 80000;

async function loadStoryDocument(storyPath, videoPath, { singleVideo = true, includePath = false } = {}) {
  if (!String(storyPath || '').trim()) throw new Error('请选择剧本或分镜文件。');
  let file = path.resolve(storyPath);
  let stat;
  try { stat = await fs.stat(file); } catch { throw new Error('剧本或分镜路径不可访问。'); }
  if (stat.isDirectory()) {
    const stem = path.parse(videoPath).name.toLowerCase();
    const suffixes = ['', '.script', '.storyboard', '_script', '_storyboard', '.剧本', '.分镜', '_剧本', '_分镜'];
    const names = new Set(suffixes.map((suffix) => stem + suffix));
    const candidates = (await fs.readdir(file, { withFileTypes: true })).filter((entry) =>
      entry.isFile() && STORY_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && names.has(path.parse(entry.name).name.toLowerCase()));
    if (!candidates.length) throw new Error(`找不到与视频“${path.parse(videoPath).name}”同名的剧本或分镜。`);
    if (candidates.length > 1) throw new Error(`视频“${path.parse(videoPath).name}”对应多个剧本或分镜，请只保留一个版本。`);
    file = path.join(file, candidates[0].name);
    stat = await fs.stat(file);
  } else if (!singleVideo) {
    throw new Error('单个剧本只用于单个视频；批量视频请选择按视频同名整理的剧本目录。');
  }
  const extension = path.extname(file).toLowerCase();
  if (!stat.isFile() || !STORY_EXTENSIONS.has(extension)) throw new Error('剧本格式仅支持 TXT、Markdown、JSON 和 DOCX。');
  if (stat.size > (extension === '.docx' ? 8 : 2) * 1024 * 1024) throw new Error('剧本文件过大，请按单集拆分后导入。');
  const buffer = await fs.readFile(file);
  let text;
  if (extension === '.docx') {
    try {
      const mammoth = require('mammoth');
      text = (await mammoth.extractRawText({ buffer }, { externalFileAccess: false })).value;
    } catch { throw new Error('无法读取 Word 剧本，请检查 DOCX 文件或导出为 TXT。'); }
  } else {
    try {
      const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : 'utf-8';
      text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch { throw new Error('剧本文本编码无法识别，请使用 UTF-8 或 UTF-16 文本。'); }
    if (extension === '.json') {
      let structured;
      try { structured = JSON.parse(text); } catch { throw new Error('剧本 JSON 格式无效。'); }
      if (!structured || !['object', 'string'].includes(typeof structured)) throw new Error('剧本 JSON 没有可用内容。');
      text = typeof structured === 'string' ? structured : JSON.stringify(structured, null, 2);
    }
  }
  text = text.trim();
  if (!text) throw new Error('剧本或分镜内容为空。');
  if (text.length > MAX_STORY_CHARS) throw new Error(`剧本内容过长，单集最多 ${MAX_STORY_CHARS} 个字符，请按集拆分。`);
  const name = path.basename(file);
  const signature = createHash('sha256').update(name).update('\0').update(buffer).digest('hex');
  return { name, text, signature, ...(includePath ? { path: file } : {}) };
}

module.exports = { loadStoryDocument, STORY_EXTENSIONS, MAX_STORY_CHARS };
