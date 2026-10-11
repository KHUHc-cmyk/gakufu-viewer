// PDF の楽譜の、表示の計算（画面にはさわらない。Node のテストからも読む）。
// 位置（pos）は { page: 1 から数えたページ, half: 半ページめくりの途中かどうか }。

export const MODES = ['auto', 'single', 'spread', 'scroll'];
export const FULL = Object.freeze({ l: 0, t: 0, r: 1, b: 1 });

// 表示の形。「自動」は、横長の画面なら見開き、縦長なら1ページ
export function layoutFor(mode, width, height) {
  if (mode === 'auto') return width > height * 1.15 ? 'spread' : 'single';
  return MODES.includes(mode) ? mode : 'single';
}

function clampPage(page, count) {
  return Math.min(Math.max(1, Math.round(page) || 1), Math.max(1, count));
}

// その表示の形で、ありうる位置に直す（見開きは、奇数ページを左に置く：1-2・3-4…）
export function normalize(pos, layout, count, halfTurn = false) {
  let page = clampPage(pos.page, count);
  if (layout === 'spread' && page % 2 === 0) page -= 1;
  const half = layout === 'single' && halfTurn && !!pos.half && page < count;
  return { page, half };
}

// いま画面に出すページ。半ページめくりの途中は [下に残すページ, 上に出す次のページ]
export function visiblePages(pos, layout, count) {
  if (layout === 'spread') return pos.page < count ? [pos.page, pos.page + 1] : [pos.page];
  if (layout === 'single' && pos.half && pos.page < count) return [pos.page, pos.page + 1];
  return [pos.page];
}

// 1つめくった先の位置（dir は 1＝次・-1＝前）。端では、同じ位置を返す
export function step(pos, dir, layout, count, halfTurn = false) {
  const now = normalize(pos, layout, count, halfTurn);
  if (layout === 'spread') {
    const page = now.page + 2 * dir;
    return page >= 1 && page <= count ? { page, half: false } : now;
  }
  if (layout === 'single' && halfTurn) {
    if (dir > 0) {
      if (now.half) return { page: now.page + 1, half: false };
      return now.page < count ? { page: now.page, half: true } : now;
    }
    if (now.half) return { page: now.page, half: false };
    return now.page > 1 ? { page: now.page - 1, half: true } : now;
  }
  return { page: clampPage(now.page + dir, count), half: false };
}

// 枠（boxW × boxH）に、縦横比（幅 ÷ 高さ）を保って収めた大きさ
export function fit(boxW, boxH, ratio) {
  if (!(boxW > 0) || !(boxH > 0) || !(ratio > 0)) return { w: 0, h: 0 };
  const w = Math.min(boxW, boxH * ratio);
  return { w: Math.floor(w), h: Math.floor(w / ratio) };
}

// キャンバスの画素の倍率。画面の細かさ（dpr）に合わせるが、画素の数が maxPixels を越えないようにする
// （iPad の Safari は、キャンバスの合計が大きいと描けなくなる）
export function pixelRatioFor(cssW, cssH, dpr, maxPixels) {
  const want = Math.max(1, dpr || 1);
  const area = cssW * cssH;
  if (!(area > 0)) return 1;
  return Math.min(want, Math.sqrt(maxPixels / area));
}

// 余白カット：小さく描いた絵（RGBA）から、中身のある範囲を割合で返す。
// 行・列に暗い点が minDark 個以上あれば「中身がある」とみなす（スキャンの小さなごみで広がらないように）。
// 中身が見つからない・切ると小さくなりすぎるときは、切らない
export function findCrop(data, width, height, { dark = 200, minDark = 2, pad = 0.015, minSide = 0.2 } = {}) {
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const light = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (light < dark) {
        rows[y] += 1;
        cols[x] += 1;
      }
    }
  }
  const first = (list) => list.findIndex((n) => n >= minDark);
  const last = (list) => list.findLastIndex((n) => n >= minDark);
  const top = first(rows);
  const left = first(cols);
  if (top < 0 || left < 0) return FULL;
  const l = Math.max(0, left / width - pad);
  const t = Math.max(0, top / height - pad);
  const r = Math.min(1, (last(cols) + 1) / width + pad);
  const b = Math.min(1, (last(rows) + 1) / height + pad);
  if (r - l < minSide || b - t < minSide) return FULL;
  return { l, t, r, b };
}

// 画面をタップした場所：左の3割＝前へ・右の3割＝次へ・真ん中＝操作の欄を出す／かくす
export function zoneAt(x, width) {
  if (!(width > 0)) return 'menu';
  const at = x / width;
  if (at < 0.3) return 'prev';
  if (at > 0.7) return 'next';
  return 'menu';
}

// ファイルの先頭が PDF かどうか（先頭の 1024 バイトのどこかに %PDF- がある）
export function looksLikePdf(bytes) {
  const head = bytes.subarray(0, 1024);
  const mark = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i + mark.length <= head.length; i++) {
    if (mark.every((c, k) => head[i + k] === c)) return true;
  }
  return false;
}

// 題名に使う名前（末尾の .pdf を取る）
export function titleOf(name) {
  const text = String(name ?? '');
  return text.toLowerCase().endsWith('.pdf') ? text.slice(0, -4) : text;
}
