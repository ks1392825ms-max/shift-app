// 確定したシフトの「公開用の写し」（スタッフが見る用）
// 管理者が「シフトを確定」したときに作り、Firestore の publishedRosters/{店舗ID_月} に保存する。
// 「確定を取り消す」と消す。スタッフは自分の所属店舗の写しだけを読める（Firestore のルール）。
//
// 写しに入れるのは表示に必要なものだけ：店舗名・月・確定日時・スタッフの表示名と肩書きと St／As・日ごとの勤務時間／休／社用。
// 入れないもの：メールアドレス・備考・勤務条件（週休・固定休など）・新人や戦力外の印・希望休や有給の申請。
// 有給は、ほかの人に分からないよう「休」として入れる（本人の画面では、本人の承認済みの有給を「有」と表示する）。
(function () {
  'use strict';
  const K = window.ShiftApp;
  const U = K.utils;

  function build(storeId, month) {
    const store = K.storage.getStore(storeId);
    if (!store) throw new Error('店舗が見つかりませんでした。');
    const pub = K.storage.getPublication(storeId, month);
    const staff = K.calc.rosterStaff(storeId, month);
    const map = K.calc.shiftMap(month, storeId);
    const days = K.calc.monthDates(month).map((date) => {
      const closed = K.calc.isStoreClosed(store, date);
      const cells = {};
      for (const m of staff) {
        const s = map.get(`${m.id}|${date}`);
        if (!s) {
          if (closed) cells[m.id] = { k: 'closed' };
          continue;
        }
        if (s.kind === 'work' || s.kind === 'business') {
          const p = K.storage.getPattern(s.patternId);
          cells[m.id] = { k: s.kind, t: p ? `${U.formatTime(p.start)}〜${U.formatTime(p.end)}` : '' };
        } else {
          // 通常休・有給は、どちらも「休」
          cells[m.id] = { k: 'off' };
        }
      }
      return { date, closed, holiday: K.holidays.holidayName(date) || '', cells };
    });
    return {
      id: `${storeId}_${month}`,
      storeId,
      month,
      storeName: store.name,
      storeColor: store.color,
      confirmedAt: pub ? pub.confirmedAt : U.nowIso(),
      staff: staff.map((m) => ({ id: m.id, name: m.name, title: m.title || '', role: U.ROLE_SHORT[m.role] })),
      days,
      version: 1,
    };
  }

  // 共有モードのときだけ、写しを保存・削除する（この端末だけのモードでは何もしない）
  async function publish(storeId, month) {
    if (!K.storage.isCloud()) return false;
    await K.app.cloudBackend().publishRoster(build(storeId, month));
    return true;
  }

  async function unpublish(storeId, month) {
    if (!K.storage.isCloud()) return false;
    await K.app.cloudBackend().unpublishRoster(`${storeId}_${month}`);
    return true;
  }

  K.published = { build, publish, unpublish };
})();
