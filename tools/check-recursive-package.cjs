'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const repository = path.resolve(__dirname, '..');
  const resources = path.join(repository, 'release/win-unpacked/resources');
  const source = path.join(resources, 'app.asar');
  for (const file of ['src/mvp.js', 'desktop/backend/batch-service.js']) {
    assert.equal(await fs.readFile(path.join(source, file), 'utf8'),
      await fs.readFile(path.join(repository, file), 'utf8'), `Packaged source mismatch: ${file}`);
  }
  assert.equal(Boolean(require(path.join(source, 'package.json')).bgmPreview),
    !process.argv.includes('--release'));
  const { scanMusic, runBatch } = require(path.join(source, 'src/mvp'));
  const { checkMusicLibrary, inspectBatch, resolveImport, reviewMusicTrack } = require(path.join(source, 'desktop/backend/batch-service'));
  const root = await fs.mkdtemp(path.join(repository, 'build/recursive-package-verified-'));
  const music = path.join(root, 'music');
  const album = path.join(music, '音乐合集', '紧张', '专辑', '第三层');
  const transcripts = path.join(root, 'transcripts');
  await fs.mkdir(album, { recursive: true });
  await fs.mkdir(path.join(music, '空情绪', '空合集'), { recursive: true });
  await fs.mkdir(transcripts);
  const track = path.join(album, 'confirmed.wav');
  const disabled = path.join(album, 'disabled.wav');
  const video = path.join(root, 'episode.mp4');
  const storyPath = path.join(root, 'episode.md');
  const ffmpeg = path.join(resources, 'ffmpeg/ffmpeg.exe');
  const ffprobe = path.join(resources, 'ffmpeg/ffprobe.exe');
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', track], { windowsHide: true });
  await fs.copyFile(track, disabled);
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=160x120:r=25:d=2.5',
    '-c:v', 'mpeg4', video], { windowsHide: true });
  await fs.writeFile(storyPath, 'A threat escalates; then a deliberate pause.');
  await fs.writeFile(path.join(transcripts, 'episode.json'), JSON.stringify({ segments: [
    { start: 0, end: 1, text: 'We are running out of time.' },
    { start: 1.25, end: 2, text: 'Wait.' },
  ] }));
  assert.deepEqual([...await scanMusic(music)], [['紧张', [track, disabled]]]);
  const options = { videos: video, music, output: path.join(root, 'output'), transcripts,
    libraryCacheDir: path.join(root, 'cache'), ffmpeg, ffprobe, strictInstrumental: true,
    transcribe: false, scenePriority: false, minTracksPerEpisode: 1, fadeIn: 0, fadeOut: 0 };
  assert.deepEqual((await inspectBatch(options)).musicGroups, [{ mood: '紧张', count: 2 }]);
  assert.deepEqual(await resolveImport({ path: music }), { key: 'music', path: music });
  const initial = await checkMusicLibrary(options);
  assert.equal(initial.total, 2);
  assert.equal(initial.usable, 0);
  assert.deepEqual(initial.emptyDirectories, ['空情绪']);
  await reviewMusicTrack({ ...options, file: track, action: 'confirm' });
  await reviewMusicTrack({ ...options, file: disabled, action: 'disable' });
  const reviewed = await checkMusicLibrary(options);
  assert.equal(reviewed.usable, 1);
  let calls = 0;
  const summary = await runBatch({ ...options, storyEnabled: true, storyPath,
    createStoryPlan: async ({ groups }) => {
      calls += 1;
      assert.deepEqual([...groups], [['紧张', [track]]]);
      return { summary: 'A threat followed by silence.', alignmentConfidence: 0.95, cues: [
        { startSegment: 0, mood: '紧张', intensity: 3, reason: 'A sustained threat.', confidence: 0.9, review: false },
        { startSegment: 1, mood: null, intensity: 1, reason: 'A deliberate pause.', confidence: 0.9, review: false },
      ] };
    },
  }, { log() {}, error() {} });
  assert.equal(summary.completed, 1, JSON.stringify(summary.results));
  assert.equal(calls, 1);
  const result = summary.results[0];
  assert.deepEqual(result.tracks, [track, null]);
  await execute(ffmpeg, ['-v', 'error', '-i', result.finalVideoPath, '-f', 'null', '-'], { windowsHide: true });
  const audio = async (start) => (await execute(ffmpeg, ['-v', 'error', '-ss', String(start),
    '-i', result.outputPath, '-t', '0.2', '-f', 's16le', '-ac', '1', '-'],
  { windowsHide: true, encoding: 'buffer' })).stdout;
  const score = await audio(0.3);
  const silence = await audio(1.5);
  assert.ok(score.length > 0 && score.some((byte) => byte !== 0));
  assert.ok(silence.length > 0 && silence.every((byte) => byte === 0));
  console.log('PACKAGED_RECURSIVE_OK', JSON.stringify({
    tracksFound: initial.total, usableAfterReview: reviewed.usable, sourceParity: true,
    nestedDepth: 4, storyCategoriesVerified: true, silenceSamplesZero: true,
    finalVideoPath: result.finalVideoPath,
  }));
  app.exit(0);
}).catch((error) => {
  console.error('PACKAGED_RECURSIVE_FAILED', error);
  app.exit(1);
});
