'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { planFrameTimes, withSampledVideoFrames } = require('../src/video-frames');

const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG || path.resolve(__dirname, '../runtime/ffmpeg/ffmpeg.exe');

test('samples span the full episode, prioritize strong cuts and remain within the cap', () => {
  const frames = planFrameTimes(600, Array.from({ length: 80 }, (_, index) => ({
    time: index * 7 + 1, score: index + 1, kind: 'scene',
  })), 12);
  assert.ok(frames.length <= 12);
  assert.ok(frames[0].time < 15);
  assert.ok(frames.at(-1).time > 560);
  assert.ok(frames.some((frame) => frame.kind === 'scene'));
  assert.deepEqual(frames.map((frame) => frame.time), [...frames.map((frame) => frame.time)].sort((a, b) => a - b));
});

test('short clips avoid duplicate timestamps and cuts outside the playable duration', () => {
  const frames = planFrameTimes(2, [{ time: 0, score: 99 }, { time: 1.9, score: 99 }, { time: 2, score: 100 }], 12);
  assert.ok(frames.length > 0);
  assert.ok(frames.every((frame) => frame.time >= 0 && frame.time < 2));
  assert.equal(new Set(frames.map((frame) => frame.time)).size, frames.length);
});

test('enforces the hard 24-frame maximum even when callers request more', () => {
  const cuts = Array.from({ length: 80 }, (_, index) => ({ time: index * 7 + 1, score: 80 }));
  assert.ok(planFrameTimes(600, cuts, 48).length <= 24);
});

test('extracts bounded low-resolution representative frames and always removes temporary images', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-frame-fixture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'source.mp4');
  const tempRoot = path.join(root, 'tmp');
  await fs.mkdir(tempRoot);
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc=size=1280x720:rate=10:duration=3', '-c:v', 'libvpx-vp9', video], { windowsHide: true });
  const result = await withSampledVideoFrames(video, 3, [{ time: 1, score: 60 }], {
    ffmpeg,
    maxFrames: 3,
    tempRoot,
    async analyze(frames) {
      assert.ok(frames.length <= 3);
      assert.ok(frames.every((frame) => frame.time >= 0 && frame.time < 3));
      const stats = await Promise.all(frames.map((frame) => fs.stat(frame.path)));
      assert.ok(stats.every((stat) => stat.size > 0));
      return frames.length;
    },
  });
  assert.ok(result > 0);
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('cancellation during extraction rejects and removes temporary frames', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-frame-abort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'source.mp4');
  const tempRoot = path.join(root, 'tmp');
  await fs.mkdir(tempRoot);
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc=size=320x240:rate=10:duration=2', '-c:v', 'libvpx-vp9', video], { windowsHide: true });
  const controller = new AbortController();
  await assert.rejects(withSampledVideoFrames(video, 2, [], {
    ffmpeg,
    maxFrames: 4,
    signal: controller.signal,
    tempRoot,
    onProgress() { controller.abort(); },
    analyze() { assert.fail('cancelled analysis must not run'); },
  }), (error) => error.name === 'AbortError' || error.code === 'ABORT_ERR');
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test('cancellation during analysis rejects and removes temporary frames', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-frame-analysis-abort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'source.mp4');
  const tempRoot = path.join(root, 'tmp');
  await fs.mkdir(tempRoot);
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc=size=320x240:rate=10:duration=2', '-c:v', 'libvpx-vp9', video], { windowsHide: true });
  const controller = new AbortController();
  await assert.rejects(withSampledVideoFrames(video, 2, [], {
    ffmpeg,
    maxFrames: 1,
    signal: controller.signal,
    tempRoot,
    analyze(_frames, _directory, signal) {
      assert.equal(signal, controller.signal);
      controller.abort();
      return new Promise((resolve, reject) => signal.addEventListener('abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    },
  }), (error) => error.name === 'AbortError' || error.code === 'ABORT_ERR');
  assert.deepEqual(await fs.readdir(tempRoot), []);
});
