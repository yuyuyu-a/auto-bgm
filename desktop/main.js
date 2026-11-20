'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createAudioClassifier } = require('./audio-classifier');
const { createStoryAISettings } = require('./story-ai-settings');
const { listModels, requestStoryPlan } = require('../src/story-director');
const { LOCAL_VISION_MODEL, assetDownloadEstimate, cancelLocalVisionDownload, downloadLocalVisionAssets, inspectLocalVisionAssets } = require('../src/local-vision-assets');
const { createLocalVisionPlanner } = require('../src/local-vision-runtime');
const runtime = app.isPackaged ? {
  transcriberExecutable: path.join(process.resourcesPath, 'transcriber', 'bgm-transcriber.exe'),
  modelPath: path.join(process.resourcesPath, 'model', 'small'),
  ffmpeg: path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
  ffprobe: path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe'),
} : {};
runtime.createAudioClassifier = createAudioClassifier;
runtime.vocalModelPath = app.isPackaged ? path.join(process.resourcesPath, 'audio', 'yamnet.tflite') : path.resolve(__dirname, '../runtime/audio/yamnet.tflite');
if (app.isPackaged) {
  process.env.HF_HUB_OFFLINE = '1';
  process.env.TRANSFORMERS_OFFLINE = '1';
}
const { checkMusicLibrary, diagnostics, episodeDetail, getInfo, inspectBatch, resolveImport, startBatch, stopBatch } = require('./backend/batch-service');
const { RELEASE_URL, createUpdateService } = require('./update-service');
const { schedulePendingUpdateCleanup } = require('./update-cache');

let mainWindow;
let updateService;
let batchStarting = false;
let localVisionRoot = '';
let localVisionPlanner;
let localVisionDownloadActive = false;

async function getLocalVisionStatus() {
  const status = await inspectLocalVisionAssets(localVisionRoot);
  return { ...status, backend: 'auto', estimatedBytes: assetDownloadEstimate() };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#f4f7fa',
    title: '自动配乐',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('maximize', () => {
    const { width, height } = mainWindow.getContentBounds();
    mainWindow.webContents.setZoomFactor(Math.min(1.35, Math.max(1, Math.min(width / 1440, height / 900))));
  });
  mainWindow.on('unmaximize', () => mainWindow.webContents.setZoomFactor(1));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('batch:event', event);
}

function sendUpdate(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update:event', event);
}

function sendLocalVision(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('local-vision:event', event);
}

app.whenReady().then(() => {
  localVisionRoot = path.join(app.getPath('userData'), 'local-vision');
  localVisionPlanner = createLocalVisionPlanner({
    root: localVisionRoot,
    onProgress: (event) => sendLocalVision({ type: 'progress', ...event }),
  });
  runtime.localVisionModelRevision = LOCAL_VISION_MODEL.revision;
  runtime.createLocalVisionPlan = (context) => localVisionPlanner.plan(context);
  const storyAI = createStoryAISettings({ filePath: path.join(app.getPath('appData'), require('../package.json').name, 'story-ai.json'), safeStorage });
  runtime.createStoryPlan = async (context) => requestStoryPlan(context, await storyAI.readPrivate(), { signal: context.signal });
  const refreshStoryProfile = async () => {
    const { baseUrl, model } = await storyAI.readPublic();
    runtime.storyAIProfile = { baseUrl, model };
  };
  ipcMain.handle('story-ai:settings', () => storyAI.readPublic());
  ipcMain.handle('story-ai:save', async (_event, input) => {
    try { return await storyAI.save(input); }
    catch { throw new Error('API 设置未保存，请检查地址和系统加密'); }
  });
  const storyModels = async () => {
    try { return await listModels(await storyAI.readPrivate(), {}); }
    catch { throw new Error('连接失败，请检查 API 地址、密钥和服务状态'); }
  };
  ipcMain.handle('story-ai:models', storyModels);
  ipcMain.handle('story-ai:test', async () => {
    await storyModels();
    return { ok: true };
  });
  if (app.isPackaged && !require('../package.json').bgmPreview) {
    schedulePendingUpdateCleanup();
    const { CancellationToken, autoUpdater } = require('electron-updater');
    const updateCheckPath = path.join(app.getPath('userData'), 'update-check.json');
    let lastCheckAt = 0;
    try { lastCheckAt = JSON.parse(fs.readFileSync(updateCheckPath, 'utf8')).lastCheckedAt || 0; } catch { /* first launch or invalid local cache */ }
    updateService = createUpdateService({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      lastCheckAt,
      onCheckAt: (lastCheckedAt) => {
        try { fs.writeFileSync(updateCheckPath, JSON.stringify({ lastCheckedAt })); } catch { /* cache is only for throttling */ }
      },
      createCancellationToken: () => new CancellationToken(),
      isBatchRunning: () => batchStarting || getInfo(runtime).running,
      emit: sendUpdate,
    });
  }
  ipcMain.handle('app:info', async () => ({
    ...await getInfo(runtime),
    version: app.getVersion(),
    storyAI: await storyAI.readPublic(),
    localVision: await getLocalVisionStatus(),
    update: updateService?.getState() || { status: 'idle', enabled: false, currentVersion: app.getVersion(), version: '', releaseDate: '', releaseNotes: '', sizeBytes: 0, percent: 0, transferred: 0, total: 0, speed: 0, lastCheckedAt: '', errorMessage: '' },
  }));
  ipcMain.handle('local-vision:download', async () => {
    if (localVisionDownloadActive) throw new Error('本地模型下载已在进行。');
    if (batchStarting || getInfo(runtime).running) throw new Error('请等待当前批次结束后再下载本地模型。');
    localVisionDownloadActive = true;
    try {
      await downloadLocalVisionAssets(localVisionRoot, {
        onProgress: (event) => sendLocalVision({
          type: 'progress',
          stage: event.stage,
          asset: event.asset,
          variant: event.variant,
          transferred: event.transferred,
          total: event.total,
          percent: event.percent,
        }),
      });
      const status = await getLocalVisionStatus();
      sendLocalVision({ type: 'ready', status });
      return status;
    } catch (error) {
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        throw new Error('本地模型下载已取消。');
      }
      throw new Error(error.message || '本地模型下载或校验失败，请重试。');
    } finally {
      localVisionDownloadActive = false;
    }
  });
  ipcMain.handle('local-vision:cancel-download', () => cancelLocalVisionDownload());
  ipcMain.handle('update:state', () => updateService?.getState());
  ipcMain.handle('update:check', () => updateService?.check({ manual: true }));
  ipcMain.handle('update:download', () => updateService?.download());
  ipcMain.handle('update:cancel', () => updateService?.cancelDownload());
  ipcMain.handle('update:install', () => updateService?.install());
  ipcMain.handle('update:open-page', async () => {
    await shell.openExternal(RELEASE_URL);
    return { opened: true };
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('dialog:directory', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: String(title || '选择目录'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:video-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择一个待配乐视频',
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:story-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择剧本或分镜',
      properties: ['openFile'],
      filters: [{ name: '剧本 / 分镜', extensions: ['txt', 'md', 'json', 'docx'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:subtitle-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择与视频同名的 SRT 字幕',
      properties: ['openFile'],
      filters: [{ name: 'SRT 字幕', extensions: ['srt'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('batch:inspect', async (_event, config) => {
    await refreshStoryProfile();
    runtime.localVisionStatus = await getLocalVisionStatus();
    return inspectBatch({ ...config, ...runtime });
  });
  ipcMain.handle('music:check', (_event, config) => checkMusicLibrary({ ...config, ...runtime }, (library) => send({ type: 'library-progress', library })));
  ipcMain.handle('music:review', (_event, config) => require('./backend/batch-service').reviewMusicTrack({ ...config, ...runtime }));
  ipcMain.handle('music:stop', () => require('./backend/batch-service').stopLibraryAnalysis());
  ipcMain.handle('paths:import', (_event, input) => resolveImport(input));
  ipcMain.handle('diagnostics:preview', (_event, config) => diagnostics(config, runtime, { version: app.getVersion(), electron: process.versions.electron }));
  ipcMain.handle('diagnostics:copy', async (_event, config) => {
    clipboard.writeText(await diagnostics(config, runtime, { version: app.getVersion(), electron: process.versions.electron }));
    return { copied: true };
  });
  ipcMain.handle('batch:start', async (_event, config) => {
    batchStarting = true;
    try {
      await refreshStoryProfile();
      runtime.localVisionStatus = await getLocalVisionStatus();
      return await startBatch(config, send, runtime);
    }
    finally { batchStarting = false; }
  });
  ipcMain.handle('batch:stop', () => stopBatch());
  ipcMain.handle('episode:detail', (_event, input) => episodeDetail(input));
  ipcMain.handle('shell:openPath', async (_event, target) => {
    const error = await shell.openPath(path.resolve(String(target || '')));
    if (error) throw new Error(error);
    return { opened: true };
  });
  ipcMain.handle('shell:showItem', (_event, target) => {
    shell.showItemInFolder(path.resolve(String(target || '')));
    return { shown: true };
  });
  createWindow();
  if (updateService) {
    const timer = setTimeout(() => updateService.check(), 7000);
    timer.unref?.();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  cancelLocalVisionDownload();
  localVisionPlanner?.dispose();
  updateService?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

