'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const {
  LOCAL_VISION_MODEL,
  LOCAL_VISION_RUNTIME,
  downloadLocalVisionAssets,
  inspectLocalVisionAssets,
} = require('../src/local-vision-assets');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function withFixtureServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await callback(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('pins a Windows runtime archive and an immutable multimodal model revision', () => {
  assert.equal(LOCAL_VISION_RUNTIME.release, 'b12566');
  assert.ok(LOCAL_VISION_RUNTIME.files.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.equal(LOCAL_VISION_MODEL.revision, '5037fcf163dd95d1e41d1974465f0898ed108ca2');
  assert.deepEqual(LOCAL_VISION_MODEL.files.map((file) => file.name), [
    'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
    'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
  ]);
  assert.deepEqual(LOCAL_VISION_MODEL.files.map(({ sizeBytes }) => sizeBytes), [1929901056, 844757728]);
  assert.ok(LOCAL_VISION_MODEL.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('downloads, verifies, extracts and reports progress for runtime and model assets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-vision-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeBytes = Buffer.from('verified-runtime-archive');
  const modelBytes = new Map([
    ['model.gguf', Buffer.from('model-weights')],
    ['mmproj.gguf', Buffer.from('vision-projector')],
  ]);
  const progress = [];
  await withFixtureServer((request, response) => {
    if (request.url === '/metadata') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ sha: 'a'.repeat(40), siblings: [...modelBytes].map(([name, bytes]) => ({
        rfilename: name, size: bytes.length, lfs: { size: bytes.length, sha256: sha256(bytes) },
      })) }));
      return;
    }
    const key = request.url.slice('/files/'.length);
    const bytes = key === 'runtime.zip' ? runtimeBytes : modelBytes.get(key);
    if (!bytes) { response.writeHead(404).end(); return; }
    response.setHeader('content-length', String(bytes.length));
    response.end(bytes);
  }, async (baseUrl) => {
    const runtime = {
      release: 'fixture-release',
      files: [{
        variant: 'cpu', filename: 'runtime.zip', url: `${baseUrl}/files/runtime.zip`,
        sizeBytes: runtimeBytes.length, sha256: sha256(runtimeBytes),
      }],
    };
    const model = {
      repository: 'fixture/model',
      revision: 'a'.repeat(40),
      metadataUrl: `${baseUrl}/metadata`,
      files: [
        { name: 'model.gguf', sha256: sha256(modelBytes.get('model.gguf')), sizeBytes: 13 },
        { name: 'mmproj.gguf', sha256: sha256(modelBytes.get('mmproj.gguf')), sizeBytes: 16 },
      ],
      resolveUrl: (name) => `${baseUrl}/files/${name}`,
    };
    const ready = await downloadLocalVisionAssets(root, {
      runtime,
      model,
      fetchImpl: fetch,
      onProgress: (event) => progress.push(event),
      async extractRuntime(_archive, destination) {
        await fs.mkdir(destination, { recursive: true });
        const serverPath = path.join(destination, 'llama-server.exe');
        await fs.writeFile(serverPath, 'fixture server');
        return path.relative(path.dirname(destination), serverPath);
      },
    });
    assert.equal(ready.ready, true);
    assert.ok(progress.some((event) => event.asset === 'runtime' && event.transferred > 0));
    assert.ok(progress.some((event) => event.asset === 'model' && event.transferred > 0));
    const inspection = await inspectLocalVisionAssets(root, { runtime, model });
    assert.equal(inspection.ready, true);
    assert.equal(inspection.modelBytes, 29);
    assert.equal(inspection.backend, 'auto');
    const manifestPath = path.join(root, 'asset-manifest.json');
    const installed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    delete installed.runtimeServers;
    await fs.writeFile(manifestPath, JSON.stringify(installed));
    assert.equal((await inspectLocalVisionAssets(root, { runtime, model })).ready, false);
  });
});

test('rejects an incorrect runtime digest and does not mark any assets ready', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-vision-bad-hash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await withFixtureServer((request, response) => {
    if (request.url === '/metadata') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ sha: 'a'.repeat(40), siblings: [{ rfilename: 'model.gguf', size: 13, lfs: { size: 13, sha256: '1'.repeat(64) } }] }));
      return;
    }
    response.end('tampered');
  }, async (baseUrl) => {
    const runtime = {
      release: 'fixture-release',
      files: [{
        variant: 'cpu', filename: 'runtime.zip', url: `${baseUrl}/runtime.zip`,
        sizeBytes: 8, sha256: '0'.repeat(64),
      }],
    };
    await assert.rejects(downloadLocalVisionAssets(root, {
      runtime,
      model: { repository: 'fixture/model', revision: 'a'.repeat(40), files: [{ name: 'model.gguf', sizeBytes: 13, sha256: '1'.repeat(64) }], resolveUrl: () => `${baseUrl}/model.gguf` },
      fetchImpl: fetch,
      async extractRuntime() { assert.fail('unverified runtime must not be extracted'); },
    }), /SHA-256|校验/);
    assert.equal((await inspectLocalVisionAssets(root, { runtime, model: LOCAL_VISION_MODEL })).ready, false);
  });
});

test('aborted downloads do not create a verified-install manifest', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-vision-abort-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  await withFixtureServer(async (request, response) => {
    if (request.url === '/metadata') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ sha: 'a'.repeat(40), siblings: [{ rfilename: 'model.gguf', size: 13, lfs: { size: 13, sha256: '1'.repeat(64) } }] }));
      return;
    }
    response.write('partial');
    setTimeout(() => { controller.abort(); response.end('tail'); }, 20);
  }, async (baseUrl) => {
    const runtime = {
      release: 'fixture-release',
      files: [{
        variant: 'cpu', filename: 'runtime.zip', url: `${baseUrl}/runtime.zip`,
        sizeBytes: 1024, sha256: sha256(Buffer.alloc(1024)),
      }],
    };
    await assert.rejects(downloadLocalVisionAssets(root, {
      runtime,
      model: { repository: 'fixture/model', revision: 'a'.repeat(40), files: [{ name: 'model.gguf', sizeBytes: 13, sha256: '1'.repeat(64) }], resolveUrl: () => `${baseUrl}/model.gguf` },
      signal: controller.signal,
      fetchImpl: fetch,
    }), (error) => error.name === 'AbortError' || error.code === 'ABORT_ERR');
    await assert.rejects(fs.stat(path.join(root, 'asset-manifest.json')), { code: 'ENOENT' });
  });
});

test('resumes an interrupted large asset from its verified partial byte count', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-bgm-vision-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeBytes = Buffer.from('runtime-archive');
  const modelBytes = Buffer.from('0123456789');
  const controller = new AbortController();
  let modelRequests = 0;
  await withFixtureServer((request, response) => {
    if (request.url === '/runtime.zip') {
      response.setHeader('content-length', String(runtimeBytes.length));
      response.end(runtimeBytes);
      return;
    }
    if (request.url !== '/model.gguf') { response.writeHead(404).end(); return; }
    modelRequests += 1;
    if (modelRequests === 1) {
      response.setHeader('content-length', String(modelBytes.length));
      response.write(modelBytes.subarray(0, 5));
      return;
    }
    assert.equal(request.headers.range, 'bytes=5-');
    response.writeHead(206, {
      'content-length': String(modelBytes.length - 5),
      'content-range': `bytes 5-${modelBytes.length - 1}/${modelBytes.length}`,
    });
    response.end(modelBytes.subarray(5));
  }, async (baseUrl) => {
    const runtime = {
      release: 'fixture-release',
      files: [{ variant: 'cpu', filename: 'runtime.zip', url: `${baseUrl}/runtime.zip`,
        sizeBytes: runtimeBytes.length, sha256: sha256(runtimeBytes) }],
    };
    const model = {
      repository: 'fixture/model', revision: 'a'.repeat(40),
      files: [{ name: 'model.gguf', sizeBytes: modelBytes.length, sha256: sha256(modelBytes) }],
      resolveUrl: () => `${baseUrl}/model.gguf`,
    };
    const extractRuntime = async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
      const server = path.join(destination, 'llama-server.exe');
      await fs.writeFile(server, 'fixture server');
      return path.relative(path.dirname(destination), server);
    };
    await assert.rejects(downloadLocalVisionAssets(root, {
      runtime, model, signal: controller.signal, fetchImpl: fetch, extractRuntime,
      onProgress(event) {
        if (event.asset === 'model' && event.transferred >= 5) controller.abort();
      },
    }), (error) => error.name === 'AbortError' || error.code === 'ABORT_ERR');
    const partial = path.join(root, 'models', 'model.gguf.part');
    assert.equal((await fs.stat(partial)).size, 5);

    const ready = await downloadLocalVisionAssets(root, {
      runtime, model, fetchImpl: fetch, extractRuntime,
    });
    assert.equal(ready.ready, true);
    assert.equal(modelRequests, 2);
    assert.deepEqual(await fs.readFile(path.join(root, 'models', 'model.gguf')), modelBytes);
    await assert.rejects(fs.stat(partial), { code: 'ENOENT' });
  });
});
