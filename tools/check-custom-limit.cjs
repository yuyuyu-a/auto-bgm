'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bgm-custom-limit-ui-'));
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let window;
  try {
    const repository = path.resolve(__dirname, '..');
    const source = process.argv.includes('--packaged')
      ? path.join(repository, 'release/win-unpacked/resources/app.asar') : repository;
    if (process.argv.includes('--packaged')) {
      for (const file of ['desktop/renderer/renderer.js', 'desktop/renderer/styles.css']) {
        assert.equal(await fs.readFile(path.join(source, file), 'utf8'),
          await fs.readFile(path.join(repository, file), 'utf8'), `Packaged source mismatch: ${file}`);
      }
    }
    const defaults = { videos: path.join(root, 'episode.mp4'), music: root,
      output: path.join(root, 'output'), modelPath: root, transcribe: false,
      minTracksPerEpisode: 1, maxTracksPerEpisode: 3, scenePriority: true,
      outputAudio: true, outputVideo: true, outputTimeline: true, outputTranscript: false };
    const fixture = { info: { defaults, running: false, version: 'custom-limit-check', logs: [] },
      batch: { rows: [], inputVideoCount: 1, paths: Object.fromEntries(['videos', 'music', 'output']
        .map((key) => [key, { status: 'available', label: '可用' }])),
      model: { exists: true }, tools: { ffmpeg: { available: true }, ffprobe: { available: true } },
      musicGroups: [{ mood: '默认', count: 30 }], validationError: '' } };
    await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify(fixture));
    window = new BrowserWindow({ show: false, width: 1440, height: 900,
      webPreferences: { preload: path.join(__dirname, 'check-workbench-preload.cjs'),
        additionalArguments: [`--bgm-test-root=${root}`], contextIsolation: true,
        sandbox: false, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const js = (script) => window.webContents.executeJavaScript(script, true);
    const waitFor = async (script) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await js(script)) return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(`Timed out: ${script}\n${errors.join('\n')}`);
    };
    const changeMaximum = async (value) => js(`(() => {
      const input = document.getElementById('config-maxTracksPerEpisode');
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const openSettings = async () => {
      await waitFor('Boolean(document.querySelector(".nav-item[data-view=settings]") && state.config.videos)');
      await js('document.querySelector(".nav-item[data-view=settings]").click()');
    };
    await window.loadFile(path.join(source, 'desktop/renderer/index.html'));
    await openSettings();
    assert.equal(await js('Boolean(document.getElementById("music-limit-custom"))'), true,
      'Custom mode must be available even while scene-priority makes the numeric cap inactive');
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    await js('document.getElementById("music-limit-custom").click()');
    assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").disabled'), false);
    assert.equal(await js('state.config.scenePriority'), false);
    assert.equal(await js('document.getElementById("config-scenePriority").checked'), false);
    await changeMaximum(17);
    assert.equal(await js('state.config.maxTracksPerEpisode'), 17);
    assert.equal(await js('JSON.parse(localStorage.getItem("bgm-studio-config")).maxTracksPerEpisode'), 17);
    assert.equal(await js('loadConfig(state.defaults).maxTracksPerEpisode'), 17);
    await js(`window.savedMaximum = document.getElementById('config-maxTracksPerEpisode');
      savedMaximum.focus(); workbenchTest.emitBatch({ type: 'log', message: 'editing custom cap' })`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(await js('savedMaximum === document.activeElement && savedMaximum.value === "17"'), true);
    const screenshots = path.join(repository, 'build/custom-limit-verification');
    await fs.mkdir(screenshots, { recursive: true });
    const screenshot = async (name) => {
      const [width, height] = window.getContentSize();
      window.setContentSize(width + 1, height);
      await new Promise((resolve) => setTimeout(resolve, 80));
      window.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await fs.writeFile(path.join(screenshots, name), (await window.webContents.capturePage()).toPNG());
    };
    await screenshot('custom-desktop.png');
    window.setContentSize(760, 520);
    assert.equal(await js('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth'), true);
    await js('document.getElementById("music-quantity-settings").scrollIntoView({ block: "start" })');
    await screenshot('custom-minimum.png');
    await window.reload();
    await openSettings();
    assert.equal(await js('document.getElementById("music-limit-custom").checked'), true);
    assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").value'), '17');
    assert.equal(await js('state.config.scenePriority'), false);
    await js('document.getElementById("top-start").click()');
    await waitFor('workbenchTest.calls().some((call) => call.action === "start")');
    assert.deepEqual(await js(`(() => {
      const config = workbenchTest.calls().find((call) => call.action === 'start').config;
      return { maximum: config.maxTracksPerEpisode, scenePriority: config.scenePriority };
    })()`), { maximum: 17, scenePriority: false });
    await js('workbenchTest.emitBatch({ type: "finished", summary: { completed: 1 } })');
    await waitFor('!state.running');
    await js('document.querySelector(".nav-item[data-view=settings]").click(); document.getElementById("music-limit-unlimited").click()');
    assert.equal(await js('state.config.maxTracksPerEpisode'), 0);
    assert.equal(await js('state.config.scenePriority'), false);
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    await window.reload();
    await openSettings();
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    assert.equal(await js('state.config.maxTracksPerEpisode'), 0);
    await js('document.getElementById("music-limit-custom").click()');
    await changeMaximum(29);
    await js('document.getElementById("config-scenePriority").click()');
    assert.equal(await js('state.config.scenePriority'), true);
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    await js('document.getElementById("music-limit-custom").click()');
    assert.equal(await js('state.config.scenePriority'), false);
    assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").value'), '29');
    await changeMaximum(0);
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    await js('document.getElementById("music-limit-custom").click()');
    for (const incomplete of ['1e', '-', '1e+']) {
      await changeMaximum(17);
      await js(`(() => {
        const input = document.getElementById('config-maxTracksPerEpisode');
        input.focus();
      })()`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
      await window.webContents.insertText(incomplete);
      assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").validity.badInput'), true,
        `Native input must retain incomplete text: ${incomplete}`);
      await js('document.getElementById("config-minTracksPerEpisode").focus()');
      assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").validity.badInput'), true,
        `Incomplete text must survive blur: ${incomplete}`);
      assert.equal(await js('state.config.maxTracksPerEpisode'), '');
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('CUSTOM_LIMIT_UI_OK', JSON.stringify({
      packaged: process.argv.includes('--packaged'), customValue: 17,
      reloadPersistence: true, startConfig: true, unlimited: true, sceneInteraction: true,
      incompleteInputPreserved: true, screenshots,
    }));
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    app.exit(1);
  }
});
