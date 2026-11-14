'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DEFAULT_TRANSITION_FADE_SECONDS, buildAudioFilter, buildMusicPlan, buildMultiTrackFilter, freezeTailDuration, inferMood, mergeIntervals, runBatch, scanMusic } = require('../src/mvp');

const execFileAsync = promisify(execFile);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

test('neutral silence renders safely and legacy completion can resume with an empty strict pool', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-silence-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const music = path.join(root, 'music');
  await fs.mkdir(path.join(music, '紧张'), { recursive: true });
  const track = path.join(music, '紧张', 'tone.wav');
  const videos = path.join(root, 'source.mp4');
  await makeAudio(track, 440);
  await makeVideo(videos);
  const options = { music, videos, output: path.join(root, 'output'), ffmpeg, ffprobe, strictInstrumental: false, autoDuck: true, duckDb: -10, fadeIn: 0, fadeOut: 0, transcribe: false };
  const logger = { log() {}, error() {} };
  const first = await runBatch(options, logger);
  assert.equal(first.completed, 1);
  assert.deepEqual(first.results[0].tracks, [null]);
  assert.equal(first.results[0].analysis.ducking.enabled, false);
  assert.equal((await runBatch(options, logger)).skipped, 1);
  const stateFile = path.join(options.output, '.mvp-state.json');
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  delete saved.episodes[videos].analysisVersion;
  await fs.writeFile(stateFile, JSON.stringify(saved));
  const resumed = await runBatch({ ...options, strictInstrumental: true, vocalModelPath: path.join(root, 'missing.tflite') }, logger);
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.results[0].analysisVersion, 'legacy');
  assert.equal(resumed.results[0].needsRegeneration, true);
  const rejected = await runBatch({ ...options, strictInstrumental: true, skipCompleted: false, vocalModelPath: path.join(root, 'missing.tflite') }, logger);
  assert.equal(rejected.failed, 1);
  assert.match(rejected.results[0].error, /纯音乐筛选条件/);
});

test('library health exposes silent, broken, short, duplicate and empty mood entries', async (t) => {
  const { checkMusicLibrary } = require('../desktop/backend/batch-service');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(['默认', '空情绪', '坏曲目'].map((name) => fs.mkdir(path.join(root, name))));
  const good = path.join(root, '默认', 'good.wav');
  await makeAudio(good, 440);
  await fs.copyFile(good, path.join(root, '默认', 'duplicate.wav'));
  await makeAudio(path.join(root, '坏曲目', 'quiet.wav'), 440, 0.000001);
  await fs.writeFile(path.join(root, '坏曲目', 'broken.mp3'), 'invalid');
  const report = await checkMusicLibrary({ music: root, ffmpeg, ffprobe, strictInstrumental: false });
  assert.equal(report.total, 4);
  assert.equal(report.usable, 2);
  assert.equal(report.duplicates.length, 1);
  assert.deepEqual(report.emptyDirectories, ['空情绪']);
  assert.deepEqual(report.unavailableMoods, ['坏曲目']);
  assert.equal(report.files.find((item) => item.file === good).tooShort, true);
  assert.match(report.files.find((item) => item.file.endsWith('quiet.wav')).reason, /静音/);
  assert.match(report.files.find((item) => item.file.endsWith('broken.mp3')).reason, /解码/);
  assert.equal((await fs.readFile(path.join(root, '坏曲目', 'broken.mp3'), 'utf8')), 'invalid');
});

test('nested music reaches desktop import, health, manual screening and strict batch rendering', async (t) => {
  const { checkMusicLibrary, inspectBatch, resolveImport, reviewMusicTrack } = require('../desktop/backend/batch-service');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-nested-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const music = path.join(root, 'music');
  const album = path.join(music, '音乐合集', '紧张', '专辑', '第二辑');
  const video = path.join(root, 'episode.mp4');
  const output = path.join(root, 'output');
  const libraryCacheDir = path.join(root, 'cache');
  await fs.mkdir(album, { recursive: true });
  await fs.mkdir(path.join(music, '空情绪', '空合集'), { recursive: true });
  const confirmed = path.join(album, 'confirmed.wav');
  const disabled = path.join(album, 'disabled.wav');
  await makeAudio(confirmed, 440);
  await makeAudio(disabled, 660);
  await makeVideo(video);
  const options = { videos: video, music, output, libraryCacheDir, ffmpeg, ffprobe,
    strictInstrumental: true, transcribe: false, scenePriority: false,
    mood: '紧张', minTracksPerEpisode: 1, fadeIn: 0, fadeOut: 0 };
  const preflight = await inspectBatch(options);
  assert.deepEqual(preflight.musicGroups, [{ mood: '紧张', count: 2 }]);
  assert.deepEqual(await resolveImport({ path: music }), { key: 'music', path: music });
  const initial = await checkMusicLibrary(options);
  assert.equal(initial.total, 2);
  assert.equal(initial.usable, 0, 'nested tracks must not bypass strict vocal screening');
  assert.deepEqual(initial.emptyDirectories, ['空情绪']);
  assert.deepEqual(initial.unavailableMoods, ['紧张']);
  await reviewMusicTrack({ ...options, file: confirmed, action: 'confirm' });
  await reviewMusicTrack({ ...options, file: confirmed, action: 'metadata', cueIn: 0.1, intensity: 3 });
  await reviewMusicTrack({ ...options, file: disabled, action: 'disable' });
  const reviewed = await checkMusicLibrary(options);
  assert.equal(reviewed.usable, 1);
  assert.equal(reviewed.files.find(({ file }) => file === confirmed).intensity, 3);
  assert.equal(reviewed.files.find(({ file }) => file === disabled).status, 'disabled');
  const rendered = await runBatch(options, { log() {}, error() {} });
  assert.equal(rendered.completed, 1, JSON.stringify(rendered.results));
  assert.deepEqual(rendered.results[0].tracks, [confirmed]);
  assert.ok((await probe(rendered.results[0].finalVideoPath)).streams.some(({ codec_type }) => codec_type === 'video'));
  assert.ok(await wavRms(rendered.results[0].outputPath, 0.2, 0.6) > 0.001);
});

test('targeted retry and resume preserve completed outputs and manual files and write reports', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videos = path.join(root, 'videos');
  const music = path.join(root, 'music');
  const output = path.join(root, 'output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(music), fs.mkdir(output)]);
  await makeAudio(path.join(music, 'good.wav'), 440);
  await makeVideo(path.join(videos, '01.mp4'));
  await fs.writeFile(path.join(videos, '02.mp4'), 'broken video');
  await makeVideo(path.join(videos, '03.mp4'));
  const manual = path.join(output, '03_bgm.wav');
  await fs.writeFile(manual, 'manual output');
  const options = { videos, music, output, ffmpeg, ffprobe, transcribe: false, outputVideo: false, minTracksPerEpisode: 1, fadeIn: 0, fadeOut: 0 };
  const logger = { log() {}, error() {} };
  const first = await runBatch({ strictInstrumental: false, ...options }, logger);
  assert.equal(first.completed, 1);
  assert.equal(first.failed, 2);
  const originalTime = (await fs.stat(path.join(output, '01_bgm.wav'))).mtimeMs;
  await makeVideo(path.join(videos, '02.mp4'));
  const retry = await runBatch({ strictInstrumental: false, ...options, runMode: 'failed' }, logger);
  assert.equal(retry.videos, 2);
  assert.equal(retry.completed, 1);
  assert.equal(retry.failed, 1);
  assert.equal((await fs.stat(path.join(output, '01_bgm.wav'))).mtimeMs, originalTime);
  assert.equal(await fs.readFile(manual, 'utf8'), 'manual output');
  const report = await fs.readFile(path.join(output, 'run-report.md'), 'utf8');
  assert.match(report, /使用音乐/);
  assert.match(report, /good.wav/);
  assert.match(report, /03.*失败/);
  assert.match(await fs.readFile(path.join(output, 'run-errors.log'), 'utf8'), /03/);
  const resumed = await runBatch({ strictInstrumental: false, ...options, runMode: 'unfinished', skipCompleted: false }, logger);
  assert.equal(resumed.skipped, 2);
  assert.equal(resumed.failed, 1);
  const regenerated = await runBatch({ strictInstrumental: false, ...options, runMode: 'episode', episodeVideoPath: path.join(videos, '01.mp4') }, logger);
  assert.equal(regenerated.videos, 1);
  assert.equal(regenerated.completed, 1);
  assert.equal(await fs.readFile(manual, 'utf8'), 'manual output');
  await assert.rejects(runBatch({ strictInstrumental: false, ...options, runMode: 'episode', episodeVideoPath: path.join(root, 'outside.mp4') }, logger), /没有符合条件/);
  const controller = new AbortController();
  const stopped = await runBatch({ strictInstrumental: false, ...options, signal: controller.signal }, { ...logger, progress(event) { if (event.status === 'skipped') controller.abort(); } });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pending, 2);
  assert.match(await fs.readFile(path.join(output, 'run-report.md'), 'utf8'), /未处理 2/);
});

test('desktop progress snapshots retain stages, accurate counters and measured estimates', async (t) => {
  const { getInfo, startBatch } = require('../desktop/backend/batch-service');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const music = path.join(root, 'music');
  const output = path.join(root, 'output');
  await fs.mkdir(music);
  await makeAudio(path.join(music, 'good.wav'), 440);
  await makeVideo(video);
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('batch did not finish')), 30000);
    startBatch({ strictInstrumental: false, videos: video, music, output, transcribe: false, ffmpeg, ffprobe, outputVideo: false, minTracksPerEpisode: 1 }, (event) => {
      events.push(event);
      if (['finished', 'error'].includes(event.type)) { clearTimeout(timer); event.type === 'error' ? reject(new Error(event.message)) : resolve(); }
    }).catch((error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(events[0].run.estimatedRemainingMs, null);
  assert.equal(events.at(-1).summary.failed, 0, events.filter((event) => event.level === 'error').map((event) => event.message).join('\n'));
  assert.ok(events.some((event) => event.stage === 'rendering-audio'));
  const snapshot = getInfo();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run.total, 1);
  assert.equal(snapshot.run.settled, 1);
  assert.equal(snapshot.run.counts.completed, 1);
  assert.equal(snapshot.run.estimatedRemainingMs, 0);
});

test('even explicit overwrite cannot replace source videos or music', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-source-protection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const track = path.join(root, 'episode_bgm.wav');
  await makeVideo(video);
  await makeAudio(track, 440);
  const before = await fs.readFile(track);
  const options = { videos: root, music: root, output: root, ffmpeg, ffprobe, overwrite: true };
  await assert.rejects(runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} }), /输出路径与输入素材重合/);
  assert.deepEqual(await fs.readFile(track), before);
  const otherVideo = path.join(root, 'episode_final.mp4');
  await fs.copyFile(video, otherVideo);
  const beforeVideo = await fs.readFile(otherVideo);
  await assert.rejects(runBatch({ strictInstrumental: false, ...options, outputAudio: false }, { log() {}, error() {} }), /输出路径与输入素材重合/);
  assert.deepEqual(await fs.readFile(otherVideo), beforeVideo);
});

async function makeAudio(filePath, frequency, volume = 1, channels = 1) {
  const audioFilter = channels === 2 ? `volume=${volume},pan=stereo|c0=c0|c1=c0` : `volume=${volume}`;
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.7`,
    '-af', audioFilter, '-ar', '22050', '-ac', String(channels), filePath,
  ], { windowsHide: true });
}

async function makeVideo(filePath, duration = 2.5) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=320x240:r=25:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=16000:duration=${duration}`,
    '-t', String(duration), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', filePath,
  ], { windowsHide: true });
}

async function makeSceneVideo(filePath, sceneDuration = 15) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=160x120:r=25:d=${sceneDuration}`,
    '-f', 'lavfi', '-i', `color=c=white:s=160x120:r=25:d=${sceneDuration}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'mpeg4', '-q:v', '5', filePath,
  ], { windowsHide: true });
}

async function makeSilentVideo(filePath, duration = 1) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=320x240:r=25:d=${duration}`,
    '-t', String(duration), '-c:v', 'mpeg4', '-q:v', '5', filePath,
  ], { windowsHide: true });
}

async function makeSilentWav(filePath, duration) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(duration), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', filePath,
  ], { windowsHide: true });
}

async function probe(filePath) {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', filePath,
  ], { windowsHide: true });
  return JSON.parse(stdout);
}

async function wavRms(filePath, startSec, endSec) {
  const wav = await fs.readFile(filePath);
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const dataOffset = wav.indexOf('data', 12) + 8;
  const start = dataOffset + Math.floor(startSec * sampleRate) * channels * 2;
  const end = dataOffset + Math.floor(endSec * sampleRate) * channels * 2;
  let sum = 0;
  let count = 0;
  for (let offset = start; offset + 1 < end; offset += 2) {
    const sample = wav.readInt16LE(offset) / 32768;
    sum += sample * sample;
    count += 1;
  }
  return Math.sqrt(sum / count);
}

async function wavMaxDb(filePath) {
  const { stderr } = await execFileAsync(ffmpeg, [
    '-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
  ], { windowsHide: true });
  const match = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  assert.ok(match, 'ffmpeg should report the WAV peak');
  return Number(match[1]);
}

test('rejects an empty BGM library before processing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-empty-library-'));
  const musicDir = path.join(root, 'empty');
  await fs.mkdir(musicDir);
  await assert.rejects(scanMusic(musicDir), /BGM 目录没有找到音频文件/);
});

test('configures track transition fades and caps them for short segments', () => {
  const segments = [{ start: 0, end: 10 }, { start: 10, end: 20 }];
  assert.equal(DEFAULT_TRANSITION_FADE_SECONDS, 1);
  const defaultGraph = buildMultiTrackFilter(segments, 20, { fadeIn: 0, fadeOut: 0 }, []);
  assert.match(defaultGraph, /afade=t=out:st=9\.5:d=1/);
  assert.match(defaultGraph, /afade=t=in:st=0:d=1/);

  const customGraph = buildMultiTrackFilter(segments, 20, { transitionFadeDuration: 0.4, fadeIn: 0, fadeOut: 0 }, []);
  assert.match(customGraph, /afade=t=out:st=9\.8:d=0\.4/);
  assert.match(customGraph, /afade=t=in:st=0:d=0\.4/);

  const disabledGraph = buildMultiTrackFilter(segments, 20, { transitionFadeEnabled: false, fadeIn: 0, fadeOut: 0 }, []);
  assert.match(disabledGraph, /adelay=10000:all=1/);
  assert.doesNotMatch(disabledGraph, /afade=t=(?:in|out):st=[^;]*d=/);

  const shortGraph = buildMultiTrackFilter(
    [{ start: 0, end: 0.8 }, { start: 0.8, end: 1.6 }],
    1.6,
    { transitionFadeDuration: 5, fadeIn: 0, fadeOut: 0 },
    [],
  );
  assert.match(shortGraph, /afade=t=out:st=0\.6:d=0\.4/);
  assert.match(shortGraph, /afade=t=in:st=0:d=0\.4/);
  assert.match(shortGraph, /adelay=600:all=1/);
});

test('mood rules and interval merging stay deterministic', () => {
  const groups = new Map([
    ['默认', ['default.wav']],
    ['紧张', ['tense.wav']],
  ]);
  const mood = inferMood({ segments: [{ start: 0, end: 1, text: '危险，快跑' }] }, groups);
  assert.equal(mood.mood, '紧张');
  assert.deepEqual(mergeIntervals([
    { start: 1, end: 2 },
    { start: 1.9, end: 3 },
  ], 5, 0), [{ start: 1, end: 3 }]);
  assert.match(buildAudioFilter(10, { fadeIn: 1, fadeOut: 1, autoDuck: true, duckDb: -10 }, [{ start: 2, end: 3 }]), /between\(t,2,3\)/);
  assert.doesNotMatch(buildAudioFilter(10, { fadeIn: 1, fadeOut: 1, duckDb: -10 }, [{ start: 2, end: 3 }]), /between\(t,2,3\)/);
  assert.doesNotMatch(buildMultiTrackFilter([{ start: 0, end: 10 }], 10, { fadeIn: 0, fadeOut: 0, duckDb: -10 }, [{ start: 2, end: 3 }]), /volume=volume='/);
  assert.match(buildMultiTrackFilter([{ start: 0, end: 10 }], 10, { fadeIn: 0, fadeOut: 0, autoDuck: true, duckDb: -10 }, [{ start: 2, end: 3 }]), /volume=volume='/);
  assert.equal(freezeTailDuration('2:15', 25), 2.6);
  assert.throws(() => freezeTailDuration('0:25', 25), /帧数必须小于视频帧率/);

  const prefixedGroups = new Map([
    ['07_平静_治愈氛围', ['calm-a.mp3', 'calm-b.mp3']],
    ['01_紧张_激烈冲突', ['tense.mp3']],
    ['08_悲伤_失落离别', ['sad.mp3']],
    ['09_忧郁_阴暗神秘', ['mystery.mp3']],
  ]);
  const plan = buildMusicPlan({ duration: 60, transcript: null, groups: prefixedGroups, options: { mood: null }, trackUses: new Map() });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].mood, '07_平静_治愈氛围');
  assert.equal(inferMood({ segments: [{ start: 1, end: 2, text: '发现秘密线索' }] }, prefixedGroups).mood, '09_忧郁_阴暗神秘');
  const scenePlan = buildMusicPlan({
    duration: 60,
    transcript: null,
    groups: prefixedGroups,
    options: { mood: null },
    trackUses: new Map(),
    sceneCuts: [{ time: 20, score: 20 }, { time: 30, score: 14 }, { time: 45, score: 16 }],
  });
  assert.equal(scenePlan.segments.length, 1);
  const override = buildMusicPlan({
    duration: 60,
    transcript: { segments: [{ start: 1, end: 15, text: '危险快跑' }, { start: 30, end: 50, text: '难过哭泣' }] },
    groups: prefixedGroups,
    options: { mood: '07_平静_治愈氛围' },
    trackUses: new Map(),
  });
  assert.deepEqual(override.segments.map((segment) => segment.mood), ['07_平静_治愈氛围']);
});

test('classifies English dialogue and mood turns', () => {
  const groups = new Map([
    ['默认', ['default.wav']],
    ['01_紧张_激烈冲突', ['tense.wav']],
    ['02_愤怒_压迫反派', ['angry.wav']],
    ['05_浪漫_温柔爱情', ['romance.wav']],
    ['08_悲伤_失落离别', ['sad.wav']],
  ]);
  assert.equal(inferMood({ segments: [{ start: 0, end: 1, text: 'How dare you? She slapped and humiliated her.' }] }, groups).mood, '02_愤怒_压迫反派');
  assert.equal(inferMood({ segments: [{ start: 0, end: 1, text: 'Just a moment, please.' }] }, groups).mood, '默认');
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [
      { start: 0, end: 20, text: 'This is our wedding. I love my husband.' },
      { start: 35, end: 55, text: 'How dare you? She slapped and humiliated her.' },
    ] },
    groups,
    options: { mood: null },
    trackUses: new Map(),
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['05_浪漫_温柔爱情', '02_愤怒_压迫反派']);
});

test('caps music segments at the configured limit and uses different tracks', () => {
  const groups = new Map([
    ['紧张', ['tense.wav']],
    ['浪漫', ['romance.wav']],
    ['悲伤', ['sad.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [
      { start: 1, end: 10, text: '危险，快跑' },
      { start: 22, end: 30, text: '我爱你' },
      { start: 42, end: 50, text: '难过，哭泣' },
    ] },
    groups,
    options: { scenePriority: false, maxTracksPerEpisode: 2 },
    trackUses: new Map(),
  });
  assert.equal(plan.segments.length, 2);
  assert.equal(new Set(plan.segments.map((segment) => segment.track)).size, 2);
});

test('uses only persistent script mood turns and never fills the segment limit by default', () => {
  const groups = new Map([
    ['紧张', ['tense.wav']],
    ['浪漫', ['romance.wav']],
    ['悲伤', ['sad.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 90,
    transcript: { segments: [
      { start: 2, end: 25, text: '危险，快跑，有人追杀' },
      { start: 30, end: 50, text: '我爱你，我们结婚吧' },
      { start: 60, end: 85, text: '我很难过，眼泪止不住' },
    ] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['紧张', '浪漫', '悲伤']);
  assert.equal(plan.segments.length, 3);
  assert.equal(new Set(plan.segments.map((segment) => segment.track)).size, 3);

  const oneMood = buildMusicPlan({
    duration: 90,
    transcript: { segments: [
      { start: 2, end: 25, text: '我爱你，我们结婚吧' },
      { start: 30, end: 50, text: '我们一起回家，感谢家人' },
      { start: 60, end: 85, text: '我会一直陪着你' },
    ] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.equal(oneMood.segments.length, 1);
});

test('ignores a brief isolated emotion mention between longer story sections', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [
      { start: 1, end: 18, text: '我爱你，我们一直相爱' },
      { start: 22, end: 23, text: '我很愤怒' },
      { start: 28, end: 55, text: '我爱你，想和你一起生活' },
    ] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].mood, '浪漫');
});

test('recognizes conflict and reconciliation turns in English drama dialogue', () => {
  const groups = new Map([
    ['02_愤怒_压迫反派', ['anger-a.mp3', 'anger-b.mp3']],
    ['07_平静_治愈氛围', ['warm-a.mp3', 'warm-b.mp3']],
    ['08_悲伤_失落离别', ['sad-a.mp3', 'sad-b.mp3']],
  ]);
  const plan = (duration, segments) => buildMusicPlan({
    duration, transcript: { segments }, groups,
    options: { maxTracksPerEpisode: 3 }, trackUses: new Map(),
  });

  const conflict = plan(85.378, [
    { start: 14.8, end: 16.8, text: 'Are you two really this cruel?' },
    { start: 17, end: 19.3, text: "Mom, this isn't about being cruel." },
    { start: 50.3, end: 51.8, text: 'You even hit me.' },
    { start: 51.8, end: 53.8, text: 'And you told us to get out twice.' },
    { start: 78, end: 83.7, text: 'If I get sick in the future, will you still come?' },
    { start: 83.7, end: 85.2, text: 'We will.' },
  ]);
  assert.deepEqual(conflict.segments.map((segment) => segment.mood), ['02_愤怒_压迫反派', '07_平静_治愈氛围']);
  assert.equal(new Set(conflict.segments.map((segment) => segment.track)).size, 2);

  const reunion = plan(88.373, [
    { start: 11.6, end: 13.6, text: "Mom, I'm hungry." },
    { start: 13.7, end: 19.3, text: "No, Mom, we're back." },
    { start: 25.8, end: 31.4, text: 'Can we stay for a couple of days?' },
    { start: 32, end: 37.1, text: "I'm older now. I can find a place." },
    { start: 40, end: 45.6, text: 'Neither of you is going anywhere.' },
    { start: 51.2, end: 56.2, text: 'Mom, thank you for not making us leave back then.' },
    { start: 56.2, end: 59.9, text: "You're stuck with me." },
    { start: 73.2, end: 76.5, text: 'Mom.' },
    { start: 77.2, end: 81.8, text: 'Real home is a place where you are safe.' },
    { start: 82.3, end: 85, text: "Eat up. Nobody's holding back tonight." },
  ]);
  assert.deepEqual(reunion.segments.map((segment) => segment.mood), ['08_悲伤_失落离别', '07_平静_治愈氛围']);
  assert.equal(new Set(reunion.segments.map((segment) => segment.track)).size, 2);
});

test('uses mood changes first and enforces the minimum even without mood evidence', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
    ['默认', ['default.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 120, transcript: { segments: [
      { start: 10, end: 16, text: '我爱你，我们一直相爱' },
      { start: 62, end: 65, text: '我真的很愤怒，也无法原谅' },
    ] }, groups,
    options: { minTracksPerEpisode: 2, maxTracksPerEpisode: 3 }, trackUses: new Map(),
  });

  assert.equal(plan.segments.length, 2);
  assert.notDeepEqual(plan.segments.map(({ start, end }) => [start, end]), [[0, 60], [60, 120]]);
  assert.equal(new Set(plan.segments.map((segment) => segment.track)).size, 2);
  assert.match(plan.segments[1].reason, /情绪转折/);

  const oneMood = buildMusicPlan({
    duration: 120, transcript: null, groups,
    options: { minTracksPerEpisode: 2, maxTracksPerEpisode: 3 }, trackUses: new Map(),
  });
  assert.equal(oneMood.segments.length, 1);
  assert.equal(oneMood.trackCount.actual, 1);
  assert.equal(oneMood.trackCount.met, false);
  assert.match(oneMood.trackCount.warning, /曲目不足/);
});

test('scene-priority switch changes music at the episode 15 transition even with one mood', () => {
  const groups = new Map([['默认', ['calm-a.wav', 'calm-b.wav', 'calm-c.wav']]]);
  const sceneCuts = [{ time: 13.566667, score: 17.279, kind: 'cut' }, { time: 18.133333, score: 48.756, kind: 'cut' }, { time: 19.766667, score: 26.315, kind: 'cut' }];
  const plan = (options) => buildMusicPlan({ duration: 53.310657, transcript: null, groups, sceneCuts, options, trackUses: new Map() });
  const enabled = plan({ scenePriority: true, minTracksPerEpisode: 1, maxTracksPerEpisode: 3 });
  assert.deepEqual(enabled.segments.map((segment) => segment.start), [0, 18.133333]);
  assert.equal(enabled.trackCount.actual, 2);
  assert.equal(enabled.sceneCandidates.filter((cut) => cut.used).length, 1);
  assert.match(enabled.segments[1].reason, /转场必换曲/);
  assert.equal(plan({ scenePriority: false, minTracksPerEpisode: 1 }).segments.length, 1);
  assert.equal(plan({ scenePriority: true, maxTracksPerEpisode: 1 }).segments.length, 2);
  const required = plan({ scenePriority: false, minTracksPerEpisode: 2, maxTracksPerEpisode: 3 });
  assert.equal(required.trackCount.met, true);
  assert.equal(required.segments[1].start, 18.133333);
});

test('custom music limits above the default reach real planning instead of stopping at three', () => {
  const groups = new Map([['默认', Array.from({ length: 20 }, (_, index) => `track-${index}.wav`)]]);
  const plan = buildMusicPlan({ duration: 180, transcript: null, groups, trackUses: new Map(),
    options: { scenePriority: false, minTracksPerEpisode: 17, maxTracksPerEpisode: 17 } });
  assert.equal(plan.segments.length, 17);
  assert.equal(plan.trackCount.actual, 17);
  assert.equal(plan.trackCount.met, true);
});

test('minimum picks different compatible songs, uses pauses and reports impossible requests', () => {
  const groups = new Map([['默认', ['calm-a.wav', 'calm-b.wav', 'calm-c.wav']], ['紧张', ['tense.wav']]]);
  const plan = (options = {}, transcript = null, duration = 60, choices = groups) => buildMusicPlan({ duration, transcript, groups: choices,
    options: { scenePriority: false, minTracksPerEpisode: 2, maxTracksPerEpisode: 3, ...options }, trackUses: new Map() });
  const paused = plan({}, { segments: [{ start: 1, end: 15, text: 'Hello.' }, { start: 20, end: 55, text: 'We should talk.' }] });
  assert.equal(paused.segments[1].start, 17.5);
  assert.match(paused.segments[1].reason, /停顿/);
  assert.deepEqual(paused.trackCount, { minimum: 2, actual: 2, segments: 2, met: true, warning: '' });
  const noEvidence = plan({ minTracksPerEpisode: 3 });
  assert.equal(noEvidence.trackCount.actual, 3);
  assert.ok(noEvidence.segments.every((segment) => segment.end - segment.start >= 6 && segment.track !== 'tense.wav'));
  const nearEnd = buildMusicPlan({ duration: 55, transcript: null, groups, sceneCuts: [{ time: 48, score: 28 }, { time: 24, score: 15 }],
    options: { scenePriority: false, minTracksPerEpisode: 2 }, trackUses: new Map() });
  assert.equal(nearEnd.segments[1].start, 24);
  const short = plan({}, null, 10);
  assert.equal(short.segments.length, 1);
  assert.match(short.trackCount.warning, /时长不足/);
  const insufficient = plan({}, null, 60, new Map([['默认', ['only.wav']], ['紧张', ['unrelated.wav']]]));
  assert.equal(insufficient.segments.length, 1);
  assert.equal(insufficient.trackCount.actual, 1);
  assert.match(insufficient.trackCount.warning, /曲目不足/);
  const compatible = plan({ mood: '紧张' });
  assert.equal(compatible.trackCount.actual, 2);
  assert.equal(compatible.segments[0].track, 'tense.wav');
  assert.ok(compatible.segments[1].track.startsWith('calm-'));
});

test('required scene switches keep close transitions and override the cap without adjacent track reuse', () => {
  const groups = new Map([['默认', Array.from({ length: 5 }, (_, index) => `calm-${index}.wav`)]]);
  const sceneCuts = [12, 13, 24, 36, 48].map((time) => ({ time, score: 50, kind: 'cut' }));
  const plan = (options) => buildMusicPlan({ duration: 60, transcript: null, groups, sceneCuts, options, trackUses: new Map() });
  const capped = plan({ maxTracksPerEpisode: 3 });
  assert.equal(capped.segments.length, 6);
  assert.ok(capped.sceneCandidates.every((cut) => cut.required && cut.used));
  assert.ok(capped.segments.every((segment, index) => !index || segment.track !== capped.segments[index - 1].track));
  assert.equal(plan({ scenePriority: false, maxTracksPerEpisode: 3 }).segments.length, 1);
  const unlimited = plan({ maxTracksPerEpisode: 0 });
  assert.deepEqual(unlimited.segments.map((segment) => segment.start), [0, 12, 13, 24, 36, 48]);
  const dense = plan({ minTracksPerEpisode: 5, maxTracksPerEpisode: 5 });
  assert.equal(dense.trackCount.met, true);
  const compact = buildMusicPlan({ duration: 30, transcript: null, groups, sceneCuts: [{ time: 15, score: 50, kind: 'cut' }],
    options: { minTracksPerEpisode: 5, maxTracksPerEpisode: 5 }, trackUses: new Map() });
  assert.equal(compact.trackCount.actual, 4);
  assert.equal(compact.trackCount.met, false);
  assert.match(compact.trackCount.warning, /必换点分段限制/);
  assert.ok(compact.sceneCandidates[0].used);
  assert.ok(compact.segments.every((segment) => segment.end - segment.start >= 6));
  const compactOff = buildMusicPlan({ duration: 30, transcript: null, groups, sceneCuts: [{ time: 15, score: 50, kind: 'cut' }],
    options: { scenePriority: false, minTracksPerEpisode: 5, maxTracksPerEpisode: 5 }, trackUses: new Map() });
  assert.equal(compactOff.trackCount.actual, 5);
});

test('scene-required mode preserves emotion changes separately instead of moving them to an earlier scene', () => {
  const groups = new Map([['浪漫', ['love.wav']], ['愤怒', ['anger.wav']], ['默认', ['calm-a.wav', 'calm-b.wav']]]);
  const options = { scenePriority: true, maxTracksPerEpisode: 1 };
  const transcript = { segments: [{ start: 1, end: 10, text: '我爱你，我们相爱。' }, { start: 32, end: 40, text: '我很愤怒，无法原谅！' }] };
  const plan = buildMusicPlan({ duration: 60, transcript, groups, options, trackUses: new Map(), sceneCuts: [{ time: 18, score: 50, kind: 'cut' }] });
  assert.deepEqual(plan.segments.map((segment) => segment.start), [0, 18, 31.8]);
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['浪漫', '默认', '愤怒']);
  assert.equal(plan.sceneCandidates[0].used, true);
  assert.match(plan.segments[2].reason, /情绪转折/);
  const coincident = buildMusicPlan({ duration: 60, transcript, groups, options, trackUses: new Map(), sceneCuts: [{ time: 32, score: 50, kind: 'cut' }] });
  assert.equal(coincident.segments.length, 2);
  assert.equal(coincident.segments[1].start, 32);
  assert.equal(coincident.segments[1].mood, '愤怒');
  assert.ok(coincident.segments[1].transition.sceneChange);
});

test('required scenes report missing alternative music instead of silently continuing the same track', () => {
  const groups = new Map([['默认', ['only.wav']], ['紧张', ['unrelated.wav']]]);
  assert.throws(() => buildMusicPlan({ duration: 60, transcript: null, groups, options: { scenePriority: true },
    trackUses: new Map(), sceneCuts: [{ time: 20, score: 50, kind: 'cut' }] }), /20 秒处必须换曲.*没有另一首/);
  const allowed = buildMusicPlan({ duration: 60, transcript: null, groups, options: { scenePriority: false },
    trackUses: new Map(), sceneCuts: [{ time: 20, score: 50, kind: 'cut' }] });
  assert.equal(allowed.segments.length, 1);
});

test('understands English clause turns and ignores negated mood words', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
    ['默认', ['default.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [{ start: 0, end: 60, text: "I love you, but how dare you treat me like this?", words: [
        {start:0,end:10,word:"I love you,"}, {start:32,end:34,word:" but"}, {start:35,end:58,word:" how dare you treat me like this?"}
      ] }] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['浪漫', '愤怒']);
  assert.equal(inferMood({ segments: [{ start: 0, end: 2, text: "I don't love you and I'm not happy." }] }, groups).mood, '默认');
});

test('batch MVP renders Chinese paths, ducking, validation, and resume', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-'));
  const videoDir = path.join(root, '素材', '视频');
  const musicDir = path.join(root, '素材', 'BGM');
  const transcriptDir = path.join(root, '素材', '字幕');
  const outputDir = path.join(root, '输出');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(path.join(musicDir, '默认'), { recursive: true }),
    fs.mkdir(path.join(musicDir, '紧张'), { recursive: true }),
    fs.mkdir(transcriptDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '默认', '平稳.wav'), 330);
  await makeAudio(path.join(musicDir, '紧张', '追逐.wav'), 660);
  await makeVideo(path.join(videoDir, '第10集.mp4'));
  await makeVideo(path.join(videoDir, '第2集.mp4'));
  await fs.writeFile(path.join(transcriptDir, '第2集.json'), JSON.stringify({ segments: [{ start: 0.6, end: 1.1, text: '危险，快跑' }] }), 'utf8');

  const options = {
    videos: videoDir,
    music: musicDir,
    output: outputDir,
    transcripts: transcriptDir,
    transcribe: false,
    mood: null,
    autoDuck: true,
    duckDb: -10,
    fadeIn: 0.2,
    fadeOut: 0.2,
    overwrite: false,
    ffmpeg,
    ffprobe,
  };
  const first = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(first.failed, 0);
  assert.equal(first.completed, 2);
  assert.deepEqual(first.results.map((item) => item.episode), ['第2集', '第10集']);
  const finalVideo = path.join(outputDir, '第2集_final.mp4');
  const finalMedia = await probe(finalVideo);
  assert.ok(finalMedia.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(finalMedia.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  assert.ok(Math.abs(Number(finalMedia.format.duration) - 2.5) <= 0.2);

  const wav = path.join(outputDir, '第2集_bgm.wav');
  const csv = path.join(outputDir, '第2集_timeline.csv');
  const media = await probe(wav);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(Number(audio.channels), 2);
  assert.ok(Math.abs(Number(media.format.duration) - 2.5) <= 0.05);
  const csvBytes = await fs.readFile(csv);
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csvText = csvBytes.toString('utf8');
  assert.match(csvText, /默认/);
  assert.match(csvText, /平稳/);
  assert.match(csvText, /duck_segments/);
  const duckedRms = await wavRms(wav, 0.7, 1.0);
  const normalRms = await wavRms(wav, 1.5, 1.8);
  assert.ok(20 * Math.log10(duckedRms / normalRms) <= -8, '对白区间 BGM should be audibly reduced');
  const leadingRms = await wavRms(wav, 0, 0.1);
  const steadyRms = await wavRms(wav, 1.4, 1.5);
  const trailingRms = await wavRms(wav, 2.4, 2.5);
  assert.ok(leadingRms < steadyRms * 0.4, 'BGM should fade in');
  assert.ok(trailingRms < steadyRms * 0.4, 'BGM should fade out');
  const mixedWav = path.join(root, 'mixed.wav');
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', finalVideo, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', mixedWav], { windowsHide: true });
  assert.ok(await wavRms(mixedWav, 1.3, 1.6) > await wavRms(wav, 1.3, 1.6) * 1.15, 'final video should retain original audio in addition to BGM');

  const secondProgress = [];
  const second = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {}, progress(event) { secondProgress.push(event); } });
  assert.equal(second.failed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(secondProgress.filter((event) => event.status === 'checking').length, 2);
  assert.equal(secondProgress.some((event) => event.status === 'processing'), false);
  assert.deepEqual(secondProgress.filter((event) => event.status).map(({ episode, status }) => [episode, status]), [
    ['第2集', 'checking'], ['第2集', 'skipped'], ['第10集', 'checking'], ['第10集', 'skipped'],
  ]);

  const overwriteButSkip = await runBatch({ strictInstrumental: false, ...options, overwrite: true, skipCompleted: true }, { log() {}, error() {} });
  assert.equal(overwriteButSkip.failed, 0);
  assert.equal(overwriteButSkip.skipped, 2);

  const changedButSkipped = await runBatch({ strictInstrumental: false, ...options, fadeIn: 0.8, skipCompleted: true }, { log() {}, error() {} });
  assert.equal(changedButSkipped.failed, 0);
  assert.equal(changedButSkipped.skipped, 2);

  const rerunProgress = [];
  const rerun = await runBatch({ strictInstrumental: false, ...options, fadeIn: 0.8, skipCompleted: false }, { log() {}, error() {}, progress(event) { rerunProgress.push(event); } });
  assert.equal(rerun.failed, 0);
  assert.equal(rerun.completed, 2);
  assert.equal(rerunProgress.filter((event) => event.status === 'processing').length, 2);

  const selectionOnly = await runBatch({ strictInstrumental: false, ...options, outputAudio: false, outputVideo: false, outputTimeline: true, outputTranscript: false }, { log() {}, error() {} });
  assert.equal(selectionOnly.skipped, 2);
  let selectionState = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const selectedEpisode = selectionState.episodes[path.join(videoDir, '第2集.mp4')];
  assert.equal(selectedEpisode.outputAudio, false);
  assert.equal(selectedEpisode.outputVideo, false);
  assert.equal(selectedEpisode.outputTimeline, true);
  assert.equal(selectedEpisode.outputTranscript, false);
  assert.equal((await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} })).skipped, 2);

  await makeSilentWav(path.join(outputDir, '第10集_bgm.wav'), 2.5);
  const recoveredProgress = [];
  const recoveredOutput = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {}, progress(event) { recoveredProgress.push(event); } });
  assert.equal(recoveredOutput.failed, 0);
  assert.equal(recoveredOutput.completed, 1);
  assert.equal(recoveredOutput.skipped, 1);
  assert.deepEqual(recoveredProgress.filter((event) => event.status).map(({ episode, status }) => [episode, status]), [
    ['第2集', 'checking'], ['第2集', 'skipped'], ['第10集', 'checking'], ['第10集', 'processing'], ['第10集', 'completed'],
  ]);

  await fs.writeFile(path.join(transcriptDir, '第2集.json'), JSON.stringify({ segments: [] }), 'utf8');
  const changedTranscript = await runBatch({ strictInstrumental: false, ...options, skipCompleted: false }, { log() {}, error() {} });
  assert.equal(changedTranscript.completed, 2);
  assert.equal(changedTranscript.skipped, 0);
  assert.equal(changedTranscript.results.find((item) => item.episode === '第2集').mood, '默认');
  assert.match(await fs.readFile(csv, 'utf8'), /,0,\[\],0:00,0,scene-required-with-mood-v4,/);
  await fs.writeFile(finalVideo, 'broken final output', 'utf8');
  const recoveredFinal = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(recoveredFinal.completed, 1);
  assert.ok((await probe(finalVideo)).streams.some((stream) => stream.codec_type === 'video')); 

  await fs.writeFile(path.join(videoDir, '第2集.mp4'), 'not a video', 'utf8');
  const damagedInput = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(damagedInput.failed, 1);
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  assert.equal(state.episodes[path.join(videoDir, '第2集.mp4')].status, 'failed');
  assert.equal(await fs.stat(wav).then(() => true), true);

  await makeVideo(path.join(videoDir, '第2集.mp4'));
  await fs.writeFile(path.join(videoDir, '坏集.mp4'), 'not a video', 'utf8');
  const thirdOutput = path.join(root, '输出-失败继续');
  const third = await runBatch({ strictInstrumental: false, ...options, output: thirdOutput }, { log() {}, error() {} });
  assert.equal(third.failed, 1);
  assert.equal(third.completed, 2);
});

test('selected outputs render only required artifacts and preserve deselected older files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-output-selection-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeVideo(path.join(videoDir, '样片.mp4'));

  const oldFiles = new Map([
    ['样片_bgm.wav', 'keep old audio'],
    ['样片_final.mp4', 'keep old video'],
    ['样片_transcript.json', 'keep old transcript'],
  ]);
  for (const [name, contents] of oldFiles) await fs.writeFile(path.join(outputDir, name), contents, 'utf8');

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir, music: path.dirname(musicDir), output: outputDir,
    transcribe: false, overwrite: false, outputAudio: false, outputVideo: false,
    outputTimeline: true, outputTranscript: false, duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, ffmpeg, ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.completed, 1);
  assert.ok((await fs.stat(path.join(outputDir, '样片_timeline.csv'))).isFile());
  for (const [name, contents] of oldFiles) assert.equal(await fs.readFile(path.join(outputDir, name), 'utf8'), contents);
  await assert.rejects(fs.access(path.join(outputDir, '样片_bgm.wav.part.wav')));
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const episode = state.episodes[path.join(videoDir, '样片.mp4')];
  assert.equal(episode.outputAudio, false);
  assert.equal(episode.outputVideo, false);
  assert.equal(episode.outputTimeline, true);
  assert.equal(episode.outputTranscript, false);
  const oldTimeline = await fs.readFile(path.join(outputDir, '样片_timeline.csv'), 'utf8');

  const videoOnly = await runBatch({ strictInstrumental: false,
    videos: videoDir, music: path.dirname(musicDir), output: outputDir,
    transcribe: false, overwrite: true, outputAudio: false, outputVideo: true,
    outputTimeline: false, outputTranscript: false, duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, ffmpeg, ffprobe,
  }, { log() {}, error() {} });
  assert.equal(videoOnly.completed, 1);
  const finalVideo = await probe(path.join(outputDir, '样片_final.mp4'));
  assert.ok(finalVideo.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(finalVideo.streams.some((stream) => stream.codec_type === 'audio'));
  assert.equal(await fs.readFile(path.join(outputDir, '样片_bgm.wav'), 'utf8'), oldFiles.get('样片_bgm.wav'));
  assert.equal(await fs.readFile(path.join(outputDir, '样片_timeline.csv'), 'utf8'), oldTimeline);
  assert.equal(await fs.readFile(path.join(outputDir, '样片_transcript.json'), 'utf8'), oldFiles.get('样片_transcript.json'));
  await assert.rejects(fs.access(path.join(outputDir, '样片_bgm.wav.part.wav')));
  const finalState = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const finalEpisode = finalState.episodes[path.join(videoDir, '样片.mp4')];
  assert.equal(finalEpisode.outputAudio, false);
  assert.equal(finalEpisode.outputVideo, true);
  assert.equal(finalEpisode.outputTimeline, false);
});

test('saves transcript text and timestamps when transcription is enabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-transcript-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const transcriptDir = path.join(root, 'transcripts');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(transcriptDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeVideo(path.join(videoDir, '样片.mp4'));
  const segments = [{ start: 0.6, end: 1.1, text: 'This is our wedding.' }];
  await fs.writeFile(path.join(transcriptDir, '样片.json'), JSON.stringify({ segments }), 'utf8');

  const options = {
    videos: videoDir, music: path.dirname(musicDir), output: outputDir, transcripts: transcriptDir,
    transcribe: true, mood: null, duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, overwrite: false, ffmpeg, ffprobe,
  };
  const transcriptPath = path.join(outputDir, '样片_transcript.json');
  await fs.writeFile(transcriptPath, 'keep user transcript', 'utf8');
  const protectedAttempt = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(protectedAttempt.failed, 1);
  assert.equal(await fs.readFile(transcriptPath, 'utf8'), 'keep user transcript');
  await fs.unlink(transcriptPath);

  const first = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(first.failed, 0);
  assert.equal(first.results[0].transcriptPath, transcriptPath);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, segments);
  assert.equal((await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} })).skipped, 1);

  const updatedSegments = [{ start: 0.6, end: 1.1, text: 'She slapped me.' }];
  await fs.writeFile(path.join(transcriptDir, '样片.json'), JSON.stringify({ segments: updatedSegments }), 'utf8');
  assert.equal((await runBatch({ strictInstrumental: false, ...options, skipCompleted: false }, { log() {}, error() {} })).completed, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, updatedSegments);

  await fs.unlink(transcriptPath);
  const resumed = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(resumed.completed, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, updatedSegments);
});

test('fails clearly when a packaged transcriber executable is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-transcriber-runtime-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeVideo(path.join(videoDir, '样片.mp4'));
  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir, music: path.dirname(musicDir), output: outputDir,
    transcribe: true, transcriberExecutable: path.join(root, 'missing-transcriber.exe'),
    duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, overwrite: false, ffmpeg, ffprobe,
  }, { log() {}, error() {} });
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0].error, /内置转录组件不存在/);
});

test('does not overwrite unowned files and renders videos without audio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-safety-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeSilentVideo(path.join(videoDir, '无音轨.mp4'));
  await makeSilentVideo(path.join(videoDir, '手工.mp4'));
  const protectedPath = path.join(outputDir, '手工_bgm.wav');
  await fs.writeFile(protectedPath, 'keep this user file', 'utf8');

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcripts: null,
    transcribe: false,
    mood: null,
    duckDb: -10,
    fadeIn: 0.1,
    fadeOut: 0.1,
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(await fs.readFile(protectedPath, 'utf8'), 'keep this user file');
  assert.equal(await outputIsPcm(path.join(outputDir, '无音轨_bgm.wav')), true);
});

async function outputIsPcm(filePath) {
  const media = await probe(filePath);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  return Boolean(audio && Number(audio.sample_rate) === 48000 && Number(audio.channels) === 2);
}

test('limits rendered BGM peaks to preserve headroom', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-limiter-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '满电平.wav'), 440, 8, 2);
  await makeVideo(path.join(videoDir, '峰值.mp4'));

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcripts: null,
    transcribe: false,
    mood: null,
    duckDb: -10,
    fadeIn: 0,
    fadeOut: 0,
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.failed, 0);
  const wav = path.join(outputDir, '峰值_bgm.wav');
  assert.ok(await wavMaxDb(wav) <= -0.9);
  assert.ok(Math.abs(Number((await probe(wav)).format.duration) - 2.5) <= 0.05);
});

test('preserves the requested BGM duration after loudnorm resampling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-loudnorm-duration-'));
  const track = path.join(root, '平稳.wav');
  const output = path.join(root, 'output.wav');
  const duration = 67.849;
  await makeAudio(track, 440);

  const filter = buildMultiTrackFilter(
    [{ start: 0, end: duration, track }],
    duration,
    { fadeIn: 0, fadeOut: 2, autoDuck: false, duckDb: -10 },
    [],
    false,
  );
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', track,
    '-filter_complex', filter, '-map', '[aout]', '-t', String(duration),
    '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output,
  ], { windowsHide: true });

  const media = await probe(output);
  assert.ok(Math.abs(Number(media.format.duration) - duration) <= 0.05);
});

test('splits a long episode at a transcript mood turn and renders two BGM segments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-scenes-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM');
  const transcriptDir = path.join(root, 'transcripts');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(path.join(musicDir, '01_紧张_激烈冲突'), { recursive: true }),
    fs.mkdir(path.join(musicDir, '08_悲伤_失落离别'), { recursive: true }),
    fs.mkdir(transcriptDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '01_紧张_激烈冲突', '冲突.wav'), 330);
  await makeAudio(path.join(musicDir, '08_悲伤_失落离别', '离别.wav'), 660);
  await makeVideo(path.join(videoDir, '转折.mp4'), 50);
  await fs.writeFile(path.join(transcriptDir, '转折.json'), JSON.stringify({ segments: [
    { start: 2, end: 18, text: '危险，快跑，前面有人追杀' },
    { start: 28, end: 46, text: '我很难过，眼泪止不住，对不起' },
  ] }), 'utf8');

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: musicDir,
    output: outputDir,
    transcripts: transcriptDir,
    transcribe: false,
    mood: null,
    duckDb: -10,
    fadeIn: 0.2,
    fadeOut: 0.2,
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.failed, 0);
  const wav = path.join(outputDir, '转折_bgm.wav');
  const csv = (await fs.readFile(path.join(outputDir, '转折_timeline.csv'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(csv.length, 3);
  assert.match(csv[1], /01_紧张_激烈冲突/);
  assert.match(csv[2], /08_悲伤_失落离别/);
  assert.match(csv[1], /片段对白关键词/);
  assert.notEqual(csv[1].split(',')[4], csv[2].split(',')[4]);
  const media = await probe(wav);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  assert.ok(audio);
  assert.ok(Math.abs(Number(media.format.duration) - 50) <= 0.05);
});

test('required scene renders a short switch despite the cap while the disabled mode keeps one track', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-required-short-scene-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'music');
  await Promise.all([fs.mkdir(videoDir), fs.mkdir(musicDir)]);
  await makeSceneVideo(path.join(videoDir, 'short.mp4'), 2);
  await makeAudio(path.join(musicDir, 'a.wav'), 330);
  await makeAudio(path.join(musicDir, 'b.wav'), 440);
  for (const scenePriority of [true, false]) {
    const summary = await runBatch({ videos: videoDir, music: musicDir, output: path.join(root, String(scenePriority)),
      strictInstrumental: false, transcribe: false, scenePriority, minTracksPerEpisode: 1, maxTracksPerEpisode: 1,
      freezeTail: 0, fadeIn: 0, fadeOut: 0, ffmpeg, ffprobe }, { log() {}, error() {} });
    assert.equal(summary.completed, 1, JSON.stringify(summary));
    const result = summary.results[0];
    assert.equal(result.analysis.trackCount.actual, scenePriority ? 2 : 1);
    assert.ok(result.analysis.sceneCandidates.length);
    if (scenePriority) {
      assert.ok(result.analysis.sceneCandidates.every((cut) => cut.required && cut.used));
      assert.ok(Math.abs(result.analysis.segments[1].start - 2) < 0.05);
      assert.notEqual(result.tracks[0], result.tracks[1]);
    }
    await execFileAsync(ffmpeg, ['-v', 'error', '-i', result.finalVideoPath, '-f', 'null', '-'], { windowsHide: true });
    assert.ok(Math.abs(Number((await probe(result.finalVideoPath)).format.duration) - 4) < 0.05);
  }
});

test('minimum produces two rendered songs at a visual cut and preserves the configured freeze tail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-visual-cuts-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳1.wav'), 330);
  await makeAudio(path.join(musicDir, '平稳2.wav'), 440);
  await makeSilentWav(path.join(musicDir, '静音.wav'), 4);
  await fs.writeFile(path.join(musicDir, '损坏.mp3'), '不是有效音频');
  await makeSceneVideo(path.join(videoDir, '转场.mp4'));

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcribe: false,
    minTracksPerEpisode: 2,
    maxTracksPerEpisode: 3,
    scenePriority: true,
    mood: null,
    autoDuck: false,
    duckDb: -10,
    fadeIn: 0,
    fadeOut: 0.2,
    freezeTail: '2:15',
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.failed, 0);
  const rows = (await fs.readFile(path.join(outputDir, '转场_timeline.csv'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(rows.length, 3);
  assert.equal(Number(rows[1].split(',')[2]), 0);
  assert.ok(Math.abs(Number(rows[1].split(',')[3]) - 15) < 0.05);
  assert.ok(Math.abs(Number(rows[2].split(',')[3]) - 27.4) < 0.05);
  assert.equal(summary.results[0].analysis.trackCount.actual, 2);
  assert.equal(summary.results[0].analysis.trackCount.met, true);
  assert.notEqual(summary.results[0].tracks[0], summary.results[0].tracks[1]);
  assert.ok(summary.results[0].analysis.sceneCandidates.some((cut) => cut.used));
  assert.equal(rows[1].split(',')[11], '2:15');
  assert.equal(Number(rows[1].split(',')[12]), 2.6);
  const bgm = await probe(path.join(outputDir, '转场_bgm.wav'));
  const finalVideo = await probe(path.join(outputDir, '转场_final.mp4'));
  assert.ok(Math.abs(Number(bgm.format.duration) - 27.4) < 0.05);
  assert.ok(Math.abs(Number(finalVideo.format.duration) - 30) < 0.2);
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  assert.equal(state.version, 14);
  assert.equal(state.musicCatalog[path.resolve(musicDir, '损坏.mp3')].playable, false);
  assert.equal(state.musicCatalog[path.resolve(musicDir, '静音.wav')].playable, false);
});

async function storyFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const music = path.join(root, 'music');
  const transcripts = path.join(root, 'transcripts');
  await Promise.all(['紧张', '浪漫'].map((mood) => fs.mkdir(path.join(music, mood), { recursive: true })));
  await fs.mkdir(transcripts);
  const video = path.join(root, 'episode.mp4');
  const storyPath = path.join(root, 'episode.md');
  await makeVideo(video, 4);
  await makeAudio(path.join(music, '紧张', 'tense.wav'), 330);
  await makeAudio(path.join(music, '浪漫', 'love.wav'), 440);
  await fs.writeFile(storyPath, 'PRIVATE_STORY_TEXT: a threat concealed by a wedding.');
  const segments = [
    { start: 0.2, end: 0.9, text: 'I love you. This is our wedding.' },
    { start: 1.25, end: 2.1, text: 'Wait.' },
    { start: 2.5, end: 3.2, text: 'Goodbye.' },
  ];
  await fs.writeFile(path.join(transcripts, 'episode.json'), JSON.stringify({ segments }));
  return {
    root, video, segments,
    options: {
      videos: video, music, transcripts, storyPath, output: path.join(root, 'output'),
      ffmpeg, ffprobe, strictInstrumental: false, transcribe: false, storyEnabled: true,
      scenePriority: false, freezeTail: '0:12', fadeIn: 0, fadeOut: 0, transitionFadeDuration: 0.4,
      storyAIProfile: { baseUrl: 'https://model.example/v1', model: 'director', apiKey: 'PRIVATE_KEY' },
    },
  };
}

function syntheticStoryPlan() {
  return { summary: 'The threat gives way to a pause and farewell.', alignmentConfidence: 0.95,
    messages: 'PRIVATE_HTTP_MESSAGES',
    cues: [
      { startSegment: 0, mood: '紧张', intensity: 1, reason: 'A concealed threat.', confidence: 0.9, review: false },
      { startSegment: 1, mood: null, intensity: 1, reason: 'Let the line land.', confidence: 0.8, review: true },
      { startSegment: 2, mood: '浪漫', intensity: 2, reason: 'The farewell recalls their bond.', confidence: 0.9, review: false },
    ] };
}

test('story-assisted batch renders local tracks at ASR anchors with exact silence and safe provenance', async (t) => {
  const fixture = await storyFixture(t);
  const stages = [];
  const controller = new AbortController();
  let received;
  const result = await runBatch({ ...fixture.options, signal: controller.signal,
    createStoryPlan: async (context) => { received = context; return syntheticStoryPlan(); },
  }, { log() {}, error() {}, progress(event) { if (event.stage) stages.push(event.stage); } });
  assert.equal(result.completed, 1, JSON.stringify(result.results));
  assert.ok(received, 'the story callback must run instead of keyword planning');
  assert.equal(received.document.name, 'episode.md');
  assert.match(received.document.text, /PRIVATE_STORY_TEXT/);
  assert.deepEqual(received.transcript.segments, fixture.segments);
  assert.equal(received.signal, controller.signal);
  assert.equal(received.duration, 3.52);
  assert.deepEqual([...received.groups.keys()], ['浪漫', '紧张']);
  assert.ok(stages.includes('analyzing-story'));
  const episode = result.results[0];
  assert.deepEqual(episode.analysis.segments.map(({ start, end }) => [start, end]), [[0, 1.25], [1.25, 2.5], [2.5, 3.52]]);
  assert.deepEqual(episode.moods, ['紧张', '剧情留白', '浪漫']);
  assert.equal(episode.analysis.story.source, 'episode.md');
  assert.equal(episode.analysis.story.profile.model, 'director');
  assert.equal(episode.analysis.needsReview, true);
  assert.ok(await wavRms(episode.outputPath, 0.3, 0.8) > 0.001);
  assert.ok(await wavRms(episode.outputPath, 1.26, 2.49) < 0.00001, 'crossfades must not enter deliberate silence');
  assert.ok(await wavRms(episode.outputPath, 2.7, 3.1) > 0.001);
  const csv = await fs.readFile(episode.timelinePath, 'utf8');
  assert.match(csv, /剧情留白/);
  const stateText = await fs.readFile(path.join(fixture.options.output, '.mvp-state.json'), 'utf8');
  const saved = JSON.parse(stateText).episodes[fixture.video];
  assert.equal(saved.transcribe, true);
  assert.match(saved.storyFingerprint, /^[a-f0-9]{64}$/);
  for (const text of [stateText, JSON.stringify(result), await fs.readFile(path.join(fixture.options.output, 'run-summary.json'), 'utf8')]) {
    assert.doesNotMatch(text, /PRIVATE_STORY_TEXT|PRIVATE_KEY|PRIVATE_HTTP_MESSAGES|apiKey/);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(episode.transcriptPath, 'utf8')).segments, fixture.segments);
  assert.ok((await probe(episode.finalVideoPath)).streams.some((stream) => stream.codec_type === 'video'));
});

test('story fingerprints invalidate early completion for mode, document, endpoint and model changes only', async (t) => {
  const { options, video } = await storyFixture(t);
  const logger = { log() {}, error() {} };
  let calls = 0;
  const createStoryPlan = async () => { calls += 1; return syntheticStoryPlan(); };
  const fast = { ...options, outputAudio: false, outputVideo: false, outputTranscript: false, createStoryPlan };
  assert.equal((await runBatch({ ...fast, storyEnabled: false }, logger)).completed, 1);
  assert.equal((await runBatch(fast, logger)).completed, 1, 'enabling story must not reuse keyword output');
  assert.equal(calls, 1);
  assert.equal((await runBatch(fast, logger)).skipped, 1);
  assert.equal(calls, 1);
  const fingerprint = JSON.parse(await fs.readFile(path.join(options.output, '.mvp-state.json'), 'utf8')).episodes[video].storyFingerprint;
  await fs.writeFile(options.storyPath, 'PRIVATE_STORY_TEXT: revised final reveal.');
  assert.equal((await runBatch(fast, logger)).completed, 1, 'changed story must invalidate before skip');
  assert.notEqual(JSON.parse(await fs.readFile(path.join(options.output, '.mvp-state.json'), 'utf8')).episodes[video].storyFingerprint, fingerprint);
  const endpoint = { ...fast, storyAIProfile: { baseUrl: 'https://other.example/v1', model: 'director' } };
  assert.equal((await runBatch(endpoint, logger)).completed, 1);
  const model = { ...endpoint, storyAIProfile: { ...endpoint.storyAIProfile, model: 'director-2' } };
  assert.equal((await runBatch(model, logger)).completed, 1);
  assert.equal((await runBatch({ ...model, storyAIProfile: { ...model.storyAIProfile, apiKey: 'PRIVATE_KEY_CHANGED' } }, logger)).skipped, 1);
  assert.equal(calls, 4);
  assert.equal((await runBatch({ ...fast, storyEnabled: false }, logger)).completed, 1, 'disabling story must not reuse story output');
  assert.equal((await runBatch({ ...fast, storyEnabled: false }, logger)).skipped, 1);
});

test('story-assisted core rejects missing callback, missing documents and empty timestamped ASR', async (t) => {
  const { options } = await storyFixture(t);
  const logger = { log() {}, error() {} };
  await assert.rejects(runBatch(options, logger), /剧情.*模型|模型.*配置/);
  const missing = await runBatch({ ...options, storyPath: path.join(options.output, 'missing.md'), createStoryPlan: async () => syntheticStoryPlan() }, logger).catch((error) => ({ failed: 1, results: [{ error: error.message }] }));
  assert.equal(missing.failed, 1);
  assert.match(missing.results[0].error, /剧本|剧情|story|ENOENT/i);
  await fs.writeFile(path.join(options.transcripts, 'episode.json'), JSON.stringify({ segments: [{ start: 1, end: 2, text: '  ' }] }));
  const empty = await runBatch({ ...options, createStoryPlan() { throw new Error('must not call a model with empty ASR'); } }, logger);
  assert.equal(empty.failed, 1);
  assert.match(empty.results[0].error, /真实.*转录|非空.*转录/);
});

test('story-assisted batch matches directory documents per episode and rejects a single document for multiple inputs', async (t) => {
  const { options, root, video } = await storyFixture(t);
  const videos = path.join(root, 'videos');
  const stories = path.join(root, 'stories');
  await Promise.all([fs.mkdir(videos), fs.mkdir(stories)]);
  await fs.copyFile(video, path.join(videos, 'episode.mp4'));
  await fs.copyFile(video, path.join(videos, 'second.mp4'));
  await fs.copyFile(path.join(options.transcripts, 'episode.json'), path.join(options.transcripts, 'second.json'));
  await fs.writeFile(path.join(stories, 'episode.md'), 'First episode story');
  await fs.writeFile(path.join(stories, 'second.txt'), 'Second episode story');
  const seen = [];
  const config = { ...options, videos, outputAudio: false, outputVideo: false, outputTranscript: false,
    createStoryPlan: async ({ document }) => { seen.push(document.name); return syntheticStoryPlan(); } };
  const logger = { log() {}, error() {} };
  const rejected = await runBatch(config, logger);
  assert.equal(rejected.failed, 2);
  assert.deepEqual(seen, []);
  const matched = await runBatch({ ...config, storyPath: stories }, logger);
  assert.equal(matched.completed, 2, JSON.stringify(matched.results));
  assert.deepEqual(seen, ['episode.md', 'second.txt']);
});

test('story callback failures do not fall back to keyword music and cancellation stops analysis', async (t) => {
  const { options } = await storyFixture(t);
  const logger = { log() {}, error() {} };
  const failed = await runBatch({ ...options, createStoryPlan: async () => { throw new Error('剧情模型暂不可用，请重试'); } }, logger);
  assert.equal(failed.failed, 1);
  assert.match(failed.results[0].error, /剧情模型暂不可用/);
  await assert.rejects(fs.access(path.join(options.output, 'episode_bgm.wav')));
  const controller = new AbortController();
  const cancelled = await runBatch({ ...options, signal: controller.signal, createStoryPlan: async ({ signal }) => {
    controller.abort();
    signal.throwIfAborted();
  } }, logger);
  assert.equal(cancelled.interrupted, 1);
  assert.equal(cancelled.completed, 0);
});

test('explicit all-silence story renders zero samples even when screened music is unavailable', async (t) => {
  const { options, video } = await storyFixture(t);
  const { reviewTrack } = require('../src/music-library');
  const groups = await scanMusic(options.music);
  for (const file of [...groups.values()].flat()) await reviewTrack(options.music, groups, { file, action: 'disable' });
  const silent = await runBatch({ ...options, createStoryPlan: async ({ groups: screened }) => {
    assert.equal(screened.size, 0);
    return { ...syntheticStoryPlan(), cues: [{ startSegment: 0, mood: null, intensity: 1, reason: 'The full scene needs silence.', confidence: 0.9, review: false }] };
  } }, { log() {}, error() {} });
  assert.equal(silent.completed, 1, JSON.stringify(silent.results));
  assert.deepEqual(silent.results[0].tracks, [null]);
  assert.equal(silent.results[0].analysis.ducking.enabled, false);
  assert.equal(await wavRms(silent.results[0].outputPath, 0.1, 3.4), 0);
  const resumed = await runBatch({ ...options, createStoryPlan() { throw new Error('unchanged story should skip'); } }, { log() {}, error() {} });
  assert.equal(resumed.skipped, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(options.output, '.mvp-state.json'), 'utf8')).episodes[video].status, 'completed');
});

test('story silence remains sample-exact at ASR anchors between millisecond boundaries', async (t) => {
  const { options, segments } = await storyFixture(t);
  segments[1].start = 1.2506;
  segments[2].start = 2.5004;
  await fs.writeFile(path.join(options.transcripts, 'episode.json'), JSON.stringify({ segments }));
  const result = await runBatch({ ...options, outputVideo: false, createStoryPlan: async () => syntheticStoryPlan() }, { log() {}, error() {} });
  assert.equal(result.completed, 1, JSON.stringify(result.results));
  const firstSilentSample = Math.ceil(1.2506 * 48000) / 48000;
  const firstResumedSample = Math.ceil(2.5004 * 48000) / 48000;
  assert.equal(await wavRms(result.results[0].outputPath, firstSilentSample, firstResumedSample), 0,
    'delay and trim rounding must not put any music samples into a story-silence interval');
});

test('story sources are protected before batch writes and temporary-file cleanup for every generated target', async (t) => {
  const { options, root } = await storyFixture(t);
  const targets = [
    '.mvp-state.json', '.mvp-state.json.part', 'run-summary.json', 'run-report.md', 'run-errors.log',
    'episode_transcript.json', 'episode_transcript.json.part', `.tmp-episode-${process.pid}.transcript.json`,
    'episode_timeline.csv', 'episode_timeline.csv.part',
    'episode_bgm.wav', 'episode_bgm.wav.part.wav', 'episode_final.mp4', 'episode_final.part.mp4',
  ];
  for (const [index, target] of targets.entries()) await t.test(target, async () => {
    const output = path.join(root, `protected-${index}`);
    await fs.mkdir(output);
    const storyPath = path.join(output, target);
    const original = JSON.stringify({ story: 'Source must remain intact.', files: {} });
    await fs.writeFile(storyPath, original);
    await assert.rejects(runBatch({ ...options, output, storyPath, overwrite: index % 2 === 1,
      libraryCacheDir: path.join(output, 'library-cache'), createStoryPlan: async () => syntheticStoryPlan(),
    }, { log() {}, error() {} }), /剧本.*重合|输入素材.*重合/);
    assert.equal(await fs.readFile(storyPath, 'utf8'), original);
    assert.deepEqual(await fs.readdir(output), [target], 'source conflicts must be caught before creating state, caches or reports');
  });
});

test('story source safety follows output-directory junction aliases and protects the music-library cache', async (t) => {
  const { options, root } = await storyFixture(t);
  const output = path.join(root, 'actual-output');
  const alias = path.join(root, 'output-alias');
  await fs.mkdir(output);
  await fs.symlink(output, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const source = path.join(output, 'run-summary.json');
  const original = JSON.stringify({ story: 'Do not follow this alias into my source.' });
  await fs.writeFile(source, original);
  await assert.rejects(runBatch({ ...options, output: alias, storyPath: source, createStoryPlan: async () => syntheticStoryPlan() },
    { log() {}, error() {} }), /剧本.*重合|输入素材.*重合/);
  assert.equal(await fs.readFile(source, 'utf8'), original);
  const { cachePath } = require('../src/music-library');
  const libraryCacheDir = path.join(root, 'library-cache');
  const cachedStory = cachePath(options.music, { libraryCacheDir });
  await fs.mkdir(libraryCacheDir);
  const cachedOriginal = JSON.stringify({ files: {}, story: 'The cache-shaped file is the selected source.' });
  for (const storyPath of [cachedStory, cachedStory + '.part']) {
    await fs.writeFile(storyPath, cachedOriginal);
    await assert.rejects(runBatch({ ...options, libraryCacheDir, storyPath, createStoryPlan: async () => syntheticStoryPlan() },
      { log() {}, error() {} }), /剧本.*重合|输入素材.*重合/);
    assert.equal(await fs.readFile(storyPath, 'utf8'), cachedOriginal);
  }
});

test('desktop library checks and track reviews protect selected stories from cache and temporary-cache writes', async (t) => {
  const { options, root } = await storyFixture(t);
  const { checkMusicLibrary, reviewMusicTrack } = require('../desktop/backend/batch-service');
  const { cachePath } = require('../src/music-library');
  const file = path.join(options.music, '浪漫', 'love.wav');
  for (const action of ['check', 'review']) {
    for (const suffix of ['', '.part']) await t.test(`${action}: cache${suffix}`, async () => {
      const libraryCacheDir = path.join(root, `${action}-cache${suffix}`);
      await fs.mkdir(libraryCacheDir);
      const target = cachePath(options.music, { libraryCacheDir });
      const storyPath = target + suffix;
      const original = JSON.stringify({ files: {}, story: 'A selected story, not disposable cache content.' });
      await fs.writeFile(storyPath, original);
      const config = { ...options, libraryCacheDir, storyPath };
      await assert.rejects(action === 'check'
        ? checkMusicLibrary({ ...config, analyzeVocals: true })
        : reviewMusicTrack({ ...config, file, action: 'confirm' }), /剧本.*重合|输入素材.*重合/);
      assert.equal(await fs.readFile(storyPath, 'utf8'), original);
      assert.deepEqual(await fs.readdir(libraryCacheDir), [path.basename(storyPath)]);
    });
  }
});

test('story preflight protects another episode document before rendering the first episode', async (t) => {
  const { options, root, video } = await storyFixture(t);
  const videos = path.join(root, 'batch-videos');
  const output = path.join(root, 'batch-stories-and-output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(output)]);
  await fs.copyFile(video, path.join(videos, 'episode.mp4'));
  await fs.copyFile(video, path.join(videos, 'episode_transcript.mp4'));
  await fs.writeFile(path.join(output, 'episode.md'), 'First script.');
  const laterStory = path.join(output, 'episode_transcript.json');
  const original = JSON.stringify({ story: 'Second script must not become the first transcript.' });
  await fs.writeFile(laterStory, original);
  await assert.rejects(runBatch({ ...options, videos, output, storyPath: output, overwrite: true,
    createStoryPlan: async () => syntheticStoryPlan(),
  }, { log() {}, error() {} }), /剧本.*重合|输入素材.*重合/);
  assert.equal(await fs.readFile(laterStory, 'utf8'), original);
  assert.deepEqual((await fs.readdir(output)).sort(), ['episode.md', 'episode_transcript.json']);
});

test('desktop fatal-error logging never appends to an aliased story source', async (t) => {
  const { options, root } = await storyFixture(t);
  const { startBatch, getInfo } = require('../desktop/backend/batch-service');
  const output = path.join(root, 'desktop-errors');
  await fs.mkdir(output);
  const log = path.join(output, 'run-errors.log');
  try { await fs.symlink(options.storyPath, log, 'file'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) await fs.link(options.storyPath, log);
    else throw error;
  }
  const original = await fs.readFile(options.storyPath, 'utf8');
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('desktop safety run did not settle')), 30000);
    startBatch({ ...options, output, videos: path.join(root, 'missing.mp4'), modelPath: root }, (event) => {
      events.push(event);
      if (['error', 'finished', 'stopped'].includes(event.type)) { clearTimeout(timer); resolve(); }
    }, { createStoryPlan: async () => syntheticStoryPlan(), storyAIProfile: options.storyAIProfile })
      .catch((error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(getInfo().running, false);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(await fs.readFile(options.storyPath, 'utf8'), original, 'a fatal preflight error must not append its log to a source alias');
});

test('desktop source collisions abort without writing a failure log or any other artifact', async (t) => {
  const { options, root } = await storyFixture(t);
  const { startBatch } = require('../desktop/backend/batch-service');
  const output = path.join(root, 'desktop-source-conflict');
  await fs.mkdir(output);
  const storyPath = path.join(output, 'run-summary.json');
  const original = JSON.stringify({ story: 'Keep this source unchanged.' });
  await fs.writeFile(storyPath, original);
  const terminal = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('desktop safety run did not settle')), 30000);
    startBatch({ ...options, output, storyPath, modelPath: root }, (event) => {
      if (['error', 'finished', 'stopped'].includes(event.type)) { clearTimeout(timer); resolve(event); }
    }, { createStoryPlan: async () => syntheticStoryPlan() })
      .catch((error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(terminal.type, 'error');
  assert.match(terminal.message, /剧本.*重合/);
  assert.equal(await fs.readFile(storyPath, 'utf8'), original);
  assert.deepEqual(await fs.readdir(output), ['run-summary.json']);
});

test('story preflight retains actionable missing and ambiguous document failures per episode', async (t) => {
  const { options, root, video } = await storyFixture(t);
  const videos = path.join(root, 'videos-with-document-errors');
  const stories = path.join(root, 'stories-with-errors');
  await Promise.all([fs.mkdir(videos), fs.mkdir(stories)]);
  for (const name of ['episode', 'ambiguous', 'missing']) await fs.copyFile(video, path.join(videos, `${name}.mp4`));
  await fs.writeFile(path.join(stories, 'episode.md'), 'The valid episode.');
  await fs.writeFile(path.join(stories, 'ambiguous.md'), 'First version.');
  await fs.writeFile(path.join(stories, 'ambiguous.txt'), 'Second version.');
  const result = await runBatch({ ...options, videos, storyPath: stories,
    outputAudio: false, outputVideo: false, outputTranscript: false,
    createStoryPlan: async ({ document }) => {
      assert.deepEqual(Object.keys(document).sort(), ['name', 'signature', 'text']);
      return syntheticStoryPlan();
    },
  }, { log() {}, error() {} });
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 2);
  assert.match(result.results.find((item) => item.episode === 'ambiguous').error, /多个.*剧本|多个.*分镜/);
  assert.match(result.results.find((item) => item.episode === 'missing').error, /找不到.*剧本|找不到.*分镜/);
});

test('story directories beside outputs resume without treating generated JSON as source documents', async (t) => {
  const { options, root, video } = await storyFixture(t);
  const output = path.join(root, 'stories-beside-output');
  const videos = path.join(root, 'videos-beside-output');
  await Promise.all([fs.mkdir(output), fs.mkdir(videos)]);
  await fs.copyFile(video, path.join(videos, 'episode.mp4'));
  await fs.writeFile(path.join(output, 'episode.md'), 'A real source, not a generated artifact.');
  const config = { ...options, videos, output, storyPath: output, outputAudio: false, outputVideo: false,
    createStoryPlan: async () => syntheticStoryPlan() };
  const logger = { log() {}, error() {} };
  assert.equal((await runBatch(config, logger)).completed, 1);
  assert.equal((await runBatch(config, logger)).skipped, 1);
  await fs.copyFile(video, path.join(videos, 'missing.mp4'));
  const missing = await runBatch(config, logger);
  assert.equal(missing.skipped, 1);
  assert.equal(missing.failed, 1);
  assert.match(missing.results.find((item) => item.episode === 'missing').error, /找不到.*剧本|找不到.*分镜/);
});

test('partial story rerenders cannot certify stale media and retain ownership across story-mode switches', async (t) => {
  const { options, video } = await storyFixture(t);
  const { episodeDetail, inspectBatch } = require('../desktop/backend/batch-service');
  const logger = { log() {}, error() {} };
  const config = { ...options, createStoryPlan: async ({ document }) => document.text.includes('REVISION_B')
    ? { summary: 'REVISION_B', alignmentConfidence: 0.95,
      cues: [{ startSegment: 0, mood: '浪漫', intensity: 2, reason: 'Revision B changes the whole score.', confidence: 0.9, review: false }] }
    : syntheticStoryPlan() };
  const allA = await runBatch(config, logger);
  assert.equal(allA.completed, 1);
  const audioPath = allA.results[0].outputPath;
  const finalVideoPath = allA.results[0].finalVideoPath;
  const audioA = await fs.readFile(audioPath);
  const videoA = await fs.readFile(finalVideoPath);
  await fs.writeFile(options.storyPath, 'REVISION_B: the entire scene recalls their romance.');
  const timelineB = await runBatch({ ...config, outputAudio: false, outputVideo: false, outputTranscript: false }, logger);
  assert.equal(timelineB.completed, 1);
  assert.deepEqual(await fs.readFile(audioPath), audioA);
  assert.deepEqual(await fs.readFile(finalVideoPath), videoA);
  const detailB = await episodeDetail({ output: options.output, episode: 'episode' });
  const inspectedB = await inspectBatch({ ...config, modelPath: path.dirname(video) });
  const savedB = JSON.parse(await fs.readFile(path.join(options.output, '.mvp-state.json'), 'utf8')).episodes[video];
  const allB = await runBatch(config, logger);
  assert.equal(allB.completed, 1, 're-enabling media must render B instead of skipping and returning A');
  assert.equal(allB.skipped, 0);
  assert.equal(detailB.staleArtifacts.outputPath, true);
  assert.equal(detailB.staleArtifacts.finalVideoPath, true);
  assert.equal(detailB.staleArtifacts.timelinePath, false);
  assert.equal(inspectedB.rows[0].staleArtifacts.outputPath, true);
  assert.equal(savedB.outputPath, audioPath);
  assert.equal(savedB.finalVideoPath, finalVideoPath);
  assert.notEqual(savedB.artifactStoryFingerprints.outputPath, savedB.artifactStoryFingerprints.timelinePath);
  assert.notDeepEqual(await fs.readFile(audioPath), audioA);
  assert.notDeepEqual(await fs.readFile(finalVideoPath), videoA);
  const audioB = await fs.readFile(audioPath);
  const disabledTimeline = await runBatch({ ...config, storyEnabled: false, outputAudio: false, outputVideo: false, outputTranscript: false }, logger);
  assert.equal(disabledTimeline.completed, 1);
  assert.deepEqual(await fs.readFile(audioPath), audioB);
  const disabledDetail = await episodeDetail({ output: options.output, episode: 'episode' });
  assert.equal(disabledDetail.staleArtifacts.outputPath, true);
  assert.equal(disabledDetail.staleArtifacts.finalVideoPath, true);
  assert.equal((await runBatch({ ...config, storyEnabled: false }, logger)).completed, 1, 'disabling story must also regenerate previously unselected media');
  assert.equal((await runBatch({ ...config, storyEnabled: false }, logger)).skipped, 1);
  assert.equal((await runBatch({ ...config, outputAudio: false, outputVideo: false, outputTranscript: false }, logger)).completed, 1);
  assert.equal((await runBatch(config, logger)).completed, 1, 'enabling story again must not reuse keyword media from a partial run');
  const finalDetail = await episodeDetail({ output: options.output, episode: 'episode' });
  assert.equal(finalDetail.staleArtifacts.outputPath, false);
  assert.equal(finalDetail.staleArtifacts.finalVideoPath, false);
});

test('legacy story outputs without artifact fingerprints regenerate once instead of guessing provenance', async (t) => {
  const { options, video } = await storyFixture(t);
  const logger = { log() {}, error() {} };
  let calls = 0;
  const config = { ...options, outputAudio: false, outputVideo: false, outputTranscript: false,
    createStoryPlan: async () => { calls += 1; return syntheticStoryPlan(); } };
  assert.equal((await runBatch(config, logger)).completed, 1);
  const statePath = path.join(options.output, '.mvp-state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  delete state.episodes[video].artifactStoryFingerprints;
  await fs.writeFile(statePath, JSON.stringify(state));
  assert.equal((await runBatch(config, logger)).completed, 1);
  assert.equal(calls, 2);
  assert.equal((await runBatch(config, logger)).skipped, 1);
  assert.equal(calls, 2);
});

test('forced partial story replanning invalidates retained media even when document and model are unchanged', async (t) => {
  const { options, video } = await storyFixture(t);
  const { episodeDetail } = require('../desktop/backend/batch-service');
  const logger = { log() {}, error() {} };
  let calls = 0;
  const config = { ...options, createStoryPlan: async () => calls++ === 0 ? syntheticStoryPlan()
    : { summary: 'The same script is reinterpreted as sustained romance.', alignmentConfidence: 0.95,
      cues: [{ startSegment: 0, mood: '浪漫', intensity: 2, reason: 'Revised interpretation.', confidence: 0.9, review: false }] } };
  const first = await runBatch(config, logger);
  assert.equal(first.completed, 1);
  const audioPath = first.results[0].outputPath;
  const original = await fs.readFile(audioPath);
  const statePath = path.join(options.output, '.mvp-state.json');
  const before = JSON.parse(await fs.readFile(statePath, 'utf8')).episodes[video];
  const partial = await runBatch({ ...config, skipCompleted: false, outputAudio: false,
    outputVideo: false, outputTranscript: false }, logger);
  assert.equal(partial.completed, 1);
  assert.equal(partial.results[0].analysis.story.summary, 'The same script is reinterpreted as sustained romance.');
  assert.deepEqual(await fs.readFile(audioPath), original, 'partial regeneration must preserve deselected media');
  const after = JSON.parse(await fs.readFile(statePath, 'utf8')).episodes[video];
  assert.equal(after.storyFingerprint, before.storyFingerprint, 'this regression must not rely on changed inputs');
  assert.equal(after.outputPath, audioPath, 'ownership must remain available for the next regeneration');
  const detail = await episodeDetail({ output: options.output, episode: 'episode' });
  assert.equal(detail.staleArtifacts.outputPath, true);
  assert.equal(detail.staleArtifacts.finalVideoPath, true);
  assert.equal(detail.staleArtifacts.timelinePath, false);
  const all = await runBatch(config, logger);
  assert.equal(all.completed, 1, 'retained media must not be reused after a different plan');
  assert.notDeepEqual(await fs.readFile(audioPath), original);
  assert.equal((await runBatch(config, logger)).skipped, 1);
});
