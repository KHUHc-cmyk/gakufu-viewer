// PDF の楽譜のページ：セットリスト（本番の曲順）の計算（src/pdf-setlist.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SETS, MAX_SONGS, setName, cleanSets, moved, without, neighbor, indexAfterMove, indexAfterRemove, locate, itemId, makeItem, cleanItem, itemRange, rangeText } from '../src/pdf-setlist.js';

test('セットリストの名前：前後の空白を取る。空なら「セットリスト ◯」。40字まで', () => {
  assert.equal(setName('  10月のライブ ', 1), '10月のライブ');
  assert.equal(setName('', 3), 'セットリスト 3');
  assert.equal(setName('   ', 1), 'セットリスト 1');
  assert.equal(setName(null, 2), 'セットリスト 2');
  assert.equal(setName('あ'.repeat(60), 1).length, 40);
});

test('保存してあったセットリスト：作った順に並べ、本棚に無い曲は外す。おかしな中身は捨てる', () => {
  const rows = [
    { id: 2, name: '後', items: [1, 9, 2, 1], made: 200 },
    { id: 1, name: '先', items: [3], made: 100 },
    { id: 'x', name: 'だめ', items: [1], made: 50 },
    { id: 3, name: 'だめ', items: 'abc', made: 50 },
    null,
    { id: 4, name: '', items: [], made: 'いつか' },
  ];
  assert.deepEqual(cleanSets(rows, [1, 2, 3]), [
    { id: 4, name: 'セットリスト 3', items: [], made: 0 },
    { id: 1, name: '先', items: [3], made: 100 },
    { id: 2, name: '後', items: [1, 2, 1], made: 200 },
  ]);
  assert.deepEqual(cleanSets(null, [1]), []);
  assert.deepEqual(cleanSets([{ id: 1, name: 'a', items: [5], made: 1 }], []), [{ id: 1, name: 'a', items: [], made: 1 }]);
});

test('保存してあったセットリスト：数の上限（セットリスト 50・1つに 100 曲）', () => {
  const many = Array.from({ length: MAX_SETS + 5 }, (_, i) => ({ id: i + 1, name: `s${i}`, items: [], made: i }));
  assert.equal(cleanSets(many, []).length, MAX_SETS);
  const long = [{ id: 1, name: 'long', items: Array.from({ length: MAX_SONGS + 20 }, () => 7), made: 1 }];
  assert.equal(cleanSets(long, [7])[0].items.length, MAX_SONGS);
});

test('曲を動かす・外す：もとの並びは変えない。端では、そのまま', () => {
  const items = [10, 20, 30];
  assert.deepEqual(moved(items, 0, 1), [20, 10, 30]);
  assert.deepEqual(moved(items, 2, -1), [10, 30, 20]);
  assert.equal(moved(items, 0, -1), items);
  assert.equal(moved(items, 2, 1), items);
  assert.equal(moved(items, 5, -1), items);
  assert.deepEqual(without(items, 1), [10, 30]);
  assert.deepEqual(items, [10, 20, 30]);
});

test('となりの曲：端の先は -1', () => {
  const items = [10, 20, 30];
  assert.equal(neighbor(items, 0, 1), 1);
  assert.equal(neighbor(items, 1, -1), 0);
  assert.equal(neighbor(items, 0, -1), -1);
  assert.equal(neighbor(items, 2, 1), -1);
  assert.equal(neighbor([], 0, 1), -1);
  assert.equal(neighbor(items, 7, -1), -1);
});

test('曲を動かした後・外した後の、いま開いている曲の位置', () => {
  // いまの曲を動かした
  assert.equal(indexAfterMove(1, 1, -1, 3), 0);
  assert.equal(indexAfterMove(1, 1, 1, 3), 2);
  // となりの曲が、いまの曲と入れ替わった
  assert.equal(indexAfterMove(1, 0, 1, 3), 0);
  assert.equal(indexAfterMove(1, 2, -1, 3), 2);
  // 関係のない曲・端で動かなかったとき
  assert.equal(indexAfterMove(0, 1, 1, 3), 0);
  assert.equal(indexAfterMove(0, 0, -1, 3), 0);
  assert.equal(indexAfterMove(1, 2, 1, 3), 1);
  // 外した
  assert.equal(indexAfterRemove(2, 0), 1);
  assert.equal(indexAfterRemove(0, 2), 0);
  assert.equal(indexAfterRemove(1, 1), -1);
});

test('動かす・外すと、位置の計算が合う（同じ曲が2回あっても、いまの曲を見失わない）', () => {
  const items = [10, 20, 10, 30];
  // いまは 2 番目（3曲目）の 10。その曲を前へ動かす
  const after = moved(items, 2, -1);
  const index = indexAfterMove(2, 2, -1, items.length);
  assert.deepEqual(after, [10, 10, 20, 30]);
  assert.equal(index, 1);
  // 先頭の 10 を外す
  assert.deepEqual(without(after, 0), [10, 20, 30]);
  assert.equal(indexAfterRemove(index, 0), 0);
});

test('並びが変わった後の位置：同じ位置にいれば そのまま。いなければ、いちばん近い所。無ければ -1', () => {
  assert.equal(locate([10, 20, 30], 1, 20), 1);
  assert.equal(locate([20, 30], 1, 20), 0);
  assert.equal(locate([10, 30], 1, 20), -1);
  assert.equal(locate([20, 10, 30, 20], 2, 20), 3);
  assert.equal(locate([], 0, 20), -1);
});

// ---------------------------------------------------------------- 曲集の PDF から、ページの範囲を1曲として並べる（2026-10-14）

test('曲集の曲：ページが空なら PDF の全部（番号だけ）。始めと終わりが逆なら入れ替える。片方だけでもよい', () => {
  assert.equal(makeItem(5, '', ''), 5);
  assert.equal(makeItem(5, '0', 'x'), 5);
  assert.deepEqual(makeItem(5, '3', '4'), { id: 5, from: 3, to: 4 });
  assert.deepEqual(makeItem(5, 7, 6), { id: 5, from: 6, to: 7 });
  assert.deepEqual(makeItem(5, '10', ''), { id: 5, from: 10, to: null });
  assert.deepEqual(makeItem(5, '', '4'), { id: 5, from: 1, to: 4 });
  assert.deepEqual(makeItem(5, '2.5', '4'), { id: 5, from: 1, to: 4 });
});

test('曲集の曲：番号・範囲・文', () => {
  assert.equal(itemId(5), 5);
  assert.equal(itemId({ id: 6, from: 2, to: 3 }), 6);
  assert.equal(itemId(null), null);
  assert.deepEqual(itemRange(5, 8), { from: 1, to: 8 });
  assert.deepEqual(itemRange({ id: 5, from: 3, to: 4 }, 8), { from: 3, to: 4 });
  assert.deepEqual(itemRange({ id: 5, from: 6, to: null }, 8), { from: 6, to: 8 });
  assert.deepEqual(itemRange({ id: 5, from: 6, to: 20 }, 8), { from: 6, to: 8 }, 'PDF のページの数に収める');
  assert.deepEqual(itemRange({ id: 5, from: 12, to: 20 }, 8), { from: 8, to: 8 });
  assert.equal(rangeText(5), '');
  assert.equal(rangeText({ id: 5, from: 3, to: 4 }), '3〜4 ページ');
  assert.equal(rangeText({ id: 5, from: 3, to: 3 }), '3 ページ');
  assert.equal(rangeText({ id: 5, from: 3, to: null }), '3 ページから');
});

test('曲集の曲：保存してあった並びを直す（範囲つきの曲も残る。本棚に無い曲・おかしな中身は外す）。位置も探せる', () => {
  const known = new Set([1, 2]);
  assert.equal(cleanItem(1, known), 1);
  assert.equal(cleanItem(9, known), null);
  assert.deepEqual(cleanItem({ id: 2, from: 4, to: 3 }, known), { id: 2, from: 3, to: 4 });
  assert.equal(cleanItem({ id: 9, from: 1, to: 2 }, known), null);
  assert.equal(cleanItem({ id: '2' }, known), null);
  assert.equal(cleanItem({ id: 2 }, known), 2, '範囲の無い曲は、番号だけにする');
  const [set] = cleanSets([{ id: 1, name: 'x', items: [1, { id: 2, from: 3, to: 4 }, { id: 9, from: 1, to: 1 }, 'z'], made: 1 }], [1, 2]);
  assert.deepEqual(set.items, [1, { id: 2, from: 3, to: 4 }]);
  const items = [{ id: 2, from: 1, to: 2 }, 1, { id: 2, from: 5, to: 6 }];
  assert.equal(locate(items, 2, 2), 2);
  assert.equal(locate(items, 1, 2), 0);
  assert.equal(locate(items, 0, 3), -1);
});
