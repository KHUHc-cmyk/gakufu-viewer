// PDF の楽譜のページ：本棚を、名前で探す・並べる計算。画面にも保存にも触らない。
import { titleOf } from './pdf-layout.js';

const KATAKANA_FIRST = 0x30a1; // ァ
const KATAKANA_LAST = 0x30f6; // ヶ
const TO_HIRAGANA = 0x60;

// 探すときの形：全角と半角・大文字と小文字・ひらがなとカタカナ を同じに扱い、空白を取る
export function searchKey(text) {
  let out = '';
  for (const ch of String(text ?? '').normalize('NFKC').toLowerCase()) {
    const code = ch.codePointAt(0);
    if (ch.trim() === '') continue;
    out += code >= KATAKANA_FIRST && code <= KATAKANA_LAST ? String.fromCodePoint(code - TO_HIRAGANA) : ch;
  }
  return out;
}

// 探す言葉を、空白で区切る（全角の空白でもよい）。空の言葉は捨てる
export function searchWords(query) {
  return String(query ?? '').normalize('NFKC').split(' ').map(searchKey).filter(Boolean);
}

// 本棚の一覧から、言葉が全部入っている名前のものだけを残して、並べる。
// order：'opened'＝もらった順のまま（最近開いた順）／'name'＝名前の順（数字は、数の大きさで）
export function findInShelf(items, query, order = 'opened') {
  const words = searchWords(query);
  const hit = items.filter((meta) => {
    const key = searchKey(titleOf(meta.name));
    return words.every((word) => key.includes(word));
  });
  if (order !== 'name') return hit;
  // 全角と半角は、同じ字として並べる（半角カタカナの名前が、離れた所に行かないように）
  const label = (meta) => titleOf(meta.name).normalize('NFKC');
  return hit.sort((a, b) => label(a).localeCompare(label(b), 'ja', { numeric: true }));
}
