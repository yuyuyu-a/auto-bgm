'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const root = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bgm-ui-check-'));
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  let window;
  try {
    const media = path.join(root, 'preview.webm');
    const audio = path.join(root, 'preview.wav');
    const ffmpeg = process.env.FFMPEG || 'ffmpeg';
    const execute = promisify(execFile);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', media], { windowsHide: true });
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', media, '-vn', '-c:a', 'pcm_s16le', audio], { windowsHide: true });
    const defaults = { videos: media, music: root, output: root, modelPath: root, transcribe: false, outputAudio: true, outputVideo: true, outputTimeline: true, outputTranscript: false, minTracksPerEpisode: 1, maxTracksPerEpisode: 3, maxTrackDuration: require('../desktop/backend/batch-service').getInfo().defaults.maxTrackDuration, skipCompleted: true };
    const run = { config: defaults, startedAt: Date.now(), total: 60, currentIndex: 12, currentEpisode: '第12集', currentStage: 'rendering-video', settled: 11, counts: { completed: 9, skipped: 1, failed: 1, interrupted: 0 }, status: 'running', estimatedRemainingMs: null };
    const rows = Array.from({ length: 60 }, (_, i) => ({ episode: `第${i + 1}集`, status: i === 49 ? 'failed' : i < 11 ? 'completed' : 'pending', videoPath: media, duration: 5, tracks: ['calm.wav'] }));
    const detail = { episode: '第1集', duration: 5, status: 'completed', mood: '平静 → 紧张', finalVideoExists: true, finalVideoPath: media, finalVideoUrl: pathToFileURL(media).href, outputPath: audio, audioUrl: pathToFileURL(audio).href, timelinePath: '', transcriptPath: '', transcript: [{ start: .2, end: .8, text: '第一句' }, { start: 1.2, end: 1.8, text: '小心，快跑' }], timeline: [{ start: 0, end: 1, mood: '平静', bgm_file: 'calm.wav', selection_reason: '开场对白', duckSegments: [] }, { start: 1, end: 5, mood: '紧张', bgm_file: 'tense.wav', selection_reason: '危险关键词', duckSegments: [{ start: 1.2, end: 1.8 }] }] };
    const batch = { rows, paths: Object.fromEntries(['videos', 'music', 'output'].map((key) => [key, { status: 'available', label: '可用' }])), model: { exists: true, sizeBytes: 1024 }, tools: { ffmpeg: { available: true }, ffprobe: { available: true } }, musicGroups: [{ mood: '默认', count: 2 }, { mood: '紧张', count: 1 }], musicCount: 2, warning: null, validationError: '', inputVideoCount: 60 };
    detail.analysis = { version: 'conservative-scenes-words-v2', strictInstrumental: true, wordTimestamps: true, ducking: { enabled: true, db: -10 }, sceneCandidates: [{ time: 1, used: true }], segments: [{ start: 0, end: 5, reason: '持续对白证据', review: true }] };
    const library = { total: 2, usable: 1, musicGroups: [], emptyDirectories: [], unavailableMoods: [], nameDuplicateCount: 1, duplicates: [
      { file: path.join(root, 'album', 'instrumental.wav'), original: path.join(root, 'instrumental.wav'), kind: 'name' },
    ], files: [
      { file: path.join(root, 'suspect.wav'), fileUrl: pathToFileURL(audio).href, playable: true, eligible: false, status: 'unknown', analysis: { intervals: [{ start: 1.2, end: 1.8, label: 'Humming' }] } },
      { file: path.join(root, 'instrumental.wav'), fileUrl: pathToFileURL(audio).href, playable: true, eligible: true, status: 'instrumental' },
    ] };
    const fixture = { info: { defaults, running: true, run, version: 'test', logs: [] }, batch, detail, library };
    await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify(fixture));
    window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(__dirname, 'check-workbench-preload.cjs'), additionalArguments: [`--bgm-test-root=${root}`], contextIsolation: true, sandbox: false, backgroundThrottling: false } });
    window.webContents.setAudioMuted(true);
    const errors = [];
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const js = async (source) => {
      try { return await window.webContents.executeJavaScript(source, true); }
      catch (error) { throw new Error(`${source}\n${error.message}\n${errors.join('\n')}`); }
    };
    const waitFor = async (source) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) { if (await js(source)) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
      throw new Error(`Timed out: ${source}`);
    };
    await window.loadFile(path.resolve(__dirname, '../desktop/renderer/index.html'));
    await waitFor('document.querySelectorAll("#queue-body tr").length === 60');
    assert.match(await js('preflightChecks().find(check => check.name === "BGM").label'), /^2 首/);
    assert.equal(await js('document.getElementById("top-start").textContent'), '停止批次');
    assert.match(await js('document.getElementById("batch-progress").textContent'), /12 \/ 60/);
    await js('window.savedInput = document.getElementById("config-videos"); savedInput.focus(); savedInput.setSelectionRange(2, 4); workbenchTest.emitBatch({type:"log", message:"progress while editing"});');
    await waitFor('document.getElementById("run-logs").textContent.includes("progress while editing")');
    assert.equal(await js('savedInput === document.activeElement && savedInput.selectionStart === 2 && savedInput.selectionEnd === 4'), true);
    await js('const search = document.getElementById("queue-search"); search.value="第50集"; search.dispatchEvent(new Event("input",{bubbles:true})); document.getElementById("queue-filter").value="failed"; document.getElementById("queue-filter").dispatchEvent(new Event("change",{bubbles:true}));');
    assert.equal(await js('document.querySelectorAll("#queue-body tr:not([hidden])").length'), 1);
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
    await capture('desk.png');
    await js('document.querySelector(".nav-item[data-view=transcript]").click()');
    await waitFor('document.getElementById("final-video")?.readyState >= 1');
    await js('window.savedVideo=document.getElementById("final-video"); window.savedAudio=document.getElementById("preview-audio"); document.querySelectorAll(".transcript-line")[1].click()');
    await waitFor('Math.abs(savedVideo.currentTime - 1.2) < .1');
    await js('document.querySelector("[data-action=media-mode][data-mode=audio]").click()');
    await waitFor('savedAudio.readyState >= 1 && Math.abs(savedAudio.currentTime - 1.2) < .1');
    await js('document.querySelector("[data-action=play-line]").click(); for(let i=0;i<12;i++) workbenchTest.emitBatch({type:"log",message:"live-"+i}); workbenchTest.emitUpdate({status:"downloading",percent:30});');
    await waitFor('savedAudio.paused && savedAudio.currentTime >= 1.8');
    assert.equal(await js('savedVideo === document.getElementById("final-video") && savedAudio === document.getElementById("preview-audio")'), true);
    assert.equal(await js('document.querySelector(".nav-item[data-view=transcript]").getAttribute("aria-current")'), 'page');
    await js('document.querySelector("[data-action=media-mode][data-mode=video]").click()');
    await waitFor('savedVideo.readyState >= 2 && !savedVideo.seeking');
    assert.equal(await js('getComputedStyle(document.querySelector(".transcript-side")).overflowY'), 'auto');
    await capture('transcript.png');
    window.setContentSize(1200, 600);
    await waitFor('document.querySelector(".transcript-side").clientHeight <= 460');
    await js('document.querySelector(".transcript-side").scrollTop = 1000');
    assert.equal(await js('document.querySelector(".transcript-side").scrollTop > 0'), true);
    await capture('short-window.png');
    window.setContentSize(900, 640);
    await waitFor('getComputedStyle(document.querySelector(".transcript-side")).position === "static"');
    assert.equal(await js('getComputedStyle(document.querySelector(".transcript-side")).overflowY'), 'visible');
    assert.equal(await js('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth'), true);
    await capture('narrow.png');
    window.setContentSize(760, 520);
    await waitFor('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth');
    await capture('minimum-window.png');
    await js('document.querySelector("[data-action=open-timeline]").click()');
    await waitFor('document.querySelectorAll(".track-block.music").length > 1');
    assert.match(await js('document.getElementById("screen").textContent'), /严格筛选/);
    await js('document.querySelectorAll(".track-block.music")[1].click()');
    assert.match(await js('document.getElementById("bookmark-reason").textContent'), /危险关键词/);
    assert.equal(await js('document.querySelectorAll(".track-block.music")[1].getAttribute("aria-pressed")'), 'true');
    await js('document.querySelector(".media-shortcuts").focus(); document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));');
    assert.equal(await js('state.playbackTime >= 5'), true);
    await js('document.querySelector(".nav-item[data-view=settings]").click(); window.settingsInput=document.getElementById("config-minTracksPerEpisode"); settingsInput.focus(); workbenchTest.emitBatch({type:"progress",episode:"第12集",status:"processing"});');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await js('settingsInput === document.activeElement'), true);
    assert.equal(await js('document.getElementById("config-maxTrackDuration")?.type'), 'number');
    assert.equal(await js('document.getElementById("config-maxTrackDuration").value'), '40');
    assert.equal(await js('document.getElementById("config-maxTrackDuration").disabled'), false);
    assert.match(await js('document.getElementById("track-duration-status").textContent'), /40.*秒/);
    assert.match(await js('document.getElementById("screen").textContent'), /已完成.*不会自动|不会自动.*已完成/);
    assert.equal(await js('document.getElementById("config-scenePriority").checked'), true);
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").disabled'), true);
    assert.match(await js('document.getElementById("screen").textContent'), /转场必须换，情绪变化也换/);
    await js('document.getElementById("music-limit-custom").click()');
    assert.equal(await js('JSON.parse(localStorage.getItem("bgm-studio-config")).scenePriority'), false);
    assert.equal(await js('loadConfig(state.defaults).scenePriority'), false);
    assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").disabled'), false);
    await waitFor('document.getElementById("config-scenePriority")?.checked === false');
    await js('document.getElementById("config-scenePriority").click()');
    assert.equal(await js('state.config.scenePriority'), true);
    assert.equal(await js('document.getElementById("music-limit-unlimited").checked'), true);
    assert.equal(await js('document.getElementById("config-maxTracksPerEpisode").disabled'), true);
    assert.match(await js('document.getElementById("screen").textContent'), /每集至少使用不同曲目/);
    assert.doesNotMatch(await js('document.getElementById("screen").textContent'), /参考下限|只作参考/);
    window.setContentSize(1440, 900);
    await capture('scene-priority-settings.png');
    await js('document.querySelector(".nav-item[data-view=desk]").click(); document.querySelector("[data-action=diagnostics]").click()');
    await waitFor('document.getElementById("diagnostics-dialog").open');
    assert.match(await js('document.getElementById("diagnostic-text").value'), /已脱敏/);
    await js('document.getElementById("copy-diagnostics").click()');
    await waitFor('workbenchTest.calls().some(call => call.action === "copy")');
    await js('document.getElementById("config-preset").value="preview"; document.getElementById("config-preset").dispatchEvent(new Event("change",{bubbles:true}));');
    await waitFor('!document.querySelector("[data-config-key=transcribe]").checked');
    assert.equal(await js('JSON.parse(localStorage.getItem("bgm-studio-config")).outputVideo'), false);
    await window.reload();
    await waitFor('document.querySelectorAll("#queue-body tr").length === 60');
    assert.equal(await js('document.getElementById("top-start").textContent'), '停止批次');
    assert.equal(await js('workbenchTest.calls().filter(call => call.action === "start").length'), 0);
    await js('workbenchTest.emitBatch({type:"finished",summary:{completed:9,skipped:1,failed:1},run:{...state.run,status:"finished",currentStage:"finished"}})');
    await waitFor('document.getElementById("top-start").textContent === "开始批次"');
    fixture.info.running = false;
    fixture.info.run = { ...run, status: 'finished', currentStage: 'finished' };
    await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify(fixture));
    const reloadSettings = async () => {
      await window.reload();
      await waitFor('document.querySelectorAll("#queue-body tr").length === 60');
      await js('document.querySelector(".nav-item[data-view=settings]").click()');
    };
    await js('delete state.config.maxTrackDuration; saveConfig()');
    await reloadSettings();
    assert.equal(await js('document.getElementById("config-maxTrackDuration").value'), '40',
      'Old saved settings without a duration must use the 40-second default');
    assert.equal(await js('state.config.skipCompleted'), true);
    assert.equal(await js('workbenchTest.calls().filter(call => call.action === "start").length'), 0);
    for (const value of ['', '-1']) {
      await js(`{ const input=document.getElementById("config-maxTrackDuration"); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event("input",{bubbles:true})); }`);
      assert.equal(await js('state.config.maxTrackDuration'), value === '' ? '' : -1);
      assert.equal(await js('document.getElementById("config-maxTrackDuration").validity.valid'), false);
      assert.match(await js('document.getElementById("track-duration-status").textContent'), /非负数字/);
    }
    const durationPayloads = [];
    for (const seconds of [40, 37.5, 0]) {
      await js(`{ const input=document.getElementById("config-maxTrackDuration"); input.value="${seconds}"; input.dispatchEvent(new Event("input",{bubbles:true})); }`);
      assert.equal(await js('state.config.maxTrackDuration'), seconds);
      assert.equal(await js('JSON.parse(localStorage.getItem("bgm-studio-config")).maxTrackDuration'), seconds);
      assert.match(await js('document.getElementById("track-duration-status").textContent'),
        seconds === 0 ? /不限制/ : new RegExp(`${seconds}.*秒`));
      await js('document.getElementById("config-maxTrackDuration").dispatchEvent(new Event("change",{bubbles:true}))');
      await reloadSettings();
      assert.equal(await js('document.getElementById("config-maxTrackDuration").value'), String(seconds));
      assert.equal(await js('typeof state.config.maxTrackDuration'), 'number');
      assert.equal(await js('document.getElementById("config-maxTrackDuration").disabled'), false);
      assert.match(await js('document.getElementById("track-duration-status").textContent'),
        seconds === 0 ? /不限制/ : new RegExp(`${seconds}.*秒`));
      assert.equal(await js('workbenchTest.calls().filter(call => call.action === "start").length'), 0,
        'Saving and reloading settings must not regenerate completed outputs');
      window.setContentSize(1440, 900);
      await js('document.getElementById("config-maxTrackDuration").scrollIntoView({block:"center"})');
      await capture(`track-duration-${seconds}-desktop.png`);
      window.setContentSize(760, 520);
      await waitFor('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth');
      await js('document.getElementById("config-maxTrackDuration").scrollIntoView({block:"center"})');
      assert.equal(await js('(() => { const input=document.getElementById("config-maxTrackDuration").getBoundingClientRect(); const status=document.getElementById("track-duration-status").getBoundingClientRect(); return input.left >= 0 && input.right <= innerWidth && input.bottom <= status.top; })()'), true);
      await capture(`track-duration-${seconds}-minimum.png`);
      await js('document.querySelector(".nav-item[data-view=desk]").click(); document.getElementById("top-start").click()');
      await waitFor('!state.starting && workbenchTest.calls().some(call => call.action === "start")');
      const payload = await js('workbenchTest.calls().find(call => call.action === "start").config');
      assert.equal(payload.maxTrackDuration, seconds);
      assert.equal(payload.skipCompleted, true);
      assert.equal(payload.overwrite, false);
      durationPayloads.push(payload);
      await js('workbenchTest.emitBatch({type:"finished",summary:{completed:9,skipped:1,failed:1},run:{...state.run,status:"finished",currentStage:"finished"}})');
      await waitFor('document.getElementById("top-start").textContent === "开始批次"');
      await js('document.querySelector(".nav-item[data-view=settings]").click()');
    }
    await js('document.querySelector("[data-config-key=transitionFadeEnabled]").click()');
    assert.equal(await js('document.getElementById("config-transitionFadeDuration").disabled'), true);
    assert.equal(await js('document.getElementById("config-maxTrackDuration").disabled'), false,
      'The track duration limit must remain editable when transition fades are disabled');
    await js('document.querySelector("[data-config-key=transitionFadeEnabled]").click()');
    for (const [stored, expected] of [['0', 0], [' 27.25 ', 27.25], ['', 40], [null, 40], [false, 40], [true, 40], [-1, 40], ['Infinity', 40]]) {
      await js(`localStorage.setItem("bgm-studio-config", JSON.stringify({...state.config,maxTrackDuration:${JSON.stringify(stored)}}))`);
      assert.equal(await js('loadConfig(state.defaults).maxTrackDuration'), expected);
    }
    await js('saveConfig(); document.querySelector(".nav-item[data-view=desk]").click()');
    assert.doesNotMatch(await js('document.querySelector(".config-details").textContent'), /曲目不足时.*留白/);
    await fs.writeFile(path.join(screenshots, 'track-duration-payloads.json'), JSON.stringify(durationPayloads, null, 2));
    window.setContentSize(1440, 900);
    await js('document.querySelector("[data-action=check-library]").click()');
    await waitFor('document.querySelectorAll(".library-track").length === 2');
    assert.match(await js('document.querySelector(".library-health").textContent'), /已跳过同名副本 1 份/);
    assert.match(await js('document.querySelector(".library-health ul").textContent'), /同名已跳过/);
    assert.doesNotMatch(await js('document.querySelector(".library-health ul").textContent'), /内容重复/);
    await js('document.getElementById("library-result").scrollIntoView({block:"center"})');
    await capture('library-name-dedup.png');
    window.setContentSize(760, 520);
    await waitFor('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth');
    await js('document.getElementById("library-result").scrollIntoView({block:"start"})');
    await capture('library-name-dedup-minimum.png');
    window.setContentSize(1440, 900);
    await js('document.querySelector(".library-health > details").open=true; document.querySelector(".library-track").open=true; window.libraryAudio=document.getElementById("library-audio-0"); window.cueInput=document.getElementById("cue-0"); cueInput.value="2.5"; cueInput.focus(); document.getElementById("library-search").value="未确定"; document.getElementById("library-search").dispatchEvent(new Event("input",{bubbles:true})); workbenchTest.emitBatch({type:"log",message:"library editing stable"});');
    await waitFor('document.getElementById("run-logs").textContent.includes("library editing stable")');
    assert.equal(await js('libraryAudio === document.getElementById("library-audio-0") && cueInput === document.activeElement && cueInput.value === "2.5"'), true);
    assert.equal(await js('document.querySelectorAll(".library-track:not([hidden])").length'), 1);
    await js('document.querySelector("[data-action=audition-vocal]").click()');
    await waitFor('libraryAudio.readyState >= 1 && libraryAudio.currentTime >= 1.2');
    await js('document.querySelector("[data-review=metadata]").click()');
    await waitFor('workbenchTest.calls().some(call => call.input?.action === "metadata" && call.input.cueIn === "2.5")');
    await js('document.querySelector("[data-review=confirm]").click()');
    await waitFor('state.library.files[0].status === "confirmed"');
    await js('document.getElementById("library-search").value=""; document.getElementById("library-search").dispatchEvent(new Event("input",{bubbles:true})); document.querySelector("[data-review=disable]").click()');
    await waitFor('state.library.files[0].status === "disabled"');
    await js('document.querySelector("[data-review=reset]").click()');
    await waitFor('state.library.files[0].status === "unknown"');
    await js('document.querySelector("[data-action=analyze-library]").click(); workbenchTest.emitBatch({type:"library-progress",library:{checked:1,total:2}})');
    await waitFor('document.getElementById("preflight-checks").textContent.includes("分析 1 / 2 首")');
    assert.equal(await js('document.getElementById("top-start").disabled'), true);
    await js('document.querySelector("[data-action=stop-library]").click()');
    await waitFor('!state.checkingLibrary');
    assert.equal(await js('workbenchTest.calls().some(call=>call.action === "library-stop")'), true);
    await js('state.config.minTracksPerEpisode=3; updateLive()');
    assert.equal(await js('preflightChecks().find(check=>check.name === "BGM").ok'), true);
    await js('state.selectedEpisode="第1集"; state.data.rows[0].needsRegeneration=true; state.data.rows[0].regenerationReason="旧版留白产物，已选择的产物将在运行时重新生成"; render()');
    await js('document.getElementById("queue-filter").value="pending"; document.getElementById("queue-filter").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await js('document.querySelector("#queue-body tr[data-episode=第1集]").hidden'), false,
      'Legacy repair candidates must remain visible in the pending filter');
    assert.equal(await js('state.data.rows[0].status'), 'completed',
      'Display status must not rewrite persisted completion state');
    assert.equal(await js('Number(document.querySelector("#metrics .metric.accent b").textContent)'),
      await js('state.data.rows.filter(row => row.status === "completed" && !row.needsRegeneration).length'));
    await js('document.getElementById("queue-filter").value="all"; document.getElementById("queue-filter").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.match(await js('document.getElementById("selected-episode-panel").textContent'), /旧版留白/);
    assert.match(await js('document.getElementById("queue-body").textContent'), /待重新生成/);
    await capture('legacy-silence-warning.png');
    window.setContentSize(760, 520);
    await waitFor('document.getElementById("screen").scrollWidth <= document.getElementById("screen").clientWidth');
    await js('document.getElementById("selected-episode-panel").scrollIntoView({block:"start"})');
    await capture('legacy-silence-warning-minimum.png');
    await js('window.confirm=()=>false; document.querySelector("[data-action=new-batch]").click()');
    assert.equal(await js('document.getElementById("config-videos").value.length > 0'), true);
    await js('window.confirm=()=>true; document.querySelector("[data-action=new-batch]").click()');
    await waitFor('document.getElementById("config-videos").value === ""');
    assert.equal((await fs.stat(media)).size > 0, true);
    assert.equal(await js('document.getElementById("top-start").disabled'), true);
    assert.match(await js('document.getElementById("preflight-content").textContent'), /选择视频目录/);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Desktop UI checks passed: track duration default40/custom37.5/unlimited0 save and reload, numeric batch payloads, reload recovery, 60-row filtering, stable editing/media, segment playback, timeline seeking, presets, diagnostics, accessibility and narrow layout.');
    console.log(`Screenshots: ${screenshots}`);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    app.exit(1);
  }
});
