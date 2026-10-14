// PDF の楽譜のページ：書き込み・しおり・メトロノームの計算（src/pdf-ink.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf } from './fixtures/make-pdf.js';
import { TOOLS, ERASER, toPage, fromPage, addPoint, hitStroke, markName, withMark, emptyNotes, cleanNotes, clampBpm, cleanTurn, nextTurn, cleanTurns, turnAt, turned, unturned } from '../src/pdf-ink.js';

const FULL = { l: 0, t: 0, r: 1, b: 1 };
const CUT = { l: 0.2, t: 0.1, r: 0.8, b: 0.9 };

test('書き込みの位置：紙の全体に対する割合で持つ。余白カットで切っていても、同じ所を指す', () => {
  assert.deepEqual(toPage(0.5, 0.5, FULL), [0.5, 0.5]);
  assert.deepEqual(toPage(0, 0, CUT), [0.2, 0.1]);
  assert.deepEqual(toPage(1, 1, CUT), [0.8, 0.9]);
  assert.deepEqual(toPage(0.5, 0.25, CUT), [0.5, 0.3]);
  // 紙の外にはみ出した指は、端に寄せる
  assert.deepEqual(toPage(-0.2, 1.4, CUT), [0.2, 0.9]);
  // 逆向き：切った後の画面で、どこに出るか
  const [fx, fy] = fromPage(0.5, 0.3, CUT);
  assert.ok(Math.abs(fx - 0.5) < 1e-9 && Math.abs(fy - 0.25) < 1e-9);
  assert.ok(fromPage(0.1, 0.5, CUT)[0] < 0, '切れた所は、0〜1 の外になる');
});

test('紙の向き：右へ 90 度ずつ回り、4回で元に戻る。おかしな値は、回していないものとする', () => {
  assert.deepEqual([0, 90, 180, 270].map(nextTurn), [90, 180, 270, 0]);
  assert.deepEqual([undefined, null, 45, -90, 360, '90', 'x'].map(cleanTurn), [0, 0, 0, 0, 0, 90, 0]);
  assert.equal(nextTurn(undefined), 90);
});

test('ページごとの向き：全部のページの向きに足す。おかしな中身・回していないページ・ページの数を越えるものは捨てる', () => {
  assert.deepEqual(cleanTurns({ 1: 90, 2: 0, 3: '180', 4: 45, 6: 270, x: 90, 0: 90, 2.5: 90 }, 5), { 1: 90, 3: 180 });
  assert.deepEqual([undefined, null, [90], 'x', 3].map((v) => cleanTurns(v, 5)), [{}, {}, {}, {}, {}]);
  const turns = { 2: 90, 3: 270 };
  assert.deepEqual([1, 2, 3].map((n) => turnAt(0, turns, n)), [0, 90, 270]);
  assert.deepEqual([1, 2, 3].map((n) => turnAt(180, turns, n)), [180, 270, 90]);
  assert.equal(turnAt(90, undefined, 1), 90);
});

test('紙の向き：もとの紙の左上は、右へ回すと 右上 → 右下 → 左下 に来る。逆向きで元に戻る', () => {
  assert.deepEqual(turned(0, 0, 0), [0, 0]);
  assert.deepEqual(turned(0, 0, 90), [1, 0]);
  assert.deepEqual(turned(0, 0, 180), [1, 1]);
  assert.deepEqual(turned(0, 0, 270), [0, 1]);
  // もとの紙の上の辺のまんなかは、右へ回すと 右の辺のまんなか
  assert.deepEqual(turned(0.5, 0, 90), [1, 0.5]);
  for (const turn of [0, 90, 180, 270]) {
    const [u, v] = turned(0.2, 0.7, turn);
    const [x, y] = unturned(u, v, turn);
    assert.ok(Math.abs(x - 0.2) < 1e-9 && Math.abs(y - 0.7) < 1e-9, `${turn} 度`);
  }
});

test('書き込みの位置：紙を回していても、もとの紙の同じ所を指す（余白カットは、回した紙の上で測る）', () => {
  // 右へ 90 度：もとの紙の左上は、画面の右上に来ている
  assert.deepEqual(toPage(1, 0, FULL, 90), [0, 0]);
  assert.deepEqual(toPage(0.8, 0.275, FULL, 90), [0.275, 0.2]);
  assert.deepEqual(toPage(0.5, 0.5, FULL, 180), [0.5, 0.5]);
  assert.deepEqual(toPage(0.25, 0.1, FULL, 180), [0.75, 0.9]);
  assert.deepEqual(toPage(0.3, 0.9, FULL, 270), [0.1, 0.3]);
  // 向きを省くと、回していないもの（前からの呼び方のまま）
  assert.deepEqual(toPage(0.5, 0.25, CUT), toPage(0.5, 0.25, CUT, 0));
  // 行って戻る
  for (const turn of [0, 90, 180, 270]) {
    const [x, y] = toPage(0.3, 0.6, CUT, turn);
    const [fx, fy] = fromPage(x, y, CUT, turn);
    assert.ok(Math.abs(fx - 0.3) < 1e-3 && Math.abs(fy - 0.6) < 1e-3, `${turn} 度（${fx}, ${fy}）`);
  }
});

test('線に点を足す：近すぎる点は足さず、上限を越えない', () => {
  const p = [];
  assert.equal(addPoint(p, 0.1, 0.1), true);
  assert.equal(addPoint(p, 0.1001, 0.1001), false);
  assert.equal(addPoint(p, 0.12, 0.1), true);
  assert.deepEqual(p, [0.1, 0.1, 0.12, 0.1]);
  const many = [];
  for (let i = 0; i < 5000; i++) addPoint(many, (i % 2) * 0.5, i / 5000);
  assert.equal(many.length, 8000);
});

test('消しゴム：線に触れたかどうか（線の途中・端・1点だけの線）', () => {
  const line = { t: 'black', p: [0.2, 0.5, 0.6, 0.5] };
  assert.equal(hitStroke(line, 0.4, 0.505, 1.4, 0.012), true); // 途中
  assert.equal(hitStroke(line, 0.4, 0.53, 1.4, 0.012), false); // 離れている（たては 1.4 倍して比べる）
  assert.equal(hitStroke(line, 0.61, 0.5, 1.4, 0.012), true); // 端のすぐ外
  assert.equal(hitStroke(line, 0.7, 0.5, 1.4, 0.012), false);
  const dot = { t: 'red', p: [0.3, 0.3] };
  assert.equal(hitStroke(dot, 0.305, 0.3, 1.4, 0.012), true);
  assert.equal(hitStroke(dot, 0.4, 0.3, 1.4, 0.012), false);
  // 蛍光ペンは太いので、少し離れていても触れる
  assert.equal(hitStroke({ t: 'marker', p: [0.2, 0.5, 0.6, 0.5] }, 0.4, 0.515, 1.4, 0.012), true);
  assert.equal(hitStroke({ t: '知らない道具', p: [0.2, 0.5] }, 0.2, 0.5, 1.4, 0.012), false);
});

test('道具：黒・赤・青・蛍光ペン。消しゴムは、線の道具ではない', () => {
  assert.deepEqual(Object.keys(TOOLS), ['black', 'red', 'blue', 'marker']);
  assert.equal(TOOLS[ERASER], undefined);
  assert.ok(TOOLS.marker.alpha < 1 && TOOLS.marker.width > TOOLS.black.width);
});

test('しおり：名前が空なら「◯ ページ目」。同じページには1つ。ページの順に並ぶ', () => {
  assert.equal(markName('  サビ  ', 3), 'サビ');
  assert.equal(markName('', 3), '3 ページ目');
  assert.equal(markName('あ'.repeat(60), 1).length, 40);
  let marks = [];
  marks = withMark(marks, 5, 'サビ');
  marks = withMark(marks, 2, '');
  marks = withMark(marks, 5, '大サビ');
  assert.deepEqual(marks, [{ page: 2, name: '2 ページ目' }, { page: 5, name: '大サビ' }]);
});

test('保存してあった覚えを読む：おかしな中身は捨て、ページの数を越えるものも捨てる', () => {
  assert.deepEqual(cleanNotes(null), emptyNotes());
  assert.deepEqual(cleanNotes('こわれた'), emptyNotes());
  const notes = cleanNotes({
    marks: [{ page: 3, name: 'サビ' }, { page: 99, name: '無いページ' }, { page: 1.5 }, null, { page: 1, name: '' }],
    ink: {
      2: [{ t: 'red', p: [0.1, 0.2, 0.3, 0.4] }, { t: '知らない', p: [0, 0] }, { t: 'black', p: [0.5] }, { t: 'blue', p: [2, -1] }],
      99: [{ t: 'black', p: [0.1, 0.1] }],
      abc: [{ t: 'black', p: [0.1, 0.1] }],
      4: 'こわれた',
    },
  }, 5);
  assert.deepEqual(notes.marks, [{ page: 1, name: '1 ページ目' }, { page: 3, name: 'サビ' }]);
  assert.deepEqual(notes.ink, { 2: [{ t: 'red', p: [0.1, 0.2, 0.3, 0.4] }, { t: 'blue', p: [1, 0] }] });
});

test('メトロノームの速さ：40〜240 に収める。数でないものは、前の値のまま', () => {
  assert.equal(clampBpm(100), 100);
  assert.equal(clampBpm('132'), 132);
  assert.equal(clampBpm(10), 40);
  assert.equal(clampBpm(999), 240);
  assert.equal(clampBpm('', 96), 96);
  assert.equal(clampBpm('あ', 96), 96);
  assert.equal(clampBpm(undefined), 100);
});

test('pdf.js：試験用の PDF の目次が読める', async () => {
  const pdfjs = await import('../vendor/pdfjs/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(makePdf(4, { outline: [['Intro', 1], ['Song Two', 3]] })), verbosity: 0 }).promise;
  const outline = await doc.getOutline();
  assert.deepEqual(outline.map((o) => o.title), ['Intro', 'Song Two']);
  assert.equal(await doc.getPageIndex(outline[1].dest[0]), 2);
  await doc.loadingTask.destroy();
});
