'use strict';

const path = require('node:path');

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function deduplicateMusic(groups) {
  const sources = [...new Set([...groups.values()].flat())].sort((a, b) =>
    collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  const representatives = new Map();
  const duplicates = [];
  const nameKey = (file) => path.basename(file).toLowerCase();
  for (const file of sources) {
    const key = nameKey(file);
    if (representatives.has(key)) {
      duplicates.push({ file, original: representatives.get(key), kind: 'name' });
    } else {
      representatives.set(key, file);
    }
  }
  // A song can belong to several moods without becoming several physical tracks.
  const uniqueGroups = new Map([...groups].map(([mood, tracks]) =>
    [mood, [...new Set(tracks.map((file) => representatives.get(nameKey(file))))]]));
  return { groups: uniqueGroups, files: [...representatives.values()], duplicates };
}

module.exports = { deduplicateMusic };
