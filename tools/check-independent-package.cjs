'use strict';

const { app, BrowserWindow, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const temporary = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'auto-bgm-release-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const repository = path.resolve(__dirname, '..');
  const resources = path.join(repository, 'release/win-unpacked/resources');
  const source = path.join(resources, 'app.asar');
  const packaged = require(path.join(source, 'package.json'));
  assert.equal(packaged.name, 'auto-bgm');
  assert.equal(packaged.version, '1.0.0');
  assert.notEqual(packaged.bgmPreview, true);
  const config = await fs.readFile(path.join(resources, 'app-update.yml'), 'utf8');
  assert.match(config, /owner: yuyuyu-a/);
  assert.match(config, /repo: auto-bgm/);
  assert.match(config, /updaterCacheDirName: auto-bgm-updater/);
  assert.equal(require(path.join(source, 'desktop/update-service')).RELEASE_URL,
    'https://github.com/yuyuyu-a/auto-bgm/releases');
  assert.equal(typeof require(path.join(source, 'node_modules/mammoth')).extractRawText, 'function');
  for (const file of [
    'desktop/main.js', 'desktop/preload.js', 'desktop/update-cache.js',
    'desktop/update-service.js', 'desktop/story-ai-settings.js',
    'desktop/renderer/index.html', 'desktop/renderer/renderer.js',
    'desktop/backend/batch-service.js', 'src/mvp.js', 'src/story-director.js',
  ]) {
    assert.equal(await fs.readFile(path.join(source, file), 'utf8'),
      await fs.readFile(path.join(repository, file), 'utf8'), `Packaged source mismatch: ${file}`);
  }
  const fixture = await fs.mkdtemp(path.join(repository, 'build/independent-package-'));
  const video = path.join(fixture, 'episode.mp4');
  const music = path.join(fixture, 'music');
  const output = path.join(fixture, 'output');
  const speech = path.join(fixture, 'speech.wav');
  const storyPath = path.join(fixture, 'episode.md');
  const ffmpeg = path.join(resources, 'ffmpeg/ffmpeg.exe');
  const ffprobe = path.join(resources, 'ffmpeg/ffprobe.exe');
  await fs.mkdir(music);
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'make-package-fixture.ps1'), '-OutputPath', speech], { windowsHide: true });
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=160x120:r=25',
    '-i', speech, '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', video], { windowsHide: true });
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=30', path.join(music, 'fixture.wav')], { windowsHide: true });
  await fs.writeFile(storyPath, 'A character hides distress, asks someone to stay, and finally says goodbye. Leave silence at the farewell.');

  const { createStoryAISettings } = require(path.join(source, 'desktop/story-ai-settings'));
  const { requestStoryPlan } = require(path.join(source, 'src/story-director'));
  const { runBatch } = require(path.join(source, 'src/mvp'));
  let requests = 0;
  let providerError;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const input = JSON.parse(payload.messages.at(-1).content);
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
      assert.ok(input.dialogue.length >= 2, 'Real transcription must supply multiple dialogue anchors');
      assert.ok(input.dialogue.some(({ text }) => /goodbye/i.test(text)));
      requests += 1;
      const plan = {
        summary: 'Local release fixture with music and intentional farewell silence.',
        alignmentConfidence: 0.95,
        cues: [
          { startSegment: 0, mood: '默认', intensity: 1, reason: 'Restrained opening.', confidence: 0.9, review: false },
          { startSegment: input.dialogue.at(-1).id, mood: null, intensity: 1,
            reason: 'Intentional silence on the farewell.', confidence: 0.9, review: false },
        ],
      };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }));
    } catch (error) {
      providerError = error;
      response.writeHead(500).end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const settingsStore = createStoryAISettings({
    filePath: path.join(temporary, 'story-ai.json'), safeStorage,
  });
  await settingsStore.save({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: 'local-release-fixture', apiKey: 'local-fixture-only',
  });
  const settings = await settingsStore.readPrivate();
  try {
    const summary = await runBatch({
      videos: video, music, output, storyEnabled: true, storyPath,
      storyAIProfile: { baseUrl: settings.baseUrl, model: settings.model },
      createStoryPlan: (context) => requestStoryPlan(context, settings),
      transcribe: true, language: 'en',
      transcriberExecutable: path.join(resources, 'transcriber/bgm-transcriber.exe'),
      modelPath: path.join(resources, 'model/small'),
      strictInstrumental: false, scenePriority: false, maxTracksPerEpisode: 17,
      minTracksPerEpisode: 1, skipCompleted: false, overwrite: false,
      fadeIn: 0.1, fadeOut: 0.1, ffmpeg, ffprobe,
    }, { log() {}, error() {} });
    if (providerError) throw providerError;
    assert.equal(summary.completed, 1, JSON.stringify(summary.results));
    assert.equal(requests, 1);
    const result = summary.results[0];
    assert.ok(result.analysis.segments.some(({ track }) => track));
    const silence = result.analysis.segments.find(({ explicitSilence }) => explicitSilence);
    assert.ok(silence);
    const pcm = (await execute(ffmpeg, ['-v', 'error', '-ss', String(silence.start + 0.1),
      '-i', result.outputPath, '-t', '0.2', '-f', 's16le', '-ac', '1', '-'],
    { windowsHide: true, encoding: 'buffer' })).stdout;
    assert.ok(pcm.length > 0 && pcm.every((byte) => byte === 0));
    await execute(ffmpeg, ['-v', 'error', '-i', result.finalVideoPath, '-f', 'null', '-'],
      { windowsHide: true });
    for (const name of await fs.readdir(output)) {
      if (/\.(json|csv|log|md)$/.test(name)) {
        assert.equal((await fs.readFile(path.join(output, name), 'utf8')).includes(settings.apiKey), false);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  const defaults = { videos: video, music, output, transcribe: false,
    minTracksPerEpisode: 1, maxTracksPerEpisode: 17, scenePriority: false };
  await fs.writeFile(path.join(temporary, 'fixture.json'), JSON.stringify({
    info: { defaults, running: false, version: '1.0.0', logs: [] },
    batch: { rows: [], inputVideoCount: 1, musicGroups: [{ mood: '默认', count: 1 }],
      paths: Object.fromEntries(['videos', 'music', 'output'].map((key) => [key, { status: 'available' }])),
      model: { exists: true }, tools: { ffmpeg: { available: true }, ffprobe: { available: true } } },
  }));
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(__dirname, 'check-workbench-preload.cjs'),
      additionalArguments: [`--bgm-test-root=${temporary}`], contextIsolation: true, sandbox: false } });
  try {
    await window.loadFile(path.join(source, 'desktop/renderer/index.html'));
    const js = (script) => window.webContents.executeJavaScript(script, true);
    const until = Date.now() + 10000;
    while (!await js('Boolean(state.version)')) {
      assert.ok(Date.now() < until, 'Packaged renderer initialization timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(await js('document.title'), '自动配乐');
    assert.equal(await js('document.querySelector(".brand-mark strong").textContent'), '自动配乐');
    await js('document.querySelector(".nav-item[data-view=about]").click()');
    assert.match(await js('document.getElementById("screen").textContent'), /yuyuyu-a.*crazyzhang277/);
    window.setContentSize(1441, 900);
    await new Promise((resolve) => setTimeout(resolve, 100));
    window.setContentSize(1440, 900);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.writeFile(path.join(fixture, 'about-desktop.png'), (await window.webContents.capturePage()).toPNG());
    window.setContentSize(760, 520);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await js('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth'), true);
    await fs.writeFile(path.join(fixture, 'about-minimum.png'), (await window.webContents.capturePage()).toPNG());
  } finally {
    window.destroy();
  }
  console.log('INDEPENDENT_PACKAGE_OK', JSON.stringify({
    product: '自动配乐', version: '1.0.0', ownUpdateFeed: true,
    realTranscription: true, localRequests: requests, silenceSamplesZero: true,
    isolatedEncryptedSettings: true, screenshots: fixture,
  }));
  app.quit();
}).catch((error) => {
  console.error('INDEPENDENT_PACKAGE_FAILED', error);
  app.exit(1);
});
