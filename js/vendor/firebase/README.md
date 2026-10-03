# Firebase JS SDK（同梱）

- 入手元：https://www.gstatic.com/firebasejs/12.19.0/ （Google 公式の配布物）
- バージョン：12.19.0（2026-10-02 取得）
- ファイル：`firebase-app.js`・`firebase-auth.js`・`firebase-firestore.js`
- ライセンス：Apache License 2.0（https://www.apache.org/licenses/LICENSE-2.0）
  Copyright Google LLC

## 書き換えた箇所

`firebase-auth.js` と `firebase-firestore.js` の中にある、`firebase-app.js` の読み込み先を
`https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js` から `./firebase-app.js` に変更しました。
アプリの外（gstatic.com）からプログラムを読み込まず、電波がないときもアプリを開けるようにするためです。
それ以外は配布物のままです。

## 使い方

共有モードのときだけ `js/cloud.js` から読み込みます。「この端末だけで使う」モードでは読み込みません。
