// 本棚：開いた PDF を、この端末のブラウザの中（IndexedDB）に保存する。外へは何も送らない。
// 保存できない端末（プライベートブラウズなど）では、ページを開いている間だけ覚える。
// meta：{ id, name, size, pages, lastPage, added, opened }／data：{ id, bytes（ArrayBuffer） }
// しおりと書き込みは、別のデータベースに置く（notes：{ id, marks, ink }。id は本棚と同じ）。
// 本棚のデータベースの版を上げないため（版を上げると、前の版のページが開いている間、開けなくなる）。
// セットリスト（本番の曲順）も、同じわけで別のデータベースに置く（sets：{ id, name, items, made }。items は曲の並び＝本棚の番号か { id, from, to }。src/pdf-setlist.js）。

import { itemId } from './pdf-setlist.js';

const SHELF = { name: 'gakufu-viewer-pdf', version: 1, stores: [['meta', { keyPath: 'id', autoIncrement: true }], ['data', { keyPath: 'id' }]] };
const NOTES = { name: 'gakufu-viewer-pdf-notes', version: 1, stores: [['notes', { keyPath: 'id' }]] };
const SETS = { name: 'gakufu-viewer-pdf-sets', version: 1, stores: [['sets', { keyPath: 'id', autoIncrement: true }]] };

const opened = new Map(); // データベースの名前 → 開いたもの（Promise）
let memory = null; // 本棚を保存できないときの代わり（{ meta: Map, data: Map, next }）
let notesMemory = null; // しおりと書き込みを保存できないときの代わり（id → { marks, ink }）
let setsMemory = null; // セットリストを保存できないときの代わり（{ rows: Map, next }）

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

function openDb(spec) {
  let promise = opened.get(spec.name);
  if (!promise) {
    promise = new Promise((resolve, reject) => {
      const request = indexedDB.open(spec.name, spec.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, options] of spec.stores) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });
    opened.set(spec.name, promise);
  }
  return promise;
}

// spec のデータベースが開けないときの代わりを用意する。
// 本棚が開けないときは、しおり・書き込み・セットリストも保存しない（本棚の番号が、開き直すたびに変わるため）
function useMemory(spec) {
  if (spec === SHELF) memory ??= { meta: new Map(), data: new Map(), next: 1 };
  if (spec !== SETS) notesMemory ??= new Map();
  if (spec !== NOTES) setsMemory ??= { rows: new Map(), next: 1 };
}

// 開けないときは null（そのときは、ページを開いている間だけ覚える）
async function db(spec = SHELF) {
  if (memory || (spec === NOTES && notesMemory) || (spec === SETS && setsMemory)) {
    useMemory(memory ? SHELF : spec);
    return null;
  }
  try {
    return await openDb(spec);
  } catch {
    useMemory(spec);
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

// しおりと書き込み（{ marks, ink }）。無ければ null
export async function notesOf(id) {
  const d = await db(NOTES);
  if (!d) return notesMemory.get(id) ?? null;
  const row = await wrap(d.transaction('notes').objectStore('notes').get(id));
  return row ? { marks: row.marks, ink: row.ink, links: row.links } : null;
}

export async function saveNotes(id, notes) {
  const d = await db(NOTES);
  if (!d) {
    notesMemory.set(id, JSON.parse(JSON.stringify(notes)));
    return;
  }
  const tx = d.transaction('notes', 'readwrite');
  tx.objectStore('notes').put({ id, marks: notes.marks, ink: notes.ink, links: notes.links ?? {} });
  await done(tx);
}

// セットリストの一覧。中身は、使う側で決まった形に直す（pdf-setlist.js の cleanSets）
export async function sets() {
  const d = await db(SETS);
  if (!d) return [...setsMemory.rows.values()].map((row) => ({ ...row, items: [...row.items] }));
  return wrap(d.transaction('sets').objectStore('sets').getAll());
}

// セットリストを書く（id が無ければ、新しく作る）。書いたものを返す
export async function saveSet(set) {
  const row = { name: set.name, items: [...set.items], made: set.made ?? Date.now() };
  if (set.id != null) row.id = set.id;
  const d = await db(SETS);
  if (!d) {
    row.id ??= setsMemory.next++;
    setsMemory.rows.set(row.id, { ...row, items: [...row.items] });
    return row;
  }
  const tx = d.transaction('sets', 'readwrite');
  row.id = await wrap(tx.objectStore('sets').put(row));
  await done(tx);
  return row;
}

// セットリストを消す（PDF は本棚に残る）
export async function removeSet(id) {
  const d = await db(SETS);
  if (!d) {
    setsMemory.rows.delete(id);
    return;
  }
  const tx = d.transaction('sets', 'readwrite');
  tx.objectStore('sets').delete(id);
  await done(tx);
}

// 本棚から消す（この端末の中の写しと、そのしおり・書き込み。セットリストからも外す。もとのファイルは消えない）
export async function remove(id) {
  const d = await db();
  if (!d) {
    memory.meta.delete(id);
    memory.data.delete(id);
  } else {
    const tx = d.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
    await done(tx);
  }
  const n = await db(NOTES);
  if (!n) {
    notesMemory.delete(id);
  } else {
    const ntx = n.transaction('notes', 'readwrite');
    ntx.objectStore('notes').delete(id);
    await done(ntx);
  }
  for (const set of await sets()) {
    if (set.items.some((item) => itemId(item) === id)) await saveSet({ ...set, items: set.items.filter((item) => itemId(item) !== id) });
  }
}
