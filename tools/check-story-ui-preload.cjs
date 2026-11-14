'use strict';

const { contextBridge, webUtils } = require('electron');
const { resolveImport } = require('../desktop/backend/batch-service');
const calls = [];
const profile = { baseUrl: '', model: '', keyStored: false };
const defaults = {
  videos: 'synthetic.mp4', music: 'synthetic-music', output: 'synthetic-output', modelPath: 'synthetic-model',
  transcribe: false, outputAudio: true, outputVideo: false, outputTimeline: true, outputTranscript: false,
};
let fail = false;
let batchListener;
const batch = {
  rows: [{ episode: '第1集', videoPath: 'synthetic.mp4', status: 'completed', duration: 10 }],
  inputVideoCount: 1, paths: Object.fromEntries(['videos', 'music', 'output'].map((key) => [key, { status: 'available' }])),
  musicGroups: [{ mood: '平静', count: 2 }], model: { exists: true },
  tools: { ffmpeg: { available: true }, ffprobe: { available: true } },
};
contextBridge.exposeInMainWorld('bgmStudio', {
  appInfo: async () => ({ defaults, version: 'test', storyAI: profile }),
  inspectBatch: async (config) => {
    calls.push({ action: 'inspect', config });
    return { ...batch, paths: Object.fromEntries(['videos', 'music', 'output'].map((key) => [key, { status: config[key] ? 'available' : 'unset' }])) };
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  resolveImport: async (input) => {
    const result = await resolveImport(input);
    calls.push({ action: 'import', input, result });
    return result;
  },
  checkMusicLibrary: async () => ({
    total: 2, usable: 0, musicGroups: [], emptyDirectories: [], duplicates: [], unavailableMoods: ['平静'],
    files: [
      { file: 'synthetic-vocal.wav', playable: true, eligible: false, status: 'vocal' },
      { file: 'synthetic-unknown.wav', playable: true, eligible: false, status: 'unknown' },
    ],
  }),
  episodeDetail: async () => ({
    episode: '第1集', duration: 10, status: 'completed', transcript: [], timeline: [],
    analysis: { story: {
      profile: { baseUrl: 'https://example.com/v1', model: 'model-a' }, source: 'synthetic.docx', alignmentConfidence: .8, summary: '重逢',
      cues: [{ startSegment: 0, mood: '平静', intensity: 2, reason: '重逢对白', confidence: .6, review: true },
        { startSegment: 1, mood: null, intensity: 1, reason: '沉默', confidence: .9, review: false }],
    } },
  }),
  storyAISettings: async () => profile,
  saveStoryAISettings: async (input) => {
    calls.push({ action: 'save', keySupplied: Boolean(input.apiKey), clearKey: Boolean(input.clearKey) });
    if (fail) throw new Error('synthetic-credential raw provider payload');
    Object.assign(profile, { baseUrl: input.baseUrl ?? profile.baseUrl, model: input.model ?? profile.model });
    if (input.clearKey) profile.keyStored = false;
    else if (input.apiKey?.trim()) profile.keyStored = true;
    return profile;
  },
  storyAIModels: async () => {
    if (fail) throw new Error('synthetic-credential raw provider payload');
    calls.push({ action: 'models' }); return ['model-a', 'model-b'];
  },
  testStoryAI: async () => {
    if (fail) throw new Error('synthetic-credential raw provider payload');
    calls.push({ action: 'test' }); return { ok: true };
  },
  chooseStoryFile: async () => 'synthetic.docx',
  chooseDirectory: async () => 'synthetic-stories',
  startBatch: async (config) => { calls.push({ action: 'start', config }); return { started: true }; },
  previewDiagnostics: async (config) => { calls.push({ action: 'diagnostics', config }); return JSON.stringify(config); },
  copyDiagnostics: async () => ({ copied: true }),
  onBatchEvent: (listener) => { batchListener = listener; }, onUpdateEvent: () => {},
});
contextBridge.exposeInMainWorld('storyTest', {
  calls: () => calls,
  fail: (value) => { fail = value; },
  emitBatch: (event) => batchListener(event),
});
