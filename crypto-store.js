// 暗号化と保存を担当する部品
// ・暗号の方式は自作せず、ブラウザ標準の Web Crypto API だけを使う
//   - 鍵の作成: PBKDF2（SHA-256, 600,000回）… パスワードから鍵を作る標準的な方法
//   - 暗号化:   AES-GCM（256ビット）… 読めない形にし、改ざんも検出できる標準の方式
// ・パスワードと鍵は保存しない。鍵はメモリ上にだけ置き、取り出せない設定（extractable=false）にする
(function (root) {
  'use strict';

  const STORAGE_KEY = 'kakeibo-mini.vault.v1';
  const APP_ID = 'kakeibo-mini';
  const FORMAT_VERSION = 1;
  const PBKDF2_ITERATIONS = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function isCryptoAvailable() {
    return !!(root.isSecureContext && root.crypto && root.crypto.subtle && root.crypto.getRandomValues);
  }

  function isStorageAvailable() {
    try {
      const k = '__kakeibo_test__';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, saltBytes, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false, // 鍵を取り出せないようにする
      ['encrypt', 'decrypt']
    );
  }

  // 暗号文の「外側の情報」（方式名・ソルトなど）も改ざん検出の対象にする
  function aadFor(kind) {
    return enc.encode(APP_ID + ':' + kind + ':v' + FORMAT_VERSION);
  }

  async function encryptJson(key, saltB64, iterations, kind, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 毎回新しい乱数（IV）を使う
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aadFor(kind) },
      key,
      enc.encode(JSON.stringify(obj))
    );
    return {
      app: APP_ID,
      kind,
      v: FORMAT_VERSION,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: saltB64 },
      cipher: { name: 'AES-GCM', iv: toB64(iv) },
      ct: toB64(ct),
    };
  }

  function checkEnvelope(env, kind) {
    return !!(env && env.app === APP_ID && env.kind === kind && env.v === FORMAT_VERSION &&
      env.kdf && env.kdf.name === 'PBKDF2' && Number.isInteger(env.kdf.iterations) &&
      env.kdf.iterations >= 100000 && env.kdf.iterations <= 10000000 &&
      typeof env.kdf.salt === 'string' && env.cipher && env.cipher.name === 'AES-GCM' &&
      typeof env.cipher.iv === 'string' && typeof env.ct === 'string');
  }

  // 失敗したら例外。パスワード違い・改ざん・壊れたファイルはすべて復号失敗になる
  async function decryptEnvelope(env, kind, password) {
    if (!checkEnvelope(env, kind)) throw new Error('FORMAT');
    const key = await deriveKey(password, fromB64(env.kdf.salt), env.kdf.iterations);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(env.cipher.iv), additionalData: aadFor(kind) },
        key,
        fromB64(env.ct)
      );
    } catch (e) {
      throw new Error('DECRYPT');
    }
    return { key, data: JSON.parse(dec.decode(plain)) };
  }

  // ---- 保存領域（localStorage）とのやりとり ----

  function hasVault() {
    return root.localStorage.getItem(STORAGE_KEY) !== null;
  }

  function readVault() {
    const raw = root.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }

  // 解錠済みの状態（鍵とソルト）。メモリ上だけに置く
  let session = null;

  async function createVault(password, initialData) {
    if (hasVault()) throw new Error('EXISTS');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = toB64(salt);
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const env = await encryptJson(key, saltB64, PBKDF2_ITERATIONS, 'vault', initialData);
    root.localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
    session = { key, saltB64, iterations: PBKDF2_ITERATIONS };
  }

  async function unlock(password) {
    const env = readVault();
    if (!env) throw new Error('NOVAULT');
    const { key, data } = await decryptEnvelope(env, 'vault', password); // 失敗時は何も書き換えない
    session = { key, saltB64: env.kdf.salt, iterations: env.kdf.iterations };
    return data;
  }

  async function save(data) {
    if (!session) throw new Error('LOCKED');
    const env = await encryptJson(session.key, session.saltB64, session.iterations, 'vault', data);
    root.localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  }

  function lock() {
    session = null; // 鍵への参照を捨てる
  }

  function isUnlocked() {
    return session !== null;
  }

  // ---- バックアップ ----

  async function makeBackup(data) {
    if (!session) throw new Error('LOCKED');
    const env = await encryptJson(session.key, session.saltB64, session.iterations, 'backup', data);
    env.createdAt = new Date().toISOString();
    return JSON.stringify(env, null, 2);
  }

  // バックアップファイルの中身を、作成時のパスワードで復号する（まだ保存はしない）
  async function readBackup(text, password) {
    let env;
    try {
      env = JSON.parse(text);
    } catch (e) {
      throw new Error('FORMAT');
    }
    const { data } = await decryptEnvelope(env, 'backup', password);
    return data;
  }

  root.KakeiboStore = {
    STORAGE_KEY, isCryptoAvailable, isStorageAvailable, hasVault, createVault, unlock,
    save, lock, isUnlocked, makeBackup, readBackup,
  };
})(self);
