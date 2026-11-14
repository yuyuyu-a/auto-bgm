'use strict';

const { app, BrowserWindow, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bgm-story-ui-'));
app.setPath('userData', path.join(root, 'profile'));
app.whenReady().then(async () => {
  let window;
  try {
    const { createStoryAISettings } = require('../desktop/story-ai-settings');
    const encryptedPath = path.join(root, 'native-settings', 'story-ai.json');
    const nativeSettings = createStoryAISettings({ filePath: encryptedPath, safeStorage });
    const nativeKey = 'synthetic-native-test-key';
    await nativeSettings.save({ baseUrl: 'https://example.com', model: 'native-test', apiKey: nativeKey });
    assert.equal((await fs.readFile(encryptedPath, 'utf8')).includes(nativeKey), false);
    const reopened = createStoryAISettings({ filePath: encryptedPath, safeStorage });
    assert.equal((await reopened.readPrivate()).apiKey, nativeKey);
    await reopened.save({ clearKey: true });
    assert.equal((await reopened.readPublic()).keyStored, false);
    window = new BrowserWindow({
      show: false, width: 1440, height: 900,
      webPreferences: { preload: path.join(__dirname, 'check-story-ui-preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
    });
    const errors = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const js = async (source) => {
      try { return await window.webContents.executeJavaScript(source, true); }
      catch (error) { throw new Error(`${source}\n${error.message}\n${errors.join('\n')}`); }
    };
    const wait = async (source) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        if (await js(source)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`Timed out: ${source}\n${errors.join('\n')}`);
    };
    await window.loadFile(path.resolve(__dirname, '../desktop/renderer/index.html'));
    await wait('document.querySelectorAll("#queue-body tr").length === 1');
    assert.equal(await js('Boolean(document.querySelector("[data-config-key=storyEnabled]"))'), true, 'story mode switch is missing');
    assert.equal(await js('state.config.storyEnabled'), false);
    assert.equal(await js('storyTest.calls().some(call => ["test","models"].includes(call.action))'), false);
    await js('document.querySelector("[data-config-key=storyEnabled]").click()');
    await wait('state.config.storyEnabled && state.config.transcribe');
    assert.equal(await js('document.getElementById("top-start").disabled'), true);
    await js('document.querySelector("[data-action=choose-story-file]").click()');
    await wait('state.config.storyPath === "synthetic.docx"');
    await js('document.querySelector("[data-action=choose-story-directory]").click()');
    await wait('state.config.storyPath === "synthetic-stories"');
    await js('document.querySelector(".nav-item[data-view=settings]").click()');
    assert.equal(await js('document.getElementById("story-ai-base-url").value'), '');
    assert.match(await js('document.querySelector(".story-ai-settings").textContent'), /启用即同意/);
    assert.match(await js('document.querySelector(".story-ai-settings").textContent'), /不上传音视频/);
    assert.match(await js('document.querySelector(".story-ai-settings").textContent'), /可能计费/);
    await js('document.getElementById("story-ai-base-url").value="https://example.com/v1"; document.getElementById("story-ai-model").value="model-a"; document.getElementById("story-ai-key").value="synthetic-credential"; document.querySelector("[data-action=save-story-ai]").click()');
    await wait('state.storyAI.keyStored && document.getElementById("story-ai-key").value === ""');
    assert.equal(await js('JSON.stringify(state).includes("synthetic-credential") || JSON.stringify(localStorage).includes("synthetic-credential")'), false);
    assert.equal(await js('Object.keys(state.config).some(key => /apiKey|baseUrl|storyAI/.test(key))'), false);
    await js('document.querySelector("[data-action=story-ai-models]").click()');
    await wait('document.querySelectorAll("#story-ai-models option").length === 2');
    assert.equal(await js('document.getElementById("story-ai-model").getAttribute("list")'), 'story-ai-models');
    await js('document.querySelector("[data-action=test-story-ai]").click()');
    await wait('storyTest.calls().some(call => call.action === "test")');
    await js('document.querySelector(".nav-item[data-view=desk]").click()');
    await wait('!state.preflightPending && !document.getElementById("top-start").disabled');
    const failures = [];
    const regression = async (name, check) => {
      try { await check(); console.log(`PASS: ${name}`); }
      catch (error) { failures.push(`${name}: ${error.message}`); console.error(`FAIL: ${name}: ${error.message}`); }
    };
    await regression('native story-directory drop preserves the output directory', async () => {
      const storyDirectory = path.join(root, 'dropped-stories');
      await fs.mkdir(storyDirectory, { recursive: true });
      await fs.writeFile(path.join(storyDirectory, 'episode.txt'), 'Synthetic story for a directory drop.');
      const previous = await js('({ output: state.config.output, storyPath: state.config.storyPath })');
      try {
        const point = await js('(() => { const input = document.getElementById("config-storyPath"); input.scrollIntoView({block:"center"}); const r = input.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
        window.webContents.debugger.attach('1.3');
        const data = { items: [], files: [storyDirectory], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await window.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
        }
        await wait('storyTest.calls().some(call => call.action === "import") && !state.preflightPending');
        assert.equal(await js('state.config.output'), previous.output, 'a story drop changed the output directory');
        assert.equal(await js('document.getElementById("config-storyPath").value'), storyDirectory);
        assert.equal(await js('JSON.parse(localStorage.getItem("bgm-studio-config")).output'), previous.output);
        assert.equal(await js('storyTest.calls().find(call => call.action === "import").input.path'), storyDirectory);
      } finally {
        if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
        await js(`Object.assign(state.config, ${JSON.stringify(previous)}); saveConfig(); refresh(true)`);
      }
    });
    await regression('story mode discloses external API use in the top badge', async () => {
      const run = { config: { storyEnabled: true }, startedAt: Date.now(), status: 'running', currentStage: 'analyzing-story', total: 1, settled: 0 };
      try {
        assert.match(await js('document.querySelector(".offline-badge").textContent'), /API|联网/);
        assert.doesNotMatch(await js('document.querySelector(".offline-badge").textContent'), /本地|离线/);
        await js('document.querySelector("[data-config-key=storyEnabled]").click()');
        await wait('!state.config.storyEnabled && !state.preflightPending');
        assert.match(await js('document.querySelector(".offline-badge").textContent'), /本地.*离线/);
        await js(`storyTest.emitBatch({type:"started",run:${JSON.stringify(run)}})`);
        await wait('state.running && document.getElementById("top-start").textContent === "停止批次"');
        assert.match(await js('document.querySelector(".offline-badge").textContent'), /API|联网/);
        assert.doesNotMatch(await js('document.querySelector(".offline-badge").textContent'), /本地|离线/);
      } finally {
        await js(`storyTest.emitBatch({type:"finished",summary:{},run:${JSON.stringify({ ...run, status: 'finished', currentStage: 'finished' })}})`);
        await wait('!state.running && !state.preflightPending');
        if (!await js('state.config.storyEnabled')) {
          await js('document.querySelector("[data-config-key=storyEnabled]").click()');
          await wait('state.config.storyEnabled && !state.preflightPending');
        }
      }
    });
    await regression('story analysis progress has a Chinese stage label', async () => {
      const run = { startedAt: Date.now(), status: 'running', currentStage: 'analyzing-story', currentEpisode: '第1集', total: 1, currentIndex: 1, settled: 0 };
      try {
        await js(`storyTest.emitBatch({type:"started",run:${JSON.stringify(run)}})`);
        await wait('document.getElementById("batch-progress").textContent.includes("analyzing-story") || document.getElementById("batch-progress").textContent.includes("分析剧情")');
        assert.match(await js('document.getElementById("batch-progress").textContent'), /分析剧情/);
        assert.doesNotMatch(await js('document.getElementById("batch-progress").textContent'), /analyzing-story/);
      } finally {
        await js(`storyTest.emitBatch({type:"finished",summary:{},run:${JSON.stringify({ ...run, status: 'finished', currentStage: 'finished' })}})`);
        await wait('!state.running && !state.preflightPending');
      }
    });
    await regression('story preflight permits explicit silence with zero eligible tracks but requires base paths', async () => {
      try {
        await js('document.querySelector("[data-action=check-library]").click()');
        await wait('state.library?.usable === 0 && !state.checkingLibrary');
        assert.equal(await js('preflightChecks().find(check => check.name === "BGM").ok'), true, 'zero eligible tracks blocked story silence');
        assert.match(await js('document.getElementById("preflight-checks").textContent'), /仅可留白/);
        assert.equal(await js('document.getElementById("top-start").disabled'), false);
        assert.equal(await js('state.config.strictInstrumental'), true);
        assert.deepEqual(await js('state.library.musicGroups'), []);
        const starts = await js('storyTest.calls().filter(call => call.action === "start").length');
        await js('document.getElementById("top-start").click()');
        await wait(`storyTest.calls().filter(call => call.action === "start").length === ${starts + 1}`);
        await js('document.querySelector("[data-config-key=storyEnabled]").click()');
        await wait('!state.config.storyEnabled && !state.preflightPending');
        assert.equal(await js('preflightChecks().find(check => check.name === "BGM").ok'), false);
        assert.equal(await js('document.getElementById("top-start").disabled'), true);
        await js('document.querySelector("[data-config-key=storyEnabled]").click()');
        await wait('state.config.storyEnabled && !state.preflightPending');
        const groups = await js('state.data.musicGroups');
        await js('state.data.musicGroups = []; updateLive()');
        assert.equal(await js('document.getElementById("top-start").disabled'), true, 'a missing raw library must remain blocked');
        await js(`state.data.musicGroups = ${JSON.stringify(groups)}; updateLive()`);
        for (const key of ['videos', 'music', 'output']) {
          const previous = await js(`state.config.${key}`);
          try {
            await js(`(() => { const input = document.getElementById("config-${key}"); input.value=""; input.dispatchEvent(new Event("change",{bubbles:true})); })()`);
            await wait('!state.preflightPending');
            assert.equal(await js('document.getElementById("top-start").disabled'), true, `missing ${key} must remain blocked`);
          } finally {
            await js(`(() => { const input = document.getElementById("config-${key}"); input.value=${JSON.stringify(previous)}; input.dispatchEvent(new Event("change",{bubbles:true})); })()`);
            await wait('!state.preflightPending');
          }
        }
      } finally {
        await js('state.library = null; state.config.storyEnabled = true; saveConfig(); refresh(true)');
      }
    });
    assert.equal(failures.length, 0, `Story review regressions:\n${failures.join('\n')}`);
    await js('document.getElementById("config-preset").value="preview"; document.getElementById("config-preset").dispatchEvent(new Event("change",{bubbles:true}))');
    await wait('!state.preflightPending && state.config.transcribe');
    assert.equal(await js('document.querySelector("[data-config-key=transcribe]").disabled'), true);
    const priorStarts = await js('storyTest.calls().filter(call => call.action === "start").length');
    await js('document.getElementById("top-start").click()');
    await wait(`storyTest.calls().filter(call => call.action === "start").length === ${priorStarts + 1}`);
    const config = await js('storyTest.calls().filter(call => call.action === "start").at(-1).config');
    assert.equal(config.storyEnabled, true);
    assert.equal(config.storyPath, 'synthetic-stories');
    assert.equal(config.transcribe, true);
    assert.doesNotMatch(JSON.stringify(config), /apiKey|synthetic-credential|baseUrl/);
    await js('document.querySelector(".nav-item[data-view=settings]").click()');
    const screenshots = path.resolve(__dirname, '../build/ux-verification');
    await fs.mkdir(screenshots, { recursive: true });
    const capture = async (name) => {
      const [width, height] = window.getContentSize();
      window.setContentSize(width + 1, height);
      await new Promise((resolve) => setTimeout(resolve, 80));
      window.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await fs.writeFile(path.join(screenshots, name), (await window.webContents.capturePage()).toPNG());
    };
    await js('document.querySelector(".story-ai-settings").scrollIntoView()');
    await capture('story-settings.png');
    window.setContentSize(760, 520);
    await js('document.querySelector(".story-ai-settings").scrollIntoView()');
    assert.equal(await js('screen.scrollWidth <= screen.clientWidth'), true);
    assert.equal(await js('[...document.querySelectorAll(".story-ai-settings button")].every(node => node.scrollWidth <= node.clientWidth)'), true);
    await capture('story-settings-minimum.png');
    await js('storyTest.fail(true); document.getElementById("story-ai-key").value="synthetic-credential"; document.querySelector("[data-action=save-story-ai]").click()');
    await wait('document.getElementById("toast").getAttribute("role") === "alert"');
    assert.doesNotMatch(await js('document.getElementById("toast").textContent'), /synthetic-credential|raw provider payload/);
    assert.equal(await js('document.getElementById("story-ai-key").value'), '');
    await js('document.querySelector("[data-action=test-story-ai]").click()');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(await js('document.getElementById("toast").textContent'), /synthetic-credential|raw provider payload/);
    await js('storyTest.fail(false); document.querySelector("[data-action=clear-story-ai-key]").click()');
    await wait('!state.storyAI.keyStored');
    await js('document.querySelector(".nav-item[data-view=desk]").click()');
    assert.equal(await js('document.getElementById("top-start").disabled'), true);
    await js('document.querySelector("[data-config-key=storyEnabled]").click()');
    await wait('!state.config.storyEnabled && !state.preflightPending');
    assert.equal(await js('preflightChecks().every(check => check.ok)'), true);
    await js('document.querySelector("[data-action=diagnostics]").click()');
    await wait('document.getElementById("diagnostics-dialog").open');
    assert.doesNotMatch(await js('document.getElementById("diagnostic-text").value'), /synthetic-credential|apiKey|baseUrl/);
    await js('document.querySelector("[data-action=close-diagnostics]").click(); document.querySelector("[data-action=open-timeline]").click()');
    await wait('document.getElementById("story-analysis")');
    assert.match(await js('document.getElementById("story-analysis").textContent'), /synthetic.docx/);
    assert.match(await js('document.getElementById("story-analysis").textContent'), /model-a/);
    assert.match(await js('document.getElementById("story-analysis").textContent'), /80%/);
    await js('document.querySelector("#story-analysis details").open = true');
    assert.equal(await js('[...document.querySelectorAll("#story-analysis details p")].some(node => node.textContent.includes("重逢对白") && node.textContent.includes("待复核"))'), true);
    assert.match(await js('document.getElementById("story-analysis").textContent'), /留白/);
    await js('document.getElementById("story-analysis").scrollIntoView()');
    await capture('story-evidence-minimum.png');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Story UI passed: native directory drop, network disclosure, Chinese story progress, silence-only preflight, base-path guards, native safeStorage, secret-free config, model settings, story evidence, and minimum-window layout.');
    console.log(`Screenshots: ${screenshots}`);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    app.exit(1);
  }
});
