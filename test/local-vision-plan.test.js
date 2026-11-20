'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLocalVisionMusicPlan } = require('../src/local-vision-plan');

const context = {
  duration: 30,
  transcript: { segments: [
    { start: 0, end: 3, text: 'Who are you?' },
    { start: 10, end: 13, text: 'I thought you were gone.' },
  ] },
  frames: [{ time: 2, path: 'frame-a.jpg' }, { time: 12, path: 'frame-b.jpg' }],
  groups: new Map([['浪漫', ['romance.wav']], ['抒情', ['lyrical.wav']]]),
  options: { minTracksPerEpisode: 1, maxTracksPerEpisode: 0, scenePriority: false, maxTrackDuration: 0 },
};

function visionPlan(overrides = {}) {
  return {
    summary: '陌生人出现后，旧日情感浮现。',
    alignmentConfidence: 0.9,
    cues: [
      { startSegment: 0, start: 0, mood: '浪漫', intensity: 2, reason: '人物重逢带来情绪转折。',
        sceneDescription: '昏暗门廊中出现一人。', dramaticIntent: '建立疑问。',
        confidence: 0.9, review: false, evidence: { frameTimes: [2], subtitleIndices: [0] } },
      { startSegment: 1, start: 10, mood: '浪漫', intensity: 1, reason: '对白暗示双方有过往。',
        sceneDescription: '两人隔着门廊对视。', dramaticIntent: '引出旧情。',
        confidence: 0.6, review: true, evidence: { frameTimes: [12], subtitleIndices: [1] } },
    ],
    ...overrides,
  };
}

test('routes local vision cues through screened track selection and preserves review evidence', () => {
  const plan = buildLocalVisionMusicPlan(context, visionPlan());
  assert.deepEqual(plan.segments.map((item) => [item.track, item.start, item.end]), [
    ['romance.wav', 0, 10],
    ['lyrical.wav', 10, 30],
  ]);
  assert.equal(plan.segments[1].review, true);
  assert.equal(plan.segments[1].requestedMood, '浪漫');
  assert.match(plan.segments[1].reason, /相近风格|替代/);
  assert.equal(plan.story.source, 'SRT + 视频画面（本机）');
  assert.deepEqual(plan.story.cues[1].evidence.subtitleIndices, [1]);
  assert.equal(plan.localVision.modelRevision, '5037fcf163dd95d1e41d1974465f0898ed108ca2');
});

test('rejects invented subtitle anchors, frame times, and music categories', () => {
  const invalid = [
    visionPlan({ cues: [{ ...visionPlan().cues[0], startSegment: 8 }] }),
    visionPlan({ cues: [{ ...visionPlan().cues[0], evidence: { frameTimes: [7], subtitleIndices: [0] } }] }),
    visionPlan({ cues: [{ ...visionPlan().cues[0], mood: '不存在' }] }),
    visionPlan({ cues: [{ ...visionPlan().cues[0], evidence: { frameTimes: [2], subtitleIndices: [1] } }] }),
    visionPlan({ cues: [visionPlan().cues[0], { ...visionPlan().cues[1], evidence: { frameTimes: [2], subtitleIndices: [1] } }] }),
    visionPlan({ cues: [{ ...visionPlan().cues[0], evidence: { frameTimes: [2, 12], subtitleIndices: [0, 1] } }, visionPlan().cues[1]] }),
  ];
  for (const value of invalid) assert.throws(() => buildLocalVisionMusicPlan(context, value), /字幕|画面|曲库|音乐|依据/);
});

test('never bypasses screening or invents silence when no compatible eligible track exists', () => {
  const unscreened = { ...context, groups: new Map([['悬疑', []], ['抒情', []]]) };
  assert.throws(() => buildLocalVisionMusicPlan(unscreened, visionPlan()), /合格|曲目|类别/);
  const silence = visionPlan();
  silence.cues[0].mood = null;
  assert.throws(() => buildLocalVisionMusicPlan(context, silence), /曲库|音乐/);
});
