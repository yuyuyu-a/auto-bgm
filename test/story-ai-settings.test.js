'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const fakeKey = 'synthetic-test-credential';

function encryptedStorage(overrides = {}) {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(buffer) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      cipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
    },
    ...overrides,
  };
}

async function fixture(t, storage = encryptedStorage()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'story-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'profile', 'story-ai.json');
  const { createStoryAISettings } = require('../desktop/story-ai-settings');
  return { filePath, storage, settings: createStoryAISettings({ filePath, safeStorage: storage }) };
}

test('new settings expose no credential and default to an empty endpoint', async (t) => {
  const { settings, filePath } = await fixture(t);
  assert.deepEqual(await settings.readPublic(), { baseUrl: '', model: '', keyStored: false });
  assert.deepEqual(await settings.readPrivate(), { baseUrl: '', model: '', apiKey: '' });
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('save persists encrypted credentials and returns only public fields', async (t) => {
  const { settings, filePath, storage } = await fixture(t);
  assert.deepEqual(await settings.save({ baseUrl: 'https://example.com/', model: ' story-model ', apiKey: fakeKey }), {
    baseUrl: 'https://example.com/v1', model: 'story-model', keyStored: true,
  });
  const persisted = await fs.readFile(filePath, 'utf8');
  assert.equal(persisted.includes(fakeKey), false);
  assert.equal(persisted.includes(Buffer.from(fakeKey).toString('base64')), false);
  const { createStoryAISettings } = require('../desktop/story-ai-settings');
  const reopened = createStoryAISettings({ filePath, safeStorage: storage });
  assert.deepEqual(await reopened.readPrivate(), {
    baseUrl: 'https://example.com/v1', model: 'story-model', apiKey: fakeKey,
  });
  assert.deepEqual(Object.keys(await reopened.readPublic()).sort(), ['baseUrl', 'keyStored', 'model']);
});

test('blank or omitted keys preserve the stored encrypted key', async (t) => {
  const { settings } = await fixture(t);
  await settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  await settings.save({ baseUrl: 'https://example.com', model: 'two', apiKey: '   ' });
  assert.equal((await settings.readPrivate()).apiKey, fakeKey);
  await settings.save({ baseUrl: 'https://example.com', model: 'three' });
  assert.equal((await settings.readPrivate()).apiKey, fakeKey);
});

test('clearKey deletes the credential even when a replacement is included', async (t) => {
  const { settings, filePath } = await fixture(t);
  await settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  assert.equal((await settings.save({ clearKey: true, apiKey: 'ignored' })).keyStored, false);
  assert.deepEqual(await settings.readPrivate(), { baseUrl: 'https://example.com/v1', model: 'one', apiKey: '' });
  assert.equal((await fs.readFile(filePath, 'utf8')).includes(fakeKey), false);
});

test('encryption unavailable or plaintext backends refuse key persistence', async (t) => {
  for (const storage of [
    encryptedStorage({ isEncryptionAvailable: () => false }),
    encryptedStorage({ getSelectedStorageBackend: () => 'basic_text' }),
  ]) {
    const { settings, filePath } = await fixture(t, storage);
    await assert.rejects(settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey }), /加密/);
    await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
  }
});

test('encryption and decryption failures never expose provider data or the key', async (t) => {
  const { settings, filePath, storage } = await fixture(t);
  await settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  storage.encryptString = () => { throw new Error(`raw payload ${fakeKey}`); };
  await assert.rejects(settings.save({ apiKey: fakeKey }), (error) => {
    assert.doesNotMatch(error.message, /synthetic-test-credential|raw payload/);
    return true;
  });
  assert.equal((await settings.readPrivate()).apiKey, fakeKey);
  storage.decryptString = () => { throw new Error(`raw payload ${fakeKey}`); };
  assert.equal((await settings.readPublic()).keyStored, true);
  await assert.rejects(settings.readPrivate(), (error) => {
    assert.doesNotMatch(error.message, /synthetic-test-credential|raw payload/);
    return true;
  });
  assert.equal((await settings.save({ clearKey: true })).keyStored, false);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).apiKey, undefined);
});

test('unsafe or credential-bearing endpoint inputs leave saved settings unchanged', async (t) => {
  const { settings } = await fixture(t);
  await settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  for (const baseUrl of [
    'http://example.com', 'https://user:password@example.com', 'https://example.com?api_key=hidden',
    'https://example.com/#hidden', 'file:///tmp/api', 'not a URL',
  ]) {
    await assert.rejects(settings.save({ baseUrl }), (error) => {
      assert.doesNotMatch(error.message, /password|hidden|synthetic-test-credential/);
      return true;
    });
    assert.equal((await settings.readPublic()).baseUrl, 'https://example.com/v1');
  }
  assert.equal((await settings.save({ baseUrl: 'http://127.0.0.1:3456' })).baseUrl, 'http://127.0.0.1:3456/v1');
});

test('public reads reject unexpected plaintext fields without leaking or migrating them', async (t) => {
  const { settings, filePath } = await fixture(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey }));
  await assert.rejects(settings.readPrivate(), (error) => !error.message.includes(fakeKey));
  await assert.rejects(settings.readPublic(), (error) => !error.message.includes(fakeKey));
});

test('concurrent saves preserve the credential and final profile', async (t) => {
  const { settings } = await fixture(t);
  await settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  await Promise.all([settings.save({ model: 'two' }), settings.save({ model: 'three', apiKey: '' })]);
  assert.deepEqual(await settings.readPrivate(), { baseUrl: 'https://example.com/v1', model: 'three', apiKey: fakeKey });
});

test('current Electron async encryption is preferred without falling back after failure', async (t) => {
  const storage = encryptedStorage();
  const encrypt = storage.encryptString.bind(storage);
  const decrypt = storage.decryptString.bind(storage);
  storage.isAsyncEncryptionAvailable = async () => true;
  storage.encryptStringAsync = async (value) => encrypt(value);
  storage.decryptStringAsync = async (value) => ({ result: decrypt(value), shouldReEncrypt: false });
  storage.isEncryptionAvailable = () => { throw new Error('deprecated sync API used'); };
  storage.encryptString = () => { throw new Error('deprecated sync API used'); };
  storage.decryptString = () => { throw new Error('deprecated sync API used'); };
  const { settings } = await fixture(t, storage);
  await settings.save({ baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  assert.equal((await settings.readPrivate()).apiKey, fakeKey);
  storage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(settings.save({ apiKey: 'replacement' }), /加密/);
  assert.equal((await settings.readPublic()).keyStored, true);
});

async function mainFixture(t) {
  const { filePath, storage } = await fixture(t);
  const handlers = new Map();
  const observed = {};
  let ready;
  const electron = {
    app: {
      isPackaged: false, getPath: (name) => name === 'appData' ? path.dirname(filePath) : path.join(path.dirname(filePath), 'product-name-user-data'), getVersion: () => 'test',
      whenReady: () => ({ then: (callback) => { ready = callback; } }), on: () => {}, quit: () => {},
    },
    BrowserWindow: class {
      constructor() { this.webContents = { send() {} }; }
      on() {} loadFile() {} static getAllWindows() { return []; }
    },
    safeStorage: storage,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    clipboard: { writeText: (text) => { observed.diagnostics = text; } },
    dialog: { showOpenDialog: async (_window, options) => { observed.dialog = options; return { canceled: false, filePaths: ['script.docx'] }; } },
    shell: {},
  };
  const director = {
    ...require('../src/story-director'),
    listModels: async (settings) => {
      if (observed.failProvider) throw new Error(`raw payload ${fakeKey}`);
      observed.modelsSettings = settings;
      return ['model-a', 'model-b'];
    },
    requestStoryPlan: async (context, settings, options) => {
      observed.plan = { context, settings, options };
      return { summary: 'synthetic plan' };
    },
  };
  const backend = {
    getInfo: () => ({ defaults: {}, running: false }),
    inspectBatch: async (config) => { observed.inspection = config; return { rows: [] }; },
    startBatch: async (config, _send, runtime) => { observed.runtime = runtime; observed.batch = config; return { started: true }; },
    diagnostics: async (config, runtime) => JSON.stringify({ config, storyAIProfile: runtime.storyAIProfile }),
  };
  const actualRequire = createRequire(path.join(root, 'desktop/main.js'));
  const context = {
    require: (name) => name === 'electron' ? electron : name === './backend/batch-service' ? backend
      : name === '../src/story-director' ? director : actualRequire(name),
    __dirname: path.join(root, 'desktop'), process, console, setTimeout,
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'desktop/main.js'), 'utf8'), context);
  await ready();
  const invoke = async (channel, input) => {
    assert.equal(handlers.has(channel), true, `missing IPC handler: ${channel}`);
    return handlers.get(channel)({}, input);
  };
  return { invoke, observed, stablePath: path.join(path.dirname(filePath), require('../package.json').name, 'story-ai.json') };
}

test('desktop stores only the encrypted API profile at the stable appData package-name location', async (t) => {
  const { invoke, stablePath } = await mainFixture(t);
  await invoke('story-ai:save', { baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  const saved = await fs.readFile(stablePath, 'utf8');
  assert.doesNotMatch(saved, /synthetic-test-credential/);
  assert.equal((await invoke('story-ai:settings')).keyStored, true);
});

test('desktop IPC keeps settings public and uses a no-completion connection check', async (t) => {
  const { invoke, observed } = await mainFixture(t);
  const saved = await invoke('story-ai:save', { baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  assert.deepEqual(saved, { baseUrl: 'https://example.com/v1', model: 'one', keyStored: true });
  assert.deepEqual(await invoke('story-ai:settings'), saved);
  assert.deepEqual((await invoke('app:info')).storyAI, saved);
  assert.deepEqual(await invoke('story-ai:models'), ['model-a', 'model-b']);
  assert.equal((await invoke('story-ai:test')).ok, true);
  assert.equal(observed.plan, undefined);
  assert.equal(observed.modelsSettings.apiKey, fakeKey);
  observed.failProvider = true;
  for (const channel of ['story-ai:models', 'story-ai:test']) {
    await assert.rejects(invoke(channel), (error) => !/raw payload|synthetic-test-credential/.test(error.message));
  }
  await assert.rejects(invoke('story-ai:save', { baseUrl: `https://user:${fakeKey}@example.com` }),
    (error) => !error.message.includes(fakeKey));
});

test('batch IPC refreshes the public profile and planning uses private settings with cancellation', async (t) => {
  const { invoke, observed } = await mainFixture(t);
  await invoke('story-ai:save', { baseUrl: 'https://example.com', model: 'one', apiKey: fakeKey });
  await invoke('batch:start', { storyEnabled: true });
  assert.deepEqual({ ...observed.runtime.storyAIProfile }, { baseUrl: 'https://example.com/v1', model: 'one' });
  const signal = new AbortController().signal;
  const context = { document: { text: 'Synthetic story' }, signal };
  assert.deepEqual(await observed.runtime.createStoryPlan(context), { summary: 'synthetic plan' });
  assert.equal(observed.plan.settings.apiKey, fakeKey);
  assert.equal(observed.plan.options.signal, signal);
  await invoke('story-ai:save', { model: 'two', apiKey: '' });
  await invoke('batch:inspect', { storyEnabled: true });
  assert.deepEqual({ ...observed.inspection.storyAIProfile }, { baseUrl: 'https://example.com/v1', model: 'two' });
  await invoke('batch:start', { storyEnabled: true });
  assert.equal(observed.runtime.storyAIProfile.model, 'two');
  await invoke('diagnostics:copy', { storyEnabled: true });
  assert.doesNotMatch(observed.diagnostics, /apiKey|synthetic-test-credential/);
  await invoke('dialog:story-file');
  assert.deepEqual(Array.from(observed.dialog.filters[0].extensions), ['txt', 'md', 'json', 'docx']);
});

test('preload exposes the story IPC API without exposing private settings', async () => {
  let api;
  const actualRequire = createRequire(path.join(root, 'desktop/preload.js'));
  vm.runInNewContext(await fs.readFile(path.join(root, 'desktop/preload.js'), 'utf8'), {
    require: (name) => name === 'electron' ? {
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (channel, input) => ({ channel, input }) },
    } : actualRequire(name),
  });
  for (const [method, channel] of Object.entries({
    storyAISettings: 'story-ai:settings', saveStoryAISettings: 'story-ai:save',
    storyAIModels: 'story-ai:models', testStoryAI: 'story-ai:test', chooseStoryFile: 'dialog:story-file',
  })) {
    assert.equal(typeof api[method], 'function', `missing preload method: ${method}`);
    assert.equal((await api[method]()).channel, channel);
  }
});
