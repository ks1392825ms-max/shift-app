// Firebase の接続情報（共有モードで使う）
// これらはアプリの公開ファイルに入れて誰でも見られる前提の値で、パスワードではない。
// データを守るのは Firestore のルール（firebase/firestore.rules）。
// Google アナリティクスは使わないので、measurementId は入れていない。
(function () {
  'use strict';
  const K = (window.ShiftApp = window.ShiftApp || {});

  K.firebaseConfig = {
    apiKey: 'AIzaSyAb0CPgseQ8CD9ZQ_h7xiWNsK097bv4n08',
    authDomain: 'r-r-m-0000.firebaseapp.com',
    projectId: 'r-r-m-0000',
    storageBucket: 'r-r-m-0000.firebasestorage.app',
    messagingSenderId: '598904020278',
    appId: '1:598904020278:web:0c7be44d281d7b0d8ea797',
  };
})();
