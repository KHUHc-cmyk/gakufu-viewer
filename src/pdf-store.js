// 本棚：開いた PDF を、この端末のブラウザの中（IndexedDB）に保存する。外へは何も送らない。
// 保存できない端末（プライベートブラウズなど）では、ページを開いている間だけ覚える。
// meta：{ id, name, size, pages, lastPage, added, opened }／data：{ id, bytes（ArrayBuffer） }

const DB_NAME = 'gakufu-viewer-pdf';
const DB_VERSION = 1;

let dbPromise = null;
let memory = null; // 保存できないときの代わり（{ meta: Map, data: Map, next }）

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
  return dbPromise;
}

async function db() {
  if (memory) return null;
  try {
    return await openDb();
  } catch {
    memory = { meta: new Map(), data: new Map(), next: 1 };
    return null;
  }
}

// この端末に残せるかどうか（残せないと、ページを閉じたときに本棚が空になる）
export async function persistent() {
  return (await db()) !== null;
}

// 最近開いた順。まだ開いていないものは後ろ（その中では、入れたのが新しい順）
function byOpened(list) {
  return list.sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0) || (b.added ?? 0) - (a.added ?? 0));
}

// 本棚の一覧（最近開いた順）。PDF の中身は読まない
export async function list() {
  const d = await db();
  if (!d) return byOpened([...memory.meta.values()].map((m) => ({ ...m })));
  return byOpened(await wrap(d.transaction('meta').objectStore('meta').getAll()));
}

// 本棚に入れる。同じ名前・同じ大きさのものがあれば、それを使う（前回のページを残す）。
// 開いた時刻（opened）は、ここでは付けない（開いたときに update で付ける）
export async function put(name, bytes) {
  const now = Date.now();
  const same = (await list()).find((m) => m.name === name && m.size === bytes.byteLength);
  const d = await db();
  if (!d) {
    const meta = same ?? { id: memory.next++, name, size: bytes.byteLength, pages: null, lastPage: 1, added: now, opened: 0 };
    memory.meta.set(meta.id, { ...meta });
    memory.data.set(meta.id, bytes.slice(0));
    return meta;
  }
  const tx = d.transaction(['meta', 'data'], 'readwrite');
  const meta = same ?? { name, size: bytes.byteLength, pages: null, lastPage: 1, added: now, opened: 0 };
  meta.id = await wrap(tx.objectStore('meta').put(meta));
  tx.objectStore('data').put({ id: meta.id, bytes });
  await done(tx);
  return meta;
}

// PDF の中身（ArrayBuffer）。無ければ null
export async function bytesOf(id) {
  const d = await db();
  if (!d) return memory.data.get(id)?.slice(0) ?? null;
  const row = await wrap(d.transaction('data').objectStore('data').get(id));
  return row?.bytes ?? null;
}

// 覚え（ページ数・前回のページ・開いた時刻）を書き換える
export async function update(id, patch) {
  const d = await db();
  if (!d) {
    const meta = memory.meta.get(id);
    if (meta) memory.meta.set(id, { ...meta, ...patch });
    return;
  }
  const tx = d.transaction('meta', 'readwrite');
  const meta = await wrap(tx.objectStore('meta').get(id));
  if (meta) tx.objectStore('meta').put({ ...meta, ...patch });
  await done(tx);
}

// 本棚から消す（この端末の中の写しだけ。もとのファイルは消えない）
export async function remove(id) {
  const d = await db();
  if (!d) {
    memory.meta.delete(id);
    memory.data.delete(id);
    return;
  }
  const tx = d.transaction(['meta', 'data'], 'readwrite');
  tx.objectStore('meta').delete(id);
  tx.objectStore('data').delete(id);
  await done(tx);
}
