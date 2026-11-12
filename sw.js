// サービスワーカー：アプリの部品（画面・プログラム・アイコン）を手元に保管し、
// 簡易サーバーを起動していなくてもアプリを開けるようにする。
// ・家計簿の記録は扱わない（記録は暗号化されて localStorage にある）
// ・このアプリ自身（同じ住所）のファイル以外は一切取りに行かない
'use strict';

const VERSION = 'kakeibo-mini-v3';
const FILES = [
  './',
  './index.html',
  './style.css',
  './calc.js',
  './crypto-store.js',
  './app.js',
  './pwa.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 自分の住所の GET だけを扱う。それ以外には関与しない
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  let path = url.pathname;
  if (path === scopePath) path = scopePath + 'index.html';
  const allowed = FILES.map((f) => new URL(f, self.registration.scope).pathname);
  if (!allowed.includes(path)) return; // tests/ などアプリ外のファイルは保管しない

  // まず簡易サーバーから最新を取り、取れなければ（起動していなければ）保管分を使う
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh.ok) await cache.put(path, fresh.clone());
      return fresh;
    } catch (e) {
      const cached = await cache.match(path);
      if (cached) return cached;
      throw e;
    }
  })());
});
