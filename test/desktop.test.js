'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { checkMusicLibrary, diagnostics, episodeDetail, getInfo, inspectBatch, resolveImport, startBatch, stopBatch } = require('../desktop/backend/batch-service');

test('desktop batch service reads queue and links timeline/transcript artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-desktop-service-'));
  const videos = path.join(root, 'videos');
  const output = path.join(root, 'output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(output)]);
  await fs.writeFile(path.join(videos, '第1集.mp4'), 'placeholder');
  await fs.writeFile(path.join(output, '第1集_timeline.csv'), '\uFEFFepisode,segment,start_sec,end_sec,bgm_file,mood,selection_reason,fade_in_sec,fade_out_sec,duck_db,duck_segments,freeze_tail,freeze_tail_sec\n第1集,1,0,12.5,"默认\\平稳,夜.mp3",默认,"片段对白关键词: 谢谢",2,2,-10,"[{""start"":1,""end"":2}]",2:15,2.6\n', 'utf8');
  await fs.writeFile(path.join(output, '第1集_transcript.json'), JSON.stringify({ segments: [{ start: 1, end: 2, text: '谢谢你' }] }), 'utf8');
  await fs.writeFile(path.join(output, '.mvp-state.json'), JSON.stringify({ episodes: {
    [path.resolve(path.join(videos, '第1集.mp4'))]: {
      status: 'completed', duration: 12.5, outputPath: path.join(output, '第1集_bgm.wav'), timelinePath: path.join(output, '第1集_timeline.csv'), transcriptPath: path.join(output, '第1集_transcript.json'), mood: '默认',
    },
  } }), 'utf8');

  const batch = await inspectBatch({ videos, output, music: '', createAudioClassifier() {} });
  assert.doesNotThrow(() => structuredClone(batch));
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].status, 'completed');
  const detail = await episodeDetail({ output, episode: '第1集' });
  assert.equal(detail.timeline.length, 1);
  assert.equal(detail.timeline[0].duckSegments[0].start, 1);
  assert.equal(detail.freezeTail, '2:15');
  assert.equal(detail.freezeTailSeconds, 2.6);
  assert.equal(detail.transcript[0].text, '谢谢你');
});


test('desktop preflight distinguishes unset, available, creatable, and invalid paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-desktop-preflight-'));
  const videos = path.join(root, 'single.mp4');
  const music = path.join(root, 'music');
  const output = path.join(root, 'new-output');
  const wrongType = path.join(root, 'not-a-directory.txt');
  await Promise.all([fs.mkdir(music), fs.writeFile(videos, 'placeholder'), fs.writeFile(wrongType, 'placeholder')]);

  const available = await inspectBatch({ videos, music, output });
  assert.deepEqual(available.paths.videos, { status: 'available', label: '\u53ef\u7528' });
  assert.deepEqual(available.paths.music, { status: 'available', label: '\u53ef\u7528' });
  assert.deepEqual(available.paths.output, { status: 'available', label: '\u53ef\u521b\u5efa' });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });

  const invalid = await inspectBatch({ videos: wrongType, music: wrongType, output: wrongType, modelPath: wrongType });
  assert.equal(invalid.paths.videos.status, 'unavailable');
  assert.equal(invalid.paths.music.status, 'unavailable');
  assert.equal(invalid.paths.output.status, 'unavailable');
  assert.equal(invalid.model.exists, false);

  const unset = await inspectBatch({ videos: '', music: '', output: '' });
  assert.equal(unset.paths.videos.status, 'unset');
  assert.equal(unset.paths.music.status, 'unset');
  assert.equal(unset.paths.output.status, 'unset');
});

test('desktop batch service can stop a queued run before rendering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-desktop-stop-'));
  const videos = path.join(root, 'videos');
  const music = path.join(root, 'music');
  const output = path.join(root, 'output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(music), fs.mkdir(output)]);

  const events = [];
  await startBatch({ videos, music, output, transcribe: false, overwrite: false }, (event) => events.push(event));
  assert.deepEqual(stopBatch(), { stopped: true });
  for (let attempt = 0; attempt < 50 && !events.some((event) => event.type === 'stopped' || event.type === 'error'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(events.at(-1).type, 'stopped');
  assert.deepEqual(stopBatch(), { stopped: false });
});


test('desktop defaults use packaged model and media-tool paths', () => {
  const developmentInfo = getInfo();
  assert.equal(developmentInfo.defaults.videos, '');
  assert.equal(developmentInfo.defaults.music, '');
  assert.equal(developmentInfo.defaults.modelPath, process.env.FASTER_WHISPER_MODEL || 'small');
  assert.match(developmentInfo.defaults.output, /Documents[\\/]自动配乐[\\/]output$/);
  const info = getInfo({ modelPath: 'C:\\app\\resources\\model\\small', ffmpeg: 'C:\\app\\resources\\ffmpeg\\ffmpeg.exe', ffprobe: 'C:\\app\\resources\\ffmpeg\\ffprobe.exe', transcriberExecutable: 'C:\\app\\resources\\transcriber\\bgm-transcriber.exe' });
  assert.equal(info.bundledRuntime, true);
  assert.equal(info.defaults.modelPath, 'C:\\app\\resources\\model\\small');
  assert.equal(info.defaults.ffmpeg, 'C:\\app\\resources\\ffmpeg\\ffmpeg.exe');
  assert.equal(info.defaults.ffprobe, 'C:\\app\\resources\\ffmpeg\\ffprobe.exe');
  assert.equal(info.defaults.videos, '');
  assert.equal(info.defaults.music, '');
  assert.match(info.defaults.output, /Documents[\\/]自动配乐[\\/]output$/);
  assert.equal(info.defaults.maxTracksPerEpisode, 3);
  assert.equal(info.defaults.minTracksPerEpisode, 1);
  assert.equal(info.defaults.scenePriority, true);
  assert.equal(info.defaults.outputAudio, true);
  assert.equal(info.defaults.outputVideo, true);
  assert.equal(info.defaults.outputTimeline, true);
  assert.equal(info.defaults.outputTranscript, true);
  assert.equal(info.defaults.transitionFadeEnabled, true);
  assert.equal(info.defaults.transitionFadeDuration, 1);
  assert.equal(info.defaults.skipCompleted, true);
  assert.equal('transcriberExecutable' in info.defaults, false);
});

test('preflight counts current inputs and identifies interrupted state after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-preflight-counts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const music = path.join(root, 'music');
  await fs.mkdir(music);
  await fs.writeFile(video, 'placeholder');
  await fs.writeFile(path.join(root, '.mvp-state.json'), JSON.stringify({ episodes: { [video]: { episode: 'episode', status: 'processing', videoPath: video } } }));
  const info = await inspectBatch({ videos: video, music, output: root, transcribe: false });
  assert.equal(info.inputVideoCount, 1);
  assert.equal(info.rows[0].status, 'interrupted');
  assert.match(info.rows[0].error, /继续未完成/);
  assert.equal(typeof info.tools.ffmpeg.available, 'boolean');
  const health = await checkMusicLibrary({ music });
  assert.equal(health.total, 0);
  assert.equal(health.usable, 0);
});

test('drag import identifies media and honours explicit path roles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const track = path.join(root, 'track.wav');
  await Promise.all([fs.writeFile(video, ''), fs.writeFile(track, '')]);
  assert.deepEqual(await resolveImport({ path: video }), { key: 'videos', path: video });
  assert.deepEqual(await resolveImport({ path: track }), { key: 'music', path: root });
  assert.deepEqual(await resolveImport({ path: root, key: 'output' }), { key: 'output', path: root });
  await assert.rejects(resolveImport({ path: video, key: 'modelPath' }), /请拖入对应目录/);
  await assert.rejects(resolveImport({ path: root, key: '__proto__' }), /用途无效/);
});

test('diagnostics omit private paths, names, arbitrary config, and raw errors', async () => {
  const secret = 'PRIVATE_PERSON_video_and_music';
  const text = await diagnostics({ videos: `C:\\Users\\${secret}\\private.mp4`, music: `/home/${secret}/music`, modelPath: `/home/${secret}/model`, unexpected: secret, freezeTail: secret, language: secret });
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('private.mp4'), false);
  const info = JSON.parse(text);
  assert.equal(info.路径配置.videos, true);
  assert.equal(info.转录模型.ready, false);
});

test('concurrent starts share a lock and reload info retains run configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-run-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const config = { videos: root, music: root, output: root, transcribe: false, scenePriority: false };
  const first = startBatch(config, (event) => events.push(event));
  await assert.rejects(startBatch(config), /已有批次/);
  await first;
  assert.equal(getInfo().running, true);
  assert.equal(getInfo().run.config.output, root);
  assert.equal(getInfo().run.config.scenePriority, false);
  assert.equal(getInfo().logs.length, 1);
  stopBatch();
  for (let n = 0; n < 100 && getInfo().running; n += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getInfo().running, false);
  assert.equal(getInfo().run.status, 'stopped');
  assert.equal(events.at(-1).type, 'stopped');
});

test('desktop batch settings reject invalid BGM caps and empty output selection', async () => {
  const base = { videos: 'videos', music: 'music', output: 'output', transcribe: false };
  await assert.rejects(startBatch({ ...base, minTracksPerEpisode: 0 }, () => {}), /每集 BGM 下限必须是正整数/);
  await assert.rejects(startBatch({ ...base, scenePriority: false, minTracksPerEpisode: 3, maxTracksPerEpisode: 2 }, () => {}), /每集 BGM 下限不能高于上限/);
  await assert.rejects(startBatch({ ...base, maxTracksPerEpisode: 2.5 }, () => {}), /每集 BGM 上限必须是非负整数/);
  await assert.rejects(startBatch({ ...base, transitionFadeEnabled: 'false' }, () => {}), /曲目衔接淡入淡出必须使用开关值/);
  await assert.rejects(startBatch({ ...base, scenePriority: 'false' }, () => {}), /转场必换曲必须使用开关值/);
  await assert.rejects(startBatch({ ...base, skipCompleted: 'false' }, () => {}), /跳过已完成必须使用开关值/);
  await assert.rejects(startBatch({ ...base, transitionFadeDuration: -0.1 }, () => {}), /曲目衔接时长必须是非负数字/);
  await assert.rejects(startBatch({ ...base, transitionFadeDuration: 'invalid' }, () => {}), /曲目衔接时长必须是非负数字/);
  await assert.rejects(startBatch({ ...base, transitionFadeDuration: null }, () => {}), /曲目衔接时长必须是非负数字/);
  await assert.rejects(startBatch({ ...base, maxTracksPerEpisode: 2, outputAudio: false, outputVideo: false, outputTimeline: false, outputTranscript: false }, () => {}), /请至少选择一种输出内容/);
  await assert.rejects(startBatch({ ...base, outputAudio: false, outputVideo: false, outputTimeline: false, outputTranscript: true }, () => {}), /开启本地转录/);
});

test('custom music limits accept arbitrary integer values and keep invalid values actionable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-custom-limit-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { videos: root, music: root, output: path.join(root, 'output'),
    transcribe: false, scenePriority: false, minTracksPerEpisode: 1 };
  for (const maximum of [17, 137, 0]) {
    const info = await inspectBatch({ ...base, maxTracksPerEpisode: maximum });
    assert.equal(info.validationError, '');
    assert.equal(info.config.maxTracksPerEpisode, maximum);
    assert.equal(info.config.scenePriority, false);
  }
  for (const maximum of ['', -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.match((await inspectBatch({ ...base, maxTracksPerEpisode: maximum })).validationError, /上限.*非负整数/);
  }
  assert.match((await inspectBatch({ ...base, minTracksPerEpisode: 18, maxTracksPerEpisode: 17 })).validationError,
    /下限不能高于上限/);
});

test('continuous track duration defaults to 40 and preflight normalizes finite nonnegative seconds', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-track-duration-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { videos: root, music: root, output: path.join(root, 'output'), transcribe: false };
  assert.equal(getInfo().defaults.maxTrackDuration, 40);
  for (const [input, expected] of [[undefined, 40], [0, 0], ['0', 0], [37.5, 37.5], [' 37.5 ', 37.5], ['1e2', 100]]) {
    const info = await inspectBatch({ ...base, maxTrackDuration: input });
    assert.equal(info.validationError, '', `valid duration ${String(input)}`);
    assert.equal(info.config.maxTrackDuration, expected);
    assert.equal(typeof info.config.maxTrackDuration, 'number');
  }
  assert.equal((await inspectBatch(base)).config.maxTrackDuration, 40);
  await assert.rejects(fs.stat(base.output), { code: 'ENOENT' });
});

test('continuous track duration rejects coercible blanks, booleans and invalid numbers before a batch starts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-track-duration-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { videos: root, music: root, output: path.join(root, 'output'), transcribe: false };
  for (const value of ['', ' \t ', null, true, false, -1, '-0.1', Infinity, -Infinity, NaN, 'Infinity', '40 seconds', [], {}]) {
    const input = { ...base, maxTrackDuration: value };
    assert.match((await inspectBatch(input)).validationError, /单曲.*时长.*非负数字/, `invalid duration ${String(value)}`);
    const events = [];
    await assert.rejects(startBatch(input, (event) => events.push(event)), /单曲.*时长.*非负数字/);
    assert.equal(events.length, 0);
    assert.equal(getInfo().running, false);
  }
  await assert.rejects(fs.stat(base.output), { code: 'ENOENT' });
});

test('continuous track duration reaches started batches and restored run configuration as a number', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-track-duration-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = { videos: root, music: root, output: root, transcribe: false, skipCompleted: true, overwrite: false };
  for (const [input, expected] of [[undefined, 40], ['0', 0], [' 37.5 ', 37.5]]) {
    const events = [];
    await startBatch({ ...base, maxTrackDuration: input }, (event) => events.push(event));
    stopBatch();
    for (let attempt = 0; attempt < 100 && getInfo().running; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(getInfo().running, false);
    assert.equal(events.at(-1).type, 'stopped');
    const config = events.find((event) => event.type === 'started').config;
    assert.equal(config.maxTrackDuration, expected);
    assert.equal(getInfo().run.config.maxTrackDuration, expected);
    assert.equal(config.skipCompleted, true);
    assert.equal(config.overwrite, false);
  }
});

test('continuous track duration diagnostics expose numeric seconds without leaking invalid input', async () => {
  for (const [input, expected] of [[undefined, 40], [0, 0], [' 37.5 ', 37.5], ['', '未设置'], [null, '未设置'], [false, '未设置'], [-1, '未设置'], ['PRIVATE_DURATION_SECRET', '未设置']]) {
    const text = await diagnostics({ maxTrackDuration: input, apiKey: 'PRIVATE_API_SECRET' });
    assert.equal(JSON.parse(text).配置摘要.maxTrackDuration, expected);
    assert.doesNotMatch(text, /PRIVATE_DURATION_SECRET|PRIVATE_API_SECRET|apiKey/);
  }
});

test('story desktop preflight enables local transcription and returns cloneable public readiness only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storyPath = path.join(root, 'episode.md');
  await fs.writeFile(storyPath, 'PRIVATE_STORY');
  await fs.writeFile(path.join(root, 'model.bin'), 'model fixture');
  const input = { videos: root, music: root, output: root, storyEnabled: true, storyPath, modelPath: root,
    transcribe: false, createStoryPlan() {}, storyAIProfile: { baseUrl: 'https://model.example/v1', model: 'director', apiKey: 'PRIVATE_SECRET' },
    apiKey: 'PRIVATE_SECRET', arbitraryRuntimeSecret: 'PRIVATE_SECRET' };
  const info = await inspectBatch(input);
  assert.equal(info.validationError, '');
  assert.equal(info.config.storyEnabled, true);
  assert.equal(info.config.transcribe, true);
  assert.equal(info.story.ready, true);
  assert.equal(info.story.enabled, true);
  assert.deepEqual(info.story.profile, { baseUrl: 'https://model.example/v1', model: 'director' });
  assert.equal(info.paths.storyPath.status, 'available');
  assert.doesNotThrow(() => structuredClone(info));
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE_SECRET|PRIVATE_STORY|apiKey|createStoryPlan|arbitraryRuntimeSecret/);
  const missingCallback = await inspectBatch({ ...input, createStoryPlan: undefined });
  assert.equal(missingCallback.story.ready, false);
  assert.match(missingCallback.validationError, /剧情.*模型|模型.*配置/);
  const directory = await inspectBatch({ ...input, storyPath: root });
  assert.equal(directory.paths.storyPath.status, 'available');
  const missing = await inspectBatch({ ...input, storyPath: path.join(root, 'missing.md') });
  assert.equal(missing.paths.storyPath.status, 'unavailable');
  assert.match(missing.validationError, /剧本|剧情/);
});

test('story desktop start rejects invalid switches, unavailable documents and missing runtime callbacks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storyPath = path.join(root, 'episode.md');
  await fs.writeFile(storyPath, 'story');
  const base = { videos: root, music: root, output: root, modelPath: root, storyEnabled: true, storyPath };
  await assert.rejects(startBatch({ ...base, storyEnabled: 'true' }, () => {}), /剧情.*开关/);
  await assert.rejects(startBatch(base, () => {}), /剧情.*模型|模型.*配置/);
  await assert.rejects(startBatch({ ...base, storyPath: '' }, () => {}, { createStoryPlan() {} }), /剧本|剧情/);
  await assert.rejects(startBatch({ ...base, storyPath: path.join(root, 'missing.md') }, () => {}, { createStoryPlan() {} }), /剧本|剧情/);
  assert.equal(getInfo().running, false);
});

test('local visual batch requires one exclusive mode, a valid SRT source, and verified model assets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-local-visual-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const subtitle = path.join(root, 'episode.srt');
  const music = path.join(root, 'music');
  await Promise.all([
    fs.writeFile(video, 'video'),
    fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello.\n'),
    fs.mkdir(music),
  ]);
  const base = { videos: video, music, output: path.join(root, 'output'), transcribe: false,
    localVisionEnabled: true, localSubtitlePath: subtitle, storyPath: music,
    createLocalVisionPlan: async () => ({}) };
  await assert.rejects(startBatch({ ...base, storyEnabled: true }, () => {}, {
    createStoryPlan: async () => ({}), localVisionStatus: { ready: true },
  }), /只能选择一种模式/);
  await assert.rejects(startBatch(base, () => {}, { localVisionStatus: { ready: false } }), /本地画面.*模型|模型.*下载/);
  await assert.rejects(startBatch({ ...base, localSubtitlePath: path.join(root, 'missing.srt') }, () => {}, {
    localVisionStatus: { ready: true },
  }), /SRT 字幕路径不可访问/);
  await assert.rejects(startBatch({ ...base, createLocalVisionPlan: undefined }, () => {}, {
    localVisionStatus: { ready: true },
  }), /本地画面.*模型未配置/);
  assert.equal(getInfo().running, false);
});

test('local visual preflight exposes only sanitized model readiness and subtitle availability', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-local-visual-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const subtitle = path.join(root, 'episode.srt');
  await fs.writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello.\n');
  const info = await inspectBatch({
    videos: root, music: root, output: root, localVisionEnabled: true, localSubtitlePath: subtitle,
    createLocalVisionPlan() {},
    localVisionStatus: { ready: false, modelBytes: 512, backend: 'cpu', root: 'PRIVATE_MODEL_PATH', prompt: 'PRIVATE_PROMPT' },
  });
  assert.equal(info.paths.localSubtitlePath.status, 'available');
  assert.deepEqual(info.localVision, { enabled: true, ready: false, modelBytes: 512, backend: 'cpu' });
  assert.doesNotMatch(JSON.stringify(info.localVision), /PRIVATE_MODEL_PATH|PRIVATE_PROMPT/);
  assert.match(info.validationError, /本地画面配乐模型/);
  const diagnosticsText = await diagnostics({ localVisionEnabled: true, localSubtitlePath: 'PRIVATE_SUBTITLE_PATH' });
  assert.match(diagnosticsText, /localVisionEnabled/);
  assert.doesNotMatch(diagnosticsText, /PRIVATE_SUBTITLE_PATH|PRIVATE_MODEL_PATH|PRIVATE_PROMPT/);
});

test('story drag import accepts documents and directories only in the explicit story role', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storyPath = path.join(root, 'episode.md');
  const video = path.join(root, 'episode.mp4');
  await Promise.all([fs.writeFile(storyPath, 'story'), fs.writeFile(video, 'placeholder')]);
  assert.deepEqual(await resolveImport({ path: storyPath, key: 'storyPath' }), { key: 'storyPath', path: storyPath });
  assert.deepEqual(await resolveImport({ path: root, key: 'storyPath' }), { key: 'storyPath', path: root });
  await assert.rejects(resolveImport({ path: video, key: 'storyPath' }), /对应目录|剧本/);
});
