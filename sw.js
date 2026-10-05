// オフラインで開けるようにする（一度開けば、電波が無くても開けて再生できる）。
// 外へは何も送らない。このサイトのファイルを端末に保存して、そこから出すだけ。
// VERSION は Pages に出すときに、コミットの番号へ置き換わる（.github/workflows/pages.yml）。
const VERSION = 'build-local';
const CACHE = `gakufu-viewer-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './src/app.js',
  './src/load.js',
  './src/mxl.js',
  './src/prepare.js',
  './src/style.css',
  './vendor/alphatab/alphaTab.mjs',
  './vendor/alphatab/alphaTab.core.mjs',
  './vendor/alphatab/alphaTab.worker.mjs',
  './vendor/alphatab/alphaTab.worklet.mjs',
  './vendor/alphatab/font/Bravura.woff2',
  './vendor/alphatab/font/Bravura.woff',
  './vendor/alphatab/soundfont/sonivox.sf2',
  './samples/aura_lea_jazz.musicxml',
  './samples/jingle_bells_pop.musicxml',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gakufu-viewer-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // ページそのもの（?out=sp などが付いていても）は index.html を出す
      const hit = req.mode === 'navigate'
        ? (await cache.match(req, { ignoreSearch: true })) ?? (await cache.match('./index.html'))
        : await cache.match(req);
      if (hit) return hit;
      return fetch(req);
    }),
  );
});
