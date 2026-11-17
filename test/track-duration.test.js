'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildMusicPlan, buildMultiTrackFilter, parseArgs } = require('../src/mvp');

function plan(duration, options = {}, overrides = {}) {
  return buildMusicPlan({
    duration, groups: new Map([['默认', ['a.wav', 'b.wav']]]), trackUses: new Map(),
    options: { scenePriority: false, maxTracksPerEpisode: 1, ...options }, ...overrides,
  });
}

test('duration cap changes the actual file repeatedly despite an episode segment maximum', () => {
  const result = plan(95, { transitionFadeEnabled: false });
  assert.deepEqual(result.segments.map(({ start, end }) => [start, end]), [[0, 40], [40, 80], [80, 95]]);
  assert.deepEqual(result.segments.map(({ track }) => track), ['a.wav', 'b.wav', 'a.wav']);
  assert.equal(result.trackCount.segments, 3);
  assert.equal(result.trackCount.actual, 2);
  assert.match(result.segments[1].reason, /40.*换曲|换曲.*40/);
  assert.equal(result.segments[1].transition.durationLimit, true);
});

test('below and exactly the cap need no changes; zero disables even a long single-track plan', () => {
  assert.equal(plan(39).segments.length, 1);
  assert.equal(plan(40).segments.length, 1);
  assert.equal(plan(95, { maxTrackDuration: 0 }).segments.length, 1);
  assert.equal(plan(31, { maxTrackDuration: 15, transitionFadeEnabled: false }).segments.length, 3);
});

test('duration cap validates public core and CLI input without coercing missing or invalid values to unlimited', () => {
  for (const value of [-1, NaN, Infinity, '', null, true, 'bad']) {
    assert.throws(() => plan(50, { maxTrackDuration: value }), /时长|duration/i, String(value));
  }
  const args = ['--videos', 'v', '--music', 'm', '--output', 'o'];
  assert.equal(parseArgs(args).maxTrackDuration, 40);
  assert.equal(parseArgs([...args, '--max-track-duration', '0']).maxTrackDuration, 0);
  assert.equal(parseArgs([...args, '--max-track-duration', '12.5']).maxTrackDuration, 12.5);
  assert.throws(() => parseArgs([...args, '--max-track-duration', '-1']), /数字|时长/);
  for (const value of ['', '   ']) {
    assert.throws(() => parseArgs([...args, '--max-track-duration', value]), /数字|时长/);
  }
});

test('required duration switching prefers same style then lyrical substitution over neutral', () => {
  const same = plan(60, { mood: '浪漫', transitionFadeEnabled: false }, {
    groups: new Map([['浪漫', ['romance1.wav', 'romance2.wav']], ['抒情', ['lyrical.wav']], ['默认', ['neutral.wav']]]),
  });
  assert.deepEqual(same.segments.map(({ track }) => track), ['romance1.wav', 'romance2.wav']);
  const similar = plan(60, { mood: '浪漫', transitionFadeEnabled: false }, {
    groups: new Map([['浪漫', ['romance.wav']], ['抒情', ['lyrical.wav']], ['默认', ['neutral.wav']]]),
  });
  assert.equal(similar.segments[1].track, 'lyrical.wav');
  assert.equal(similar.segments[1].matchType, 'similar');
  assert.equal(similar.segments[1].requestedMood, '浪漫');
  assert.equal(similar.segments[1].selectedMood, '抒情');
});

test('duration cap never uses an incompatible or unscreened alternative or inserts accidental silence', () => {
  assert.throws(() => plan(60, { mood: '浪漫', transitionFadeEnabled: false }, {
    groups: new Map([['浪漫', ['only.wav']], ['紧张', ['opposing.wav']]]),
  }), /40.*另一首.*补充|40.*补充.*曲目/);
});

function storyPlan(cues, overrides = {}) {
  return plan(95, { storyEnabled: true, scenePriority: false, maxTracksPerEpisode: 3,
    transitionFadeEnabled: false, ...overrides.options }, {
    transcript: { segments: [
      { start: 0, end: 10, text: 'Hello.' }, { start: 25, end: 35, text: 'Stay.' },
      { start: 55, end: 60, text: 'Pause.' }, { start: 70, end: 80, text: 'Return.' },
    ] },
    storyPlan: { alignmentConfidence: 0.9, summary: 'Story', cues: cues.map(([startSegment, mood]) =>
      ({ startSegment, mood, intensity: 1, reason: 'Anchored story beat', confidence: 0.8, review: false })) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'options')),
  });
}

test('restarting the same file at a story anchor does not reset the continuous clock', () => {
  assert.throws(() => storyPlan([[0, '默认'], [1, '默认']], {
    groups: new Map([['默认', ['only.wav']]]),
  }), /40.*另一首/);
});

test('story duration switching overrides segment count and leaves explicit silence untouched', () => {
  const long = storyPlan([[0, '默认']], { options: { maxTracksPerEpisode: 1 } });
  assert.equal(long.segments.length, 3);
  const result = storyPlan([[0, '默认'], [2, null], [3, '默认']]);
  assert.ok(result.segments.some((segment) => segment.start === 40 && segment.track));
  const silence = result.segments.find((segment) => segment.explicitSilence);
  assert.deepEqual([silence.start, silence.end, silence.track], [55, 70, null]);
  assert.equal(result.segments.at(-1).end, 95);
});

test('duration changes preserve required scene switches even if the inserted track equals the original next track', () => {
  const result = plan(80, { scenePriority: true }, { sceneCuts: [{ time: 50, score: 60 }] });
  const sceneIndex = result.segments.findIndex((segment) => segment.start === 50);
  assert.ok(sceneIndex > 1);
  assert.notEqual(result.segments[sceneIndex].track, result.segments[sceneIndex - 1].track);
  assert.equal(result.sceneCandidates[0].used, true);
});

test('duration replacement reserves the only compatible track for an upcoming required story scene', () => {
  const result = buildMusicPlan({
    duration: 90, trackUses: new Map(),
    groups: new Map([['浪漫', ['a.wav', 'b.wav', 'c.wav']], ['抒情', ['b.wav']]]),
    transcript: { segments: [{ start: 0, end: 10, text: 'First.' },
      { start: 50, end: 60, text: 'Second.' }, { start: 65, end: 70, text: 'Third.' }] },
    storyPlan: { summary: 'Three beats.', alignmentConfidence: 0.9,
      cues: [[0, '浪漫'], [1, '抒情'], [2, '浪漫']].map(([startSegment, mood]) =>
        ({ startSegment, mood, intensity: 1, reason: 'Story beat', confidence: 0.8, review: false })) },
    sceneCuts: [{ time: 50, score: 60 }, { time: 65, score: 60 }],
    options: { storyEnabled: true, scenePriority: true, maxTrackDuration: 40, transitionFadeEnabled: false },
  });
  assert.deepEqual(result.segments.map(({ start, track }) => [start, track]),
    [[0, 'a.wav'], [40, 'c.wav'], [50, 'b.wav'], [65, 'c.wav']]);
  assert.ok(result.sceneCandidates.every((cut) => cut.required && cut.used));
});

test('a distant required scene does not reserve its only track across multiple earlier duration changes', () => {
  for (const transitionFadeEnabled of [false, true]) {
    const result = buildMusicPlan({
      duration: 135, trackUses: new Map(),
      groups: new Map([['浪漫', ['a.wav', 'b.wav']], ['抒情', ['b.wav']]]),
      transcript: { segments: [{ start: 0, end: 10, text: 'First.' }, { start: 120, end: 130, text: 'Second.' }] },
      storyPlan: { summary: 'Two beats.', alignmentConfidence: 0.9,
        cues: [[0, '浪漫'], [1, '抒情']].map(([startSegment, mood]) =>
          ({ startSegment, mood, intensity: 1, reason: 'Story beat', confidence: 0.8, review: false })) },
      sceneCuts: [{ time: 120, score: 60 }],
      options: { storyEnabled: true, scenePriority: true, maxTrackDuration: 40, transitionFadeEnabled },
    });
    if (!transitionFadeEnabled) assert.deepEqual(result.segments.map(({ start, track }) => [start, track]),
      [[0, 'a.wav'], [40, 'b.wav'], [80, 'a.wav'], [120, 'b.wav']]);
    assert.equal(result.sceneCandidates[0].used, true);
    const { playbackWindows } = require('../src/track-duration');
    assert.ok(playbackWindows(result.segments, 135, { transitionFadeEnabled })
      .every((span) => span.renderEnd - span.renderStart <= 40 + 1e-9));
  }
});

test('fade-aware windows stay within the audible cap including consecutive same-file cue restarts', () => {
  const { playbackWindows } = require('../src/track-duration');
  const result = plan(95);
  const windows = playbackWindows(result.segments, 95, {});
  assert.equal(windows.length, 3);
  for (const window of windows) assert.ok(window.renderEnd - window.renderStart <= 40 + 1e-9);
  assert.ok(windows[0].fadeOut > 0);
  assert.ok(windows[1].renderStart < windows[0].renderEnd);
  const repeated = playbackWindows([
    { start: 0, end: 20, track: 'a.wav', cueIn: 0 },
    { start: 20, end: 40, track: 'a.wav', cueIn: 2 },
    { start: 40, end: 41, track: 'b.wav' },
  ], 41, { maxTrackDuration: 40, transitionFadeDuration: 10 });
  assert.equal(repeated[0].renderStart, 0);
  assert.equal(repeated[1].renderEnd, 40);
  assert.equal(repeated[2].renderStart, 40);
});

test('shared enforcement retains separate same-file intention evidence and replacement cue metadata', () => {
  const { enforceTrackDuration } = require('../src/track-duration');
  const result = enforceTrackDuration({
    segments: [
      { start: 0, end: 25, track: 'a.wav', mood: '浪漫', requestedMood: '浪漫', reason: 'First beat' },
      { start: 25, end: 70, track: 'a.wav', mood: '温情', requestedMood: '温情', reason: 'Second beat', startSegment: 1 },
    ],
    trackCount: { minimum: 1, met: true, warning: '' },
  }, {
    groups: new Map([['浪漫', ['a.wav']], ['温情', ['a.wav']], ['抒情', ['b.wav']]]),
    options: { transitionFadeEnabled: false, trackMetadata: new Map([['b.wav', {
      cueIn: 3, intensity: 1, status: 'confirmed_instrumental', analysis: { intervals: [] },
    }]]) }, trackUses: new Map(),
  });
  assert.deepEqual(result.segments.map(({ start, end }) => [start, end]), [[0, 25], [25, 40], [40, 70]]);
  assert.equal(result.segments[1].reason, 'Second beat');
  assert.equal(result.segments[2].startSegment, 1);
  assert.equal(result.segments[2].track, 'b.wav');
  assert.equal(result.segments[2].cueIn, 3);
  assert.equal(result.segments[2].instrumentalStatus, 'confirmed_instrumental');
});

test('real rendered fades change tones without the outgoing track surviving the audible deadline', async () => {
  const result = plan(95);
  const args = ['-hide_banner', '-loglevel', 'error'];
  for (const segment of result.segments) args.push('-f', 'lavfi', '-i',
    `sine=frequency=${segment.track === 'a.wav' ? 220 : 440}:sample_rate=48000`);
  args.push('-filter_complex', buildMultiTrackFilter(result.segments, 95, { fadeIn: 0, fadeOut: 0 }, [], false),
    '-map', '[aout]', '-t', '95', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1');
  const { stdout } = await promisify(execFile)(process.env.FFMPEG || 'ffmpeg', args,
    { encoding: 'buffer', maxBuffer: 24 * 1024 * 1024, windowsHide: true });
  const magnitude = (frequency, start) => {
    const first = Math.round(start * 48000);
    const count = 4800;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < count; index += 1) {
      const value = stdout.readFloatLE((first + index) * 4);
      const phase = 2 * Math.PI * frequency * index / 48000;
      real += value * Math.cos(phase);
      imaginary += value * Math.sin(phase);
    }
    return Math.hypot(real, imaginary) * 2 / count;
  };
  assert.ok(magnitude(220, 10) > 0.01);
  assert.ok(magnitude(220, 39.1) > 0.001);
  assert.ok(magnitude(440, 39.1) > 0.001);
  assert.ok(magnitude(220, 40.1) < 0.0001);
  assert.ok(magnitude(440, 40.1) > 0.01);
  assert.ok(magnitude(440, 79.1) < 0.0001);
  assert.ok(magnitude(220, 79.1) > 0.01);
});

test('fractional duration limits do not round rendered playback above the configured value', async () => {
  const options = { maxTrackDuration: 1.0006, transitionFadeEnabled: false, fadeIn: 0, fadeOut: 0 };
  const result = plan(1.5, options);
  const { stdout } = await promisify(execFile)(process.env.FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=220:sample_rate=48000,pan=stereo|c0=c0|c1=0*c0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000,pan=stereo|c0=0*c0|c1=c0',
    '-filter_complex', buildMultiTrackFilter(result.segments, 1.5, options, [], false),
    '-map', '[aout]', '-t', '1.5', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true });
  let lastSound = 0;
  for (let index = 0; index < stdout.length / 8; index += 1) {
    if (Math.abs(stdout.readFloatLE(index * 8)) > 0.00001) lastSound = index;
  }
  assert.ok(lastSound > 47000);
  assert.ok((lastSound + 1) / 48000 <= 1.0006, `last sound at sample ${lastSound}`);
});

test('fractional hard changes do not discard a millisecond of sound between adjacent screened tracks', async () => {
  const options = { maxTrackDuration: 1.0004, transitionFadeEnabled: false, fadeIn: 0, fadeOut: 0 };
  const result = plan(1.5, options);
  const { stdout } = await promisify(execFile)(process.env.FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=220:sample_rate=48000,pan=stereo|c0=c0|c1=0*c0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000,pan=stereo|c0=0*c0|c1=c0',
    '-filter_complex', buildMultiTrackFilter(result.segments, 1.5, options, [], false),
    '-map', '[aout]', '-t', '1.5', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true });
  let lastLeft = -1;
  let firstRight = -1;
  for (let index = 47000; index < 49000; index += 1) {
    if (Math.abs(stdout.readFloatLE(index * 8)) > 0.00001) lastLeft = index;
    if (firstRight < 0 && Math.abs(stdout.readFloatLE(index * 8 + 4)) > 0.00001) firstRight = index;
  }
  assert.ok(lastLeft >= 48017, `outgoing music ended at ${lastLeft}`);
  assert.ok(firstRight - lastLeft <= 3, `avoidable silent gap: ${lastLeft} to ${firstRight}`);
});
