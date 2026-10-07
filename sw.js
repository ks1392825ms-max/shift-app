// 電波がなくてもアプリを開けるようにする仕組み（Service Worker）
// 公開した URL（https）で開いたときだけ動く。
// 方針：いつもはインターネットから最新のファイルを取り、取れないとき（電波がない等）だけ、保存しておいたファイルを使う。
// そのため、アプリを更新したときに古い版が残り続けることはない。
// シフトや設定のデータはここでは扱わない（端末だけのモードは localStorage、共有モードは Firebase が扱う）。
// 同じ場所（このアプリ）のファイルだけを扱い、Firebase との通信には関わらない。

const CACHE = 'shift-app-v4';

// 最初に保存しておくファイル（アプリのファイルを増やしたら、ここにも追加する）
const APP_FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/utils.js',
  'js/data/defaults.js',
  'js/storage.js',
  'js/firebase-config.js',
  'js/cloud.js',
  'js/vendor/firebase/firebase-app.js',
  'js/vendor/firebase/firebase-auth.js',
  'js/vendor/firebase/firebase-firestore.js',
  'js/backup.js',
  'js/holidays.js',
  'js/calc.js',
  'js/rules.js',
  'js/requests.js',
  'js/autoshift.js',
  'js/export.js',
  'js/screens/roster.js',
  'js/screens/day.js',
  'js/screens/staff-view.js',
  'js/screens/summary.js',
  'js/screens/settings-stores.js',
  'js/screens/settings-staff.js',
  'js/screens/settings-patterns.js',
  'js/screens/settings-business.js',
  'js/screens/settings-staffing.js',
  'js/screens/settings-checks.js',
  'js/screens/settings-data.js',
  'js/screens/settings.js',
  'js/screens/login.js',
  'js/screens/request.js',
  'js/screens/requests-admin.js',
  'js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 1つ取れなくても、ほかは保存する
      .then((cache) => Promise.all(APP_FILES.map((f) => cache.add(f).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // 古い名前の保存分を片付ける
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shift-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // 同じ場所（このアプリ）のファイルを読むときだけ扱う
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((cached) => cached || Response.error()))
  );
});
