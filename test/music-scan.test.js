'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inferMood, scanMusic } = require('../src/mvp');

async function libraryFixture(t, names) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-music-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of names) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'scan fixture');
  }
  return root;
}

test('recursive music scan preserves root and flat categories and supported extensions', async (t) => {
  const root = await libraryFixture(t, [
    'root.MP3', '默认/calm.wav', '紧张/chase.m4a',
    '紧张/action.aac', '紧张/pulse.flac', '紧张/drums.ogg',
    '紧张/beat.opus', '紧张/notes.txt', 'cover.jpg',
  ]);
  const groups = await scanMusic(root);
  assert.deepEqual(groups.get('默认'), [path.join(root, '默认/calm.wav'), path.join(root, 'root.MP3')]);
  assert.equal(groups.get('紧张').length, 5);
  assert.equal([...groups.values()].flat().length, 7);
  assert.ok([...groups.values()].flat().every((file) => !/\.(txt|jpg)$/.test(file)));
});

test('recursive music scan finds deep albums and inherits their mood category', async (t) => {
  const root = await libraryFixture(t, [
    '紧张/tone10.wav', '紧张/合集/tone2.wav',
    '紧张/合集/第二辑/tone1.wav', '默认/日常/calm.mp3',
  ]);
  const groups = await scanMusic(root);
  assert.deepEqual(groups.get('紧张'), [
    path.join(root, '紧张/合集/第二辑/tone1.wav'),
    path.join(root, '紧张/合集/tone2.wav'),
    path.join(root, '紧张/tone10.wav'),
  ]);
  assert.deepEqual(groups.get('默认'), [path.join(root, '默认/日常/calm.mp3')]);
  assert.equal(groups.has('合集'), false);
  assert.equal(groups.has('第二辑'), false);
});

test('recursive music scan recognizes moods below collection wrappers and deeper overrides', async (t) => {
  const root = await libraryFixture(t, [
    '音乐合集/紧张/追逐/chase.wav', '音乐合集/悬疑/mystery.wav',
    '紧张/伤感/离别/sad.wav', '另一合集/悲伤/钢琴/piano.wav',
    '音乐合集/默认/日常/calm.wav',
  ]);
  const groups = await scanMusic(root);
  assert.deepEqual([...groups.keys()].sort(), ['离别', '默认', '悲伤', '紧张', '悬疑'].sort());
  assert.deepEqual(groups.get('紧张'), [path.join(root, '音乐合集/紧张/追逐/chase.wav')]);
  assert.deepEqual(groups.get('离别'), [path.join(root, '紧张/伤感/离别/sad.wav')]);
  assert.deepEqual(groups.get('悲伤'), [path.join(root, '另一合集/悲伤/钢琴/piano.wav')]);
  assert.equal(inferMood({ segments: [{ text: '危险，快跑，救命！' }] }, groups).mood, '紧张');
  assert.equal(inferMood({ segments: [] }, groups).mood, '默认');
});

test('recursive music scan retains custom first-level labels and same-name files with stable ordering', async (t) => {
  const root = await libraryFixture(t, [
    '史诗氛围/album10/same.wav', '史诗氛围/album2/same.wav',
    '史诗氛围/album2/deeper/theme.wav', '史诗氛围/direct.wav',
  ]);
  const expected = [
    path.join(root, '史诗氛围/direct.wav'),
    path.join(root, '史诗氛围/album2/same.wav'),
    path.join(root, '史诗氛围/album10/same.wav'),
    path.join(root, '史诗氛围/album2/deeper/theme.wav'),
  ];
  assert.deepEqual((await scanMusic(root)).get('史诗氛围'), expected);
  assert.deepEqual((await scanMusic(root)).get('史诗氛围'), expected);
});

test('recursive music scan ignores directory links and cycles instead of leaving the library', async (t) => {
  const parent = await libraryFixture(t, ['music/紧张/合集/inside.wav', 'outside/outside.wav']);
  const root = path.join(parent, 'music');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(root, path.join(root, '紧张/loop'), type);
  await fs.symlink(path.join(parent, 'outside'), path.join(root, 'external'), type);
  const groups = await scanMusic(root);
  assert.deepEqual([...groups], [['紧张', [path.join(root, '紧张/合集/inside.wav')]]]);
});

test('recursive music scan still rejects an audio-empty nested tree', async (t) => {
  const root = await libraryFixture(t, ['合集/紧张/说明.txt']);
  await assert.rejects(scanMusic(root), /BGM 目录没有找到音频文件/);
});
