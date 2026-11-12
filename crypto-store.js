// 暗号化と保存を担当する部品（第2版）
// ・暗号の方式は自作せず、ブラウザ標準の Web Crypto API と WebAuthn（パスキー）だけを使う
// ・記録は「データ鍵」（ランダムな256ビット鍵）で AES-GCM 暗号化する
// ・データ鍵そのものは保存せず、次の「鍵をしまう鍵」で暗号化した形だけを保存する
//   - パスワード：PBKDF2-SHA256（600,000回）でパスワードから作る … 必ずある（予備にもなる）
//   - 顔認証・指紋：パスキーの PRF 機能（端末の中で鍵の素を作る仕組み）＋ HKDF … 登録したときだけ
// ・パスワード・データ鍵・パスキーの秘密は保存しない
(function (root) {
  'use strict';

  const STORAGE_KEY = 'kakeibo-mini.vault.v1'; // 保存名は第1版と同じ（中身の版は v で区別）
  const APP_ID = 'kakeibo-mini';
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
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
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
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const aad = (label) => enc.encode(APP_ID + ':' + label);

  async function gcmEncrypt(key, label, bytes) {
    const iv = rand(12); // 毎回新しい乱数（IV）
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(label) }, key, bytes);
    return { iv: toB64(iv), ct: toB64(ct) };
  }
  async function gcmDecrypt(key, label, box) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(box.iv), additionalData: aad(label) }, key, fromB64(box.ct)));
    } catch (e) {
      throw new Error('DECRYPT');
    }
  }

  async function passwordKek(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function prfKek(prfOutput) {
    const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(APP_ID + ':passkey-kek:v2') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // データ鍵の生の値 → 使うための鍵（取り出せない設定）
  function importDek(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function wrapWithPassword(rawDek, password) {
    const salt = rand(16);
    const kek = await passwordKek(password, salt, PBKDF2_ITERATIONS);
    const box = await gcmEncrypt(kek, 'wrap-pw:v2', rawDek);
    return { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt) }, ...box };
  }

  function checkPwWrap(w) {
    return !!(w && w.kdf && w.kdf.name === 'PBKDF2' && Number.isInteger(w.kdf.iterations) &&
      w.kdf.iterations >= 100000 && w.kdf.iterations <= 10000000 && typeof w.kdf.salt === 'string' &&
      typeof w.iv === 'string' && typeof w.ct === 'string');
  }

  async function unwrapWithPassword(w, password) {
    if (!checkPwWrap(w)) throw new Error('FORMAT');
    const kek = await passwordKek(password, fromB64(w.kdf.salt), w.kdf.iterations);
    return gcmDecrypt(kek, 'wrap-pw:v2', w); // 失敗＝パスワード違い
  }

  // ---- 第1版（v1）の形式：パスワードから作った鍵で記録を直接暗号化 ----
  function checkV1(env, kind) {
    return !!(env && env.app === APP_ID && env.kind === kind && env.v === 1 && env.kdf &&
      env.kdf.name === 'PBKDF2' && Number.isInteger(env.kdf.iterations) &&
      env.kdf.iterations >= 100000 && env.kdf.iterations <= 10000000 &&
      env.cipher && env.cipher.name === 'AES-GCM' && typeof env.ct === 'string');
  }
  async function decryptV1(env, kind, password) {
    if (!checkV1(env, kind)) throw new Error('FORMAT');
    const key = await passwordKek(password, fromB64(env.kdf.salt), env.kdf.iterations);
    const plain = await gcmDecrypt(key, kind + ':v1', { iv: env.cipher.iv, ct: env.ct });
    return JSON.parse(dec.decode(plain));
  }

  // ---- 保存領域 ----
  function readVault() {
    const raw = root.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (e) { return { broken: true }; }
  }
  function writeVault(env) {
    root.localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  }
  function hasVault() {
    return root.localStorage.getItem(STORAGE_KEY) !== null;
  }

  // 解錠中だけメモリに置く：データ鍵（取り出せない設定）
  let session = null;

  async function newVaultEnvelope(rawDek, password, data, pk) {
    const dek = await importDek(rawDek);
    const pw = await wrapWithPassword(rawDek, password);
    const box = await gcmEncrypt(dek, 'data:v2', enc.encode(JSON.stringify(data)));
    return { dek, env: { app: APP_ID, kind: 'vault', v: 2, pw, pk: pk || null, data: box } };
  }

  async function createVault(password, initialData) {
    if (hasVault()) throw new Error('EXISTS');
    const rawDek = rand(32);
    const { dek, env } = await newVaultEnvelope(rawDek, password, initialData, null);
    rawDek.fill(0);
    writeVault(env);
    session = { dek };
  }

  async function openData(dek, env) {
    const plain = await gcmDecrypt(dek, 'data:v2', env.data);
    return JSON.parse(dec.decode(plain));
  }

  // パスワードで解除。失敗しても保存データは書き換えない
  async function unlock(password) {
    const env = readVault();
    if (!env) throw new Error('NOVAULT');
    if (env.v === 1) {
      // 第1版のデータ：読めたら第2版の形にして保存し直す
      const data = await decryptV1(env, 'vault', password);
      const rawDek = rand(32);
      const made = await newVaultEnvelope(rawDek, password, data, null);
      rawDek.fill(0);
      writeVault(made.env);
      session = { dek: made.dek };
      return data;
    }
    if (env.v !== 2 || env.app !== APP_ID) throw new Error('FORMAT');
    const rawDek = await unwrapWithPassword(env.pw, password);
    const dek = await importDek(rawDek);
    rawDek.fill(0);
    const data = await openData(dek, env);
    session = { dek };
    return data;
  }

  async function save(data) {
    if (!session) throw new Error('LOCKED');
    const env = readVault();
    if (!env || env.v !== 2) throw new Error('FORMAT');
    env.data = await gcmEncrypt(session.dek, 'data:v2', enc.encode(JSON.stringify(data)));
    writeVault(env);
  }

  function lock() {
    session = null;
    pendingEnroll = null;
  }
  function isUnlocked() {
    return session !== null;
  }

  // パスワード忘れのとき：この端末のデータだけを消す
  function resetVault() {
    root.localStorage.removeItem(STORAGE_KEY);
    lock();
  }

  // ---- 顔認証・指紋（パスキー）----
  // パスキーは「127.0.0.1」のような数字の住所では使えない決まり（localhost や github.io は可）
  function isIpAddressHost() {
    const h = root.location.hostname;
    return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('[');
  }

  async function isPasskeySupported() {
    try {
      if (isIpAddressHost()) return false;
      if (!root.PublicKeyCredential || !navigator.credentials) return false;
      if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
      if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
        const caps = await PublicKeyCredential.getClientCapabilities();
        if (caps && caps['extension:prf'] === false) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function hasPasskey() {
    const env = readVault();
    return !!(env && env.v === 2 && env.pk && env.pk.credId);
  }

  async function prfFromAssertion(credIdBytes, prfSalt) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: 'public-key', id: credIdBytes }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
    const r = cred && cred.getClientExtensionResults && cred.getClientExtensionResults();
    const first = r && r.prf && r.prf.results && r.prf.results.first;
    if (!first) throw new Error('UNSUPPORTED');
    return new Uint8Array(first);
  }

  // 登録の手順1：パスワードを確かめて、データ鍵を短時間だけ用意する
  let pendingEnroll = null;
  async function beginPasskeyEnroll(password) {
    if (!session) throw new Error('LOCKED');
    const env = readVault();
    const rawDek = await unwrapWithPassword(env.pw, password);
    if (pendingEnroll) pendingEnroll.rawDek.fill(0);
    pendingEnroll = { rawDek, credId: null, prfSalt: rand(32), expires: Date.now() + 2 * 60 * 1000 };
  }

  // 登録の手順2：ボタンを押した直後に呼ぶ（顔認証・指紋の確認が出る）
  // 端末によっては確認が2回必要。その場合は 'AGAIN' を投げるので、もう一度押してもらう
  async function finishPasskeyEnroll() {
    const p = pendingEnroll;
    if (!session || !p || Date.now() > p.expires) { cancelPasskeyEnroll(); throw new Error('EXPIRED'); }
    let prf = null;
    if (!p.credId) {
      const cred = await navigator.credentials.create({
        publicKey: {
          rp: { name: 'かんたん家計簿' },
          user: { id: rand(16), name: 'kakeibo-mini', displayName: 'かんたん家計簿' },
          challenge: rand(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
          timeout: 60000,
          extensions: { prf: { eval: { first: p.prfSalt } } },
        },
      });
      p.credId = new Uint8Array(cred.rawId);
      const r = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
      if (r.prf && r.prf.enabled === false) { cancelPasskeyEnroll(); throw new Error('UNSUPPORTED'); }
      if (r.prf && r.prf.results && r.prf.results.first) prf = new Uint8Array(r.prf.results.first);
    }
    if (!prf) {
      try {
        prf = await prfFromAssertion(p.credId, p.prfSalt);
      } catch (e) {
        if (e && e.name === 'NotAllowedError') throw new Error('AGAIN');
        if (e.message === 'UNSUPPORTED') cancelPasskeyEnroll();
        throw e;
      }
    }
    const kek = await prfKek(prf);
    prf.fill(0);
    const box = await gcmEncrypt(kek, 'wrap-pk:v2', p.rawDek);
    const env = readVault();
    env.pk = { credId: toB64(p.credId), prfSalt: toB64(p.prfSalt), ...box };
    writeVault(env);
    cancelPasskeyEnroll();
  }

  function cancelPasskeyEnroll() {
    if (pendingEnroll) pendingEnroll.rawDek.fill(0);
    pendingEnroll = null;
  }
  function isEnrollPending() {
    return !!(pendingEnroll && Date.now() <= pendingEnroll.expires);
  }

  async function unlockWithPasskey() {
    const env = readVault();
    if (!env || env.v !== 2 || !env.pk) throw new Error('NOPASSKEY');
    const prf = await prfFromAssertion(fromB64(env.pk.credId), fromB64(env.pk.prfSalt));
    const kek = await prfKek(prf);
    prf.fill(0);
    const rawDek = await gcmDecrypt(kek, 'wrap-pk:v2', env.pk);
    const dek = await importDek(rawDek);
    rawDek.fill(0);
    const data = await openData(dek, env);
    session = { dek };
    return data;
  }

  function removePasskey() {
    const env = readVault();
    if (!env || env.v !== 2) return;
    env.pk = null;
    writeVault(env);
  }

  // ---- バックアップ（パスワードで開ける形。顔認証の情報は入れない）----
  async function makeBackup(data) {
    if (!session) throw new Error('LOCKED');
    const env = readVault();
    const box = await gcmEncrypt(session.dek, 'backup-data:v2', enc.encode(JSON.stringify(data)));
    return JSON.stringify({ app: APP_ID, kind: 'backup', v: 2, pw: env.pw, data: box, createdAt: new Date().toISOString() }, null, 2);
  }

  async function readBackup(text, password) {
    let env;
    try { env = JSON.parse(text); } catch (e) { throw new Error('FORMAT'); }
    if (!env || env.app !== APP_ID || env.kind !== 'backup') throw new Error('FORMAT');
    if (env.v === 1) return decryptV1(env, 'backup', password);
    if (env.v !== 2) throw new Error('FORMAT');
    const rawDek = await unwrapWithPassword(env.pw, password);
    const dek = await importDek(rawDek);
    rawDek.fill(0);
    const plain = await gcmDecrypt(dek, 'backup-data:v2', env.data);
    return JSON.parse(dec.decode(plain));
  }

  root.KakeiboStore = {
    STORAGE_KEY, isCryptoAvailable, isStorageAvailable, hasVault, createVault, unlock, save, lock,
    isUnlocked, resetVault, isIpAddressHost, makeBackup, readBackup, isPasskeySupported, hasPasskey,
    beginPasskeyEnroll, finishPasskeyEnroll, cancelPasskeyEnroll, isEnrollPending, unlockWithPasskey, removePasskey,
  };
})(self);
