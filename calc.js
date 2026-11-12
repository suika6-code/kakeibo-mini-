// 計算と入力チェックだけを担当する部品（画面や保存には触れない）
// ブラウザでは window.KakeiboCalc として、テストでは require() で使う。
(function (root) {
  'use strict';

  const MAX_AMOUNT = 100000000; // 1億円まで

  const CATEGORIES = {
    expense: ['食費', '日用品', '交通', '住まい', '光熱・通信', '医療', '娯楽', '衣服', 'その他'],
    income: ['給与', '副収入', 'その他'],
  };

  // 全角数字やカンマ・円を取り除いて、半角の数字文字列にそろえる
  function normalizeAmountText(text) {
    return String(text == null ? '' : text)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，\s円¥￥]/g, '');
  }

  // 金額を検査する。正しければ {ok:true, value}、だめなら {ok:false, message}
  function parseAmount(text) {
    const t = normalizeAmountText(text);
    if (t === '') return { ok: false, message: '金額を入力してください。' };
    if (!/^\d+$/.test(t)) return { ok: false, message: '金額は0〜9の数字だけで入力してください（小数・マイナス不可）。' };
    const value = Number(t);
    if (value <= 0) return { ok: false, message: '金額は1円以上にしてください。' };
    if (value > MAX_AMOUNT) return { ok: false, message: '金額は1億円以下にしてください。' };
    return { ok: true, value };
  }

  // 予算額の検査（0円も可）
  function parseBudget(text) {
    const t = normalizeAmountText(text);
    if (t === '') return { ok: false, message: '予算額を入力してください。' };
    if (!/^\d+$/.test(t)) return { ok: false, message: '予算は0〜9の数字だけで入力してください。' };
    const value = Number(t);
    if (value > MAX_AMOUNT) return { ok: false, message: '予算は1億円以下にしてください。' };
    return { ok: true, value };
  }

  function isValidDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // 1件の記録を検査する。errors はフィールド名→メッセージ
  function validateRecord(input) {
    const errors = {};
    if (!isValidDate(input.date || '')) errors.date = '正しい日付を選んでください。';
    if (input.type !== 'income' && input.type !== 'expense') errors.type = '収入か支出を選んでください。';
    const amt = parseAmount(input.amount);
    if (!amt.ok) errors.amount = amt.message;
    const cats = CATEGORIES[input.type] || [];
    if (!cats.includes(input.category)) errors.category = 'カテゴリを選んでください。';
    const memo = String(input.memo || '');
    if (memo.length > 200) errors.memo = 'メモは200文字以内にしてください。';
    if (Object.keys(errors).length) return { ok: false, errors };
    return {
      ok: true,
      record: { date: input.date, type: input.type, amount: amt.value, category: input.category, memo: memo.trim() },
    };
  }

  function monthOf(dateStr) {
    return dateStr.slice(0, 7); // "2026-11-05" → "2026-11"
  }

  function recordsInMonth(records, month) {
    return records.filter((r) => monthOf(r.date) === month);
  }

  // 月の集計。残り予算は「予算 − 支出合計」で、収入は含めない
  function monthSummary(data, month) {
    const list = recordsInMonth(data.records, month);
    let income = 0;
    let expense = 0;
    for (const r of list) {
      if (r.type === 'income') income += r.amount;
      else if (r.type === 'expense') expense += r.amount;
    }
    const hasBudget = Object.prototype.hasOwnProperty.call(data.budgets, month);
    const budget = hasBudget ? data.budgets[month] : null;
    const remaining = hasBudget ? budget - expense : null;
    const over = hasBudget && remaining < 0 ? -remaining : 0;
    return { month, income, expense, budget, hasBudget, remaining, over };
  }

  // カテゴリ別の支出合計（多い順）
  function expenseByCategory(records, month) {
    const totals = new Map();
    for (const r of recordsInMonth(records, month)) {
      if (r.type !== 'expense') continue;
      totals.set(r.category, (totals.get(r.category) || 0) + r.amount);
    }
    return [...totals.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category, 'ja'));
  }

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function formatYen(n) {
    return n.toLocaleString('ja-JP') + '円';
  }

  // 復元時などに、読み込んだデータの形が正しいかを確かめる
  function validateData(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Array.isArray(data.records) || !data.budgets || typeof data.budgets !== 'object') return false;
    for (const r of data.records) {
      if (typeof r.id !== 'string') return false;
      const v = validateRecord({ ...r, amount: String(r.amount) });
      if (!v.ok) return false;
    }
    for (const [k, v] of Object.entries(data.budgets)) {
      if (!/^\d{4}-\d{2}$/.test(k) || !Number.isInteger(v) || v < 0 || v > MAX_AMOUNT) return false;
    }
    return true;
  }

  function emptyData() {
    return { version: 1, records: [], budgets: {} };
  }

  const api = {
    CATEGORIES, MAX_AMOUNT, normalizeAmountText, parseAmount, parseBudget, isValidDate,
    validateRecord, monthOf, recordsInMonth, monthSummary, expenseByCategory, shiftMonth,
    formatYen, validateData, emptyData,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KakeiboCalc = api;
})(typeof self !== 'undefined' ? self : this);
