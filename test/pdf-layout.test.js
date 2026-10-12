// PDF の楽譜のページ：表示の計算（src/pdf-layout.js）と、同梱した pdf.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, readText } from './helpers.js';
import { makePdf } from './fixtures/make-pdf.js';
import { listPdfjs } from '../scripts/list-pdfjs.js';
import { FULL, layoutFor, normalize, visiblePages, step, fit, pixelRatioFor, findCrop, zoneAt, looksLikePdf, titleOf } from '../src/pdf-layout.js';

test('表示の形：「自動」は、横長なら見開き、縦長なら1ページ', () => {
  assert.equal(layoutFor('auto', 820, 1000), 'single');
  assert.equal(layoutFor('auto', 1180, 700), 'spread');
  assert.equal(layoutFor('auto', 800, 780), 'single'); // ほぼ真四角は1ページ
  assert.equal(layoutFor('single', 1180, 700), 'single');
  assert.equal(layoutFor('spread', 820, 1000), 'spread');
  assert.equal(layoutFor('scroll', 820, 1000), 'scroll');
  assert.equal(layoutFor('知らない', 820, 1000), 'single');
});

test('位置を直す：範囲の外は端へ。見開きは奇数ページを左に置く', () => {
  assert.deepEqual(normalize({ page: 0, half: false }, 'single', 5), { page: 1, half: false });
  assert.deepEqual(normalize({ page: 9, half: false }, 'single', 5), { page: 5, half: false });
  assert.deepEqual(normalize({ page: 4, half: false }, 'spread', 5), { page: 3, half: false });
  assert.deepEqual(normalize({ page: 5, half: false }, 'spread', 5), { page: 5, half: false });
  // 半ページめくりの途中は、1ページ表示で、設定が入っていて、次のページがあるときだけ
  assert.deepEqual(normalize({ page: 2, half: true }, 'single', 5, true), { page: 2, half: true });
  assert.deepEqual(normalize({ page: 2, half: true }, 'single', 5, false), { page: 2, half: false });
  assert.deepEqual(normalize({ page: 5, half: true }, 'single', 5, true), { page: 5, half: false });
  assert.deepEqual(normalize({ page: 1, half: true }, 'spread', 5, true), { page: 1, half: false });
});

test('画面に出すページ：1ページ・見開き・半ページめくりの途中', () => {
  assert.deepEqual(visiblePages({ page: 3, half: false }, 'single', 5), [3]);
  assert.deepEqual(visiblePages({ page: 3, half: true }, 'single', 5), [3, 4]);
  assert.deepEqual(visiblePages({ page: 3, half: false }, 'spread', 5), [3, 4]);
  assert.deepEqual(visiblePages({ page: 5, half: false }, 'spread', 5), [5]);
  assert.deepEqual(visiblePages({ page: 3, half: false }, 'scroll', 5), [3]);
});

function walk(layout, count, halfTurn, dir, from) {
  const seen = [];
  let pos = from;
  for (let i = 0; i < 20; i++) {
    const next = step(pos, dir, layout, count, halfTurn);
    if (next.page === pos.page && next.half === pos.half) break;
    seen.push(`${next.page}${next.half ? '+' : ''}`);
    pos = next;
  }
  return seen.join(' ');
}

test('めくる：1ページずつ。端では動かない', () => {
  assert.equal(walk('single', 4, false, 1, { page: 1, half: false }), '2 3 4');
  assert.equal(walk('single', 4, false, -1, { page: 4, half: false }), '3 2 1');
  assert.equal(walk('single', 1, false, 1, { page: 1, half: false }), '');
});

test('めくる：見開きは2ページずつ', () => {
  assert.equal(walk('spread', 5, false, 1, { page: 1, half: false }), '3 5');
  assert.equal(walk('spread', 5, false, -1, { page: 5, half: false }), '3 1');
  assert.equal(walk('spread', 4, false, 1, { page: 1, half: false }), '3');
  assert.equal(walk('spread', 4, true, 1, { page: 1, half: false }), '3'); // 見開きでは、半ページめくりは効かない
});

test('めくる：半ページめくりは「途中 → 次のページ」と進み、戻るときは同じ道を戻る', () => {
  assert.equal(walk('single', 3, true, 1, { page: 1, half: false }), '1+ 2 2+ 3');
  assert.equal(walk('single', 3, true, -1, { page: 3, half: false }), '2+ 2 1+ 1');
});

test('枠に収める：縦横比を保って、はみ出さない', () => {
  assert.deepEqual(fit(800, 1000, 0.5), { w: 500, h: 1000 }); // 高さで決まる
  assert.deepEqual(fit(400, 1000, 0.5), { w: 400, h: 800 }); // 幅で決まる
  assert.deepEqual(fit(0, 1000, 0.5), { w: 0, h: 0 });
  const box = fit(819, 1093, 595 / 842);
  assert.ok(box.w <= 819 && box.h <= 1093);
});

test('キャンバスの画素：画面の細かさに合わせるが、上限を越えない', () => {
  assert.equal(pixelRatioFor(800, 1000, 2, 5000000), 2);
  const ratio = pixelRatioFor(1600, 2200, 2, 5000000);
  assert.ok(ratio < 2);
  assert.ok(1600 * ratio * 2200 * ratio <= 5000000 * 1.001);
  assert.equal(pixelRatioFor(800, 1000, 0, 5000000), 1);
});

function picture(width, height, marks) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1] of marks) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return data;
}

test('余白カット：中身のある範囲に、少しゆとりを付けて返す', () => {
  const crop = findCrop(picture(100, 200, [[20, 40, 80, 160]]), 100, 200);
  assert.ok(Math.abs(crop.l - (0.2 - 0.015)) < 1e-9);
  assert.ok(Math.abs(crop.r - (0.8 + 0.015)) < 1e-9);
  assert.ok(Math.abs(crop.t - (0.2 - 0.015)) < 1e-9);
  assert.ok(Math.abs(crop.b - (0.8 + 0.015)) < 1e-9);
});

test('余白カット：端まで中身があれば切らず、小さなごみ（1点）は中身とみなさない', () => {
  assert.deepEqual(findCrop(picture(100, 200, [[0, 0, 100, 200]]), 100, 200), { l: 0, t: 0, r: 1, b: 1 });
  const crop = findCrop(picture(100, 200, [[20, 40, 80, 160], [2, 2, 3, 3]]), 100, 200);
  assert.ok(crop.l > 0.1 && crop.t > 0.1);
});

test('余白カット：白紙・中身が小さすぎるページは切らない', () => {
  assert.equal(findCrop(picture(100, 200, []), 100, 200), FULL);
  assert.equal(findCrop(picture(100, 200, [[48, 190, 52, 194]]), 100, 200), FULL); // ページ番号だけ
});

test('タップした場所：左の3割＝前へ・右の3割＝次へ・真ん中＝操作の欄', () => {
  assert.equal(zoneAt(100, 1000), 'prev');
  assert.equal(zoneAt(500, 1000), 'menu');
  assert.equal(zoneAt(900, 1000), 'next');
  assert.equal(zoneAt(10, 0), 'menu');
});

test('PDF かどうか・題名', () => {
  assert.equal(looksLikePdf(new Uint8Array(makePdf(1))), true);
  assert.equal(looksLikePdf(new TextEncoder().encode('<?xml version="1.0"?><score-partwise/>')), false);
  assert.equal(looksLikePdf(new Uint8Array(0)), false);
  assert.equal(titleOf('朝の練習.PDF'), '朝の練習');
  assert.equal(titleOf('scale.pdf'), 'scale');
  assert.equal(titleOf('pdf'), 'pdf');
});

test('pdf.js：同梱したもので、試験用の PDF のページ数と紙の大きさが読める', async () => {
  const pdfjs = await import('../vendor/pdfjs/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(makePdf(3, { sizes: [[595, 842], [842, 595]] })), verbosity: 0 }).promise;
  assert.equal(doc.numPages, 3);
  const second = (await doc.getPage(2)).getViewport({ scale: 1 });
  assert.deepEqual([second.width, second.height], [842, 595]);
  await doc.loadingTask.destroy();
});

test('pdf.js：保存する一覧（files.json）が、vendor/pdfjs の中身と同じ', () => {
  assert.deepEqual(JSON.parse(readText('vendor/pdfjs/files.json')), listPdfjs());
  for (const name of ['pdf.mjs', 'pdf.worker.mjs', 'LICENSE', 'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'cmaps/90ms-RKSJ-H.bcmap', 'standard_fonts/LiberationSans-Regular.ttf']) {
    assert.ok(fs.existsSync(path.join(root, 'vendor/pdfjs', name)), `${name} が無い`);
  }
});

test('PDF のページ：外へ送る通信を書いていない（読むのは、同梱した部品だけ）', () => {
  for (const file of ['src/pdf-app.js', 'src/pdf-layout.js', 'src/pdf-store.js', 'src/pdf-ink.js', 'src/pdf-metronome.js', 'src/pdf-setlist.js', 'src/pdf-shelf.js', 'pdf.html']) {
    const text = readText(file);
    assert.ok(!text.includes('http://') && !text.includes('https://'), `${file} に外の URL がある`);
    assert.ok(!text.includes('fetch(') && !text.includes('XMLHttpRequest') && !text.includes('sendBeacon'), `${file} に通信がある`);
    assert.ok(!text.includes(String.fromCharCode(92)), `${file} に逆スラッシュがある`);
  }
});
