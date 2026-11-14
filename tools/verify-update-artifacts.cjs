'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { gunzipSync } = require('node:zlib');
const yaml = require('js-yaml');
const builderRequire = createRequire(require.resolve('app-builder-lib'));
const { blake2b } = builderRequire('@noble/hashes/blake2.js');

async function verify() {
  const version = require('../package.json').version;
  const directory = path.resolve(__dirname, '../release');
  const installer = `auto-bgm-setup-${version}.exe`;
  const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  const sha512 = createHash('sha512');
  const sha256 = createHash('sha256');
  const installerPath = path.join(directory, installer);
  const size = fs.statSync(installerPath).size;
  const blockmap = JSON.parse(gunzipSync(fs.readFileSync(`${installerPath}.blockmap`)));
  assert.equal(blockmap.version, '2');
  assert.ok(Array.isArray(blockmap.files) && blockmap.files.length > 0);
  const blocks = [];
  let coveredBytes = 0;
  for (const file of blockmap.files) {
    assert.ok(Number.isSafeInteger(file.offset) && file.offset >= 0 && file.offset < size,
      'Blockmap file offset must be an in-range integer');
    assert.equal(file.offset, coveredBytes, 'Blockmap file offsets must be contiguous');
    assert.ok(Array.isArray(file.checksums) && Array.isArray(file.sizes) && file.sizes.length > 0);
    assert.equal(file.checksums.length, file.sizes.length);
    for (let index = 0; index < file.sizes.length; index++) {
      const length = file.sizes[index];
      assert.ok(Number.isSafeInteger(length) && length > 0, 'Blockmap chunk size must be a positive integer');
      assert.ok(length <= size - coveredBytes, 'Blockmap chunk must stay within the installer');
      assert.ok(typeof file.checksums[index] === 'string' && /^[A-Za-z0-9+/]{24}$/.test(file.checksums[index]),
        'Blockmap checksum must encode an 18-byte BLAKE2b digest');
      blocks.push({ size: length, checksum: file.checksums[index] });
      coveredBytes += length;
    }
  }
  assert.equal(blockmap.files.length, 1, 'NSIS blockmaps must contain exactly one file entry');
  assert.equal(coveredBytes, size, 'Blockmap chunks must cover the matching installer');
  let blockIndex = 0;
  let remaining = blocks[0].size;
  let blockHash = blake2b.create({ dkLen: 18 });
  for await (const chunk of fs.createReadStream(installerPath)) {
    sha512.update(chunk);
    sha256.update(chunk);
    // Stream buffers and blockmap chunks have independent boundaries.
    let offset = 0;
    while (offset < chunk.length) {
      assert.ok(blockIndex < blocks.length, 'Installer exceeds blockmap coverage');
      const length = Math.min(remaining, chunk.length - offset);
      blockHash.update(chunk.subarray(offset, offset + length));
      offset += length;
      remaining -= length;
      if (remaining === 0) {
        assert.equal(Buffer.from(blockHash.digest()).toString('base64'), blocks[blockIndex].checksum,
          `Blockmap checksum mismatch at chunk ${blockIndex}`);
        blockIndex++;
        if (blockIndex < blocks.length) {
          remaining = blocks[blockIndex].size;
          blockHash = blake2b.create({ dkLen: 18 });
        }
      }
    }
  }
  assert.equal(blockIndex, blocks.length, 'Installer ends before blockmap coverage');
  const hash512 = sha512.digest('base64');
  const hash256 = sha256.digest('hex');
  assert.equal(metadata.version, version);
  assert.equal(metadata.path, installer);
  assert.equal(metadata.sha512, hash512);
  assert.equal(metadata.files.length, 1);
  assert.equal(metadata.files[0].url, installer);
  assert.equal(metadata.files[0].size, size);
  assert.equal(metadata.files[0].sha512, hash512);
  console.log(`PASS: ${version} installer, blockmap chunk checksums and latest.yml SHA-512/size match`);
  console.log(`SHA256 ${installer} ${hash256}`);

  if (process.argv.includes('--remote')) {
    const release = JSON.parse(execFileSync('gh', ['api',
      `repos/yuyuyu-a/auto-bgm/releases/tags/v${version}`], { encoding: 'utf8', windowsHide: true }));
    assert.equal(release.tag_name, `v${version}`);
    assert.equal(release.prerelease, false);
    const names = [installer, `${installer}.blockmap`, 'latest.yml'];
    assert.deepEqual(release.assets.map(({ name }) => name).sort(), [...names].sort());
    for (const name of names) {
      const asset = release.assets.find((item) => item.name === name);
      const filePath = path.join(directory, name);
      const digest = name === installer ? hash256
        : createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      assert.equal(asset.size, fs.statSync(filePath).size, name);
      assert.equal(asset.digest, `sha256:${digest}`, name);
    }
    console.log(`PASS: GitHub ${release.draft ? 'draft' : 'published'} v${version}: all three asset sizes and SHA-256 digests match`);
  }
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
