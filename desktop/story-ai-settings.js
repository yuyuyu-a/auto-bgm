'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeBaseUrl } = require('../src/story-director');

function createStoryAISettings({ filePath, safeStorage }) {
  let pending = Promise.resolve();

  function baseUrl(value) {
    if (typeof value !== 'string') throw new Error('API 地址无效');
    if (!value.trim()) return '';
    try { return normalizeBaseUrl(value.trim()); }
    catch { throw new Error('API 地址无效，请使用 HTTPS 或本机地址，勿包含凭据'); }
  }

  function modelName(value) {
    if (typeof value !== 'string' || value.length > 200 || /[\r\n\0]/.test(value)) throw new Error('模型名称无效');
    return value.trim();
  }

  async function requireEncryption() {
    try {
      const available = safeStorage?.isAsyncEncryptionAvailable
        ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage?.isEncryptionAvailable();
      if (!available || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error();
    } catch { throw new Error('系统加密不可用，无法保存或读取密钥'); }
  }

  async function readRecord() {
    let text;
    try { text = await fs.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, baseUrl: '', model: '', encryptedApiKey: '' };
      throw new Error('无法读取 API 设置');
    }
    try {
      const record = JSON.parse(text);
      if (!record || record.version !== 1 || Object.hasOwn(record, 'apiKey')
        || typeof record.encryptedApiKey !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.encryptedApiKey)) throw new Error();
      return { version: 1, baseUrl: baseUrl(record.baseUrl), model: modelName(record.model), encryptedApiKey: record.encryptedApiKey };
    } catch { throw new Error('API 设置损坏，请重新配置'); }
  }

  function publicRecord(record) {
    return { baseUrl: record.baseUrl, model: record.model, keyStored: Boolean(record.encryptedApiKey) };
  }

  async function readPublic() {
    await pending;
    return publicRecord(await readRecord());
  }

  async function readPrivate() {
    await pending;
    const record = await readRecord();
    let apiKey = '';
    if (record.encryptedApiKey) {
      await requireEncryption();
      try {
        const encrypted = Buffer.from(record.encryptedApiKey, 'base64');
        apiKey = safeStorage.decryptStringAsync ? (await safeStorage.decryptStringAsync(encrypted)).result : safeStorage.decryptString(encrypted);
        if (typeof apiKey !== 'string') throw new Error();
      }
      catch { throw new Error('无法解密 API 密钥，请删除后重新保存'); }
    }
    return { baseUrl: record.baseUrl, model: record.model, apiKey };
  }

  function save(input) {
    const operation = pending.then(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('API 设置无效');
      const previous = await readRecord();
      const record = {
        ...previous,
        baseUrl: input.baseUrl === undefined ? previous.baseUrl : baseUrl(input.baseUrl),
        model: input.model === undefined ? previous.model : modelName(input.model),
      };
      if (input.clearKey === true) record.encryptedApiKey = '';
      else if (input.apiKey !== undefined) {
        if (typeof input.apiKey !== 'string' || input.apiKey.length > 16384 || /[\r\n\0]/.test(input.apiKey)) throw new Error('API 密钥无效');
        if (input.apiKey.trim()) {
          await requireEncryption();
          try {
            const encrypted = safeStorage.encryptStringAsync
              ? await safeStorage.encryptStringAsync(input.apiKey.trim()) : safeStorage.encryptString(input.apiKey.trim());
            if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error();
            record.encryptedApiKey = encrypted.toString('base64');
          } catch { throw new Error('无法加密 API 密钥，未保存'); }
        }
      }
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, filePath);
      } catch {
        throw new Error('无法保存 API 设置');
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      return publicRecord(record);
    });
    pending = operation.catch(() => {});
    return operation;
  }

  return { readPublic, readPrivate, save };
}

module.exports = { createStoryAISettings };
