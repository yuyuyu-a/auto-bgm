'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'auto-bgm-settings-'));
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.on('browser-window-created', (_event, window) => window.hide());

const source = process.argv.includes('--installed')
  ? path.join(process.env.LOCALAPPDATA, 'Programs/auto-bgm/resources/app.asar')
  : process.argv.includes('--packaged')
    ? path.resolve(__dirname, '../release/win-unpacked/resources/app.asar')
    : path.resolve(__dirname, '..');
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET' || !['/v1/models', '/alternate/v1/models'].includes(request.url)) {
    response.writeHead(404);
    response.end(JSON.stringify({ error: { message: 'Unexpected fixture route' } }));
    return;
  }
  response.end(JSON.stringify({ data: [{ id: 'fixture-director' }, { id: 'fixture-backup' }] }));
});

require(path.join(source, 'desktop/main.js'));

app.whenReady().then(async () => {
  let window;
  let exitCode = 1;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    window = BrowserWindow.getAllWindows()[0];
    assert.ok(window, 'The real desktop main process must create its window');
    const js = (script) => window.webContents.executeJavaScript(script, true);
    const wait = async (script) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        if (await js(script)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(`Timed out: ${script}`);
    };
    await wait('typeof state !== "undefined" && state.version && !state.preflightPending');
    await js('document.querySelector(".nav-item[data-view=settings]").click()');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const key = 'local-settings-fixture-only';
    await js(`document.getElementById("story-ai-base-url").value = ${JSON.stringify(baseUrl)};
      document.getElementById("story-ai-model").value = "fixture-director";
      document.getElementById("story-ai-key").value = ${JSON.stringify(key)};
      document.querySelector("[data-action=story-ai-models]").click()`);
    await wait('!state.storyAIBusy');
    assert.equal(await js('state.storyModels.length'), 2,
      'Getting models after entering API settings must use the current form, not empty saved settings');
    assert.equal(await js('state.storyAI.keyStored'), true);
    assert.equal(await js('document.getElementById("story-ai-key").value'), '');
    assert.equal(await js('Boolean(document.getElementById("story-ai-key-saved"))'), true,
      'Saved credentials must show a persistent masked status instead of an empty password field');
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), true);
    assert.equal(await js('document.getElementById("story-ai-key-saved").checkVisibility()'), true);
    assert.equal(await js(`document.querySelector(".story-ai-settings").innerHTML.includes(${JSON.stringify(key)})`), false);
    assert.deepEqual(requests, [{ method: 'GET', url: '/v1/models', authorization: `Bearer ${key}` }]);
    console.log('PASS: first-use model discovery saves the current form through real IPC');

    const settingsPath = path.join(root, 'auto-bgm/story-ai.json');
    assert.equal((await fs.readFile(settingsPath, 'utf8')).includes(key), false);
    assert.equal(await js(`JSON.stringify(localStorage).includes(${JSON.stringify(key)})`), false);
    await js(`document.getElementById("story-ai-base-url").value = ${JSON.stringify(`${baseUrl}/alternate`)};
      document.getElementById("story-ai-model").value = "fixture-backup";
      document.querySelector("[data-action=test-story-ai]").click()`);
    await wait('!state.storyAIBusy');
    assert.equal(await js('document.getElementById("toast").textContent'), '连接正常');
    assert.equal(requests.at(-1).url, '/alternate/v1/models');
    assert.equal(requests.at(-1).authorization, `Bearer ${key}`);
    assert.equal(await js('state.storyAI.model'), 'fixture-backup');
    console.log('PASS: connection check uses edited settings and preserves an existing encrypted key');

    await js('document.querySelector("[data-action=replace-story-ai-key]").click()');
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), false);
    assert.equal(await js('document.getElementById("story-ai-key").type'), 'password');
    assert.equal(await js('document.activeElement.id'), 'story-ai-key');
    await js('document.getElementById("story-ai-key").value = "discard-this-draft"; document.querySelector("[data-action=cancel-story-ai-key]").click()');
    assert.equal(await js('document.getElementById("story-ai-key").value'), '');
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), true);
    await js('document.querySelector("[data-action=replace-story-ai-key]").click(); document.getElementById("story-ai-key").value = "unsaved-navigation-draft"; document.querySelector(".nav-item[data-view=desk]").click(); document.querySelector(".nav-item[data-view=settings]").click()');
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), true);
    assert.equal(await js('document.getElementById("story-ai-key").value'), '');
    await js('document.querySelector("[data-action=replace-story-ai-key]").click(); document.getElementById("story-ai-key").value = "unsaved-update-draft"; state.view = "about"; render(); document.querySelector(".nav-item[data-view=settings]").click()');
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), true,
      'Programmatic navigation away from settings must also restore the saved mask');
    const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload();
    await reloaded;
    await wait('typeof state !== "undefined" && state.version && !state.preflightPending');
    await js('document.querySelector(".nav-item[data-view=settings]").click()');
    assert.equal(await js('state.storyAI.keyStored'), true);
    assert.equal(await js('document.getElementById("story-ai-key-saved").checkVisibility()'), true);
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), true);
    await js('document.querySelector("[data-action=test-story-ai]").click()');
    await wait('!state.storyAIBusy');
    assert.equal(requests.at(-1).authorization, `Bearer ${key}`);
    console.log('PASS: saved mask survives reload; cancel/navigation discard replacement drafts; saved key still authenticates');

    const screenshots = path.resolve(__dirname, '../build/ux-verification');
    await fs.mkdir(screenshots, { recursive: true });
    const captureScreenshots = !process.argv.includes('--no-screenshots');
    if (!captureScreenshots) console.warn('SKIP: API-settings screenshots explicitly disabled; IPC, encryption and DOM layout assertions remain enabled.');
    await js('document.querySelector(".story-ai-settings").scrollIntoView()');
    if (captureScreenshots) await fs.writeFile(path.join(screenshots, 'api-settings-desktop.png'),
      (await window.webContents.capturePage()).toPNG());
    window.setContentSize(760, 520);
    await js('document.querySelector(".story-ai-settings").scrollIntoView()');
    assert.equal(await js('screen.scrollWidth <= screen.clientWidth'), true);
    assert.equal(await js('[...document.querySelectorAll(".story-ai-settings button")].every(node => node.scrollWidth <= node.clientWidth)'), true);
    if (captureScreenshots) await fs.writeFile(path.join(screenshots, 'api-settings-minimum.png'),
      (await window.webContents.capturePage()).toPNG());
    assert.equal(requests.every(({ method, url }) => method === 'GET' && url.endsWith('/models')), true);
    const replacement = 'local-settings-replacement-only';
    await js(`document.querySelector("[data-action=replace-story-ai-key]").click();
      document.getElementById("story-ai-key").value = ${JSON.stringify(replacement)};
      document.querySelector("[data-action=test-story-ai]").click()`);
    await wait('!state.storyAIBusy');
    assert.equal(requests.at(-1).authorization, `Bearer ${replacement}`);
    assert.equal(await js('document.getElementById("story-ai-key").value'), '');
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), true);
    assert.equal((await fs.readFile(settingsPath, 'utf8')).includes(replacement), false);
    assert.equal(await js(`JSON.stringify(localStorage).includes(${JSON.stringify(replacement)})`), false);
    await js('document.querySelector("[data-action=clear-story-ai-key]").click()');
    await wait('!state.storyAIBusy');
    assert.equal(await js('state.storyAI.keyStored'), false);
    assert.equal(await js('document.getElementById("story-ai-key").hidden'), false);
    assert.equal(await js('document.getElementById("story-ai-key-saved")'), null);
    assert.equal(JSON.parse(await fs.readFile(settingsPath, 'utf8')).encryptedApiKey, '');
    console.log('PASS: explicit replacement changes authorization; deleting returns to the initial empty field');
    console.log('PASS: native encryption, desktop/minimum layout, and no completion requests');
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    window?.destroy();
    app.exit(exitCode);
  }
});
