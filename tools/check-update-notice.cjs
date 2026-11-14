'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'auto-bgm-notice-'));
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const packaged = process.argv.includes('--packaged');
const source = path.resolve(__dirname, packaged ? '../release/win-unpacked/resources/app.asar' : '..');
const { createUpdateService } = require(path.join(source, 'desktop/update-service.js'));
const defaults = {
  videos: 'fixture-videos', music: 'fixture-music', output: 'fixture-output',
  modelPath: 'fixture-model', transcribe: false, outputAudio: true,
  outputVideo: false, outputTimeline: true, outputTranscript: false,
};
const batch = {
  rows: [], inputVideoCount: 1, musicGroups: [{ mood: 'fixture', count: 1 }],
  paths: Object.fromEntries(['videos', 'music', 'output'].map((key) => [key, { status: 'available' }])),
  model: { exists: true }, tools: { ffmpeg: { available: true }, ffprobe: { available: true } },
  warning: null, validationError: '',
};
const profile = { baseUrl: '', model: '', keyStored: false };
const calls = [];
const gates = new Map();
const updater = new EventEmitter();
let window;
let download;
let downloadAttempts = 0;
let nextVersion = '1.0.2';
const notes = '\u6539\u8fdb\u66f4\u65b0\u63d0\u9192\u3002\n\u4fdd\u7559\u624b\u52a8\u4e0b\u8f7d\u548c\u5b89\u88c5\u3002';
const releaseInfo = (version, releaseNotes = notes) => ({
  version, releaseNotes, releaseDate: '2026-11-14T00:00:00Z', files: [{ size: 120000000 }],
});
const service = createUpdateService({
  updater, currentVersion: '1.0.1',
  emit: (value) => window?.webContents.send('notice-fixture:update', value),
  createCancellationToken: () => ({
    cancel: () => { updater.emit('update-cancelled', releaseInfo(nextVersion)); download?.resolve(); },
  }),
});
updater.checkForUpdates = async () => { updater.emit('update-available', releaseInfo(nextVersion)); };
updater.downloadUpdate = async () => {
  downloadAttempts += 1;
  if (downloadAttempts === 1) throw new Error('Local download fixture failed');
  await new Promise((resolve) => { download = { resolve }; });
};
updater.quitAndInstall = () => { throw new Error('The notice must never install automatically'); };

function hold(method) {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  const gate = { promise, resolve, reject };
  gates.set(method, gate);
  return gate;
}

ipcMain.handle('notice-fixture:call', async (_event, method, args) => {
  calls.push({ method, args });
  const gate = gates.get(method);
  if (gate) {
    gates.delete(method);
    try { await gate.promise; }
    catch (error) { return { noticeFixtureError: error.message }; }
  }
  switch (method) {
    case 'appInfo': return { defaults, version: '1.0.1', update: service.getState(), storyAI: profile };
    case 'inspectBatch': return batch;
    case 'startBatch': return { started: true };
    case 'checkMusicLibrary': return { total: 0, usable: 0, files: [], musicGroups: [], emptyDirectories: [], duplicates: [] };
    case 'saveStoryAISettings':
      Object.assign(profile, { baseUrl: args[0].baseUrl || '', model: args[0].model || '', keyStored: Boolean(args[0].apiKey) });
      return profile;
    case 'storyAIModels': return ['fixture-director'];
    case 'testStoryAI': return { ok: true };
    case 'previewDiagnostics': return '{"fixture":"redacted"}';
    case 'copyDiagnostics': return { copied: true };
    case 'checkForUpdates': return service.check({ manual: true });
    case 'downloadUpdate': return service.download();
    case 'cancelUpdate': return service.cancelDownload();
    case 'installUpdate': return service.install();
    case 'openUpdatePage': throw new Error('External navigation is forbidden in this harness');
    default: throw new Error(`Unexpected fixture method: ${method}`);
  }
});

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const startup = hold('appInfo');
    const preflight = hold('inspectBatch');
    const errors = [];
    const networkRequests = [];
    window = new BrowserWindow({
      show: false, width: 1440, height: 900, useContentSize: true,
      webPreferences: {
        preload: path.join(__dirname, 'check-update-notice-preload.cjs'),
        contextIsolation: true, sandbox: true, backgroundThrottling: false,
      },
    });
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => { networkRequests.push(details.url); callback({ cancel: true }); },
    );
    window.webContents.setWindowOpenHandler(() => { throw new Error('Unexpected popup'); });
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    const js = (script) => window.webContents.executeJavaScript(script, true);
    const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
    const wait = async (script) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        if (await js(script)) return;
        await pause(30);
      }
      throw new Error(`Timed out: ${script}\n${errors.join('\n')}`);
    };
    const count = (method) => calls.filter((call) => call.method === method).length;
    const waitCall = async (method, previous = 0) => {
      const until = Date.now() + 10000;
      while (count(method) <= previous && Date.now() < until) await pause(30);
      assert.ok(count(method) > previous, `Expected the renderer to call ${method}`);
    };
    const open = 'Boolean(document.getElementById("update-notice-dialog")?.open)';
    const assertClosed = async (reason) => {
      await pause(350);
      assert.equal(await js(open), false, reason);
    };
    const available = (version, text = notes) => {
      nextVersion = version;
      updater.emit('update-available', releaseInfo(version, text));
    };
    const dismiss = async () => {
      await js('document.querySelector("#update-notice-dialog [data-action=later-update]").click()');
      await assertClosed('Later must dismiss without reopening');
    };
    const escape = async () => {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await wait(`!(${open})`);
    };
    const reload = async () => {
      window.webContents.reload();
      await wait('typeof state !== "undefined" && state.version && !state.preflightPending && document.querySelector(".view")');
      await pause(350);
    };
    const screenshots = path.resolve(__dirname, '../build/ux-verification');
    await fs.mkdir(screenshots, { recursive: true });
    const capture = async (name, width, height) => {
      // A real resize flushes stale compositor frames in a hidden test window.
      window.setContentSize(width + 1, height);
      await wait(`innerWidth === ${width + 1} && innerHeight === ${height}`);
      await pause(100);
      window.setContentSize(width, height);
      await wait(`innerWidth === ${width} && innerHeight === ${height}`);
      await pause(150);
      const geometry = await js(`(() => {
        const dialog = document.getElementById("update-notice-dialog");
        const bounds = dialog.getBoundingClientRect();
        const buttons = [...dialog.querySelectorAll("button")];
        return {
          viewport: [innerWidth, innerHeight],
          panelPixel: { x: Math.ceil(bounds.left) + 12, y: Math.ceil(bounds.top) + 12, width: 1, height: 1 },
          contained: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
          overflow: dialog.scrollWidth > dialog.clientWidth,
          buttonsVisible: buttons.every(button => {
            const rect = button.getBoundingClientRect();
            return rect.top >= bounds.top && rect.bottom <= bounds.bottom && button.scrollWidth <= button.clientWidth;
          }),
          focusInside: dialog.contains(document.activeElement),
        };
      })()`);
      assert.deepEqual(geometry.viewport, [width, height]);
      assert.equal(geometry.contained && geometry.buttonsVisible && geometry.focusInside && !geometry.overflow, true,
        `Dialog and actions must fit at ${width}x${height}: ${JSON.stringify(geometry)}`);
      const image = await window.webContents.capturePage();
      assert.equal(image.isEmpty(), false);
      assert.deepEqual(image.getSize(), { width, height }, 'Screenshots must have deterministic viewport pixels');
      const pixel = [...image.crop(geometry.panelPixel).toBitmap()].slice(0, 3);
      assert.equal(pixel.every((value) => value >= 252), true,
        `Screenshot must contain the white dialog panel, not a stale background frame: ${pixel}`);
      const bitmap = image.toBitmap();
      assert.ok(bitmap.some((value, index) => index % 4 !== 3 && value !== bitmap[0]), 'Screenshot must not be blank');
      const filename = `update-notice-${name}${packaged ? '-packaged' : ''}.png`;
      await fs.writeFile(path.join(screenshots, filename), image.toPNG());
      console.log(`Screenshot: ${path.join(screenshots, filename)}`);
    };
    const assertNoAutomaticActions = () => {
      assert.equal(count('installUpdate'), 0, 'No implicit install or restart');
      assert.equal(count('openUpdatePage'), 0, 'No implicit external navigation');
      assert.equal(updater.autoDownload, false);
      assert.equal(updater.autoInstallOnAppQuit, false);
      assert.equal(updater.allowPrerelease, false);
      assert.equal(updater.allowDowngrade, false);
    };

    await window.loadFile(path.join(source, 'desktop/renderer/index.html'));
    await waitCall('appInfo');
    available('1.0.2');
    await assertClosed('An early update event must wait for app info');
    startup.resolve();
    await waitCall('inspectBatch');
    await assertClosed('An available update must wait for initial preflight');
    preflight.resolve();
    await wait('state.version && !state.preflightPending && document.querySelector(".view")');
    await pause(200);
    assert.equal(await js(open), true,
      'Missing visible update dialog: an enabled available update must be announced when the real renderer is idle');
    assert.equal(await js('document.getElementById("update-notice-title").textContent'), '\u53d1\u73b0\u65b0\u7248\u672c');
    assert.equal(await js('document.getElementById("update-notice-version").textContent'), 'v1.0.2');
    assert.equal(await js('document.getElementById("update-notice-notes").textContent'), notes);
    assert.equal(count('downloadUpdate'), 0, 'Discovery must not download');
    assertNoAutomaticActions();
    await capture('desktop', 1440, 900);
    await dismiss();
    await reload();
    await assertClosed('Later acknowledgement must survive reload');
    available('1.0.2');
    await assertClosed('Repeated events must not repeat an acknowledged version');
    console.log('PASS: real-renderer idle discovery, startup gating, Later and reload acknowledgement');

    await js(`window.keyboardFixture = {
      originalActiveMedia: activeMedia, originalSeekMedia: seekMedia,
      media: { paused: true, currentTime: 10, plays: 0, pauses: 0,
        play() { this.paused = false; this.plays++; },
        pause() { this.paused = true; this.pauses++; } },
      seeks: [],
      reset() { Object.assign(this.media, { paused: true, currentTime: 10, plays: 0, pauses: 0 }); this.seeks = []; },
      press(target, keys) {
        target.focus();
        return keys.map(key => {
          const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        });
      },
      snapshot() {
        const { paused, currentTime, plays, pauses } = this.media;
        return { paused, currentTime, plays, pauses, seeks: [...this.seeks] };
      },
    };
    activeMedia = () => keyboardFixture.media;
    seekMedia = time => { keyboardFixture.seeks.push(time); keyboardFixture.media.currentTime = time; }; void 0;`);
    const unchangedMedia = { paused: true, currentTime: 10, plays: 0, pauses: 0, seeks: [] };
    for (const [index, view] of ['timeline', 'transcript'].entries()) {
      await js(`state.view = ${JSON.stringify(view)}; render(); keyboardFixture.reset()`);
      available(`1.0.${20 + index}`);
      await wait(open);
      assert.deepEqual(await js('keyboardFixture.press(document.getElementById("update-notice-notes"), [" ", "ArrowLeft", "ArrowRight"])'),
        [false, false, false], `${view}: update notes must retain native Space/arrow behavior`);
      assert.deepEqual(await js('keyboardFixture.snapshot()'), unchangedMedia, `${view}: update notes must not play or seek background media`);
      await escape();
      await js('document.getElementById("diagnostics-dialog").showModal(); document.getElementById("diagnostics-title").tabIndex = -1');
      assert.deepEqual(await js('keyboardFixture.press(document.getElementById("diagnostics-title"), [" ", "ArrowLeft", "ArrowRight"])'),
        [false, false, false], `${view}: diagnostics must not consume playback shortcuts`);
      assert.deepEqual(await js('keyboardFixture.snapshot()'), unchangedMedia, `${view}: diagnostics must protect background media`);
      await js('document.getElementById("diagnostics-dialog").close(); screen.tabIndex = -1');
      assert.deepEqual(await js('keyboardFixture.press(screen, [" ", "ArrowLeft", "ArrowRight", " "])'),
        [true, true, true, true], `${view}: normal playback shortcuts must remain enabled outside dialogs`);
      assert.deepEqual(await js('keyboardFixture.snapshot()'),
        { paused: true, currentTime: 10, plays: 1, pauses: 1, seeks: [5, 10] });
    }
    await js('activeMedia = keyboardFixture.originalActiveMedia; seekMedia = keyboardFixture.originalSeekMedia; delete window.keyboardFixture; state.view = "desk"; render()');
    console.log('PASS: dialog Space/arrows leave media and native defaults untouched; Escape and normal playback shortcuts work');

    available('1.0.3');
    await wait(open);
    await escape();
    await reload();
    await assertClosed('Native Escape must persist acknowledgement');
    available('1.0.2');
    await assertClosed('Acknowledgements are per version, not just the last seen version');
    available('1.0.4');
    await wait(open);
    const malicious = '<img src="https://fixture.invalid/note" onerror="window.noticeInjected=true"><script>window.noticeInjected=true</script>';
    const maliciousVersion = '1.0.5<svg onload="window.noticeInjected=true">';
    available(maliciousVersion, malicious);
    await wait(`document.getElementById("update-notice-version").textContent === ${JSON.stringify(`v${maliciousVersion}`)}`);
    assert.equal(await js('document.getElementById("update-notice-notes").textContent'), malicious);
    assert.equal(await js('Boolean(window.noticeInjected || document.querySelector("#update-notice-dialog img, #update-notice-dialog svg, #update-notice-dialog script"))'), false);
    await dismiss();
    const longNotes = `${notes}\n\n${('Release notes with a long detail line. '.repeat(12) + '\n\n').repeat(30)}${'x'.repeat(1500)}`;
    available('1.0.6', longNotes);
    await wait(open);
    await capture('minimum', 760, 520);
    assert.equal(await js('document.getElementById("update-notice-notes").scrollHeight > document.getElementById("update-notice-notes").clientHeight'), true,
      'Long notes must scroll independently of the actions');
    await js('document.getElementById("update-notice-notes").scrollTop = 100000');
    assert.equal(await js('document.getElementById("update-notice-notes").scrollWidth <= document.getElementById("update-notice-notes").clientWidth'), true);
    await dismiss();
    window.setContentSize(1440, 900);
    console.log('PASS: native Escape, later versions, safe text, long notes, desktop/minimum layout');

    for (const status of ['idle', 'checking', 'downloading', 'downloaded', 'installing', 'not-available', 'error']) {
      window.webContents.send('notice-fixture:update', { ...service.getState(), version: '2.0.0', status });
      await assertClosed(`The ${status} state must not announce an available update`);
    }
    window.webContents.send('notice-fixture:update', { ...service.getState(), version: '2.0.0', status: 'available', enabled: false });
    await assertClosed('Disabled updaters must not announce');
    available('2.0.0');
    await wait(open);
    await dismiss();
    available('2.0.1');
    await wait(open);
    updater.emit('update-not-available');
    await assertClosed('A withdrawn update must close its stale notice');
    available('2.0.1');
    await wait(open);
    window.webContents.send('notice-fixture:batch', { type: 'started' });
    await wait('state.running');
    await assertClosed('A newly started batch must close an open notice without acknowledging it');
    window.webContents.send('notice-fixture:batch', { type: 'finished', summary: {} });
    await wait(open);
    await dismiss();

    for (const type of ['finished', 'stopped', 'error']) {
      window.webContents.send('notice-fixture:batch', { type: 'started' });
      await wait('state.running');
      available(`2.1.${['finished', 'stopped', 'error'].indexOf(type)}`);
      await assertClosed('Running work must defer the notice without acknowledging it');
      assert.equal(await js('document.querySelector(".update-dot").classList.contains("visible")'), true);
      const inspection = hold('inspectBatch');
      const previous = count('inspectBatch');
      window.webContents.send('notice-fixture:batch', { type, message: 'Local batch fixture settled', summary: {} });
      await waitCall('inspectBatch', previous);
      await assertClosed('Post-run preflight must finish before announcing');
      inspection.resolve();
      await wait(open);
      await dismiss();
    }
    const startingInspection = hold('inspectBatch');
    const starting = hold('startBatch');
    const previousInspections = count('inspectBatch');
    await js('document.getElementById("top-start").click()');
    await waitCall('inspectBatch', previousInspections);
    available('2.2.0');
    await assertClosed('Starting validation must defer a newly discovered update');
    startingInspection.resolve();
    await waitCall('startBatch');
    await assertClosed('An outstanding start request must defer the notice');
    starting.resolve();
    await wait(open);
    await dismiss();
    console.log('PASS: enabled/available guards, running/finished/stopped/error and starting-to-idle deferral');

    const library = hold('checkMusicLibrary');
    await js('document.querySelector("[data-action=analyze-library]").click()');
    await waitCall('checkMusicLibrary');
    available('2.3.0');
    await assertClosed('Library analysis must defer the notice');
    library.resolve();
    await wait(open);
    await dismiss();
    await js('document.querySelector(".nav-item[data-view=settings]").click()');
    for (const [index, method, action] of [
      [0, 'saveStoryAISettings', 'save-story-ai'],
      [1, 'storyAIModels', 'story-ai-models'],
      [2, 'testStoryAI', 'test-story-ai'],
    ]) {
      const pending = hold(method);
      const previous = count(method);
      await js(`document.querySelector("[data-action=${action}]").click()`);
      await waitCall(method, previous);
      available(`2.4.${index}`);
      await assertClosed('API settings work must defer the notice');
      if (method === 'testStoryAI') pending.reject(new Error('Local API fixture failed'));
      else pending.resolve();
      await wait(open);
      await dismiss();
    }
    await js('document.querySelector(".nav-item[data-view=desk]").click(); document.querySelector("[data-action=diagnostics]").click()');
    await wait('document.getElementById("diagnostics-dialog").open');
    available('2.5.0');
    await assertClosed('Another modal must not be interrupted');
    await js('document.querySelector("[data-action=close-diagnostics]").click()');
    await wait(open);
    await dismiss();
    await js('document.querySelector("[data-action=diagnostics]").click()');
    await wait('document.getElementById("diagnostics-dialog").open');
    available('2.5.1');
    await assertClosed('Another modal must defer before native Escape');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait(open);
    await dismiss();
    console.log('PASS: library/API actions and modal close/Escape reconsider notices on idle');

    available('3.0.0');
    await wait(open);
    await js('document.querySelector("#update-notice-dialog [data-action=download-update]").click()');
    await wait('state.view === "about" && state.update.status === "error"');
    await assertClosed('A failed download must not reopen its acknowledged notice');
    assert.match(await js('document.querySelector(".update-body").textContent'), /Local download fixture failed/);
    assert.equal(count('downloadUpdate'), 1, 'Only the Download click may start the first attempt');
    await js('document.querySelector("[data-action=check-update]").click()');
    await wait('state.update.status === "available"');
    await assertClosed('A retry check must retain notice acknowledgement');
    assert.equal(count('downloadUpdate'), 1, 'Retry discovery must not implicitly download');
    await js('document.querySelector(".update-panel [data-action=download-update]").click()');
    await wait('state.update.status === "downloading"');
    updater.emit('download-progress', { percent: 37, transferred: 37000000, total: 100000000, bytesPerSecond: 1000000 });
    await wait('document.querySelector(".update-progress")?.getAttribute("aria-valuenow") === "37"');
    updater.emit('update-downloaded', releaseInfo('3.0.0'));
    download.resolve();
    await wait('document.querySelector("[data-action=install-update]")');
    assert.equal(count('downloadUpdate'), 2);
    assertNoAutomaticActions();
    await js('document.querySelector("[data-action=defer-update]").click()');
    await reload();
    await assertClosed('Downloaded updates must not prompt or install on reload');
    available('3.0.0');
    await assertClosed('Download acknowledgement must survive reload');
    available('3.0.1');
    await wait(open);
    await js('document.querySelector("#update-notice-dialog [data-action=download-update]").click()');
    await wait('state.update.status === "downloading"');
    await js('document.querySelector("[data-action=cancel-update]").click()');
    await wait('state.update.status === "available"');
    await assertClosed('Cancelling the download must not reopen the notice');
    assertNoAutomaticActions();
    assert.equal(networkRequests.length, 0, `No live network is allowed: ${networkRequests.join(', ')}`);
    assert.deepEqual(errors, [], 'Renderer must not report errors');
    console.log('PASS: Download hands off to About, failure/manual retry, progress, cancel, no automatic download/install');
    console.log(`Update notice checks passed (${packaged ? 'packaged app.asar' : 'source'}); isolated profile: ${root}`);
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    service.dispose();
    ipcMain.removeHandler('notice-fixture:call');
    window?.destroy();
    app.exit(exitCode);
  }
});
