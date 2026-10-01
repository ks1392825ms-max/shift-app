// 初めて起動したときに登録される初期データ
// id は固定の文字列にしておく（同期のとき、どの端末でも同じものとして扱えるように）
(function () {
  'use strict';
  const K = (window.ShiftApp = window.ShiftApp || {});

  K.defaults = {
    // 営業時間・定休日は仮の値。設定画面で変更する
    // closedWeekdays：0 = 日曜 … 6 = 土曜
    stores: [
      { id: 'store_a', name: 'A店', color: '#3b82f6', open: '09:00', close: '20:00', closedWeekdays: [2] },
      { id: 'store_b', name: 'B店', color: '#f59e0b', open: '09:00', close: '20:00', closedWeekdays: [2] },
    ],

    shiftPatterns: [
      { id: 'pat_0900_1800', start: '09:00', end: '18:00', breakMinutes: 60, label: '9-18', color: '#0ea5e9' },
      { id: 'pat_1000_1900', start: '10:00', end: '19:00', breakMinutes: 60, label: '10-19', color: '#8b5cf6' },
      { id: 'pat_1100_2000', start: '11:00', end: '20:00', breakMinutes: 60, label: '11-20', color: '#14b8a6' },
    ],

    // 自動チェックの基準（Step4 で使う。設定画面で変更できるようにする）
    checks: {
      maxConsecutiveDays: 6, // 連勤の上限
      monthlyOffDays: 8, // 月の休日数の目安
      hoursCheckEnabled: true, // 労働時間のチェックをするか
      dailyHoursLimit: 8, // 1日の実働時間の目安
      weeklyHoursLimit: 40, // 1週の実働時間の目安
      countPaidLeaveAsOff: false, // 有給を休日数に数えるか
      closedDayAsOff: true, // 定休日を通常休として扱うか
      shortageMinSlots: 1, // 30分の枠がいくつ不足したら「人員不足」とするか
      // 週の区切りは月曜〜日曜（週40時間のチェック用）
    },

    // 店舗を追加したときに順番に使う目印の色（A店・B店の青・オレンジのあとに続く）
    storeColors: ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16', '#64748b'],

    // 選べる色
    colors: [
      '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
      '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6', '#64748b',
    ],
  };
})();
