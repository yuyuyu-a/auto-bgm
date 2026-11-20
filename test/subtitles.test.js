'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { findSubtitleForVideo, parseSrt } = require('../src/subtitles');

test('parses BOM, CRLF, hours, fractional timestamps and multiline cues without moving timings', () => {
  const result = parseSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:02,500\r\n<i>Hello</i>\r\nmy friend\r\n\r\n2\r\n01:02:03.125 --> 01:02:04.5\r\n- Wait!\r\n', 4000);
  assert.deepEqual(result, { segments: [
    { start: 1.25, end: 2.5, text: 'Hello my friend' },
    { start: 3723.125, end: 3724.5, text: '- Wait!' },
  ], language: null });
});

test('preserves duplicate and overlapping dialogue cues while requiring ordered starts', () => {
  const result = parseSrt('1\n00:00:01,000 --> 00:00:03,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond\n\n3\n00:00:02,500 --> 00:00:04,000\nThird', 5);
  assert.deepEqual(result.segments.map(({ start, end }) => [start, end]), [[1, 3], [1, 2], [2.5, 4]]);
  assert.throws(() => parseSrt('1\n00:00:03,000 --> 00:00:04,000\nLate\n\n2\n00:00:02,000 --> 00:00:03,000\nEarly', 5), /顺序/);
});

test('rejects malformed, reversed, empty, or out-of-duration subtitles instead of dropping cues', () => {
  for (const value of [
    'not an SRT cue',
    '1\n00:00:AA,000 --> 00:00:02,000\nText',
    '1\n00:00:03,000 --> 00:00:02,000\nText',
    '1\n00:00:01,000 --> 00:00:02,000\n',
    '',
  ]) assert.throws(() => parseSrt(value, 10), /字幕|SRT|时间|为空/);
  assert.throws(() => parseSrt('1\n00:00:09,900 --> 00:00:10,100\nText', 10), /时长/);
});

test('pairs SRT files by exact episode basename and accepts one direct file only for one video', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-srt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'Episode 01.mp4');
  const srt = path.join(root, 'Episode 01.srt');
  await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:02,000\nHello');
  const fromFile = await findSubtitleForVideo(video, srt, 1, 4);
  assert.equal(fromFile.path, srt);
  assert.equal(fromFile.source, 'srt');
  assert.equal(fromFile.contentSha256, createHash('sha256').update(await fs.readFile(srt)).digest('hex'));
  assert.equal(fromFile.segments[0].text, 'Hello');
  assert.deepEqual(await findSubtitleForVideo(video, root, 2, 4), fromFile);
  await assert.rejects(findSubtitleForVideo(video, srt, 2, 4), /单个视频/);
});

test('rejects missing and ambiguous basename matches', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-srt-pair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  await assert.rejects(findSubtitleForVideo(video, root, 1, 10), /找不到/);
  await fs.mkdir(path.join(root, 'first'));
  await fs.mkdir(path.join(root, 'second'));
  await fs.writeFile(path.join(root, 'first', 'episode.srt'), '1\n00:00:01,000 --> 00:00:02,000\nA');
  await fs.writeFile(path.join(root, 'second', 'episode.srt'), '1\n00:00:01,000 --> 00:00:02,000\nB');
  await assert.rejects(findSubtitleForVideo(video, root, 1, 10), /多个|歧义/);
});
