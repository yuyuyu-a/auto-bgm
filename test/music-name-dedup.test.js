'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { inspectMusicCatalog, runBatch, scanMusic } = require('../src/mvp');
const { checkMusicLibrary, inspectBatch } = require('../desktop/backend/batch-service');
const { filterLibrary, fingerprint, readLibrary, reviewTrack } = require('../src/music-library');

const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-name-dedup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const music = path.join(root, 'music');
  const original = path.join(music, 'album2', 'theme.wav');
  const duplicate = path.join(music, 'album10', 'THEME.WAV');
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.mkdir(path.dirname(duplicate), { recursive: true });
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=2', original], { windowsHide: true });
  await fs.writeFile(duplicate, 'different content that must never be decoded');
  return { root, music, original, duplicate, libraryCacheDir: path.join(root, 'cache') };
}

test('library health skips same-name copies before decoding and retains their mood memberships', async (t) => {
  const options = await fixture(t);
  const { original, duplicate } = options;
  const report = await checkMusicLibrary({ ...options, ffmpeg, ffprobe, strictInstrumental: false });
  assert.equal(report.total, 1);
  assert.equal(report.usable, 1);
  assert.equal(report.nameDuplicateCount, 1);
  assert.deepEqual(report.duplicates, [{ file: duplicate, original, kind: 'name' }]);
  assert.deepEqual(report.files.map(({ file }) => file), [original]);
  assert.deepEqual(report.musicGroups.map(({ mood, count, usable }) => ({ mood, count, usable })), [
    { mood: 'album10', count: 1, usable: 1 }, { mood: 'album2', count: 1, usable: 1 },
  ]);
  assert.deepEqual(report.emptyDirectories, []);
  const saved = await readLibrary(options.music, options);
  assert.deepEqual(Object.keys(saved.health), [original]);
  assert.equal(await fs.readFile(duplicate, 'utf8'), 'different content that must never be decoded');
  const preflight = await inspectBatch({ ...options, ffmpeg, ffprobe });
  assert.equal(preflight.musicCount, 1);
});

test('catalog representative is stable across group order while raw source inventory stays complete', async (t) => {
  const options = await fixture(t);
  const { original, duplicate } = options;
  const raw = await scanMusic(options.music);
  assert.equal([...raw.values()].flat().length, 2);
  const state = { musicCatalog: {} };
  const first = await inspectMusicCatalog(raw, ffprobe, ffmpeg, undefined, state);
  const reversed = await inspectMusicCatalog(new Map([...raw].reverse()), ffprobe, ffmpeg, undefined, state);
  for (const catalog of [first, reversed]) {
    assert.equal(catalog.checked, 1);
    assert.deepEqual(catalog.files.map(({ file }) => file), [original]);
    assert.deepEqual(catalog.duplicates, [{ file: duplicate, original, kind: 'name' }]);
    assert.deepEqual(catalog.groups.get('album10'), [original]);
    assert.deepEqual(catalog.groups.get('album2'), [original]);
  }
});

test('filename deduplication does not collapse different extensions or numbered copies', async (t) => {
  const options = await fixture(t);
  const differentExtension = path.join(options.music, 'album2', 'theme.mp3');
  const differentName = path.join(options.music, 'album2', 'theme (1).wav');
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.original,
    differentExtension], { windowsHide: true });
  await fs.copyFile(options.original, differentName);
  const result = await inspectMusicCatalog(await scanMusic(options.music), ffprobe, ffmpeg,
    undefined, { musicCatalog: {} });
  assert.equal(result.checked, 3);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(new Set(result.files.map(({ file }) => file)),
    new Set([options.original, differentExtension, differentName]));
});

test('strict screening uses one representative cache and invalidates it when that file changes', async (t) => {
  const options = await fixture(t);
  const raw = await scanMusic(options.music);
  await reviewTrack(options.music, raw, { file: options.original, action: 'confirm' }, options);
  const progress = [];
  const first = await filterLibrary(raw, options, { analyze: true, progress: (event) => progress.push(event) });
  assert.equal(first.counts.confirmed, 1);
  assert.equal(first.files.length, 1);
  assert.deepEqual([...first.groups.values()], [[options.original], [options.original]]);
  assert.deepEqual(progress.map(({ checked, total }) => ({ checked, total })), [{ checked: 1, total: 1 }]);
  const saved = await readLibrary(options.music, options);
  assert.deepEqual(Object.keys(saved.files), [options.original]);
  assert.equal(saved.files[options.original].fingerprint, fingerprint(await fs.stat(options.original)));
  await fs.appendFile(options.original, 'changed');
  const changed = await filterLibrary(raw, options);
  assert.equal(changed.files.length, 1);
  assert.equal(changed.counts.unknown, 1);
  assert.equal(changed.groups.size, 0);
});

test('disabling the representative cannot be bypassed by another same-name copy', async (t) => {
  const options = await fixture(t);
  const raw = await scanMusic(options.music);
  await reviewTrack(options.music, raw, { file: options.original, action: 'disable' }, options);
  const result = await filterLibrary(raw, { ...options, strictInstrumental: false });
  assert.equal(result.files.length, 1);
  assert.equal(result.counts.disabled, 1);
  assert.equal(result.groups.size, 0);
});

test('same-name copies cannot satisfy a request for two different batch tracks', async (t) => {
  const options = await fixture(t);
  const video = path.join(options.root, 'episode.mp4');
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=blue:s=64x64:r=10:d=14', '-c:v', 'mpeg4', video], { windowsHide: true });
  await fs.copyFile(options.original, options.duplicate);
  const result = await runBatch({
    ...options, videos: video, output: path.join(options.root, 'output'), ffmpeg, ffprobe,
    transcribe: false, strictInstrumental: false, scenePriority: false, mood: 'album10',
    minTracksPerEpisode: 2, maxTracksPerEpisode: 0, fadeIn: 0, fadeOut: 0,
    outputAudio: true, outputVideo: false, outputTimeline: true, outputTranscript: false,
  }, { log() {}, error() {} });
  assert.equal(result.completed, 1, JSON.stringify(result.results));
  assert.equal(result.library.nameDuplicateCount, 1);
  assert.deepEqual([...new Set(result.results[0].tracks.filter(Boolean))], [options.original]);
  assert.equal(result.results[0].analysis.trackCount.actual, 1);
  assert.equal(result.results[0].analysis.trackCount.met, false);
});

test('batch output protection still covers sources excluded by filename deduplication', async (t) => {
  const options = await fixture(t);
  const video = path.join(options.root, 'theme.mp4');
  const protectedSource = path.join(options.music, 'album10', 'theme_bgm.wav');
  await fs.rename(options.original, path.join(options.music, 'album2', 'theme_bgm.wav'));
  await fs.rename(options.duplicate, protectedSource);
  await fs.writeFile(video, 'collision test does not need a decoded video');
  await assert.rejects(runBatch({
    ...options, videos: video, output: path.dirname(protectedSource), ffmpeg, ffprobe,
    transcribe: false, strictInstrumental: false, overwrite: true,
  }, { log() {}, error() {} }), { code: 'SOURCE_OUTPUT_COLLISION' });
  assert.equal(await fs.readFile(protectedSource, 'utf8'), 'different content that must never be decoded');
});
