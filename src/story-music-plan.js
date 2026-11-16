'use strict';

const { describeTrackSelection, selectionReason } = require('./music-selection');

function publicStoryProfile(profile = {}) {
  let baseUrl = '';
  try {
    const url = new URL(profile?.baseUrl);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    if (['https:', 'http:'].includes(url.protocol)) baseUrl = url.href;
  } catch { /* Only a public endpoint and model belong in artifacts. */ }
  return { baseUrl, model: typeof profile?.model === 'string' ? profile.model : '' };
}

function assertStoryTranscript(transcript) {
  const segments = transcript?.segments;
  if (!Array.isArray(segments) || !segments.length || !segments.some((segment) => typeof segment.text === 'string' && segment.text.trim()) ||
    segments.some((segment, index) => !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
      segment.start < 0 || segment.end <= segment.start || index > 0 && segment.start < segments[index - 1].start)) {
    throw new Error('剧情辅助需要真实、非空且带有效时间戳的本地转录；请检查字幕 JSON 或重新运行本地转录。');
  }
}

function buildStoryMusicPlan(context, chooseTrack) {
  const { duration, transcript, groups, storyPlan, document, options = {}, trackUses = new Map(), sceneCuts = [], planningVersion = 'story-anchored-v1' } = context;
  assertStoryTranscript(transcript);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('剧情配乐时长必须为有效时间');
  if (!Number.isFinite(storyPlan?.alignmentConfidence) || storyPlan.alignmentConfidence < 0.5 || storyPlan.alignmentConfidence > 1) {
    throw new Error('剧情与对白的对齐置信度不足或无效，请检查对应剧本和字幕。');
  }
  if (typeof storyPlan.summary !== 'string' || !Array.isArray(storyPlan.cues) || !storyPlan.cues.length) throw new Error('剧情配乐计划缺少有效摘要或提示段');
  let previousAnchor = -1;
  let previousStart = -1;
  const cues = storyPlan.cues.map((cue, index) => {
    const anchor = cue?.startSegment;
    if (!Number.isSafeInteger(anchor) || anchor <= previousAnchor || anchor >= transcript.segments.length || (!index && anchor !== 0)) {
      throw new Error('剧情锚点必须从字幕索引 0 开始、严格递增且指向真实字幕段');
    }
    const start = index ? transcript.segments[anchor].start : 0;
    if (start <= previousStart || start >= duration) throw new Error('剧情锚点时间必须严格递增且位于片尾定格之前');
    if (cue.mood !== null && (typeof cue.mood !== 'string' || !groups.has(cue.mood))) throw new Error('剧情配乐包含未知曲库类别，请重新分析剧情。');
    if (![1, 2, 3].includes(cue.intensity)) throw new Error('剧情配乐强度必须为 1、2 或 3');
    if (typeof cue.reason !== 'string' || !cue.reason.trim() || !Number.isFinite(cue.confidence) || cue.confidence < 0 || cue.confidence > 1 ||
      typeof cue.review !== 'boolean') throw new Error('剧情配乐理由、置信度或复核标记无效');
    previousAnchor = anchor;
    previousStart = start;
    return { startSegment: anchor, mood: cue.mood, intensity: cue.intensity, reason: cue.reason, confidence: cue.confidence, review: cue.review, start };
  }).map((cue, index, entries) => ({ ...cue, end: entries[index + 1]?.start ?? duration }));
  const minimum = options.minTracksPerEpisode ?? 1;
  const maximum = options.maxTracksPerEpisode ?? 3;
  const scenePriority = options.scenePriority !== false;
  if (!Number.isSafeInteger(minimum) || minimum < 1 || !Number.isSafeInteger(maximum) || maximum < 0 ||
    !scenePriority && maximum > 0 && minimum > maximum) throw new Error('每集 BGM 数量设置无效，请检查下限和上限');

  const boundaries = new Map(cues.map((cue, cueIndex) => [cue.start, { cueIndex }]));
  const sceneCandidates = sceneCuts.map((cut) => {
    const cueIndex = cues.findIndex((cue) => cut.time >= cue.start && cut.time < cue.end);
    const silence = cueIndex >= 0 && cues[cueIndex].mood === null;
    const required = scenePriority && !silence && cueIndex >= 0 && cut.time > 0 && (cut.score >= 30 || cut.kind === 'black');
    const reason = silence ? '剧情留白期间不触发转场换曲' : required ? '转场必换曲：保留剧情情绪并更换合格曲目，待试听' : '普通镜头候选或转场必换已关闭';
    if (required) boundaries.set(cut.time, { ...boundaries.get(cut.time), cueIndex, boundary: cut.time, sceneTime: cut.time, sceneChange: true, changeTrack: true, required: true, reason });
    return { ...cut, required, used: false, reason };
  });
  const starts = [...boundaries.keys()].sort((a, b) => a - b);
  const episodeTracks = new Set();
  const screened = new Set([...groups.values()].flat());
  const segments = [];
  for (const [index, start] of starts.entries()) {
    const transition = boundaries.get(start);
    const cue = cues[transition.cueIndex];
    const end = starts[index + 1] ?? duration;
    const previousTrack = segments.at(-1)?.track;
    const track = cue.mood === null ? null : chooseTrack(groups, cue.mood, trackUses, episodeTracks,
      options.trackMetadata, index > 0, transition.required ? previousTrack : null, cue.intensity);
    if (cue.mood !== null && transition.required && (!track || track === previousTrack)) {
      throw new Error(`${start} 秒处必须换曲，但没有另一首匹配情绪、相近风格或兼容中性的合格曲目；请补充或确认曲目后重试。`);
    }
    if (cue.mood !== null && !track) throw new Error(`${start} 秒处剧情类别“${cue.mood}”没有合格曲目；请补充或确认该类别、相近风格或兼容中性曲目后重试。`);
    if (track && !screened.has(track)) throw new Error('剧情配乐只能使用已筛选的本地曲库文件');
    const metadata = options.trackMetadata?.get(track);
    const selection = describeTrackSelection(groups, cue.mood, track);
    const fallback = Boolean(track && selection.matchType !== 'exact');
    const segment = {
      start, end, startSegment: cue.startSegment, mood: cue.mood ?? '剧情留白', track, ...selection,
      reason: [cue.reason, transition.required ? transition.reason : '', selectionReason(selection)].filter(Boolean).join('；'),
      confidence: cue.confidence, review: cue.review || fallback || Boolean(transition.required),
      explicitSilence: cue.mood === null, cueIn: metadata?.cueIn || 0, intensity: cue.intensity,
      instrumentalStatus: metadata?.status || (track ? 'unknown' : 'silence'),
      vocalEvidence: metadata?.analysis?.intervals || [], timingSource: 'segment',
      transition: transition.required ? transition : null,
    };
    if (track) { episodeTracks.add(track); trackUses.set(track, (trackUses.get(track) || 0) + 1); }
    segments.push(segment);
  }
  for (const cut of sceneCandidates) cut.used = !cues.some((cue) => cue.mood === null && cut.time >= cue.start && cut.time < cue.end) &&
    segments.some((segment) => segment.start > 0 && segment.start === cut.time);
  const actual = episodeTracks.size;
  if (!scenePriority && maximum > 0 && segments.filter((segment) => segment.track).length > maximum) throw new Error('剧情配乐段数超过每集 BGM 上限；请提高上限或调整剧情提示段，不能丢弃剧情留白或情绪边界。');
  const trackCount = { minimum, actual, segments: segments.length, met: actual >= minimum,
    warning: actual >= minimum ? '' : `未达到每集至少 ${minimum} 首：实际 ${actual} 首；保留剧情提示段与剧情留白，不添加无剧情依据或不匹配的音乐补数。` };
  return {
    baseMood: { mood: cues[0].mood, reason: cues[0].reason },
    segments, sceneCandidates, trackCount, planningVersion,
    story: { source: document?.name || '', profile: publicStoryProfile(options.storyAIProfile),
      alignmentConfidence: storyPlan.alignmentConfidence, summary: storyPlan.summary, cues },
  };
}

module.exports = { assertStoryTranscript, buildStoryMusicPlan, publicStoryProfile };
