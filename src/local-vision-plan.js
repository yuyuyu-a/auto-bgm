'use strict';

const { buildStoryMusicPlan } = require('./story-music-plan');
const { chooseTrack } = require('./music-selection');
const { LOCAL_VISION_MODEL } = require('./local-vision-assets');

function validateLocalVisionPlan(context, visionPlan) {
  const { duration, transcript, frames, groups } = context;
  const segments = transcript?.segments;
  if (!Number.isFinite(duration) || duration <= 0 || !Array.isArray(segments) || !segments.length ||
      !Array.isArray(frames) || !frames.length || !(groups instanceof Map) || !groups.size) {
    throw new Error('本地画面配乐上下文不完整，请检查视频、SRT 字幕和已筛选曲库。');
  }
  if (!visionPlan || typeof visionPlan.summary !== 'string' || !visionPlan.summary.trim() ||
      !Number.isFinite(visionPlan.alignmentConfidence) || visionPlan.alignmentConfidence < 0.5 ||
      visionPlan.alignmentConfidence > 1 || !Array.isArray(visionPlan.cues) || !visionPlan.cues.length) {
    throw new Error('本地画面配乐分析结果无效或字幕对齐置信度不足。');
  }
  const frameTimes = new Set(frames.map(({ time }) => time));
  let previous = -1;
  const cues = visionPlan.cues.map((cue, index) => {
    const segment = segments[cue?.startSegment];
    if (!Number.isSafeInteger(cue?.startSegment) || cue.startSegment <= previous ||
        index === 0 && cue.startSegment !== 0 || !segment ||
        !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.start < 0 || segment.end <= segment.start || segment.end > duration) {
      throw new Error('本地画面配乐锚点必须按顺序引用视频范围内的真实 SRT 字幕。');
    }
    if (typeof cue.mood !== 'string' || !groups.has(cue.mood) || !groups.get(cue.mood)?.length) {
      throw new Error('本地画面配乐类别不在当前通过筛选的音乐曲库中。');
    }
    const evidence = cue.evidence;
    const requestedNextAnchor = visionPlan.cues[index + 1]?.startSegment;
    const nextSegment = Number.isSafeInteger(requestedNextAnchor) ? segments[requestedNextAnchor] : null;
    const nextAnchor = nextSegment ? requestedNextAnchor : segments.length;
    const cueStart = index === 0 ? 0 : segment.start;
    const cueEnd = nextSegment ? nextSegment.start : duration;
    if (!evidence || !Array.isArray(evidence.frameTimes) || !evidence.frameTimes.length ||
        evidence.frameTimes.some((time) => !frameTimes.has(time)) ||
        evidence.frameTimes.some((time) => time < cueStart || time >= cueEnd) ||
        !Array.isArray(evidence.subtitleIndices) || !evidence.subtitleIndices.length ||
        !evidence.subtitleIndices.includes(cue.startSegment) ||
        evidence.subtitleIndices.some((id) => !Number.isSafeInteger(id) || !segments[id] ||
          id < cue.startSegment || id >= nextAnchor)) {
      throw new Error('本地画面配乐依据必须引用当前音乐段内的抽帧和真实字幕。');
    }
    if (![1, 2, 3].includes(cue.intensity) || !Number.isFinite(cue.confidence) ||
        cue.confidence < 0 || cue.confidence > 1 ||
        typeof cue.reason !== 'string' || !cue.reason.trim() ||
        typeof cue.sceneDescription !== 'string' || !cue.sceneDescription.trim() ||
        typeof cue.dramaticIntent !== 'string' || !cue.dramaticIntent.trim()) {
      throw new Error('本地画面配乐缺少有效强度、置信度、画面说明或选曲依据。');
    }
    previous = cue.startSegment;
    return {
      ...cue,
      start: index === 0 ? 0 : segment.start,
      end: undefined,
      review: cue.review === true || cue.confidence < 0.75 || visionPlan.alignmentConfidence < 0.75,
      evidence: {
        frameTimes: [...new Set(evidence.frameTimes)],
        subtitleIndices: [...new Set(evidence.subtitleIndices)],
      },
    };
  });
  return { ...visionPlan, cues };
}

function buildLocalVisionMusicPlan(context, rawVisionPlan, chooseTrackFn = chooseTrack) {
  const visionPlan = validateLocalVisionPlan(context, rawVisionPlan);
  const storyPlan = {
    summary: visionPlan.summary,
    alignmentConfidence: visionPlan.alignmentConfidence,
    cues: visionPlan.cues.map(({ startSegment, mood, intensity, reason, confidence, review }) =>
      ({ startSegment, mood, intensity, reason, confidence, review })),
  };
  const result = buildStoryMusicPlan({
    ...context,
    storyPlan,
    document: { name: 'SRT + 视频画面（本机）' },
    options: { ...context.options, storyAIProfile: undefined },
    planningVersion: 'local-visual-srt-v1',
  }, chooseTrackFn);
  const cues = visionPlan.cues.map((cue, index) => ({
    ...cue,
    end: visionPlan.cues[index + 1]?.start ?? context.duration,
  }));
  const byAnchor = new Map(cues.map((cue) => [cue.startSegment, cue]));
  const segments = result.segments.map((segment) => {
    const cue = byAnchor.get(segment.startSegment);
    return cue ? {
      ...segment,
      sceneDescription: cue.sceneDescription,
      dramaticIntent: cue.dramaticIntent,
      visualEvidence: cue.evidence,
    } : segment;
  });
  return {
    ...result,
    segments,
    story: {
      ...result.story,
      source: 'SRT + 视频画面（本机）',
      profile: undefined,
      model: `Qwen2.5-VL-3B · ${LOCAL_VISION_MODEL.revision.slice(0, 12)}`,
      cues,
    },
    localVision: {
      modelRepository: LOCAL_VISION_MODEL.repository,
      modelRevision: LOCAL_VISION_MODEL.revision,
      summary: visionPlan.summary,
      alignmentConfidence: visionPlan.alignmentConfidence,
      cues,
    },
  };
}

module.exports = { buildLocalVisionMusicPlan, validateLocalVisionPlan };
