// PDF の楽譜のページ：本棚を、名前で探す・並べる計算（src/pdf-shelf.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKey, searchWords, findInShelf } from '../src/pdf-shelf.js';

const SHELF = [
  { id: 1, name: 'Morning Song.pdf' },
  { id: 2, name: '夕べのワルツ.pdf' },
  { id: 3, name: 'カノン（ギター2本）.pdf' },
  { id: 4, name: 'ｴﾁｭｰﾄﾞ 10番.PDF' },
  { id: 5, name: 'エチュード 2番.pdf' },
];
const ids = (items) => items.map((m) => m.id);

test('探すときの形：全角と半角・大文字と小文字・ひらがなとカタカナ を同じに扱い、空白を取る', () => {
  assert.equal(searchKey('Ｍｏｒｎｉｎｇ　Song'), 'morningsong');
  assert.equal(searchKey('カノン'), 'かのん');
  assert.equal(searchKey('ｶﾉﾝ'), 'かのん');
  assert.equal(searchKey('ヴァイオリン'), 'ゔぁいおりん');
  assert.equal(searchKey('エチュード'), 'えちゅーど');
  assert.equal(searchKey('  夕べ の ワルツ '), '夕べのわるつ');
  assert.equal(searchKey(null), '');
});

test('探す言葉：空白（全角でも）で区切る。空の言葉は捨てる', () => {
  assert.deepEqual(searchWords('  カノン　ギター '), ['かのん', 'ぎたー']);
  assert.deepEqual(searchWords(''), []);
  assert.deepEqual(searchWords('   '), []);
  assert.deepEqual(searchWords(undefined), []);
});

test('本棚を探す：言葉が無ければ全部。言葉が全部入っている名前だけを残す（順は、もらった順のまま）', () => {
  assert.deepEqual(ids(findInShelf(SHELF, '')), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(findInShelf(SHELF, 'かのん')), [3]);
  assert.deepEqual(ids(findInShelf(SHELF, 'ＭＯＲＮＩＮＧ')), [1]);
  assert.deepEqual(ids(findInShelf(SHELF, 'えちゅーど')), [4, 5]);
  assert.deepEqual(ids(findInShelf(SHELF, 'エチュード 10')), [4]);
  assert.deepEqual(ids(findInShelf(SHELF, 'ギター　カノン')), [3]);
  assert.deepEqual(ids(findInShelf(SHELF, 'わるつ')), [2]);
  assert.deepEqual(ids(findInShelf(SHELF, 'zzz')), []);
  // 拡張子（.pdf）は、探す相手に入れない
  assert.deepEqual(ids(findInShelf(SHELF, 'pdf')), []);
});

test('本棚を並べる：名前の順（数字は、数の大きさで）。もとの並びは変えない', () => {
  const before = ids(SHELF);
  const byName = findInShelf(SHELF, 'えちゅーど', 'name');
  assert.deepEqual(ids(byName), [5, 4], '2番 → 10番');
  const all = findInShelf(SHELF, '', 'name');
  assert.equal(all.length, 5);
  assert.equal(all[0].id, 1, '英字の名前が先');
  assert.deepEqual(ids(SHELF), before);
  assert.deepEqual(ids(findInShelf(SHELF, '', 'opened')), before);
});
