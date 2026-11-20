'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MANIFEST_FILENAME = 'asset-manifest.json';
const ASSET_ROOTS = Object.freeze({ downloads: 'downloads', runtime: 'runtime', models: 'models' });

const LOCAL_VISION_RUNTIME = Object.freeze({
  release: 'b12566',
  repository: 'ggml-org/llama.cpp',
  license: 'MIT',
  files: Object.freeze([
    Object.freeze({
      variant: 'cpu',
      filename: 'llama-b12566-bin-win-cpu-x64.zip',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12566/llama-b12566-bin-win-cpu-x64.zip',
      sizeBytes: 24876314,
      sha256: 'e72081a185cc87a2326a83e639ffcd34e5912f9403efa27460b7dd02216b7810',
    }),
    Object.freeze({
      variant: 'vulkan',
      filename: 'llama-b12566-bin-win-vulkan-x64.zip',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12566/llama-b12566-bin-win-vulkan-x64.zip',
      sizeBytes: 38719958,
      sha256: 'a6a7e2db35dbcd3d64ca7ee76bf827addcfec79501bff390bed12ca9faff938d',
    }),
  ]),
});

const LOCAL_VISION_MODEL = Object.freeze({
  repository: 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
  revision: '5037fcf163dd95d1e41d1974465f0898ed108ca2',
  license: 'Apache-2.0',
  estimatedBytes: 2_774_658_784,
  files: Object.freeze([
    Object.freeze({
      name: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf',
      sizeBytes: 1_929_901_056,
      sha256: 'd02fe9b69ad8cadbbd228e387667af66612c44bed29ffc8eb1e7caf9ac486c12',
    }),
    Object.freeze({
      name: 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf',
      sizeBytes: 844_757_728,
      sha256: '980c9b2f78c04e6cff93d277ada09e768394f112d75db3b4e9dea8a69f9fb904',
    }),
  ]),
});

let activeDownload = null;

function abortError() {
  return Object.assign(new Error('用户已取消本地视觉模型下载。'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function validateAsset(asset) {
  let url;
  try { url = new URL(asset?.url); } catch { /* Invalid URL. */ }
  const localHttp = url?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!asset || !url || !(url.protocol === 'https:' || localHttp) || url.username || url.password ||
      typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 ||
      typeof asset.filename !== 'string' && typeof asset.name !== 'string') {
    throw new Error('本地视觉资源清单无效，已停止下载。');
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const stream = require('node:fs').createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function downloadFile(asset, target, { signal, onProgress, fetchImpl = fetch } = {}) {
  validateAsset(asset);
  signal?.throwIfAborted();
  if (await pathExists(target)) {
    const existingHash = await hashFile(target);
    if (existingHash === asset.sha256) {
      const stat = await fs.stat(target);
      onProgress?.({ transferred: stat.size, total: stat.size, percent: 100, reused: true });
      return { sizeBytes: stat.size, sha256: existingHash };
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.part`;
  let partialBytes = 0;
  if (await pathExists(temporary)) {
    const partialStat = await fs.stat(temporary);
    if (partialStat.size === asset.sizeBytes) {
      const digest = await hashFile(temporary);
      if (digest === asset.sha256) {
        await fs.rename(temporary, target);
        onProgress?.({ transferred: partialStat.size, total: partialStat.size, percent: 100, reused: true });
        return { sizeBytes: partialStat.size, sha256: digest };
      }
      await fs.rm(temporary, { force: true });
    } else if (partialStat.size > asset.sizeBytes) {
      await fs.rm(temporary, { force: true });
    } else {
      partialBytes = partialStat.size;
    }
  }
  let handle;
  try {
    const urls = [...new Set([asset.url, asset.fallbackUrl].filter(Boolean))];
    let response;
    let lastRequestError;
    for (const url of urls) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal?.throwIfAborted();
        try {
          const requestOptions = {
            signal,
            redirect: 'follow',
            ...(partialBytes ? { headers: { range: `bytes=${partialBytes}-` } } : {}),
          };
          let candidate = await fetchImpl(url, requestOptions);
          if (candidate.status === 416 && partialBytes) {
            await candidate.body?.cancel().catch(() => {});
            await fs.rm(temporary, { force: true });
            partialBytes = 0;
            candidate = await fetchImpl(url, { signal, redirect: 'follow' });
          }
          if (candidate.ok && candidate.body) {
            response = candidate;
            break;
          }
          const status = candidate.status;
          await candidate.body?.cancel().catch(() => {});
          lastRequestError = new Error(`HTTP ${status}`);
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw abortError();
          lastRequestError = error;
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (response?.ok && response.body) break;
    }
    if (!response?.ok || !response.body) throw new Error('本地视觉资源下载失败，请检查网络后重试。', { cause: lastRequestError });
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!partialBytes || !range || Number(range[1]) !== partialBytes ||
          Number(range[2]) >= asset.sizeBytes || Number(range[3]) !== asset.sizeBytes) {
        await response.body.cancel().catch(() => {});
        throw new Error('本地视觉资源续传范围无效，请重试下载。');
      }
    } else if (response.status === 200) {
      partialBytes = 0;
    } else {
      await response.body.cancel().catch(() => {});
      throw new Error('本地视觉资源服务器返回了不支持的续传响应。');
    }
    const hash = createHash('sha256');
    if (partialBytes) {
      for await (const chunk of require('node:fs').createReadStream(temporary)) hash.update(chunk);
    }
    handle = await fs.open(temporary, partialBytes ? 'a' : 'w');
    const reader = response.body.getReader();
    let transferred = partialBytes;
    const total = asset.sizeBytes;
    if (partialBytes) onProgress?.({ transferred, total, percent: transferred / total * 100, reused: false, resumed: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(bytes, offset, bytes.length - offset);
          offset += result.bytesWritten;
        }
        transferred += bytes.length;
        onProgress?.({ transferred, total, percent: total ? Math.min(100, transferred / total * 100) : null, reused: false });
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    signal?.throwIfAborted();
    if (transferred !== asset.sizeBytes) {
      throw Object.assign(new Error('本地视觉资源下载未完整结束，保留已下载部分以便续传。'), { preservePartial: true });
    }
    const digest = hash.digest('hex');
    if (digest !== asset.sha256) throw Object.assign(new Error('本地视觉资源 SHA-256 校验失败，已删除不完整文件。'), { discardPartial: true });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    return { sizeBytes: transferred, sha256: digest };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    let partialSize = 0;
    try { partialSize = (await fs.stat(temporary)).size; } catch { /* no partial file */ }
    if (error.discardPartial || (!error.preservePartial && !signal?.aborted && partialSize === 0)) {
      await fs.rm(temporary, { force: true }).catch(() => {});
    } else if (!error.preservePartial && !signal?.aborted && partialSize >= asset.sizeBytes) {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw abortError();
    throw error;
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function findServerExecutable(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true });
  const server = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'llama-server.exe');
  return server ? path.join(server.parentPath || directory, server.name) : '';
}

async function extractRuntimeArchive(archive, destination, variant) {
  const extractionDirectory = `${destination}.extract-${process.pid}-${Date.now()}`;
  await fs.mkdir(extractionDirectory, { recursive: true });
  try {
    const command = `Expand-Archive -LiteralPath ${quotePowerShell(archive)} -DestinationPath ${quotePowerShell(extractionDirectory)} -Force`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    const server = await findServerExecutable(extractionDirectory);
    if (!server) throw new Error(`本地视觉 ${variant} 运行时缺少 llama-server.exe。`);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    await fs.cp(path.dirname(server), destination, { recursive: true, force: true });
    const installedServer = await findServerExecutable(destination);
    if (!installedServer) throw new Error(`本地视觉 ${variant} 运行时解压后未找到服务端。`);
    return path.relative(path.dirname(destination), installedServer);
  } finally { await fs.rm(extractionDirectory, { recursive: true, force: true }); }
}

function assetRelativePath(asset, kind) {
  if (kind === 'runtime') return path.join(ASSET_ROOTS.downloads, asset.filename);
  return path.join(ASSET_ROOTS.models, asset.name);
}

async function readPinnedModelAssets(model) {
  if (!/^[a-f0-9]{40}$/.test(model.revision) || !Array.isArray(model.files) || !model.files.length) {
    throw new Error('本地视觉模型 revision 无效，已停止下载。');
  }
  return model.files.map((expected) => {
    if (!expected || typeof expected.name !== 'string' ||
        !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0 ||
        typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error('固定 revision 的模型文件缺少 SHA-256 或大小，已停止下载。');
    }
    const url = typeof model.resolveUrl === 'function' ? model.resolveUrl(expected.name)
      : `https://huggingface.co/${model.repository}/resolve/${model.revision}/${encodeURIComponent(expected.name)}?download=true`;
    const fallbackUrl = typeof model.resolveUrl === 'function' ? undefined
      : `https://hf-mirror.com/${model.repository}/resolve/${model.revision}/${encodeURIComponent(expected.name)}?download=true`;
    return { ...expected, url, ...(fallbackUrl ? { fallbackUrl } : {}) };
  });
}

async function writeInstalledManifest(root, runtime, model, installed) {
  const files = [];
  for (const { asset, relativePath } of installed.assets) {
    const stat = await fs.stat(path.join(root, relativePath));
    files.push({ relativePath, sha256: asset.sha256, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  const content = {
    version: 1,
    runtimeRelease: runtime.release,
    modelRepository: model.repository,
    modelRevision: model.revision,
    runtimeServers: installed.runtimeServers,
    modelFileHashes: installed.modelFileHashes,
    files,
    verifiedAt: new Date().toISOString(),
  };
  const target = path.join(root, MANIFEST_FILENAME);
  const temporary = `${target}.${process.pid}.part`;
  await fs.writeFile(temporary, JSON.stringify(content, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, target);
}

async function inspectLocalVisionAssets(root, {
  runtime = LOCAL_VISION_RUNTIME, model = LOCAL_VISION_MODEL,
} = {}) {
  if (!root) return { ready: false, modelBytes: 0, runtime: { cpu: false, vulkan: false } };
  const status = { ready: false, modelBytes: 0, runtime: { cpu: false, vulkan: false }, backend: 'auto' };
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_FILENAME), 'utf8')); } catch { return status; }
  if (manifest.runtimeRelease !== runtime.release || manifest.modelRepository !== model.repository ||
      manifest.modelRevision !== model.revision || !Array.isArray(manifest.files)) return status;
  for (const asset of runtime.files) {
    const relativePath = assetRelativePath(asset, 'runtime');
    const record = manifest.files.find((entry) => entry.relativePath === relativePath && entry.sha256 === asset.sha256);
    if (!record) return status;
    let stat;
    try { stat = await fs.stat(path.join(root, relativePath)); } catch { return status; }
    if (!stat.isFile() || stat.size !== record.sizeBytes || stat.mtimeMs !== record.mtimeMs) return status;
  }
  for (const asset of model.files) {
    const relativePath = assetRelativePath(asset, 'model');
    const expectedHash = manifest.modelFileHashes?.[asset.name];
    const record = manifest.files.find((entry) => entry.relativePath === relativePath && entry.sha256 === expectedHash);
    if (!record || !/^[a-f0-9]{64}$/.test(expectedHash || '')) return status;
    let stat;
    try { stat = await fs.stat(path.join(root, relativePath)); } catch { return status; }
    if (!stat.isFile() || stat.size !== record.sizeBytes || stat.mtimeMs !== record.mtimeMs) return status;
    status.modelBytes += stat.size;
  }
  for (const asset of runtime.files) {
    const relative = manifest.runtimeServers?.[asset.variant];
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) continue;
    const runtimeRoot = path.resolve(root, 'runtime');
    const executable = path.resolve(runtimeRoot, relative);
    if (!executable.startsWith(runtimeRoot + path.sep)) continue;
    try {
      if ((await fs.stat(executable)).isFile()) status.runtime[asset.variant] = true;
    } catch { /* A missing executable means the runtime is not installed. */ }
  }
  status.ready = status.modelBytes > 0 &&
    model.files.every((asset) => manifest.modelFileHashes?.[asset.name] === asset.sha256) &&
    runtime.files.every((asset) => status.runtime[asset.variant] === true);
  return status;
}

async function verifyLocalVisionAssets(root, { runtime = LOCAL_VISION_RUNTIME, model = LOCAL_VISION_MODEL } = {}) {
  const inspection = await inspectLocalVisionAssets(root, { runtime, model });
  if (!inspection.ready) throw new Error('本地视觉模型或运行时未安装完整，请在设置中下载并校验。');
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST_FILENAME), 'utf8'));
  for (const asset of runtime.files) {
    const relative = assetRelativePath(asset, 'runtime');
    if (await hashFile(path.join(root, relative)) !== asset.sha256) throw new Error('本地视觉资源 SHA-256 校验失败，请重新下载。');
  }
  for (const asset of model.files) {
    const relative = assetRelativePath(asset, 'model');
    if (manifest.modelFileHashes[asset.name] !== asset.sha256 ||
        await hashFile(path.join(root, relative)) !== asset.sha256) throw new Error('本地视觉资源 SHA-256 校验失败，请重新下载。');
  }
  return { ...inspection, manifest };
}

async function downloadLocalVisionAssets(root, {
  runtime = LOCAL_VISION_RUNTIME,
  model = LOCAL_VISION_MODEL,
  signal,
  onProgress,
  fetchImpl = fetch,
  extractRuntime = extractRuntimeArchive,
} = {}) {
  if (activeDownload) throw new Error('本地视觉资源下载已在进行。');
  if (!root || !Array.isArray(runtime.files) || !Array.isArray(model.files) || !model.files.length) {
    throw new Error('本地视觉资源配置无效。');
  }
  const controller = new AbortController();
  activeDownload = controller;
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const installed = { assets: [], runtimeServers: {}, modelFileHashes: {} };
  try {
    await fs.mkdir(root, { recursive: true });
    for (const asset of runtime.files) {
      combinedSignal.throwIfAborted();
      const archiveRelative = assetRelativePath(asset, 'runtime');
      const archive = path.join(root, archiveRelative);
      const result = await downloadFile(asset, archive, {
        signal: combinedSignal, fetchImpl,
        onProgress: (event) => onProgress?.({ stage: 'downloading', asset: 'runtime', variant: asset.variant, ...event }),
      });
      installed.assets.push({ asset, relativePath: archiveRelative });
      const destination = path.join(root, 'runtime', asset.variant);
      onProgress?.({ stage: 'extracting', asset: 'runtime', variant: asset.variant, transferred: 0, total: 0, percent: null });
      installed.runtimeServers[asset.variant] = await extractRuntime(archive, destination, asset.variant);
      const serverPath = path.join(path.dirname(destination), installed.runtimeServers[asset.variant]);
      if (!(await pathExists(serverPath))) throw new Error(`本地视觉 ${asset.variant} 运行时解压失败。`);
      onProgress?.({ stage: 'verified', asset: 'runtime', variant: asset.variant, transferred: result.sizeBytes, total: result.sizeBytes, percent: 100 });
    }
    const pinnedModelFiles = await readPinnedModelAssets(model);
    installed.modelFileHashes = Object.fromEntries(pinnedModelFiles.map((asset) => [asset.name, asset.sha256]));
    for (const asset of pinnedModelFiles) {
      combinedSignal.throwIfAborted();
      const relativePath = assetRelativePath(asset, 'model');
      const result = await downloadFile(asset, path.join(root, relativePath), {
        signal: combinedSignal, fetchImpl,
        onProgress: (event) => onProgress?.({ stage: 'downloading', asset: 'model', filename: asset.name, ...event }),
      });
      installed.assets.push({ asset, relativePath });
      onProgress?.({ stage: 'verified', asset: 'model', filename: asset.name, transferred: result.sizeBytes, total: result.sizeBytes, percent: 100 });
    }
    combinedSignal.throwIfAborted();
    await writeInstalledManifest(root, runtime, model, installed);
    return inspectLocalVisionAssets(root, { runtime, model });
  } catch (error) {
    if (combinedSignal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw abortError();
    throw error;
  } finally { activeDownload = null; }
}

function cancelLocalVisionDownload() {
  if (!activeDownload) return { cancelled: false };
  activeDownload.abort();
  return { cancelled: true };
}

function assetDownloadEstimate(runtime = LOCAL_VISION_RUNTIME, model = LOCAL_VISION_MODEL) {
  return runtime.files.reduce((sum, asset) => sum + (asset.sizeBytes || 0), 0) + (model.estimatedBytes || 0);
}

module.exports = {
  LOCAL_VISION_MODEL, LOCAL_VISION_RUNTIME, assetDownloadEstimate,
  cancelLocalVisionDownload, downloadLocalVisionAssets, inspectLocalVisionAssets,
  readPinnedModelAssets, verifyLocalVisionAssets,
};
