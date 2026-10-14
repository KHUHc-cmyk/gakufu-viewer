// PDF の楽譜のページ：セットリスト（本番の曲順）の計算。画面にも保存にも触らない。
// セットリスト：{ id, name, items（曲の並び。同じ曲を2回入れてもよい）, made }
// 曲：本棚の番号（その PDF の全部）か、{ id, from, to }（その PDF の from〜to ページだけ。曲集の PDF から1曲を選ぶとき。to が null なら最後まで）

const SET_NAME_MAX = 40;
export const MAX_SETS = 50;
export const MAX_SONGS = 100;

// セットリストの名前（前後の空白を取る。空なら「セットリスト ◯」）
export function setName(name, n) {
  const text = String(name ?? '').trim().slice(0, SET_NAME_MAX);
  return text || `セットリスト ${n}`;
}

// 曲の、本棚の番号
export function itemId(item) {
  return typeof item === 'number' ? item : item && typeof item === 'object' ? item.id : null;
}

function pageNum(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// 曲を作る。ページが2つとも空なら、その PDF の全部（本棚の番号だけ）。始めと終わりが逆なら入れ替える
export function makeItem(id, from, to) {
  let f = pageNum(from);
  let t = pageNum(to);
  if (f && t && t < f) [f, t] = [t, f];
  if (!f && !t) return id;
  return { id, from: f ?? 1, to: t };
}

// 保存してあった曲を、決まった形に直す（本棚に無い曲・おかしな中身は null）
export function cleanItem(raw, known) {
  const id = itemId(raw);
  if (!Number.isInteger(id) || !known.has(id)) return null;
  return typeof raw === 'number' ? raw : makeItem(id, raw.from, raw.to);
}

// 曲のページの範囲（PDF のページの数 count に収める）
export function itemRange(item, count) {
  const last = Math.max(1, count);
  if (!item || typeof item !== 'object') return { from: 1, to: last };
  const from = Math.min(item.from ?? 1, last);
  const to = item.to == null ? last : Math.min(Math.max(item.to, from), last);
  return { from, to };
}

// 曲のページの範囲の文（PDF の全部なら空）
export function rangeText(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.to == null) return `${item.from} ページから`;
  return item.from === item.to ? `${item.from} ページ` : `${item.from}〜${item.to} ページ`;
}

// 保存してあったセットリストを、決まった形に直す（作った順）。本棚に無い曲は外す。おかしな中身は捨てる
export function cleanSets(rows, shelfIds) {
  const known = new Set(shelfIds);
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !Number.isInteger(row.id) || !Array.isArray(row.items)) continue;
    out.push({
      id: row.id,
      name: setName(row.name, out.length + 1),
      items: row.items.map((item) => cleanItem(item, known)).filter((item) => item !== null).slice(0, MAX_SONGS),
      made: Number.isFinite(row.made) ? row.made : 0,
    });
  }
  return out.sort((a, b) => a.made - b.made || a.id - b.id).slice(0, MAX_SETS);
}

// 曲を1つ動かす（dir：-1＝前へ・1＝後ろへ）。端では、そのまま
export function moved(items, index, dir) {
  const to = index + dir;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return items;
  const out = items.slice();
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

// 曲を1つ外す
export function without(items, index) {
  return items.filter((_, i) => i !== index);
}

// となりの曲の位置（無ければ -1）
export function neighbor(items, index, dir) {
  const to = index + dir;
  return index >= 0 && index < items.length && to >= 0 && to < items.length ? to : -1;
}

// index の曲を動かした後の、いま開いている曲（current）の位置
export function indexAfterMove(current, index, dir, length) {
  const to = index + dir;
  if (index < 0 || index >= length || to < 0 || to >= length) return current;
  if (current === index) return to;
  if (current === to) return index;
  return current;
}

// index の曲を外した後の、いま開いている曲（current）の位置。いまの曲を外したら -1
export function indexAfterRemove(current, index) {
  if (current === index) return -1;
  return current > index ? current - 1 : current;
}

// 並びが変わった後の、いま開いている曲の位置（前の位置にいなければ、いちばん近い所。無ければ -1）
export function locate(items, index, id) {
  if (itemId(items[index]) === id) return index;
  let best = -1;
  items.forEach((item, i) => {
    if (itemId(item) === id && (best < 0 || Math.abs(i - index) < Math.abs(best - index))) best = i;
  });
  return best;
}
