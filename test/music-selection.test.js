'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMusicPlan, inferMood } = require('../src/mvp');

function plan(groups, text, overrides = {}) {
  return buildMusicPlan({
    duration: 40,
    transcript: text ? { segments: [{ start: 1, end: 12, text }] } : null,
    groups: new Map(groups),
    options: { scenePriority: false },
    trackUses: new Map(),
    ...overrides,
  });
}

test('missing romance retains its intended emotion and substitutes warmth instead of neutral', () => {
  const groups = [['默认', ['neutral.wav']], ['温情', ['warm.wav']]];
  const result = plan(groups, 'I love you. You mean everything to me.');
  const segment = result.segments[0];
  assert.equal(segment.track, 'warm.wav');
  assert.equal(segment.requestedMood, '浪漫');
  assert.equal(segment.selectedMood, '温情');
  assert.equal(segment.matchType, 'similar');
  assert.equal(segment.review, true);
  assert.match(segment.reason, /浪漫.*相近.*温情/);
});

test('missing tension prefers suspense over neutral and recognizes numbered category aliases', () => {
  const result = plan([
    ['默认', ['neutral.wav']],
    ['09_忧郁_阴暗神秘', ['gloom.wav']],
    ['03_悬疑_线索', ['mystery.wav']],
  ], "We're trapped. Help me!");
  assert.equal(result.segments[0].track, 'mystery.wav');
  assert.equal(result.segments[0].requestedMood, '紧张');
  assert.equal(result.segments[0].selectedMood, '03_悬疑_线索');
  assert.equal(result.segments[0].matchType, 'similar');
});

test('sadness never substitutes an opposing cheerful style or completes with silent BGM', () => {
  assert.throws(() => plan([['欢快', ['happy.wav']]], "Goodbye. I lost you. It's over."),
    /伤感.*合格曲目|合格曲目.*伤感/);
});

test('uncertain emotion without neutral uses the least intense screened candidate and marks review', () => {
  const result = plan([['紧张', ['hard.wav', 'quiet.wav']]], 'Just a moment, please.', {
    options: {
      scenePriority: false,
      trackMetadata: new Map([['hard.wav', { intensity: 3 }], ['quiet.wav', { intensity: 1 }]]),
    },
    trackUses: new Map([['quiet.wav', 100]]),
  });
  assert.equal(result.segments[0].track, 'quiet.wav');
  assert.equal(result.segments[0].requestedMood, null);
  assert.equal(result.segments[0].selectedMood, '紧张');
  assert.equal(result.segments[0].matchType, 'library');
  assert.equal(result.segments[0].mood, '紧张');
  assert.equal(result.segments[0].review, true);
  assert.match(result.segments[0].reason, /情绪.*不足|情绪.*未明确/);
});

test('large libraries without neutral do not become silent or depend on insertion order', () => {
  const tracks = Array.from({ length: 1000 }, (_, index) => `track-${index + 1}.wav`).reverse();
  const result = plan([['紧张', tracks]], 'Just a moment, please.');
  assert.equal(result.segments[0].track, 'track-1.wav');
  assert.equal(result.segments[0].matchType, 'library');
});

test('brief isolated evidence still uses neutral instead of promoting a missing style', () => {
  const result = plan([['默认', ['neutral.wav']], ['温情', ['warm.wav']]], null, {
    transcript: { segments: [{ start: 1, end: 2, text: 'I love you.' }] },
  });
  assert.equal(result.segments[0].track, 'neutral.wav');
});

test('a brief opening cue without neutral gets similar music without creating extra boundaries', () => {
  const result = plan([['温情', ['warm.wav']]], null, {
    transcript: { segments: [{ start: 1, end: 2, text: 'I love you.' }] },
  });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].track, 'warm.wav');
  assert.equal(result.segments[0].review, true);
});

test('missing emotion categories preserve sustained changes between similar substitutes', () => {
  const result = plan([['温情', ['warm.wav']], ['忧郁', ['gloom.wav']]], null, {
    transcript: { segments: [
      { start: 1, end: 12, text: 'I love you. You mean everything to me.' },
      { start: 25, end: 36, text: "Goodbye. I lost you. It's over." },
    ] },
  });
  assert.deepEqual(result.segments.map(({ track }) => track), ['warm.wav', 'gloom.wav']);
  assert.deepEqual(result.segments.map(({ requestedMood }) => requestedMood), ['浪漫', '伤感']);
  assert.ok(result.segments.every(({ track, review }) => track && review));
});

test('required scene change uses a different similar track before neutral', () => {
  const result = plan([
    ['紧张', ['tense.wav']],
    ['悬疑', ['mystery.wav']],
    ['默认', ['neutral.wav']],
  ], "We're trapped. Help me!", {
    options: { scenePriority: true, mood: '紧张' },
    sceneCuts: [{ time: 20, score: 50, kind: 'cut' }],
  });
  assert.deepEqual(result.segments.map(({ track }) => track), ['tense.wav', 'mystery.wav']);
  assert.equal(result.segments[1].matchType, 'similar');
  assert.equal(result.sceneCandidates[0].used, true);
});

test('track minimum prefers unused similar music but ordinary playback retains an exact category', () => {
  const choices = [['紧张', ['tense.wav']], ['悬疑', ['mystery.wav']], ['默认', ['neutral.wav']]];
  const ordinary = plan(choices, null, { options: { mood: '紧张', scenePriority: false } });
  assert.equal(ordinary.segments[0].track, 'tense.wav');
  const minimum = plan(choices, null, {
    options: { mood: '紧张', scenePriority: false, minTracksPerEpisode: 2 },
  });
  assert.deepEqual(minimum.segments.map(({ track }) => track), ['tense.wav', 'mystery.wav']);
  assert.equal(minimum.trackCount.met, true);
});

test('explicit known style can substitute when its folder is absent but typos are rejected', () => {
  const result = plan([['温情', ['warm.wav']]], null, {
    options: { mood: '浪漫', scenePriority: false },
  });
  assert.equal(result.segments[0].track, 'warm.wav');
  assert.equal(result.segments[0].requestedMood, '浪漫');
  assert.throws(() => inferMood(null, new Map([['温情', ['warm.wav']]]), 'not-a-category'),
    /指定情绪|未知情绪/);
});

test('empty screened categories fail actionably instead of creating silent rule segments', () => {
  assert.throws(() => plan([['浪漫', []]], null), /合格曲目|曲库.*空/);
  assert.throws(() => plan([], null), /合格曲目|曲库.*空/);
});

test('ordinary same-category selection still prefers unused tracks before intensity and reuse', () => {
  const { chooseTrack } = require('../src/music-selection');
  const selected = chooseTrack(new Map([['紧张', ['used-hard.wav', 'unused-soft.wav']]]),
    '紧张', new Map(), new Set(['used-hard.wav']),
    new Map([['used-hard.wav', { intensity: 3 }], ['unused-soft.wav', { intensity: 1 }]]));
  assert.equal(selected, 'unused-soft.wav');
});

test('an empty exact folder does not hide a usable alias of the same requested style', () => {
  const result = plan([['伤感', []], ['08_悲伤_离别', ['sad.wav']]], "Goodbye. I lost you.");
  assert.equal(result.segments[0].track, 'sad.wav');
  assert.equal(result.segments[0].matchType, 'exact');
});

test('inferred prefixed folder names still include equivalent aliases at required scene changes', () => {
  const result = plan([
    ['01_紧张', ['tense.wav']], ['02_激烈', ['action.wav']], ['默认', ['neutral.wav']],
  ], "We're trapped. Help me!", {
    options: { scenePriority: true },
    transcript: { segments: [{ start: 1, end: 36, text: "We're trapped. Help me!" }] },
    sceneCuts: [{ time: 20, score: 50, kind: 'cut' }],
  });
  assert.deepEqual(result.segments.map(({ track }) => track), ['action.wav', 'tense.wav']);
  assert.ok(result.segments.every(({ matchType }) => matchType === 'exact'));
});

test('equivalent style aliases share intensity and unused-track priority rather than folder priority', () => {
  const { chooseTrack } = require('../src/music-selection');
  const groups = new Map([['紧张', ['soft.wav']], ['激烈', ['hard.wav']]]);
  const metadata = new Map([['soft.wav', { intensity: 1 }], ['hard.wav', { intensity: 3 }]]);
  assert.equal(chooseTrack(groups, '紧张', new Map(), new Set(), metadata), 'hard.wav');
  assert.equal(chooseTrack(groups, '紧张', new Map(), new Set(['soft.wav']), metadata), 'hard.wav');
});

test('shared compatible folders retain distinct sustained intent and intensity with truthful review', () => {
  const result = plan([['悬疑', ['hard.wav', 'soft.wav']]], null, {
    transcript: { segments: [
      { start: 1, end: 12, text: "We're trapped. Help me!" },
      { start: 25, end: 36, text: 'A secret clue. We need to find out.' },
    ] },
    options: { scenePriority: true,
      trackMetadata: new Map([['hard.wav', { intensity: 3 }], ['soft.wav', { intensity: 1 }]]) },
  });
  assert.deepEqual(result.segments.map(({ requestedMood }) => requestedMood), ['紧张', '悬疑']);
  assert.deepEqual(result.segments.map(({ track }) => track), ['hard.wav', 'soft.wav']);
  assert.equal(result.segments[0].matchType, 'similar');
  assert.equal(result.segments[0].review, true);
});

test('uncertain minimum filling retains the initial style rather than switching to opposing music', () => {
  const result = plan([['伤感', ['sad.wav']], ['欢快', ['happy.wav']]], null, {
    options: { scenePriority: false, minTracksPerEpisode: 2,
      trackMetadata: new Map([['sad.wav', { intensity: 1 }], ['happy.wav', { intensity: 2 }]]) },
  });
  assert.deepEqual(result.segments.map(({ track }) => track), ['sad.wav']);
  assert.equal(result.trackCount.actual, 1);
  assert.equal(result.trackCount.met, false);
  assert.match(result.trackCount.warning, /曲目不足/);
});

test('a similar warmth category is not mislabeled neutral merely because its name includes healing', () => {
  const result = plan([['温情_治愈', ['warm.wav']], ['默认', ['neutral.wav']]],
    'I love you. You mean everything to me.');
  assert.equal(result.segments[0].track, 'warm.wav');
  assert.equal(result.segments[0].matchType, 'similar');
  assert.equal(result.segments[0].selectedMood, '温情_治愈');
  assert.match(result.segments[0].reason, /相近/);
  assert.doesNotMatch(result.segments[0].reason, /兼容中性/);
});

test('selection provenance uses the chosen category instead of the first deduplicated membership', () => {
  const result = plan([['伤感', ['shared.wav']], ['温情', ['shared.wav']]],
    'I love you. You mean everything to me.');
  assert.equal(result.segments[0].track, 'shared.wav');
  assert.equal(result.segments[0].selectedMood, '温情');
  assert.equal(result.segments[0].matchType, 'similar');
});

test('shared-style emotion changes keep intent even with one track but real scene changes still require an alternative', () => {
  const overrides = {
    transcript: { segments: [
      { start: 1, end: 12, text: "We're trapped. Help me!" },
      { start: 25, end: 36, text: 'A secret clue. We need to find out.' },
    ] },
    options: { scenePriority: true },
  };
  const result = plan([['悬疑', ['only.wav']]], null, overrides);
  assert.deepEqual(result.segments.map(({ requestedMood }) => requestedMood), ['紧张', '悬疑']);
  assert.deepEqual(result.segments.map(({ track }) => track), ['only.wav', 'only.wav']);
  assert.equal(result.trackCount.actual, 1);
  assert.throws(() => plan([['悬疑', ['only.wav']]], null, {
    ...overrides, sceneCuts: [{ time: result.segments[1].start, score: 50, kind: 'cut' }],
  }), /必须换曲.*另一首/);
});
