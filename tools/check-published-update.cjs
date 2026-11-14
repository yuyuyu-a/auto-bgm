'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updaterRequire = require('node:module').createRequire(require.resolve('electron-updater'));
const semver = updaterRequire('semver');
const yaml = require('js-yaml');
const { NsisUpdater } = require('electron-updater');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const expected = argument('expected');
const from = argument('from') || '1.0.1';
assert.ok(semver.valid(expected), 'Pass --expected=<published-version>');
assert.ok(semver.valid(from) && semver.lt(from, expected), 'The fixture current version must be older');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-bgm-update-discovery-'));
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const resources = path.resolve(__dirname, '../release/win-unpacked/resources');
const source = path.join(resources, 'app.asar');
const configPath = path.join(resources, 'app-update.yml');
const { createUpdateService } = require(path.join(source, 'desktop/update-service.js'));
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'Invalid packaged update configuration');
assert.ok(config.provider === 'github' && config.owner === 'yuyuyu-a' && config.repo === 'auto-bgm',
  'Discovery must use the expected public GitHub repository');
for (const field of ['token', 'requestHeaders', 'private', 'host', 'protocol']) {
  assert.ok(!Object.hasOwn(config, field), `Public discovery forbids the ${field} override`);
}

const timeout = setTimeout(() => {
  console.error('FAIL: public update discovery timed out');
  app.exit(1);
}, 90000);

app.whenReady().then(async () => {
  let service;
  let exitCode = 1;
  try {
    const updater = new NsisUpdater();
    updater.logger = null;
    updater.forceDevUpdateConfig = true;
    updater.updateConfigPath = configPath;
    // Only the fixture version changes; provider, HTTP and version comparison stay real.
    updater.currentVersion = semver.parse(from);
    let downloads = 0;
    let installs = 0;
    updater.downloadUpdate = async () => {
      downloads++;
      throw new Error('Discovery must never download an installer');
    };
    updater.quitAndInstall = () => {
      installs++;
      throw new Error('Discovery must never install an update');
    };
    service = createUpdateService({ updater, currentVersion: from });
    updater.setFeedURL(config);
    const provider = await updater.clientPromise;
    assert.ok(provider instanceof GitHubProvider && provider.constructor === GitHubProvider,
      'Discovery must construct the real public GitHub provider before networking');
    assert.ok(updater.requestHeaders == null && provider.requestHeaders == null,
      'Public discovery must not include request header overrides');
    const result = await service.check({ manual: true });
    assert.equal(result.status, 'available', result.errorMessage || 'Expected an available update');
    assert.equal(result.version, expected);
    assert.equal(result.currentVersion, from);
    assert.ok(result.sizeBytes > 0, 'Published installer size must be discoverable');
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(downloads, 0);
    assert.equal(installs, 0);
    console.log(`PASS: packaged public GitHub provider discovers ${expected} from ${from}`);
    console.log(`PASS: installer metadata has ${result.sizeBytes} bytes; no download or install`);
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    clearTimeout(timeout);
    service?.dispose();
    app.exit(exitCode);
  }
});
