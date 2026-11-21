'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  buildVisionRequest,
  createLocalVisionPlanner,
  detectVisionBackend,
  normalizeVisionPlan,
} = require('../src/local-vision-runtime');
const { parseSrt } = require('../src/subtitles');

function context(overrides = {}) {
  return {
    duration: 12,
    transcript: { segments: [
      { start: 0, end: 2, text: '谁在门外？' },
      { start: 4, end: 6, text: '我听见脚步声。' },
      { start: 9, end: 11, text: '原来是你。' },
    ] },
    groups: new Map([['悬疑', ['mystery.wav']], ['温情', ['warm.wav']]]),
    frames: [
      { time: 1, path: 'frame-one.jpg' },
      { time: 10, path: 'frame-two.jpg' },
    ],
    ...overrides,
  };
}

const rawPlan = {
  summary: '门外出现未知人物，随后确认是熟悉的人。',
  alignmentConfidence: 0.9,
  cues: [
    { startSegment: 0, mood: '悬疑', intensity: 2, confidence: 0.9, reason: '画面与对白共同建立未明威胁。', sceneDescription: '门外有人影。', dramaticIntent: '建立未知威胁。', evidence: { frameTimes: [1], subtitleIndices: [0, 1] } },
    { startSegment: 2, mood: '温情', intensity: 1, confidence: 0.8, reason: '人物确认后冲突解除。', sceneDescription: '熟人进入画面。', dramaticIntent: '解除误会。', evidence: { frameTimes: [10], subtitleIndices: [2] } },
  ],
};

const modelFileHashes = {
  'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf': 'a'.repeat(64),
  'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf': 'b'.repeat(64),
};

test('validates local cues against exact subtitle anchors, sampled frames, and screened categories', () => {
  const result = normalizeVisionPlan(rawPlan, context());
  assert.deepEqual(result.cues.map((cue) => [cue.startSegment, cue.mood]), [[0, '悬疑'], [2, '温情']]);
  assert.equal(result.cues[1].review, false);
  assert.deepEqual(result.cues[1].evidence.frameTimes, [10]);
});

test('rebuilds model-generated evidence from sampled frames and subtitles when its references are invalid', () => {
  const inaccurateEvidence = structuredClone(rawPlan);
  inaccurateEvidence.cues[0].evidence = { frameTimes: [7], subtitleIndices: [99] };
  inaccurateEvidence.cues[1].evidence = { frameTimes: [1], subtitleIndices: [0] };

  const result = normalizeVisionPlan(inaccurateEvidence, context());

  assert.deepEqual(result.cues.map(({ evidence }) => evidence), [
    { frameTimes: [1], subtitleIndices: [0, 1] },
    { frameTimes: [10], subtitleIndices: [2] },
  ]);
});

test('rejects invalid anchors, unscreened music, null silence, and invalid confidence', () => {
  const invalidPlans = [
    { ...rawPlan, cues: [{ ...rawPlan.cues[0], startSegment: 12 }] },
    { ...rawPlan, cues: [{ ...rawPlan.cues[0], mood: '任意曲库' }] },
    { ...rawPlan, cues: [{ ...rawPlan.cues[0], mood: null }] },
    { ...rawPlan, cues: [{ ...rawPlan.cues[0], confidence: 2 }] },
    { ...rawPlan, cues: [rawPlan.cues[0], { ...rawPlan.cues[1], startSegment: 0 }] },
  ];
  for (const plan of invalidPlans) assert.throws(() => normalizeVisionPlan(plan, context()), /画面|字幕|曲库|音乐|时间|依据|置信|锚点/);
  assert.throws(() => normalizeVisionPlan(rawPlan, context({ allowedFrameTimes: [] })),
    /本地画面配乐依据必须对应当前音乐段内的实际抽帧时刻和字幕索引/);
});

test('requires scene intent and confidence, and marks uncertain cues for review', () => {
  const uncertain = structuredClone(rawPlan);
  uncertain.cues[0].confidence = 0.4;
  const result = normalizeVisionPlan(uncertain, context());
  assert.equal(result.cues[0].review, true);
  assert.equal(result.cues[0].start, 0);
  assert.equal(result.cues[0].sceneDescription, '门外有人影。');
  assert.throws(() => normalizeVisionPlan({
    ...rawPlan,
    cues: [{ ...rawPlan.cues[0], dramaticIntent: '' }],
  }, context()), /画面|剧情|依据/);
});

test('local prompt contains only nearby indexed subtitle cues and in-memory image data, never file paths', async () => {
  const request = await buildVisionRequest(context(), async (file) => Buffer.from(file === 'frame-one.jpg' ? 'frame one bytes' : 'frame two bytes'));
  const text = request.messages[1].content[0].text;
  assert.match(text, /"id":0/);
  assert.match(text, /"id":2/);
  assert.match(text, /可用曲库类别/);
  assert.doesNotMatch(text, /frame-one\.jpg|frame-two\.jpg/);
  assert.equal(request.messages[1].content.filter((item) => item.type === 'image_url').length, 2);
  assert.match(request.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('selects Vulkan when an installed build reports a usable GPU and otherwise selects CPU', async () => {
  const selected = await detectVisionBackend({
    runtimeServers: { cpu: 'cpu/llama-server.exe', vulkan: 'vulkan/llama-server.exe' },
    async execFileImpl() { return { stdout: 'Available devices:\nVulkan0: NVIDIA GeForce RTX 4060\n', stderr: '' }; },
  });
  assert.equal(selected.variant, 'vulkan');
  assert.equal(selected.device, 'Vulkan0');
  const fallback = await detectVisionBackend({
    runtimeServers: { cpu: 'cpu/llama-server.exe', vulkan: 'vulkan/llama-server.exe' },
    async execFileImpl() { throw new Error('No Vulkan devices'); },
  });
  assert.equal(fallback.variant, 'cpu');
  assert.equal(fallback.gpu, false);
});

test('uses loopback-only inference, retries CPU after GPU startup failure, and stops the child', async () => {
  const started = [];
  const children = [];
  const progress = [];
  const child = () => {
    const value = new EventEmitter();
    value.kill = () => { value.killed = true; value.emit('exit', 0, null); return true; };
    children.push(value);
    return value;
  };
  let gpuHealthChecks = 0;
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    verifyAssets: async () => ({ manifest: { runtimeServers: {
      cpu: 'cpu/llama-server.exe', vulkan: 'vulkan/llama-server.exe',
    }, modelFileHashes } }),
    async execFileImpl() { return { stdout: 'Vulkan0: NVIDIA GPU', stderr: '' }; },
    spawnImpl(executable, args) { started.push({ executable, args }); return child(); },
    serverStartTimeoutMs: 18,
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url, options = {}) {
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.equal(options.redirect, 'error');
      if (url.endsWith('/health')) {
        if (started.at(-1)?.args.includes('Vulkan0')) {
          gpuHealthChecks += 1;
          return new Response('', { status: 503 });
        }
        return new Response('', { status: 200 });
      }
      const body = JSON.parse(options.body);
      assert.equal(body.messages[1].content.filter((part) => part.type === 'image_url').length, 2);
      return Response.json({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] });
    },
  });
  const result = await planner.plan(context({ onProgress: (event) => progress.push(event) }));
  assert.equal(result.cues.length, 2);
  assert.ok(gpuHealthChecks > 0);
  assert.equal(started.length, 2);
  assert.equal(started[0].args.includes('Vulkan0'), true);
  assert.equal(started[1].args.includes('0'), true);
  assert.ok(progress.some((event) => event.stage === 'vision-ready'));
  assert.ok(progress.some((event) => event.stage === 'analyzing-vision'));
  assert.ok(progress.some((event) => event.stage === 'vision-completed'));
  await planner.dispose();
  assert.ok(children.every((process) => process.killed));
});

test('uses one music anchor for English and Chinese subtitles with the same timestamp', async () => {
  const children = [];
  const requests = [];
  const transcript = parseSrt([
    '1\n00:00:00,000 --> 00:00:01,300\nTwenty minutes later',
    '2\n00:00:02,000 --> 00:00:03,000\nVivienne walked in',
    '3\n00:00:04,000 --> 00:00:05,000\nI laughed',
    '1\n00:00:00,000 --> 00:00:01,300\n二十分钟后',
    '2\n00:00:02,000 --> 00:00:03,000\n薇薇安走了进来',
    '3\n00:00:04,000 --> 00:00:05,000\n我笑了',
  ].join('\n\n'), 6);
  const episode = context({
    duration: 6,
    transcript,
    frames: [0.5, 2.5, 4.5].map((time, index) => ({ time, path: `frame-${index}.jpg` })),
  });
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    platform: 'linux',
    verifyAssets: async () => ({ manifest: {
      runtimeServers: { cpu: 'cpu/llama-server' }, modelFileHashes,
    } }),
    spawnImpl() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
      children.push(child);
      return child;
    },
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url, options = {}) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      const body = JSON.parse(options.body);
      const data = JSON.parse(body.messages[1].content[0].text.split('可用信息：\n')[1]);
      requests.push(data);
      const anchors = data.requirements.allowedStartSegments;
      const cues = anchors.map((anchor, index) => {
        const nextAnchor = anchors[index + 1];
        const nextStart = Number.isSafeInteger(nextAnchor)
          ? transcript.segments[nextAnchor].start
          : episode.duration;
        const frameTime = data.requirements.frameTimes.find((time) =>
          time >= transcript.segments[anchor].start && time < nextStart);
        return {
          startSegment: anchor, mood: '温情', intensity: 1, confidence: 0.9,
          reason: '画面与对白表现人物关系。', sceneDescription: '人物在画面中交谈。',
          dramaticIntent: '延续人物关系。',
          evidence: {
            frameTimes: [frameTime ?? data.requirements.frameTimes[0]],
            subtitleIndices: data.subtitles
              .filter(({ id }) => id >= anchor && (!Number.isSafeInteger(nextAnchor) || id < nextAnchor))
              .map(({ id }) => id),
          },
        };
      });
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: '按双语字幕时间点划分剧情。',
        alignmentConfidence: 0.9,
        cues,
      }) } }] });
    },
  });

  const result = await planner.plan(episode);
  await planner.dispose();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].requirements.allowedStartSegments, [0, 2, 4]);
  assert.deepEqual(result.cues.map(({ startSegment }) => startSegment), [0, 2, 4]);
  assert.deepEqual(result.cues.map(({ evidence }) => evidence.subtitleIndices), [
    [0, 1], [2, 3], [4, 5],
  ]);
  assert.ok(children.every((child) => child.killed));
});

test('splits long visual analysis into bounded requests and merges global subtitle anchors', async () => {
  const children = [];
  const requests = [];
  const segments = Array.from({ length: 10 }, (_, index) => ({
    start: index + 0.1, end: index + 0.4, text: `字幕 ${index}`,
  }));
  const episode = context({
    duration: 10,
    transcript: { segments },
    frames: Array.from({ length: 10 }, (_, index) => ({
      time: index + 0.5, path: `frame-${index}.jpg`,
    })),
  });
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    platform: 'linux',
    verifyAssets: async () => ({ manifest: {
      runtimeServers: { cpu: 'cpu/llama-server' }, modelFileHashes,
    } }),
    spawnImpl() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
      children.push(child);
      return child;
    },
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url, options = {}) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      const body = JSON.parse(options.body);
      const requestText = body.messages[1].content[0].text;
      const data = JSON.parse(requestText.split('可用信息：\n')[1]);
      requests.push(data);
      const anchor = data.requirements.allowedStartSegments[0];
      const frameTime = data.sampledFrameTimes.find((time) => time >= segments[anchor].start);
      assert.notEqual(frameTime, undefined);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: `第 ${anchor} 段`,
        alignmentConfidence: 0.9,
        cues: [{
          startSegment: anchor, mood: '温情', intensity: 2, confidence: 0.9,
          reason: '画面和对白呈现持续的温情。', sceneDescription: '人物在画面中交谈。',
          dramaticIntent: '延续人物关系。',
          evidence: { frameTimes: [frameTime], subtitleIndices: [anchor] },
        }],
      }) } }] });
    },
  });

  const result = await planner.plan(episode);
  await planner.dispose();
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.sampledFrameTimes.length <= 4));
  assert.deepEqual(requests.map((request) => request.requirements.frameTimes.length), [4, 3, 3]);
  assert.equal(requests[1].sampledFrameTimes[0], requests[0].sampledFrameTimes.at(-1));
  assert.ok(!requests[1].requirements.frameTimes.includes(requests[1].sampledFrameTimes[0]));
  assert.deepEqual(
    [...new Set(requests.flatMap((request) => request.requirements.allowedStartSegments))].sort((a, b) => a - b),
    Array.from({ length: 10 }, (_value, index) => index),
  );
  assert.deepEqual(result.cues.map(({ startSegment }) => startSegment), [0, 4, 7]);
  assert.ok(children.every((child) => child.killed));
});

test('recursively splits only truncated visual batches and merges their plans', async () => {
  const children = [];
  const requests = [];
  const progress = [];
  const segments = Array.from({ length: 4 }, (_, index) => ({
    start: index + 0.1, end: index + 0.4, text: `字幕 ${index}`,
  }));
  const episode = context({
    duration: 4,
    transcript: { segments },
    frames: Array.from({ length: 4 }, (_, index) => ({
      time: index + 0.5, path: `frame-${index}.jpg`,
    })),
  });
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    platform: 'linux',
    verifyAssets: async () => ({ manifest: {
      runtimeServers: { cpu: 'cpu/llama-server' }, modelFileHashes,
    } }),
    spawnImpl() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
      children.push(child);
      return child;
    },
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url, options = {}) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      const body = JSON.parse(options.body);
      const data = JSON.parse(body.messages[1].content[0].text.split('可用信息：\n')[1]);
      requests.push(data);
      if (requests.length === 1) {
        return Response.json({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
      }
      const anchor = data.requirements.allowedStartSegments[0];
      const frameTime = data.sampledFrameTimes.find((time) => time >= segments[anchor].start);
      assert.notEqual(frameTime, undefined);
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        summary: `第 ${anchor} 段`,
        alignmentConfidence: 0.9,
        cues: [{
          startSegment: anchor, mood: '温情', intensity: 2, confidence: 0.9,
          reason: '画面和对白呈现持续的温情。', sceneDescription: '人物在画面中交谈。',
          dramaticIntent: '延续人物关系。',
          evidence: { frameTimes: [frameTime], subtitleIndices: [anchor] },
        }],
      }) } }] });
    },
  });

  const result = await planner.plan({ ...episode, onProgress: (event) => progress.push(event) });
  await planner.dispose();
  assert.deepEqual(requests.map((request) => request.requirements.allowedStartSegments.length), [4, 2, 2]);
  assert.deepEqual(requests.map((request) => request.sampledFrameTimes.length), [4, 2, 2]);
  assert.deepEqual(result.cues.map(({ startSegment }) => startSegment), [0, 2]);
  assert.ok(progress.some((event) => event.stage === 'splitting-vision'));
  assert.ok(children.every((child) => child.killed));
});

test('reports irreducible truncation without incorrectly asking to shorten the video', async () => {
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    platform: 'linux',
    verifyAssets: async () => ({ manifest: {
      runtimeServers: { cpu: 'cpu/llama-server' }, modelFileHashes,
    } }),
    spawnImpl: () => child,
    pollIntervalMs: 1,
    readFile: async () => Buffer.from('frame'),
    async fetchImpl(url) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      return Response.json({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
    },
  });

  await assert.rejects(planner.plan(context({
    duration: 2,
    transcript: { segments: [{ start: 0, end: 1, text: '只有一条字幕。' }] },
    frames: [{ time: 0.5, path: 'frame.jpg' }],
  })), /最小字幕与画面分析批次仍被模型截断/);
  await planner.dispose();
  assert.equal(child.killed, true);
});

test('retries CPU when GPU inference fails after the server becomes healthy', async () => {
  const started = [];
  const children = [];
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    verifyAssets: async () => ({ manifest: { runtimeServers: {
      cpu: 'cpu/llama-server.exe', vulkan: 'vulkan/llama-server.exe',
    }, modelFileHashes } }),
    async execFileImpl() { return { stdout: 'Vulkan0: NVIDIA GPU', stderr: '' }; },
    spawnImpl(executable, args) {
      started.push({ executable, args });
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
      children.push(child);
      return child;
    },
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      if (started.at(-1).args.includes('Vulkan0')) return new Response('', { status: 500 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] });
    },
  });
  const result = await planner.plan(context());
  await planner.dispose();
  assert.equal(result.cues.length, 2);
  assert.equal(started.length, 2);
  assert.equal(started[0].args.includes('Vulkan0'), true);
  assert.equal(started[1].args.includes('Vulkan0'), false);
  assert.ok(children.every((child) => child.killed));
});

test('retries CPU when GPU inference times out after the server becomes healthy', async () => {
  const started = [];
  const children = [];
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    verifyAssets: async () => ({ manifest: { runtimeServers: {
      cpu: 'cpu/llama-server.exe', vulkan: 'vulkan/llama-server.exe',
    }, modelFileHashes } }),
    async execFileImpl() { return { stdout: 'Vulkan0: NVIDIA GPU', stderr: '' }; },
    spawnImpl(executable, args) {
      started.push({ executable, args });
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
      children.push(child);
      return child;
    },
    inferenceTimeoutMs: 10,
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url, options = {}) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      if (started.at(-1).args.includes('Vulkan0')) {
        return new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error('GPU inference stalled')), 100);
          options.signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] });
    },
  });
  const result = await planner.plan(context());
  await planner.dispose();
  assert.equal(result.cues.length, 2);
  assert.equal(started.length, 2);
  assert.equal(started[1].args.includes('Vulkan0'), false);
  assert.ok(children.every((child) => child.killed));
});

test('rejects cancelled local inference and releases the loopback server', async () => {
  const children = [];
  const controller = new AbortController();
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    verifyAssets: async () => ({ manifest: {
      runtimeServers: { cpu: 'cpu/llama-server.exe' }, modelFileHashes,
    } }),
    async execFileImpl() { throw new Error('no gpu'); },
    spawnImpl() {
      const process = new EventEmitter();
      process.kill = () => { process.killed = true; process.emit('exit', 0, null); };
      children.push(process);
      return process;
    },
    pollIntervalMs: 1,
    readFile: async () => Buffer.from('frame'),
    async fetchImpl(url) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  await assert.rejects(planner.plan(context({ signal: controller.signal })), (error) => error.name === 'AbortError');
  await planner.dispose();
  assert.equal(children[0].killed, true);
});

test('cancellation while the local server is starting kills the child process', async () => {
  const controller = new AbortController();
  const process = new EventEmitter();
  process.kill = () => { process.killed = true; process.emit('exit', 0, null); };
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    verifyAssets: async () => ({ manifest: {
      runtimeServers: { cpu: 'cpu/llama-server.exe' }, modelFileHashes,
    } }),
    async execFileImpl() { throw new Error('no gpu'); },
    spawnImpl() { return process; },
    pollIntervalMs: 1,
    readFile: async () => Buffer.from('frame'),
    async fetchImpl(url) {
      assert.match(url, /\/health$/);
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  await assert.rejects(planner.plan(context({ signal: controller.signal })), (error) => error.name === 'AbortError');
  assert.equal(process.killed, true);
});

test('verifies installed model assets once for a multi-episode planner', async () => {
  let verifications = 0;
  const children = [];
  const planner = createLocalVisionPlanner({
    root: 'C:/local-vision',
    verifyAssets: async () => {
      verifications += 1;
      return { manifest: { runtimeServers: { cpu: 'cpu/llama-server.exe' }, modelFileHashes } };
    },
    async execFileImpl() { throw new Error('no gpu'); },
    spawnImpl() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 0, null); };
      children.push(child);
      return child;
    },
    pollIntervalMs: 1,
    readFile: async (file) => Buffer.from(file),
    async fetchImpl(url) {
      if (url.endsWith('/health')) return new Response('', { status: 200 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(rawPlan) } }] });
    },
  });
  await planner.plan(context());
  await planner.plan(context());
  await planner.dispose();
  assert.equal(verifications, 1);
  assert.ok(children.every((child) => child.killed));
});
