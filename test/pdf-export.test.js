// PDF の楽譜のページ：書き込みつきの PDF を組み立てる計算（src/pdf-export.js）。中身の絵は、画面のテスト（test-ui/pdf-export.test.js）で確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, exportName, exportPixels } from '../src/pdf-export.js';
import { drawStrokes } from '../src/pdf-ink.js';

const latin = (bytes) => Buffer.from(bytes).toString('latin1');
const fakeJpeg = (n) => new Uint8Array(n).map((_, i) => (i * 37) % 256);

test('PDF の形：ページの数・大きさ・絵が入り、目次（xref）の位置が、それぞれの obj を指す', () => {
  const pages = [
    { width: 595.28, height: 841.89, image: { bytes: fakeJpeg(50), w: 1414, h: 2000 } },
    { width: 842, height: 595, image: { bytes: fakeJpeg(70), w: 2000, h: 1413 } },
  ];
  const bytes = buildPdf(pages);
  const text = latin(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /[/]Count 2/);
  assert.ok(text.includes('/MediaBox [0 0 595.28 841.89]'));
  assert.ok(text.includes('/MediaBox [0 0 842 595]'));
  assert.match(text, /[/]Width 1414 [/]Height 2000 .*[/]Filter [/]DCTDecode [/]Length 50/);

  // startxref → xref の表 → 各 obj の始まり
  const start = Number(text.match(/startxref.([0-9]+).%%EOF/s)[1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const rows = text.slice(start).split(String.fromCharCode(10)).slice(2, 2 + 9);
  assert.equal(rows[0], '0000000000 65535 f ');
  rows.slice(1).forEach((row, i) => {
    assert.match(row, /^[0-9]{10} 00000 n $/);
    const at = Number(row.slice(0, 10));
    assert.ok(text.startsWith(`${i + 1} 0 obj`, at), `${i + 1} 0 obj の位置`);
  });

  // 絵のバイトは、そのまま入る
  const img = text.indexOf('/Length 70 >>');
  const body = text.indexOf('stream', img) + 'stream'.length + 1;
  assert.deepEqual([...bytes.slice(body, body + 70)], [...pages[1].image.bytes]);

  // 中身の長さ（/Length）が、描く命令の長さと合う
  const draw = text.match(/[/]Length ([0-9]+) >>.stream.(q [^Q]*Q).endstream/s);
  assert.equal(Number(draw[1]), draw[2].length);
});

test('PDF の形：ページが無いときは作らない', () => {
  assert.throws(() => buildPdf([]));
});

test('ファイルの名前と、絵の大きさ', () => {
  assert.equal(exportName('ジムノペディ'), 'ジムノペディ（書き込みつき）.pdf');
  assert.equal(exportName(''), '楽譜（書き込みつき）.pdf');
  assert.deepEqual(exportPixels(595, 842, 2000), { scale: 2000 / 842, w: 1413, h: 2000 });
  assert.deepEqual(exportPixels(842, 595, 2000), { scale: 2000 / 842, w: 2000, h: 1413 });
});

test('線を描く：決まった太さと色で、紙の割合の位置に描く（回した向きにも合わせる）', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, name) => (name in ctxState ? ctxState[name] : (...args) => calls.push([name, ...args])),
    set: (_, name, value) => {
      ctxState[name] = value;
      calls.push(['set', name, value]);
      return true;
    },
  });
  const ctxState = {};
  const full = { l: 0, t: 0, r: 1, b: 1 };
  drawStrokes(ctx, [{ t: 'red', p: [0.1, 0.2, 0.3, 0.2] }, { t: 'nope', p: [0, 0] }], 1000, 2000, full, 0);
  assert.deepEqual(calls.find((c) => c[0] === 'moveTo').slice(1), [100, 400]);
  assert.deepEqual(calls.find((c) => c[0] === 'lineTo').slice(1), [300, 400]);
  assert.ok(calls.some((c) => c[0] === 'set' && c[1] === 'strokeStyle' && c[2] === '#d6202a'));
  assert.equal(calls.filter((c) => c[0] === 'stroke').length, 1, '知らない道具の線は描かない');
  // 右へ 90 度回した紙（2000 × 1000）：もとの (0.1, 0.2) は、(1 − 0.2, 0.1) に出る
  calls.length = 0;
  drawStrokes(ctx, [{ t: 'black', p: [0.1, 0.2, 0.3, 0.2] }], 2000, 1000, full, 90);
  assert.deepEqual(calls.find((c) => c[0] === 'moveTo').slice(1), [1600, 100]);
});
