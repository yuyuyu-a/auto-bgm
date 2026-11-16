'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMusicPlan } = require('../src/mvp');

const transcript = { segments: [
  { start: 2, end: 6, text: 'I love you. This is our wedding.' },
  { start: 9, end: 12, text: '' },
  { start: 18.125, end: 25, text: 'We should talk.' },
  { start: 31.75, end: 38, text: 'Goodbye.' },
] };
const groups = new Map([
  ['紧张', ['tense-hard.wav', 'tense-soft.wav']],
  ['浪漫', ['romance.wav']],
  ['默认', ['neutral.wav']],
]);
const cue = (startSegment, mood, intensity = 1) => ({
  startSegment, mood, intensity, reason: `Story beat ${startSegment}`, confidence: 0.85, review: false,
});
const storyPlan = (cues) => ({ summary: 'A concealed threat, then a pause.', alignmentConfidence: 0.9, cues });
function plan(cues, overrides = {}) {
  return buildMusicPlan({
    duration: 40, transcript, groups, trackUses: new Map(),
    document: { name: 'episode.md', text: 'PRIVATE_SCRIPT', signature: 'document-hash' },
    storyPlan: storyPlan(cues),
    options: {
      storyEnabled: true, scenePriority: false, maxTracksPerEpisode: 0,
      storyAIProfile: { baseUrl: 'https://model.example/v1', model: 'director', apiKey: 'PRIVATE_KEY' },
      trackMetadata: new Map([
        ['tense-hard.wav', { intensity: 3, cueIn: 1, status: 'confirmed_instrumental' }],
        ['tense-soft.wav', { intensity: 1, cueIn: 2, status: 'confirmed_instrumental' }],
      ]),
    },
    ...overrides,
  });
}

test('story cues override keyword moods and use original ASR array anchors without moving boundaries', () => {
  const result = plan([cue(0, '紧张'), cue(2, null), cue(3, '浪漫', 2)]);
  assert.deepEqual(result.segments.map(({ start, end }) => [start, end]), [[0, 18.125], [18.125, 31.75], [31.75, 40]]);
  assert.deepEqual(result.segments.map(({ mood }) => mood), ['紧张', '剧情留白', '浪漫']);
  assert.equal(result.segments[0].track, 'tense-soft.wav');
  assert.equal(result.segments[0].cueIn, 2);
  assert.equal(result.segments[0].intensity, 1);
  assert.equal(result.segments[1].track, null);
  assert.equal(result.segments[1].explicitSilence, true);
  assert.equal(result.story.source, 'episode.md');
  assert.deepEqual(result.story.profile, { baseUrl: 'https://model.example/v1', model: 'director' });
  assert.equal(result.story.alignmentConfidence, 0.9);
  assert.deepEqual(result.story.cues.map(({ startSegment }) => startSegment), [0, 2, 3]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SCRIPT|PRIVATE_KEY|apiKey/);
});

test('story intensity is independent of the category name and applies to screened track selection', () => {
  const soft = plan([cue(0, '紧张', 1)]);
  const hard = plan([cue(0, '紧张', 3)]);
  assert.equal(soft.segments[0].track, 'tense-soft.wav');
  assert.equal(hard.segments[0].track, 'tense-hard.wav');
  assert.equal(hard.segments[0].mood, '紧张');
});

test('story minimum reports insufficient distinct music without adding cues or filling deliberate silence', () => {
  const result = plan([cue(0, '紧张'), cue(2, null)], {
    options: { storyEnabled: true, scenePriority: false, minTracksPerEpisode: 3, maxTracksPerEpisode: 0 },
  });
  assert.equal(result.segments.length, 2);
  assert.equal(result.trackCount.actual, 1);
  assert.equal(result.trackCount.met, false);
  assert.match(result.trackCount.warning, /未达到.*3.*剧情/);
  const silent = plan([cue(0, null)]);
  assert.equal(silent.segments.length, 1);
  assert.equal(silent.segments[0].track, null);
  assert.equal(silent.trackCount.actual, 0);
});

test('required scene changes switch local music but never split an explicit-silence cue', () => {
  const result = plan([cue(0, '紧张'), cue(2, null), cue(3, '浪漫')], {
    options: { storyEnabled: true, scenePriority: true, maxTracksPerEpisode: 1 },
    sceneCuts: [{ time: 8, score: 50 }, { time: 22, score: 60 }, { time: 31.75, score: 55 }],
  });
  assert.deepEqual(result.segments.map(({ start }) => start), [0, 8, 18.125, 31.75]);
  assert.notEqual(result.segments[0].track, result.segments[1].track);
  assert.equal(result.sceneCandidates[0].required, true);
  assert.equal(result.sceneCandidates[0].used, true);
  assert.equal(result.sceneCandidates[1].required, false);
  assert.equal(result.sceneCandidates[1].used, false);
  assert.match(result.sceneCandidates[1].reason, /剧情留白/);
  const disabled = plan([cue(0, '紧张')], { sceneCuts: [{ time: 8, score: 50 }] });
  assert.equal(disabled.segments.length, 1);
});

test('missing story music or required alternatives fail actionably instead of falling back to silence', () => {
  assert.throws(() => plan([cue(0, '紧张')], { groups: new Map([['紧张', []]]) }), /合格曲目.*补充|补充.*曲目/);
  assert.throws(() => plan([cue(0, '紧张')], {
    groups: new Map([['紧张', ['only.wav']]]),
    options: { storyEnabled: true, scenePriority: true },
    sceneCuts: [{ time: 8, score: 50 }],
  }), /8.*必须换曲.*另一首/);
  const neutral = plan([cue(0, '紧张')], { groups: new Map([['紧张', []], ['默认', ['neutral.wav']]]) });
  assert.equal(neutral.segments[0].track, 'neutral.wav');
  assert.equal(neutral.segments[0].review, true);
  assert.match(neutral.segments[0].reason, /兼容中性/);
});

test('an unavailable valid story category uses similar music with accurate provenance and keeps deliberate silence', () => {
  const result = plan([cue(0, '浪漫'), cue(2, null)], {
    groups: new Map([['浪漫', []], ['温情', ['warm.wav']], ['默认', ['neutral.wav']]]),
  });
  assert.deepEqual(result.segments.map(({ track }) => track), ['warm.wav', null]);
  assert.equal(result.segments[0].requestedMood, '浪漫');
  assert.equal(result.segments[0].selectedMood, '温情');
  assert.equal(result.segments[0].matchType, 'similar');
  assert.equal(result.segments[0].review, true);
  assert.match(result.segments[0].reason, /浪漫.*相近.*温情/);
  assert.doesNotMatch(result.segments[0].reason, /兼容中性/);
  assert.equal(result.segments[1].explicitSilence, true);
  assert.equal(result.segments[1].matchType, 'silence');
});

test('story switching can substitute suspense for a second tension track without moving the scene', () => {
  const result = plan([cue(0, '紧张', 3)], {
    groups: new Map([['紧张', ['only.wav']], ['悬疑', ['mystery.wav']], ['默认', ['neutral.wav']]]),
    options: { storyEnabled: true, scenePriority: true },
    sceneCuts: [{ time: 8, score: 50 }],
  });
  assert.deepEqual(result.segments.map(({ track }) => track), ['only.wav', 'mystery.wav']);
  assert.equal(result.segments[1].start, 8);
  assert.equal(result.segments[1].selectedMood, '悬疑');
  assert.equal(result.segments[1].matchType, 'similar');
  assert.equal(result.sceneCandidates[0].used, true);
});

test('local story builder rejects malformed cues and low alignment defensively', () => {
  const invalid = [
    [], [cue(2, '紧张')], [cue(0, '紧张'), cue(0, '浪漫')],
    [cue(0, '紧张'), cue(9, null)], [cue(0, '紧张'), cue(3, null), cue(2, '浪漫')],
    [cue(0, '/arbitrary/audio.wav')], [{ ...cue(0, '紧张'), intensity: 4 }],
    [{ ...cue(0, '紧张'), confidence: NaN }], [{ ...cue(0, '紧张'), review: 'false' }],
    [cue(0, '紧张'), cue(3, null)],
  ];
  for (const [index, cues] of invalid.entries()) {
    assert.throws(() => plan(cues, index === invalid.length - 1 ? { duration: 30 } : {}), /剧情|锚点|强度|置信|类别|时间/);
  }
  assert.throws(() => plan([cue(0, '紧张')], { storyPlan: { ...storyPlan([cue(0, '紧张')]), alignmentConfidence: 0.3 } }), /对齐|置信/);
});

test('local story builder rejects a chooser path outside the screened groups', () => {
  const { buildStoryMusicPlan } = require('../src/story-music-plan');
  assert.throws(() => buildStoryMusicPlan({
    duration: 40, transcript, groups, options: {}, trackUses: new Map(), storyPlan: storyPlan([cue(0, '紧张')]),
  }, () => 'C:\\private\\unscanned.wav'), /筛选|曲库/);
});

test('story cap counts repeated nonsilent segments rather than distinct files and excludes silence', () => {
  assert.throws(() => plan([cue(0, '紧张'), cue(2, '紧张')], {
    groups: new Map([['紧张', ['only.wav']]]),
    options: { storyEnabled: true, scenePriority: false, maxTracksPerEpisode: 1 },
  }), /上限.*提高|提高.*上限/);
  const result = plan([cue(0, '紧张'), cue(2, null), cue(3, '紧张')], {
    groups: new Map([['紧张', ['only.wav']]]),
    options: { storyEnabled: true, scenePriority: false, maxTracksPerEpisode: 2 },
  });
  assert.equal(result.segments.length, 3);
  assert.equal(result.trackCount.actual, 1);
  assert.equal(result.segments[1].explicitSilence, true);
});

test('story provenance strips credential-bearing URL fields and private provider fields', () => {
  const result = plan([cue(0, '紧张')], {
    options: { storyEnabled: true, storyAIProfile: {
      baseUrl: 'https://PRIVATE_USER:PRIVATE_KEY@model.example/v1?apiKey=PRIVATE_KEY#PRIVATE_KEY',
      model: 'director', apiKey: 'PRIVATE_KEY', messages: 'PRIVATE_HTTP',
    } },
    storyPlan: { ...storyPlan([cue(0, '紧张')]), messages: 'PRIVATE_HTTP' },
  });
  assert.deepEqual(result.story.profile, { baseUrl: 'https://model.example/v1', model: 'director' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});
