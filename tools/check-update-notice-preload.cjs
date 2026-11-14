'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const methods = [
  'appInfo', 'inspectBatch', 'startBatch', 'checkMusicLibrary', 'saveStoryAISettings',
  'storyAIModels', 'testStoryAI', 'previewDiagnostics', 'copyDiagnostics',
  'checkForUpdates', 'downloadUpdate', 'cancelUpdate', 'installUpdate', 'openUpdatePage',
];
const api = Object.fromEntries(methods.map((method) => [
  method, async (...args) => {
    const result = await ipcRenderer.invoke('notice-fixture:call', method, args);
    if (result?.noticeFixtureError) throw new Error(result.noticeFixtureError);
    return result;
  },
]));
api.onBatchEvent = (listener) => ipcRenderer.on('notice-fixture:batch', (_event, value) => listener(value));
api.onUpdateEvent = (listener) => ipcRenderer.on('notice-fixture:update', (_event, value) => listener(value));
contextBridge.exposeInMainWorld('bgmStudio', api);
