'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { loadStoryDocument } = require('../src/story-input');
const { normalizeBaseUrl, listModels, requestStoryPlan, normalizeStoryPlan } = require('../src/story-director');

const transcript = { segments: [
  { start: 1, end: 5, text: "I'm fine." },
  { start: 9, end: 15, text: 'Please stay.' },
  { start: 23, end: 29, text: 'Leave me alone.' },
] };
const groups = new Map([['伤感', ['private/sad.wav']], ['紧张', ['private/tense.wav']], ['默认', ['private/neutral.wav']]]);
const validPlan = () => ({
  summary: 'The speaker conceals grief before a confrontation.',
  alignmentConfidence: 0.92,
  cues: [
    { startSegment: 0, mood: '伤感', intensity: 1, reason: 'The script describes suppressed tears.', confidence: 0.9, review: false },
    { startSegment: 2, mood: null, intensity: 1, reason: 'Let the final confrontation land without music.', confidence: 0.7, review: true },
  ],
});
const context = () => ({
  document: { name: 'episode.md', text: 'She says she is fine, but hides her tears. Silence after the confrontation.' },
  transcript, groups, sceneCuts: [{ time: 20, score: 40 }], duration: 35,
});

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key-not-a-user-secret', model: 'fixture-director' };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('story input loads the matching document, changes its signature, and rejects ambiguity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-input-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'episode.script.md');
  await fs.writeFile(file, 'A quiet reunion.');
  const first = await loadStoryDocument(root, path.join(root, 'episode.mp4'), { singleVideo: false });
  assert.equal(first.name, 'episode.script.md');
  assert.equal(first.text, 'A quiet reunion.');
  assert.match(first.signature, /^[a-f0-9]{64}$/);
  await fs.writeFile(file, 'A tense reunion.');
  const second = await loadStoryDocument(root, path.join(root, 'episode.mp4'), { singleVideo: false });
  assert.notEqual(first.signature, second.signature);
  await fs.writeFile(path.join(root, 'episode.txt'), 'Other revision.');
  await assert.rejects(loadStoryDocument(root, path.join(root, 'episode.mp4')), /多个|ambiguous/i);
  await assert.rejects(loadStoryDocument(file, path.join(root, 'episode.mp4'), { singleVideo: false }), /单个|single/i);
  await assert.rejects(loadStoryDocument(root, path.join(root, 'missing.mp4')), /找不到|missing/i);
});

test('story input parses structured JSON and rejects invalid, empty, oversized or unsupported documents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-types-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'episode.json');
  const video = path.join(root, 'episode.mp4');
  await fs.writeFile(file, '{"scenes":[{"action":"Silently crying"}]}');
  assert.match((await loadStoryDocument(file, video, { singleVideo: true })).text, /Silently crying/);
  await fs.writeFile(file, '{"scenes":');
  await assert.rejects(loadStoryDocument(file, video, { singleVideo: true }), /JSON/);
  await fs.writeFile(file, 'null');
  await assert.rejects(loadStoryDocument(file, video, { singleVideo: true }), /内容|content/i);
  await fs.writeFile(file, '  ');
  await assert.rejects(loadStoryDocument(file, video, { singleVideo: true }), /空|JSON|empty/i);
  const text = path.join(root, 'episode.txt');
  await fs.writeFile(text, 'x'.repeat(80001));
  await assert.rejects(loadStoryDocument(text, video, { singleVideo: true }), /过长|limit|长度/i);
  const pdf = path.join(root, 'episode.pdf');
  await fs.writeFile(pdf, '%PDF');
  await assert.rejects(loadStoryDocument(pdf, video, { singleVideo: true }), /格式|支持|format/i);
});

test('story input exposes its resolved source path only for local write protection when requested', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'episode.script.md');
  await fs.writeFile(file, 'Protect this original script.');
  const document = await loadStoryDocument(root, path.join(root, 'episode.mp4'), { includePath: true });
  assert.equal(document.path, file);
  const publicDocument = await loadStoryDocument(file, path.join(root, 'episode.mp4'));
  assert.equal(Object.hasOwn(publicDocument, 'path'), false);
});

test('Word DOCX extraction reads real document text rather than binary bytes or filenames', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-story-word-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docx = 'UEsDBAoAAAAIAK84bl2sbhJangAAANwAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbF2PsQ7CMBBDf6XKitqrGBhQ24UdGPiBU3JtI5pLlBwF/p4EpA6Mlu1nubu9A6Xq5RZOvZpFwhEg6ZkcpsYH4uyMPjqULOMEAfUdJ4J92x5AexZiqaUw1NBdVorRGqquGOWMjnoFTx8NGK8fLiebTFPV6Vcry73CEBarUaxnWNn8bdZ+HK2mrV9oIXpNKVme3NJsjkPLu4KHoYPvqeEDUEsDBAoAAAAAAK84bl0AAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAIAK84bl1hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQKAAAAAACvOG5dAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAIAK84bl0Nr++5fQAAAKYAAAARAAAAd29yZC9kb2N1bWVudC54bWxFzsENwyAMBdBVUAaIox56QJQlOgENbkCKMbKpaLdvSA+9vC/r60t23UZeX4SlmTftRW2/Tam1agF0TUhBZ65Yju7JQqEdp2zQWWIVXlE1l412uCzLFSjkMnnX7YPjZ2QdyKD5e0KTckQ1CcU0DKKzg9EM5bSe/tbw/8x/AVBLAQIUAAoAAAAIAK84bl2sbhJangAAANwAAAATAAAAAAAAAAAAAAAAAAAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQACgAAAAAArzhuXQAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAAzwAAAF9yZWxzL1BLAQIUAAoAAAAIAK84bl1hey9DiQAAAPIAAAALAAAAAAAAAAAAAAAAAPMAAABfcmVscy8ucmVsc1BLAQIUAAoAAAAAAK84bl0AAAAAAAAAAAAAAAAFAAAAAAAAAAAAEAAAAKUBAAB3b3JkL1BLAQIUAAoAAAAIAK84bl0Nr++5fQAAAKYAAAARAAAAAAAAAAAAAAAAAMgBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABQAFACABAAB0AgAAAAA=';
  const file = path.join(root, 'episode.docx');
  await fs.writeFile(file, Buffer.from(docx, 'base64'));
  assert.equal((await loadStoryDocument(file, path.join(root, 'episode.mp4'))).text, 'She hides her tears.');
});

test('API URLs normalize consistently and never accept credentials or plaintext public hosts', () => {
  assert.equal(normalizeBaseUrl('https://example.com/'), 'https://example.com/v1');
  assert.equal(normalizeBaseUrl('https://example.com/v1/'), 'https://example.com/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:9123'), 'http://127.0.0.1:9123/v1');
  for (const bad of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'file:///secret', 'https://example.com/#key']) {
    assert.throws(() => normalizeBaseUrl(bad), /地址|HTTPS|URL/i);
  }
});

test('model listing sends bearer auth to exactly the configured origin and filters malformed IDs', async (t) => {
  let seen;
  const settings = await fixture(t, (request, response) => {
    seen = { url: request.url, authorization: request.headers.authorization };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-one' }, { id: 'model-one' }, { id: '' }, {}, { id: 'model-two' }] }));
  });
  assert.deepEqual(await listModels(settings), ['model-one', 'model-two']);
  assert.equal(seen.url, '/v1/models');
  assert.equal(seen.authorization, 'Bearer fixture-key-not-a-user-secret');
});

test('story request sends grounded dialogue and category counts, not local media paths or API secrets in the prompt', async (t) => {
  let payload;
  const settings = await fixture(t, async (request, response) => {
    payload = await body(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] }));
  });
  const plan = await requestStoryPlan(context(), settings);
  assert.equal(plan.cues[0].mood, '伤感');
  assert.equal(plan.cues[1].mood, null);
  assert.equal(plan.alignmentConfidence, 0.92);
  assert.equal(payload.model, 'fixture-director');
  assert.equal(payload.stream, false);
  const prompt = payload.messages.map((message) => message.content).join('\n');
  assert.match(prompt, /suppressed|script|剧本/i);
  assert.match(prompt, /I'm fine/);
  assert.match(prompt, /startSegment/);
  assert.match(payload.messages[0].content, /romance.*warmth.*抒情/i);
  assert.equal(prompt.includes('private/sad.wav'), false);
  assert.equal(prompt.includes(settings.apiKey), false);
  const input = JSON.parse(payload.messages.at(-1).content);
  assert.deepEqual(input.dialogue[2], { id: 2, start: 23, end: 29, text: 'Leave me alone.' });
  assert.deepEqual(input.categories.find((category) => category.mood === '伤感'), { mood: '伤感', count: 1 });
});

test('cue validation refuses invented anchors, categories, unsafe confidence and malformed timing', () => {
  const normalize = (raw, extra = {}) => normalizeStoryPlan(raw, { transcript, groups, duration: 35, ...extra });
  assert.equal(normalize(validPlan()).cues[1].review, true);
  const badPlans = [
    { ...validPlan(), alignmentConfidence: 0.1 },
    { ...validPlan(), alignmentConfidence: '0.9' },
    { ...validPlan(), cues: [] },
    { ...validPlan(), cues: [{ ...validPlan().cues[0], startSegment: 1 }] },
    { ...validPlan(), cues: [{ ...validPlan().cues[0], startSegment: 0.5 }] },
    { ...validPlan(), cues: [validPlan().cues[0], { ...validPlan().cues[1], startSegment: 10 }] },
    { ...validPlan(), cues: [validPlan().cues[0], { ...validPlan().cues[1], startSegment: 0 }] },
    { ...validPlan(), cues: [{ ...validPlan().cues[0], mood: 'nonexistent' }] },
    { ...validPlan(), cues: [{ ...validPlan().cues[0], intensity: 9 }] },
    { ...validPlan(), cues: [{ ...validPlan().cues[0], confidence: 2 }] },
  ];
  for (const raw of badPlans) assert.throws(() => normalize(raw), /剧情|配乐|对齐|情绪|强度|时间|置信|cue|plan/i);
  assert.throws(() => normalize(validPlan(), { transcript: { segments: [] } }), /对白|转录|时间|transcript/i);
  const uncertain = validPlan();
  uncertain.cues[0].confidence = 0.6;
  assert.equal(normalize(uncertain).cues[0].review, true);
});

test('remote failures and redirects cannot leak credentials or trigger a keyword fallback', async (t) => {
  let redirected = false;
  const settings = await fixture(t, (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(302, { location: '/stolen' });
      response.end();
    } else { redirected = true; response.end('{}'); }
  });
  await assert.rejects(listModels(settings), (error) => !error.message.includes(settings.apiKey));
  assert.equal(redirected, false);
  const denied = await fixture(t, (_request, response) => {
    response.writeHead(401);
    response.end(JSON.stringify({ error: { message: 'fixture-key-not-a-user-secret should not be shown' } }));
  });
  await assert.rejects(requestStoryPlan(context(), denied), (error) => /401|密钥|认证/.test(error.message) && !error.message.includes(denied.apiKey));
});

test('cancelled model requests stop before sending data and malformed model JSON is rejected', async (t) => {
  let requests = 0;
  const settings = await fixture(t, (_request, response) => {
    requests += 1;
    response.end(JSON.stringify({ choices: [{ message: { content: 'not valid JSON' } }] }));
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestStoryPlan(context(), settings, { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(requests, 0);
  await assert.rejects(requestStoryPlan(context(), settings), /JSON|格式/);
});

test('even a valid provider plan is rejected when it echoes the authorization credential', async (t) => {
  const settings = await fixture(t, (_request, response) => {
    const raw = validPlan();
    raw.cues[0].reason = 'fixture-key-not-a-user-secret';
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }));
  });
  await assert.rejects(requestStoryPlan(context(), settings), (error) => !error.message.includes(settings.apiKey));
});

test('JSON-escaped credential echoes are rejected before decoded plan text can be persisted', async (t) => {
  const settings = await fixture(t, async (request, response) => {
    await body(request);
    const raw = validPlan();
    raw.summary = 'fixture-key-not-a-user-secret';
    raw.cues[0].reason = 'fixture-key-not-a-user-secret';
    const content = JSON.stringify(raw).replaceAll('fixture-key-not-a-user-secret',
      '\\u0066ixture-key-not-a-user-secret');
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await assert.rejects(requestStoryPlan(context(), settings),
    (error) => /不安全/.test(error.message) && !error.message.includes(settings.apiKey));
});

test('credential echo rejection checks actual decoded strings even when JSON must escape the key itself', async (t) => {
  const settings = await fixture(t, async (request, response) => {
    await body(request);
    const raw = validPlan();
    raw.cues[0].reason = 'fixture-"quoted-key';
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }));
  });
  settings.apiKey = 'fixture-"quoted-key';
  await assert.rejects(requestStoryPlan(context(), settings),
    (error) => /不安全/.test(error.message) && !error.message.includes(settings.apiKey));
});

test('story HTTP analysis preserves original anchors through timestamped blank transcript segments', async (t) => {
  let input;
  const settings = await fixture(t, async (request, response) => {
    input = JSON.parse((await body(request)).messages.at(-1).content);
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validPlan()) } }] }));
  });
  const withBlank = { segments: [
    transcript.segments[0],
    { start: 6, end: 8, text: '  ' },
    transcript.segments[2],
  ] };
  const plan = await requestStoryPlan({ ...context(), transcript: withBlank }, settings);
  assert.equal(input.dialogue[1].id, 1);
  assert.equal(input.dialogue[1].text, '  ');
  assert.equal(input.dialogue[2].id, 2);
  assert.equal(plan.cues[1].startSegment, 2);
});

test('empty eligible categories allow explicit story silence but never invented music', async (t) => {
  let input;
  let calls = 0;
  const settings = await fixture(t, async (request, response) => {
    input = JSON.parse((await body(request)).messages.at(-1).content);
    const raw = validPlan();
    raw.cues = [{ ...raw.cues[0], mood: calls++ === 0 ? null : '伤感' }];
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }));
  });
  const empty = { ...context(), groups: new Map() };
  const plan = await requestStoryPlan(empty, settings);
  assert.deepEqual(input.categories, []);
  assert.equal(plan.cues[0].mood, null);
  await assert.rejects(requestStoryPlan(empty, settings), /情绪|分类|曲库/);
});

test('oversized responses are rejected and cancellation interrupts a streaming response body', async (t) => {
  const oversized = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 3 * 1024 * 1024 });
    response.end('{}');
  });
  await assert.rejects(listModels(oversized), /过大/);
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const streaming = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":[');
    requestStarted();
  });
  const controller = new AbortController();
  const pending = requestStoryPlan(context(), streaming, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
