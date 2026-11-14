'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { gzipSync } = require('node:zlib');
const builderRequire = createRequire(require.resolve('app-builder-lib'));
const { blake2b } = builderRequire('@noble/hashes/blake2.js');

const tools = path.resolve(__dirname, '../tools');
const version = require('../package.json').version;
const publicConfig = { provider: 'github', owner: 'yuyuyu-a', repo: 'auto-bgm' };

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-bgm-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function blockFile(bytes, offset, sizes) {
  let cursor = offset;
  return {
    name: 'file',
    offset,
    sizes,
    checksums: sizes.map((size) => {
      const checksum = Buffer.from(blake2b(bytes.subarray(cursor, cursor + size), { dkLen: 18 })).toString('base64');
      cursor += size;
      return checksum;
    }),
  };
}

async function validateArtifacts(t, change = () => {}) {
  const directory = temporary(t);
  const release = path.join(directory, 'release');
  fs.mkdirSync(release);
  const bytes = Buffer.alloc(150003);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const installer = `auto-bgm-setup-${version}.exe`;
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const blockmap = { version: '2', files: [blockFile(bytes, 0, [3, 70000, 80000])] };
  change(blockmap, bytes);
  fs.writeFileSync(path.join(release, installer), bytes);
  fs.writeFileSync(path.join(release, `${installer}.blockmap`), gzipSync(JSON.stringify(blockmap)));
  fs.writeFileSync(path.join(release, 'latest.yml'), JSON.stringify({
    version, path: installer, sha512, files: [{ url: installer, size: bytes.length, sha512 }],
  }));
  const filename = path.join(tools, 'verify-update-artifacts.cjs');
  const errors = [];
  const output = [];
  const processState = { argv: [], exitCode: 0 };
  await vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: createRequire(filename),
    __dirname: path.join(directory, 'tools'),
    Buffer,
    process: processState,
    console: { log: (...values) => output.push(values.join(' ')), error: (error) => errors.push(error) },
  }, { filename });
  return { exitCode: processState.exitCode, errors, output };
}

test('artifact validation accepts valid checksums across stream and block boundaries', async (t) => {
  const result = await validateArtifacts(t);
  assert.equal(result.exitCode, 0);
  assert.equal(result.errors.length, 0);
  assert.match(result.output[0], /^PASS:/);
});

test('artifact validation rejects a corrupt block checksum despite matching installer SHA-512', async (t) => {
  const result = await validateArtifacts(t, (blockmap) => {
    blockmap.files[0].checksums[1] = Buffer.alloc(18).toString('base64');
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors[0].message, /checksum/i);
});

for (const offset of [-1, 0.5, 1, 150004]) {
  test(`artifact validation rejects invalid initial offset ${offset}`, async (t) => {
    const result = await validateArtifacts(t, (blockmap) => { blockmap.files[0].offset = offset; });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0].message, /offset/i);
  });
}

for (const offset of [2, 4]) {
  test(`artifact validation rejects overlapping or gapped offset ${offset}`, async (t) => {
    const result = await validateArtifacts(t, (blockmap, bytes) => {
      blockmap.files = [blockFile(bytes, 0, [3]), blockFile(bytes, 3, [150000])];
      blockmap.files[1].offset = offset;
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.errors[0].message, /offset/i);
  });
}

test('artifact validation rejects multiple NSIS file entries with contiguous offsets', async (t) => {
  const result = await validateArtifacts(t, (blockmap, bytes) => {
    blockmap.files = [blockFile(bytes, 0, [3]), blockFile(bytes, 3, [150000])];
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors[0].message, /exactly one file entry/i);
});

for (const size of [0, -1, 1.5, 150004]) {
  test(`artifact validation rejects invalid chunk size ${size}`, async (t) => {
    const result = await validateArtifacts(t, (blockmap) => { blockmap.files[0].sizes[0] = size; });
    assert.equal(result.exitCode, 1);
  });
}

function loadDiscovery(t, config, runReady = false) {
  const filename = path.join(tools, 'check-published-update.cjs');
  const localRequire = createRequire(filename);
  const root = temporary(t);
  const module = { exports: {} };
  const errors = [];
  let exitCode;
  const load = (id) => {
    if (id === 'electron') return { app: {
      setPath() {}, disableHardwareAcceleration() {},
      whenReady: () => runReady ? Promise.resolve() : { then() {} },
      exit: (code) => { exitCode = code; },
    } };
    if (id === 'electron-updater' && runReady) {
      const { NsisUpdater } = localRequire(id);
      const { GitHubProvider } = localRequire('electron-updater/out/providers/GitHubProvider');
      const updaterRequire = createRequire(localRequire.resolve('electron-updater'));
      return { NsisUpdater: class extends NsisUpdater {
        constructor() {
          super(undefined, { version: '1.0.2', whenReady: async () => {}, isPackaged: false });
          this.checkForUpdates = async () => {
            assert.ok(this.clientPromise, 'Public provider must be constructed before discovery networking');
            assert.equal((await this.clientPromise).constructor, GitHubProvider);
            assert.ok(this.currentVersion instanceof updaterRequire('semver').SemVer);
            this.emit('update-available', { version: '1.0.2', files: [{ size: 123 }] });
          };
        }
      } };
    }
    if (id === 'node:fs') return {
      ...fs,
      mkdtempSync: () => root,
      readFileSync: (file, ...args) => file.endsWith('app-update.yml')
        ? JSON.stringify(config) : fs.readFileSync(file, ...args),
    };
    if (id.endsWith('app.asar/desktop/update-service.js')
      || id.endsWith('app.asar\\desktop\\update-service.js')) return require('../desktop/update-service');
    return localRequire(id);
  };
  load.resolve = localRequire.resolve;
  load.main = module;
  const completion = vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: load, module, __dirname: tools,
    process: { argv: ['--expected=1.0.2', '--from=1.0.1'] },
    console: { log() {}, error: (error) => errors.push(error) },
    setTimeout: () => 0, clearTimeout() {},
  }, { filename });
  return { completion, errors, exitCode: () => exitCode };
}

test('discovery accepts credential-free public GitHub configuration', (t) => {
  assert.doesNotThrow(() => loadDiscovery(t, publicConfig));
});

test('discovery constructs the real public provider before networking with updater-owned semver', async (t) => {
  const result = loadDiscovery(t, publicConfig, true);
  await result.completion;
  assert.equal(result.exitCode(), 0, result.errors.map((error) => error.message).join('\n'));
});

for (const [field, value] of [
  ['token', 'synthetic-secret-never-print'],
  ['requestHeaders', { authorization: 'synthetic-secret-never-print' }],
  ['private', true],
  ['host', 'example.invalid'],
  ['protocol', 'http'],
]) {
  test(`discovery rejects ${field} overrides without exposing credentials`, (t) => {
    assert.throws(() => loadDiscovery(t, { ...publicConfig, [field]: value }), (error) => {
      assert.equal(error.message.includes('synthetic-secret-never-print'), false);
      return true;
    });
  });
}
