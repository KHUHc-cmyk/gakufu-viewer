// オフラインで開けるようにする（一度開けば、電波が無くても開けて再生できる）。
// 外へは何も送らない。このサイトのファイルを端末に保存して、そこから出すだけ。
// VERSION は Pages に出すときに、コミットの番号へ置き換わる（.github/workflows/pages.yml）。
const VERSION = 'build-local';
const CACHE = `gakufu-viewer-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './src/app.js',
  './src/incoming.js',
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

// アプリ本体（ページと src/ の小さいファイル）は、電波があれば新しいものを取りに行く。
// 保存してあるものを先に出すと、新しい版を出した後の1回目は、前の版のまま開いてしまう（2026-10-11 に iPad で起きた）。
// 取れないとき・SHELL_WAIT_MS たっても返らないときは、保存してあるものを出す。
// alphaTab・音源・フォント・見本（大きくて、めったに変わらない）は、保存してあるものを先に出す。
const SHELL_WAIT_MS = 3000;

function isShell(req) {
  return req.mode === 'navigate' || new URL(req.url).pathname.includes('/src/');
}

// ページそのもの（?out=sp などが付いていても）は index.html を出す
async function saved(cache, req) {
  return req.mode === 'navigate'
    ? (await cache.match(req, { ignoreSearch: true })) ?? (await cache.match('./index.html'))
    : cache.match(req);
}

// 新しいものを取って、保存し直す。取れなければ null
async function fresh(cache, req) {
  try {
    const res = await fetch(req.url, { cache: 'no-cache' });
    if (!res.ok) return null;
    await cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
    return res;
  } catch {
    return null;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      if (!isShell(req)) return (await saved(cache, req)) ?? fetch(req);
      const network = fresh(cache, req);
      const quick = await Promise.race([network, new Promise((resolve) => { setTimeout(resolve, SHELL_WAIT_MS, null); })]);
      return quick ?? (await saved(cache, req)) ?? (await network) ?? fetch(req);
    }),
  );
});
