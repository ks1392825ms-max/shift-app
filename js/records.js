// 申請と判断の記録の形（希望休・有給・判断の履歴）
// アプリ（cloud.js）と、Firestore のルールの試験の両方で使う。ここで作る形と、ルールで許す形をそろえる。
//
// 記録の種類：
//   wishRequests/{スタッフID_日付}   希望休（1日ごと）：status＝pending（申請中）/ approved（承認）/ rejected（却下）
//   wishCounts/{スタッフID_月}        希望休の日数（月の上限をルールで確かめるため）。0日の「希望なし」も、送信した印として残す
//   paidRequests/{スタッフID_日付_回数} 有給希望（今までの形に、判断の項目を足す）
//   changeRequests/{種類_記録の名前_回数} 変更申請：承認済みの希望休・有給の取り消し（cancel）・日付の変更（move）
//                                  同じ申請への変更申請は3回まで（2回目・3回目は前の回が却下のときだけ）。承認されたら、オーナーがシフト表に反映する
//   decisionLogs/{種類_記録の名前_日時} 判断の履歴：誰が・いつ・どの申請を・どう変えたか。追加するだけで、書き換え・削除はできない
//                                  種類：'wish'（希望休）/ 'paid'（有給）/ 'change'（変更申請）
//
// 判断の項目（希望休・有給で共通）：
//   decidedBy（判断した人のメール。申請中は ''）・decidedRole（'owner'＝オーナー / 'manager'＝幹部。申請中は ''）
//   decidedAt（判断した日時。申請中は ''）・reason（却下の理由。却下のときだけ、50文字以内）
//   status は pending / approved / rejected と、cancelled（取り消し済み：承認された変更申請をオーナーが反映したもの。オーナーだけ）
//   lastActionBy・lastActionAt（最後に判断を変えた人と日時。申請中に戻したときも入る。履歴の記録の名前に使う）
(function (root) {
  'use strict';

  const MAX_REASON = 50;
  const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
  const CHANGE_TYPES = ['cancel', 'move'];
  const MAX_CHANGE_ATTEMPTS = 3;
  const DECISION_KEYS = ['status', 'reason', 'decidedBy', 'decidedRole', 'decidedAt', 'lastActionBy', 'lastActionAt', 'updatedAt'];

  const wishId = (staffId, date) => `${staffId}_${date}`;
  const countId = (staffId, month) => `${staffId}_${month}`;
  const logId = (kind, targetId, at) => `${kind}_${targetId}_${at}`;
  const collectionOf = (kind) => ({ wish: 'wishRequests', paid: 'paidRequests', change: 'changeRequests' })[kind];
  const changeId = (kind, targetId, attempt) => `${kind}_${targetId}_${attempt}`;

  // 却下の理由：却下のときだけ必須（前後の空白は除く。50文字以内）。それ以外は空
  function cleanReason(status, reason) {
    if (status !== 'rejected') return '';
    const r = String(reason || '').trim();
    if (!r) throw new Error('却下の理由を入れてください。');
    if ([...r].length > MAX_REASON) throw new Error(`却下の理由は${MAX_REASON}文字以内で入れてください。`);
    return r;
  }

  // スタッフが出す希望休（1日分）
  function newWish({ staffId, storeId, date, email, now }) {
    return { staffId, storeId, month: date.slice(0, 7), date, status: 'pending', createdAt: now, updatedAt: now, createdBy: email || '' };
  }

  // 希望休の日数。count を1つ増やす・減らすときは、増減した日を lastDate に入れる
  function countDoc({ staffId, storeId, month, count, lastDate, email, now }) {
    return { staffId, storeId, month, count, lastDate: lastDate || '', submitted: true, updatedAt: now, updatedBy: email || '' };
  }

  // スタッフが出す変更申請。target は承認済みの希望休・有給の記録（id を含む）。type は 'cancel' か 'move'（newDate が必要）
  function newChange({ kind, target, type, newDate, note, email, now, attempt }) {
    if (!['wish', 'paid'].includes(kind)) throw new Error('変更申請の対象が正しくありません。');
    if (!CHANGE_TYPES.includes(type)) throw new Error('変更の種類を選んでください。');
    const n = String(note || '').trim();
    if ([...n].length > MAX_REASON) throw new Error(`理由は${MAX_REASON}文字以内で入れてください。`);
    return {
      id: changeId(kind, target.id, attempt),
      data: {
        kind,
        targetId: target.id,
        staffId: target.staffId,
        storeId: target.storeId,
        month: target.month,
        date: target.date,
        type,
        newDate: type === 'move' ? newDate : '',
        note: n,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        createdBy: email || '',
      },
    };
  }

  // 判断（承認・却下・申請中に戻す）：記録に書き足す項目と、同時に追加する履歴を作る
  // before は今の記録（id を含む）。role は 'owner' か 'manager'
  function decision(kind, before, { status, reason, email, role, now, note }) {
    if (!STATUSES.includes(status)) throw new Error('判断の種類が正しくありません。');
    if (status === before.status) throw new Error('今と同じ判断です。');
    const pending = status === 'pending';
    const patch = {
      status,
      reason: cleanReason(status, reason),
      decidedBy: pending ? '' : email,
      decidedRole: pending ? '' : role,
      decidedAt: pending ? '' : now,
      lastActionBy: email,
      lastActionAt: now,
      updatedAt: now,
    };
    return { patch, log: newLog(kind, before, { from: before.status, to: status, reason: patch.reason, email, role, now, note }) };
  }

  // 履歴の1件
  function newLog(kind, before, { from, to, reason, email, role, now, note }) {
    return {
      id: logId(kind, before.id, now),
      data: {
        kind,
        targetId: before.id,
        staffId: before.staffId,
        storeId: before.storeId,
        month: before.month,
        date: before.date,
        from,
        to,
        reason: reason || '',
        note: note || '',
        by: email,
        role,
        at: now,
      },
    };
  }

  const api = { MAX_REASON, STATUSES, CHANGE_TYPES, MAX_CHANGE_ATTEMPTS, DECISION_KEYS, wishId, countId, logId, changeId, collectionOf, cleanReason, newWish, countDoc, newChange, decision, newLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.ShiftApp = root.ShiftApp || {}).records = api;
})(typeof window !== 'undefined' ? window : globalThis);
