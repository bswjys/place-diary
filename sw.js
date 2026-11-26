/* 오늘의 발자국 · 오프라인 캐시
 *  - 화면(index.html), 코드(app.js, styles.css): 네트워크 우선 → 실패하면 캐시
 *  - 아이콘·manifest: 캐시 우선
 *  - 기록과 사진은 서비스워커가 아니라 IndexedDB에 저장된다 (여기서는 다루지 않음)
 */
const CACHE = 'place-diary-v3';
const VERSION = '3';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=' + VERSION,
  './app.js?v=' + VERSION,
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

const isCode = (path) => /\/app\.js$/.test(path) || /\/styles\.css$/.test(path) || /\/index\.html$/.test(path) || /\/$/.test(path);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('place-diary-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isCode(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
