// 「アプリとしてインストール」の対応（PWA：ブラウザの機能でアプリのように使う仕組み）
(function () {
  'use strict';
  const btn = document.getElementById('install-button');
  const help = document.getElementById('install-help');
  const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // 登録できなくても家計簿自体は使える
    });
  }

  // ブラウザに「この保存データは勝手に消さないで」と頼む（認められるかはブラウザ次第）
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist().catch(() => {}); }).catch(() => {});
  }

  if (installed) {
    if (help) help.hidden = true;
    return;
  }

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (btn) btn.hidden = false;
  });
  if (btn) {
    btn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => null);
      deferred = null;
      btn.hidden = true;
    });
  }
  window.addEventListener('appinstalled', () => {
    if (btn) btn.hidden = true;
    if (help) help.textContent = 'アプリとしてインストールしました。次からはデスクトップやアプリ一覧の「家計簿」アイコンから開けます。';
  });
})();
