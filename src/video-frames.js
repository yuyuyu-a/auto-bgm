'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_FRAME_LIMIT = 24;
const MIN_FRAME_LIMIT = 1;

function planFrameTimes(duration, sceneCuts = [], maxFrames = 24) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效，无法抽取画面。');
  const limit = Math.max(MIN_FRAME_LIMIT, Math.min(MAX_FRAME_LIMIT, Math.floor(Number(maxFrames) || 24)));
  const cutLimit = Math.floor(limit / 2);
  const uniformCount = limit - cutLimit;
  const margin = Math.min(0.5, duration / (uniformCount * 4));
  const selected = new Map();
  const add = (time, kind, score = 0) => {
    const bounded = Math.max(0, Math.min(duration - Math.min(0.05, duration / 10), time));
    const rounded = Math.round(bounded * 1000) / 1000;
    const existing = selected.get(rounded);
    if (!existing || score > existing.score) selected.set(rounded, { time: rounded, kind, score });
  };

  for (let index = 0; index < uniformCount; index += 1) {
    const fraction = uniformCount === 1 ? 0.5 : index / (uniformCount - 1);
    add(margin + (duration - margin * 2) * fraction, 'interval');
  }

  const cuts = sceneCuts.filter((cut) => Number.isFinite(cut?.time) && cut.time >= 0 && cut.time < duration &&
    ((Number(cut.score) >= 30) || cut.kind === 'black')).sort((a, b) => a.time - b.time);
  if (cutLimit && cuts.length) {
    const count = Math.min(cutLimit, cuts.length);
    for (let index = 0; index < count; index += 1) {
      const cut = cuts[Math.round(index * (cuts.length - 1) / Math.max(1, count - 1))];
      add(cut.time + Math.min(0.4, Math.max(0.05, duration / 1000)), 'scene', Number(cut.score) || 0);
    }
  }
  return [...selected.values()].sort((a, b) => a.time - b.time);
}

function abortError() {
  return Object.assign(new Error('用户已停止画面分析。'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function extractFrame(ffmpeg, videoPath, time, outputPath, signal) {
  signal?.throwIfAborted();
  const child = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', String(time), '-i', videoPath,
    '-frames:v', '1', '-vf', "scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-q:v', '5', outputPath,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(signal?.aborted ? abortError() : error));
    child.once('close', (code) => code === 0 ? resolve() : reject(
      signal?.aborted ? abortError() : new Error(stderr.trim() ? '无法从视频抽取代表画面。' : 'FFmpeg 画面抽取失败。')));
  });
}

async function withSampledVideoFrames(videoPath, duration, sceneCuts, {
  ffmpeg = process.env.FFMPEG || 'ffmpeg',
  maxFrames = 24,
  signal,
  onProgress,
  tempRoot = os.tmpdir(),
  analyze,
} = {}) {
  if (typeof analyze !== 'function') throw new Error('画面分析回调未配置。');
  signal?.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(tempRoot, 'auto-bgm-frames-'));
  try {
    const times = planFrameTimes(duration, sceneCuts, maxFrames);
    const frames = [];
    for (let index = 0; index < times.length; index += 1) {
      signal?.throwIfAborted();
      const sample = times[index];
      const file = path.join(directory, `${String(index + 1).padStart(3, '0')}.jpg`);
      await extractFrame(ffmpeg, videoPath, sample.time, file, signal);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size < 100) throw new Error('FFmpeg 未能生成有效代表画面。');
      frames.push({ time: sample.time, kind: sample.kind, path: file });
      onProgress?.({ completed: index + 1, total: times.length, time: sample.time });
    }
    signal?.throwIfAborted();
    const result = await raceWithAbort(Promise.resolve().then(() => analyze(frames, directory, signal)), signal);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { MAX_FRAME_LIMIT, planFrameTimes, withSampledVideoFrames };
