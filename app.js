// 画面の動きを担当する部品
(function () {
  'use strict';

  const C = window.KakeiboCalc;
  const S = window.KakeiboStore;
  const AUTO_LOCK_MINUTES = 15;
  const AUTO_LOCK_MS = AUTO_LOCK_MINUTES * 60 * 1000; // 15分

  const $ = (id) => document.getElementById(id);

  // 解錠中だけメモリに置くデータ
  let data = null;
  let currentMonth = thisMonth();
  let editingId = null;
  let selectedCategory = null;
  let lockTimer = null;
  let busy = false;

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function thisMonth() {
    return todayStr().slice(0, 7);
  }
  function monthLabel(m) {
    const [y, mo] = m.split('-').map(Number);
    return y + '年' + mo + '月';
  }
  function newId() {
    const b = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- 画面の切り替え ----------
  function show(screen) {
    for (const id of ['screen-env', 'screen-setup', 'screen-lock', 'screen-main']) {
      $(id).hidden = id !== screen;
    }
    $('lock-button').hidden = screen !== 'screen-main';
  }

  function setText(id, text) {
    $(id).textContent = text || '';
  }

  // ---------- 起動 ----------
  function start() {
    if (!S.isCryptoAvailable()) {
      setText('env-reason', 'このブラウザ（または、ファイルを直接開く開き方）では、標準の暗号機能が使えません。');
      show('screen-env');
      return;
    }
    if (!S.isStorageAvailable()) {
      setText('env-reason', 'このブラウザでは保存領域（localStorage）が使えません。プライベートモードや保存の制限を確認してください。');
      show('screen-env');
      return;
    }
    if (S.hasVault()) {
      show('screen-lock');
      updateLockScreen();
    } else {
      show('screen-setup');
      $('setup-pw').focus();
    }
  }

  // ロック画面：顔認証を登録済みなら、そのボタンをいちばん上に出す
  function updateLockScreen() {
    const pk = S.hasPasskey();
    $('passkey-unlock-box').hidden = !pk;
    setText('passkey-unlock-error', '');
    $('reset-confirm').value = '';
    setText('reset-error', '');
    $('forgot').open = false;
    if (pk) $('passkey-unlock').focus();
    else $('unlock-pw').focus();
  }

  // ---------- 初回設定 ----------
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const pw = $('setup-pw').value;
    const pw2 = $('setup-pw2').value;
    let msg = '';
    if (pw.length < 10) msg = 'パスワードは10文字以上にしてください。';
    else if (pw !== pw2) msg = '確認用のパスワードが一致しません。';
    else if (!$('setup-agree').checked) msg = '「忘れると復元できない」ことの確認にチェックを入れてください。';
    setText('setup-error', msg);
    if (msg) return;
    busy = true;
    setText('setup-error', '設定中です…');
    try {
      await S.createVault(pw, C.emptyData());
      $('setup-pw').value = '';
      $('setup-pw2').value = '';
      setText('setup-error', '');
      openMain(C.emptyData());
    } catch (err) {
      setText('setup-error', err.message === 'EXISTS' ? 'すでにパスワードが設定されています。再読み込みしてください。' : '設定に失敗しました。');
    } finally {
      busy = false;
    }
  });

  // ---------- 解錠 ----------
  $('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const pw = $('unlock-pw').value;
    if (!pw) {
      setText('unlock-error', 'パスワードを入力してください。');
      return;
    }
    busy = true;
    $('unlock-submit').disabled = true;
    setText('unlock-error', '確認中です…');
    try {
      const loaded = await S.unlock(pw);
      if (!C.validateData(loaded)) throw new Error('FORMAT');
      $('unlock-pw').value = '';
      setPasswordVisible(false);
      setText('unlock-error', '');
      openMain(loaded);
      $('entry-amount').focus();
    } catch (err) {
      S.lock();
      // 失敗しても保存データには一切触れない
      setText('unlock-error', 'パスワードが違うか、保存データを読み取れませんでした。記録は消えていません。');
      $('unlock-pw').select();
    } finally {
      busy = false;
      $('unlock-submit').disabled = false;
    }
  });

  function openMain(loaded) {
    data = loaded;
    currentMonth = thisMonth();
    resetEntryForm();
    show('screen-main');
    render();
    renderPasskeyCard();
    resetLockTimer();
  }

  // ---------- 顔認証・指紋で解除 ----------
  $('passkey-unlock').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('passkey-unlock').disabled = true;
    setText('passkey-unlock-error', '');
    try {
      const loaded = await S.unlockWithPasskey();
      if (!C.validateData(loaded)) throw new Error('FORMAT');
      openMain(loaded);
      $('entry-amount').focus();
    } catch (err) {
      S.lock();
      setText('passkey-unlock-error', err && err.name === 'NotAllowedError'
        ? 'キャンセルされたか、時間切れになりました。もう一度押すか、パスワードで解除してください。'
        : '顔認証・指紋では開けませんでした。パスワードで解除してください。記録は消えていません。');
    } finally {
      busy = false;
      $('passkey-unlock').disabled = false;
    }
  });

  function hidePasskeySteps() {
    $('passkey-step1').hidden = true;
    $('passkey-step2').hidden = true;
    $('passkey-pw').value = '';
    setText('passkey-error', '');
  }

  async function renderPasskeyCard() {
    hidePasskeySteps();
    $('passkey-start').hidden = true;
    $('passkey-remove').hidden = true;
    if (S.hasPasskey()) {
      setText('passkey-status', '✓ 設定済みです。ロック画面の「顔認証・指紋で解除」で開けます。');
      $('passkey-remove').hidden = false;
      return;
    }
    const ok = await S.isPasskeySupported();
    if (!S.isUnlocked()) return;
    if (ok) {
      setText('passkey-status', 'この端末では、顔認証（Face ID）や指紋（Touch ID）で開けるように設定できます。');
      $('passkey-start').hidden = false;
    } else if (S.isIpAddressHost()) {
      setText('passkey-status', 'この開き方（' + location.host + '）では使えません。公開版（github.io）か、http://localhost:8000/ で開くと使えます。');
    } else {
      setText('passkey-status', 'この端末・ブラウザでは使えません（iPhone は iOS 18 以降の Safari、Mac は macOS 15 以降の Safari か Chrome で使えます）。');
    }
  }

  $('passkey-start').addEventListener('click', () => {
    setText('passkey-ok', '');
    $('passkey-start').hidden = true;
    $('passkey-step1').hidden = false;
    $('passkey-pw').focus();
  });

  async function passkeyNext() {
    if (busy) return;
    const pw = $('passkey-pw').value;
    if (!pw) { setText('passkey-error', 'パスワードを入力してください。'); return; }
    busy = true;
    setText('passkey-error', '確認中です…');
    try {
      await S.beginPasskeyEnroll(pw);
      $('passkey-pw').value = '';
      setText('passkey-error', '');
      $('passkey-step1').hidden = true;
      $('passkey-step2').hidden = false;
      $('passkey-register').focus();
    } catch (err) {
      setText('passkey-error', 'パスワードが違います。');
      $('passkey-pw').select();
    } finally {
      busy = false;
    }
  }
  $('passkey-next').addEventListener('click', passkeyNext);
  $('passkey-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); passkeyNext(); } });

  $('passkey-register').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    setText('passkey-error', '');
    try {
      await S.finishPasskeyEnroll(); // ボタンを押した直後に呼ぶ（端末の確認が出る）
      await renderPasskeyCard();
      setText('passkey-ok', '登録しました。次からはロック画面の「顔認証・指紋で解除」で開けます。');
    } catch (err) {
      const m = err && err.message;
      if (m === 'AGAIN') {
        setText('passkey-error', 'もう一度このボタンを押すと、登録が完了します。');
      } else if (m === 'UNSUPPORTED') {
        setText('passkey-error', 'この端末では顔認証・指紋での解除に対応していませんでした。これまでどおりパスワードで解除してください。');
        await renderPasskeyCard();
      } else if (m === 'EXPIRED') {
        setText('passkey-error', '時間がたったので、もう一度パスワードの確認からやり直してください。');
        await renderPasskeyCard();
      } else if (err && err.name === 'NotAllowedError') {
        setText('passkey-error', 'キャンセルされたか、時間切れになりました。もう一度押してください。');
      } else {
        setText('passkey-error', '登録できませんでした。（' + ((err && err.name) || 'エラー') + '）');
      }
    } finally {
      busy = false;
    }
  });

  $('passkey-remove').addEventListener('click', async () => {
    const ok = await confirmDialog('顔認証・指紋での解除をやめますか？ これからはパスワードで解除します。（iPhone・Mac の「パスワード」アプリに残る鍵は、そちらで削除できます）', 'やめる');
    if (!ok || !S.isUnlocked()) return;
    S.removePasskey();
    await renderPasskeyCard();
    setText('passkey-ok', '顔認証・指紋での解除をやめました。');
  });

  // ---------- パスワードを忘れたとき：この端末のデータを消す ----------
  $('reset-button').addEventListener('click', async () => {
    if ($('reset-confirm').value.trim() !== 'けす') {
      setText('reset-error', '消す場合は「けす」と入力してください。');
      return;
    }
    setText('reset-error', '');
    const ok = await confirmDialog('この端末の家計簿の記録・予算をすべて消します。元には戻せません。本当に消しますか？', '消す');
    if (!ok) return;
    S.resetVault();
    data = null;
    $('reset-confirm').value = '';
    show('screen-setup');
    $('setup-pw').focus();
  });

  // ---------- ロック ----------
  function lockNow(reason) {
    S.lock();
    data = null;
    editingId = null;
    clearTimeout(lockTimer);
    lockTimer = null;
    // 画面に残った記録や入力中の内容も消す
    $('record-list').replaceChildren();
    $('category-chart').replaceChildren();
    for (const id of ['sum-income', 'sum-expense', 'sum-budget', 'sum-remaining', 'over-message']) setText(id, '');
    for (const id of ['entry-amount', 'entry-memo', 'budget-amount', 'restore-pw']) $(id).value = '';
    $('restore-file').value = '';
    const dlg = $('confirm-dialog');
    if (dlg.open) dlg.close('cancel');
    setText('lock-message', reason || 'パスワードを入力すると記録を表示します。');
    setText('unlock-error', '');
    setPasswordVisible(false);
    $('caps-warning').hidden = true;
    hidePasskeySteps();
    setText('passkey-ok', '');
    show('screen-lock');
    $('unlock-pw').value = '';
    updateLockScreen(); // すぐ解除できるように
  }

  // パスワードの表示／非表示
  function setPasswordVisible(visible) {
    $('unlock-pw').type = visible ? 'text' : 'password';
    $('unlock-show').textContent = visible ? '隠す' : '表示';
    $('unlock-show').setAttribute('aria-pressed', String(visible));
  }
  $('unlock-show').addEventListener('click', () => {
    setPasswordVisible($('unlock-pw').type === 'password');
    $('unlock-pw').focus();
  });
  // Caps Lock（大文字固定）の打ち間違いに気づけるようにする
  for (const ev of ['keydown', 'keyup']) {
    $('unlock-pw').addEventListener(ev, (e) => {
      if (e.getModifierState) $('caps-warning').hidden = !e.getModifierState('CapsLock');
    });
  }

  $('lock-button').addEventListener('click', () => lockNow('ロックしました。'));

  function resetLockTimer() {
    if (!S.isUnlocked()) return;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(() => lockNow(AUTO_LOCK_MINUTES + '分間操作がなかったため、ロックしました。'), AUTO_LOCK_MS);
  }
  for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(ev, resetLockTimer, { passive: true, capture: true });
  }
  // スリープ復帰などでタイマーが遅れた場合にも備える
  let lastActive = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'input']) {
    window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.isUnlocked() && Date.now() - lastActive >= AUTO_LOCK_MS) {
      lockNow(AUTO_LOCK_MINUTES + '分間操作がなかったため、ロックしました。');
    }
  });

  // ---------- 保存 ----------
  async function persist() {
    await S.save(data);
  }

  // ---------- 月の切り替え ----------
  function goMonth(m) {
    currentMonth = m;
    // 新しく記録するときの日付も、表示中の月に合わせる（編集中は変えない）
    if (!editingId) $('entry-date').value = defaultDateFor(currentMonth);
    setText('budget-status', '');
    setText('entry-status', '');
    render();
  }
  function defaultDateFor(m) {
    return m === thisMonth() ? todayStr() : m + '-01';
  }
  $('prev-month').addEventListener('click', () => goMonth(C.shiftMonth(currentMonth, -1)));
  $('next-month').addEventListener('click', () => goMonth(C.shiftMonth(currentMonth, 1)));
  $('this-month').addEventListener('click', () => goMonth(thisMonth()));

  // ---------- 記録の入力 ----------
  function selectedType() {
    return document.querySelector('input[name="type"]:checked').value;
  }

  function renderChips() {
    const box = $('category-chips');
    box.replaceChildren();
    for (const cat of C.CATEGORIES[selectedType()]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = cat;
      b.setAttribute('aria-pressed', String(cat === selectedCategory));
      b.addEventListener('click', () => {
        selectedCategory = cat;
        setText('err-category', '');
        renderChips();
      });
      box.appendChild(b);
    }
  }

  for (const r of document.querySelectorAll('input[name="type"]')) {
    r.addEventListener('change', () => {
      if (!C.CATEGORIES[selectedType()].includes(selectedCategory)) selectedCategory = null;
      renderChips();
    });
  }

  function clearEntryErrors() {
    for (const id of ['err-amount', 'err-category', 'err-date', 'err-memo', 'entry-status']) setText(id, '');
  }

  function resetEntryForm() {
    editingId = null;
    document.querySelector('input[name="type"][value="expense"]').checked = true;
    selectedCategory = null;
    $('entry-amount').value = '';
    $('entry-memo').value = '';
    $('entry-date').value = defaultDateFor(currentMonth);
    $('entry-submit').textContent = '記録する';
    $('entry-cancel').hidden = true;
    setText('entry-title', '収入・支出を記録する');
    clearEntryErrors();
    renderChips();
  }

  $('entry-cancel').addEventListener('click', () => resetEntryForm());

  $('entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!data || busy) return;
    clearEntryErrors();
    const v = C.validateRecord({
      date: $('entry-date').value,
      type: selectedType(),
      amount: $('entry-amount').value,
      category: selectedCategory,
      memo: $('entry-memo').value,
    });
    if (!v.ok) {
      setText('err-amount', v.errors.amount);
      setText('err-category', v.errors.category);
      setText('err-date', v.errors.date);
      setText('err-memo', v.errors.memo);
      const first = v.errors.amount ? 'entry-amount' : v.errors.date ? 'entry-date' : v.errors.memo ? 'entry-memo' : null;
      if (first) $(first).focus();
      return;
    }
    busy = true;
    const before = JSON.stringify(data);
    try {
      let message;
      if (editingId) {
        const idx = data.records.findIndex((r) => r.id === editingId);
        if (idx < 0) throw new Error('NOTFOUND');
        data.records[idx] = { id: editingId, ...v.record };
        message = '変更を保存しました。';
      } else {
        data.records.push({ id: newId(), ...v.record });
        message = '記録しました。';
      }
      await persist();
      currentMonth = C.monthOf(v.record.date);
      resetEntryForm();
      setText('entry-status', message);
      render();
      $('entry-amount').focus();
    } catch (err) {
      data = JSON.parse(before); // 保存できなかったら元に戻す
      setText('entry-status', '保存に失敗しました。もう一度お試しください。');
    } finally {
      busy = false;
    }
  });

  function startEdit(rec) {
    editingId = rec.id;
    document.querySelector(`input[name="type"][value="${rec.type}"]`).checked = true;
    selectedCategory = rec.category;
    $('entry-amount').value = String(rec.amount);
    $('entry-date').value = rec.date;
    $('entry-memo').value = rec.memo || '';
    $('entry-submit').textContent = '変更を保存';
    $('entry-cancel').hidden = false;
    setText('entry-title', '記録を編集する');
    clearEntryErrors();
    renderChips();
    $('entry-amount').focus();
    $('entry-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function deleteRecord(rec) {
    const ok = await confirmDialog(`${rec.date}　${rec.category}　${C.formatYen(rec.amount)} の記録を削除しますか？`, '削除する');
    if (!ok || !data) return;
    const before = JSON.stringify(data);
    data.records = data.records.filter((r) => r.id !== rec.id);
    try {
      await persist();
      if (editingId === rec.id) resetEntryForm();
      render();
    } catch (err) {
      data = JSON.parse(before);
      alertStatus('entry-status', '削除に失敗しました。');
    }
  }

  function alertStatus(id, msg) {
    setText(id, msg);
  }

  // ---------- 予算 ----------
  $('budget-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!data || busy) return;
    setText('budget-status', '');
    const v = C.parseBudget($('budget-amount').value);
    if (!v.ok) {
      setText('err-budget', v.message);
      $('budget-amount').focus();
      return;
    }
    setText('err-budget', '');
    busy = true;
    const before = JSON.stringify(data);
    try {
      data.budgets[currentMonth] = v.value;
      await persist();
      setText('budget-status', monthLabel(currentMonth) + 'の予算を ' + C.formatYen(v.value) + ' にしました。');
      render();
    } catch (err) {
      data = JSON.parse(before);
      setText('err-budget', '保存に失敗しました。');
    } finally {
      busy = false;
    }
  });

  // ---------- 表示 ----------
  function render() {
    if (!data) return;
    const s = C.monthSummary(data, currentMonth);
    const isThis = currentMonth === thisMonth();
    const prefix = isThis ? '今月' : monthLabel(currentMonth).replace(/^\d+年/, '');
    setText('month-label', monthLabel(currentMonth));
    setText('label-income', prefix + 'の収入');
    setText('label-expense', prefix + 'の支出');
    setText('label-budget', prefix + 'の予算');
    $('this-month').hidden = isThis;
    setText('budget-title', monthLabel(currentMonth) + 'の予算');
    setText('list-title', monthLabel(currentMonth) + 'の記録');
    setText('chart-title', monthLabel(currentMonth) + 'のカテゴリ別支出');

    setText('sum-income', C.formatYen(s.income));
    setText('sum-expense', C.formatYen(s.expense));
    setText('sum-budget', s.hasBudget ? C.formatYen(s.budget) : '未設定');
    const remEl = $('stat-remaining');
    remEl.classList.toggle('is-over', s.over > 0);
    if (!s.hasBudget) setText('sum-remaining', '予算未設定');
    else setText('sum-remaining', s.remaining < 0 ? '−' + C.formatYen(-s.remaining) : C.formatYen(s.remaining));
    const overEl = $('over-message');
    if (s.over > 0) {
      overEl.hidden = false;
      setText('over-message', '⚠ 予算を ' + C.formatYen(s.over) + ' 超えています。');
    } else {
      overEl.hidden = true;
      setText('over-message', '');
    }
    if (document.activeElement !== $('budget-amount')) $('budget-amount').value = s.hasBudget ? String(s.budget) : '';

    renderChart();
    renderList();
  }

  function renderChart() {
    const rows = C.expenseByCategory(data.records, currentMonth);
    const box = $('category-chart');
    box.replaceChildren();
    $('chart-empty').hidden = rows.length > 0;
    if (!rows.length) return;
    const max = rows[0].total;
    const total = rows.reduce((a, r) => a + r.total, 0);
    for (const r of rows) {
      const pct = total ? Math.round((r.total / total) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.title = `${r.category}: ${C.formatYen(r.total)}（支出全体の${pct}%）`;
      const label = document.createElement('span');
      label.className = 'bar-label';
      label.textContent = r.category;
      const track = document.createElement('span');
      track.className = 'bar-track';
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.width = Math.max(2, (r.total / max) * 100) + '%';
      track.appendChild(bar);
      const val = document.createElement('span');
      val.className = 'bar-value';
      val.textContent = `${C.formatYen(r.total)}（${pct}%）`;
      row.append(label, track, val);
      box.appendChild(row);
    }
  }

  function renderList() {
    const list = $('record-list');
    list.replaceChildren();
    const recs = C.recordsInMonth(data.records, currentMonth)
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date));
    $('list-empty').hidden = recs.length > 0;
    for (const rec of recs) {
      const li = document.createElement('li');
      li.className = 'record ' + rec.type;
      const main = document.createElement('div');
      main.className = 'record-main';
      const top = document.createElement('div');
      const date = document.createElement('span');
      date.className = 'record-date';
      date.textContent = rec.date.slice(5).replace('-', '/');
      const cat = document.createElement('span');
      cat.className = 'record-cat';
      cat.textContent = (rec.type === 'income' ? '収入・' : '支出・') + rec.category;
      top.append(date, cat);
      const amt = document.createElement('div');
      amt.className = 'record-amount';
      amt.textContent = (rec.type === 'income' ? '＋' : '−') + C.formatYen(rec.amount);
      main.append(top, amt);
      if (rec.memo) {
        const memo = document.createElement('div');
        memo.className = 'record-memo';
        memo.textContent = rec.memo;
        main.appendChild(memo);
      }
      const actions = document.createElement('div');
      actions.className = 'record-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-ghost btn-small';
      edit.textContent = '編集';
      edit.setAttribute('aria-label', `${rec.date} ${rec.category} を編集`);
      edit.addEventListener('click', () => startEdit(rec));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-danger-ghost btn-small';
      del.textContent = '削除';
      del.setAttribute('aria-label', `${rec.date} ${rec.category} を削除`);
      del.addEventListener('click', () => deleteRecord(rec));
      actions.append(edit, del);
      li.append(main, actions);
      list.appendChild(li);
    }
  }

  // ---------- 確認ダイアログ ----------
  function confirmDialog(message, okLabel) {
    return new Promise((resolve) => {
      const dlg = $('confirm-dialog');
      setText('confirm-message', message);
      $('confirm-ok').textContent = okLabel || '実行する';
      dlg.returnValue = '';
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      };
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  // ---------- バックアップ ----------
  $('backup-export').addEventListener('click', async () => {
    if (!data) return;
    try {
      const text = await S.makeBackup(data);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `kakeibo-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setText('backup-status', `書き出しました（${a.download}）。中身は暗号化されています。`);
    } catch (err) {
      setText('backup-status', '書き出しに失敗しました。');
    }
  });

  $('restore-button').addEventListener('click', async () => {
    if (!data || busy) return;
    setText('restore-error', '');
    setText('restore-status', '');
    const file = $('restore-file').files[0];
    const pw = $('restore-pw').value;
    if (!file) { setText('restore-error', 'バックアップファイルを選んでください。'); return; }
    if (!pw) { setText('restore-error', 'バックアップを作ったときのパスワードを入力してください。'); return; }
    if (file.size > 20 * 1024 * 1024) { setText('restore-error', 'ファイルが大きすぎます（20MBまで）。'); return; }
    busy = true;
    let restored;
    try {
      setText('restore-status', '確認中です…');
      const text = await file.text();
      restored = await S.readBackup(text, pw);
      if (!C.validateData(restored)) throw new Error('FORMAT');
    } catch (err) {
      setText('restore-status', '');
      setText('restore-error', err.message === 'DECRYPT'
        ? 'パスワードが違うか、ファイルが壊れています。いまの記録はそのままです。'
        : 'このアプリのバックアップファイルとして読み取れませんでした。いまの記録はそのままです。');
      busy = false;
      return;
    }
    busy = false;
    setText('restore-status', '');
    const msg = `いまの記録 ${data.records.length}件・予算 ${Object.keys(data.budgets).length}か月分を、バックアップの記録 ${restored.records.length}件・予算 ${Object.keys(restored.budgets).length}か月分で上書きします。元には戻せません。よろしいですか？`;
    const ok = await confirmDialog(msg, '上書きして復元する');
    if (!ok || !data) {
      setText('restore-status', '復元をやめました。いまの記録はそのままです。');
      return;
    }
    const before = data;
    try {
      data = restored;
      await persist(); // いまのパスワードで暗号化して保存し直す
      $('restore-pw').value = '';
      $('restore-file').value = '';
      resetEntryForm();
      render();
      setText('restore-status', '復元しました。');
    } catch (err) {
      data = before;
      setText('restore-error', '復元の保存に失敗しました。');
    }
  });

  start();
})();
