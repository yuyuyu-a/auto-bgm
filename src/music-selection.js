'use strict';

const path = require('node:path');

const MOOD_ALIASES = {
  紧张: ['紧张', '激烈', '冲突'],
  愤怒: ['愤怒', '压迫', '反派'],
  悬疑: ['悬疑', '阴暗', '神秘'],
  爽感: ['爽感', '爽', '打脸', '酷感', '放克'],
  欢快: ['欢快', '活泼', '轻松'],
  浪漫: ['浪漫', '爱情', '温柔'],
  励志: ['励志', '成长', '希望'],
  伤感: ['伤感', '悲伤', '悲情', '失落', '离别'],
  温情: ['温情', '治愈', '平静', '陪伴', '温柔'],
  忧郁: ['忧郁', '阴暗', '沉重', '孤独'],
  默认: ['默认', 'default', '平静', '治愈'],
};

const SIMILAR_MOODS = {
  紧张: ['悬疑', '愤怒', '忧郁'],
  愤怒: ['紧张', '悬疑', '忧郁'],
  悬疑: ['忧郁', '紧张'],
  忧郁: ['伤感', '悬疑'],
  伤感: ['忧郁'],
  浪漫: ['温情'],
  温情: ['浪漫', '励志'],
  欢快: ['爽感', '励志'],
  励志: ['爽感', '温情', '欢快'],
  爽感: ['励志', '欢快'],
};

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');

function canonicalMood(value) {
  const wanted = normalize(value);
  if (!wanted) return null;
  const moods = Object.keys(MOOD_ALIASES);
  return moods.find((mood) => normalize(mood) === wanted) ||
    moods.find((mood) => wanted.includes(normalize(mood))) ||
    ['默认', ...moods.filter((mood) => mood !== '默认')].find((mood) =>
      MOOD_ALIASES[mood].some((alias) => wanted.includes(normalize(alias)))) || null;
}

function matchingFolders(mood, groups) {
  const wanted = normalize(mood);
  if (!wanted) return [];
  const aliases = [mood, ...(MOOD_ALIASES[canonicalMood(mood)] || [])].map(normalize);
  const rank = (name) => normalize(name) === wanted ? -1 : aliases.findIndex((alias) => normalize(name).includes(alias));
  return [...groups.keys()].filter((name) => normalize(name) === wanted || rank(name) >= 0)
    .sort((a, b) => rank(a) - rank(b) || collator.compare(a, b));
}

function findMoodFolder(mood, groups) {
  return matchingFolders(mood, groups)[0] || null;
}

function moodIntensity(mood) {
  const canonical = canonicalMood(mood);
  return /紧张|愤怒|爽感/.test(canonical) ? 3 : /浪漫|欢快|励志/.test(canonical) ? 2 : 1;
}

function selectionTiers(mood, groups) {
  const tiers = [];
  const seen = new Set();
  const add = (names, matchType) => {
    const folders = names.filter((name) => !seen.has(name));
    if (!folders.length) return;
    folders.forEach((name) => seen.add(name));
    tiers.push({ folders, matchType, tracks: [...new Set(folders.flatMap((name) => groups.get(name) || []))] });
  };
  const equivalent = (wanted) => matchingFolders(wanted, groups).filter((name) => {
    const canonical = canonicalMood(wanted);
    const normalized = normalize(name);
    return normalized === normalize(wanted) || !canonical || normalized.includes(normalize(canonical)) ||
      !Object.keys(MOOD_ALIASES).some((label) => normalized.includes(normalize(label)));
  });
  add(equivalent(mood), 'exact');
  for (const similar of SIMILAR_MOODS[canonicalMood(mood)] || []) add(equivalent(similar), 'similar');
  add(equivalent('默认'), 'neutral');
  return tiers;
}

function findCompatibleMoodFolder(mood, groups) {
  return selectionTiers(mood, groups).flatMap((tier) => tier.folders).find((name) => groups.get(name)?.length) || null;
}

function chooseTrack(groups, mood, trackUses, episodeTracks, metadata = new Map(), changeTrack = false, previousTrack = null, intensityOverride) {
  const compatible = selectionTiers(mood, groups);
  const uncertain = !mood && !compatible.some((tier) => tier.tracks.some((track) => track !== previousTrack));
  const tiers = uncertain ? [[...new Set([...groups.values()].flat())]] : compatible.map((tier) => tier.tracks);
  const available = tiers.map((tracks) => tracks.filter((track) => track !== previousTrack)).filter((tracks) => tracks.length);
  const unused = available.map((tracks) => tracks.filter((track) => !episodeTracks.has(track))).filter((tracks) => tracks.length);
  const preferred = available[0] || [];
  const unusedPreferred = preferred.filter((track) => !episodeTracks.has(track));
  const candidates = changeTrack && unused.length ? unused[0] : unusedPreferred.length ? unusedPreferred : preferred;
  const targetIntensity = intensityOverride ?? (uncertain ? 1 : moodIntensity(mood));
  const inferredIntensities = uncertain ? new Map([...groups].flatMap(([name, tracks]) =>
    tracks.map((track) => [track, moodIntensity(name)]))) : new Map();
  const trackIntensity = (track) => metadata.get(track)?.intensity || inferredIntensities.get(track) || 2;
  return [...candidates].sort((a, b) =>
    Math.abs(trackIntensity(a) - targetIntensity) - Math.abs(trackIntensity(b) - targetIntensity) ||
    (trackUses.get(a) || 0) - (trackUses.get(b) || 0) ||
    collator.compare(path.basename(a), path.basename(b)) || collator.compare(a, b))[0] || null;
}

function describeTrackSelection(groups, requestedMood, track) {
  const tier = track && selectionTiers(requestedMood, groups).find((entry) => entry.tracks.includes(track));
  const names = tier?.folders || [...groups.keys()].sort((a, b) => collator.compare(a, b));
  const selectedMood = track ? names.find((name) => groups.get(name)?.includes(track)) || null : null;
  return {
    requestedMood: requestedMood || null,
    selectedMood,
    matchType: !track ? 'silence' : tier?.matchType || 'library',
  };
}

function selectionReason(selection) {
  const { requestedMood, selectedMood, matchType } = selection;
  if (matchType === 'similar') return `目标情绪“${requestedMood}”曲目不足，使用相近风格“${selectedMood}”替代，待试听`;
  if (matchType === 'neutral') return `目标情绪“${requestedMood || '未明确'}”曲目不足，使用兼容中性曲目“${selectedMood}”，待试听`;
  if (matchType === 'library') return `情绪证据不足且无中性曲目，使用曲库中较克制的候选“${selectedMood}”，待试听`;
  return '';
}

module.exports = { canonicalMood, chooseTrack, describeTrackSelection, findCompatibleMoodFolder, findMoodFolder, selectionReason };
