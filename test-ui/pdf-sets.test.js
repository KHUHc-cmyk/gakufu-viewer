// PDF の楽譜のページ：セットリスト（本番の曲順）の、画面のテスト（Playwright の Chromium）。npm run test:ui
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { root } from '../test/helpers.js';
import { makePdf } from '../test/fixtures/make-pdf.js';

let server;
let baseUrl;
let browser;

before(async () => {
  ({ server, url: baseUrl } = await startServer(root));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

const A = { name: 'a-two.pdf', mimeType: 'application/pdf', buffer: makePdf(2) };
const B = { name: 'b-three.pdf', mimeType: 'application/pdf', buffer: makePdf(3) };
const C = { name: 'c-one.pdf', mimeType: 'application/pdf', buffer: makePdf(1) };

function waitShown(page, pages) {
  return page.waitForFunction((want) => {
    const sheets = [...document.querySelectorAll('#stage .layer .sheet')];
    return JSON.stringify(sheets.map((s) => Number(s.dataset.page))) === JSON.stringify(want) && sheets.every((s) => s.querySelector('canvas'));
  }, pages);
}

/** 題名と、ページの位置が、その形になるまで待つ（曲をまたぐと、題名が変わる） */
function waitSong(page, title, position) {
  return page.waitForFunction(([t, p]) => document.getElementById('title').textContent === t && document.getElementById('position').textContent === p, [title, position]);
}

function rowsOf(page) {
  return page.evaluate(() => [...document.querySelectorAll('#sets-list .shelf-item')].map((b) => `${b.querySelector('.name').textContent}｜${b.querySelector('.sub').textContent}`));
}

function waitRows(page, count) {
  return page.waitForFunction((n) => document.querySelectorAll('#sets-list .shelf-item').length === n, count);
}

async function openPdf({ files = [A, B, C], context = null, first = [1], viewport = { width: 820, height: 1180 } } = {}) {
  const page = context ? await context.newPage() : await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('Warning:')) errors.push(m.text());
  });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  if (files) {
    await page.setInputFiles('#file', files);
    await waitShown(page, first);
    if (files.length > 1) await page.waitForFunction((n) => document.getElementById('status').textContent === `${n} 本を本棚に入れました`, files.length);
  }
  return { page, errors };
}

/** セットリストを作って、本棚の曲を名前の順に count 曲足す（欄は、そのセットリストの中を出したまま） */
async function makeSet(page, name, count) {
  await page.click('#sets-open');
  await page.waitForSelector('#sets-list .hint');
  await page.fill('#set-name', name);
  await page.click('#set-add');
  await page.waitForSelector('#set-songs:not([hidden])');
  for (let i = 1; i <= count; i++) {
    await page.click('#set-song-add');
    await waitRows(page, i);
  }
}

test('セットリスト：作って曲を足し、押すとその曲の頭から開く。端のページでめくると、となりの曲へ移る', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    assert.equal(await page.textContent('#title'), 'a-two');

    await page.click('#sets-open');
    await page.waitForSelector('#sets-list .hint');
    assert.equal(await page.textContent('#sets-title'), 'セットリスト');
    assert.ok(await page.isHidden('#set-songs'));
    assert.ok(await page.isHidden('#sets-back'));
    await page.fill('#set-name', 'ライブ');
    await page.click('#set-add');
    // 作ると、そのまま中が出る
    await page.waitForSelector('#set-songs:not([hidden])');
    assert.equal(await page.textContent('#sets-title'), 'ライブ');
    assert.ok(await page.isHidden('#sets-new'));
    assert.match(await page.textContent('#sets-list'), /まだ曲がありません/);
    // 選び欄は本棚の名前の順。まだ入れていない曲が、先に選ばれている
    assert.deepEqual(await page.evaluate(() => [...document.getElementById('set-song').options].map((o) => o.textContent)), ['a-two', 'b-three', 'c-one']);
    for (let i = 1; i <= 3; i++) {
      await page.click('#set-song-add');
      await waitRows(page, i);
    }
    assert.deepEqual(await rowsOf(page), ['a-two｜1 曲目・2 ページ', 'b-three｜2 曲目', 'c-one｜3 曲目']);

    // 開いている間は、キーでめくれない
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    assert.equal(await page.textContent('#position'), '1 / 2');

    // 曲を押すと、欄が閉じて、その曲の頭から開く
    await page.click('#sets-list .shelf-item >> nth=0');
    await waitSong(page, '1/3 a-two', '1 / 2');
    assert.ok(await page.isHidden('#sets'));
    await waitShown(page, [1]);
    assert.ok(await page.isDisabled('#prev'), '1曲目の最初のページでは、前へ行けない');
    assert.ok(await page.isEnabled('#next'));

    // 最後のページで「次へ」＝次の曲の頭
    await page.keyboard.press('ArrowRight');
    await waitSong(page, '1/3 a-two', '2 / 2');
    assert.ok(await page.isEnabled('#next'), '最後のページでも、次の曲があれば押せる');
    await page.keyboard.press('ArrowRight');
    await waitSong(page, '2/3 b-three', '1 / 3');
    await waitShown(page, [1]);
    assert.ok(await page.isEnabled('#prev'), '最初のページでも、前の曲があれば押せる');

    // 最初のページで「前へ」＝前の曲の最後のページ
    await page.click('#prev');
    await waitSong(page, '1/3 a-two', '2 / 2');
    await waitShown(page, [2]);

    // 最後の曲まで進む。最後の曲の最後のページでは、次へ行けない
    await page.click('#next');
    await waitSong(page, '2/3 b-three', '1 / 3');
    await page.keyboard.press('End');
    await waitSong(page, '2/3 b-three', '3 / 3');
    await page.click('#next');
    await waitSong(page, '3/3 c-one', '1 / 1');
    await waitShown(page, [1]);
    assert.ok(await page.isDisabled('#next'));
    assert.ok(await page.isEnabled('#prev'));
    assert.equal(await page.textContent('#pager'), '曲 3/3・1 / 1');

    // 欄を開くと、いまのセットリストの中が出て、いまの曲に印が付く
    await page.click('#sets-open');
    await waitRows(page, 3);
    assert.equal(await page.textContent('#sets-title'), 'ライブ');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#sets-list .shelf-item')].map((b) => b.getAttribute('aria-current'))), [null, null, 'true']);
    // 開いた曲には、ページ数も出る（本棚を読み直した後に出る）
    await page.waitForFunction(() => document.querySelectorAll('#sets-list .shelf-item .sub')[2]?.textContent === '3 曲目・1 ページ');
    assert.deepEqual(await rowsOf(page), ['a-two｜1 曲目・2 ページ', 'b-three｜2 曲目・3 ページ', 'c-one｜3 曲目・1 ページ']);
    await page.click('#sets-close');

    // 開き直しても、セットリストの続きから
    await page.waitForTimeout(600);
    await page.reload();
    await waitSong(page, '3/3 c-one', '1 / 1');
    await page.click('#prev');
    await waitSong(page, '2/3 b-three', '3 / 3');

    // 本棚から開くと、セットリストから抜ける
    await page.click('#shelf-open');
    await page.waitForSelector('#shelf-list .shelf-item');
    await page.click('#shelf-list .shelf-item:has-text("a-two")');
    await waitSong(page, 'a-two', '2 / 2');
    assert.ok(await page.isDisabled('#next'));
    assert.equal(await page.textContent('#pager'), '2 / 2');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('セットリスト：並べ替え・外す・消す。本棚から消した曲は、セットリストからも外れる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    // 名前を入れずに Enter で作ると「セットリスト 1」
    await page.click('#sets-open');
    await page.waitForSelector('#sets-list .hint');
    await page.locator('#set-name').press('Enter');
    await page.waitForSelector('#set-songs:not([hidden])');
    assert.equal(await page.textContent('#sets-title'), 'セットリスト 1');
    for (let i = 1; i <= 3; i++) {
      await page.click('#set-song-add');
      await waitRows(page, i);
    }
    // 全部入れた後は、同じ曲をもう一度足せる（アンコールなど）
    await page.click('#set-song-add');
    await waitRows(page, 4);
    assert.deepEqual((await rowsOf(page)).map((r) => r.split('｜')[0]), ['a-two', 'b-three', 'c-one', 'a-two']);
    await page.click('#sets-list [data-out="3"]');
    await waitRows(page, 3);

    // 端の曲は、その先へ動かせない
    assert.ok(await page.isDisabled('#sets-list [data-move="0"][data-dir="-1"]'));
    assert.ok(await page.isDisabled('#sets-list [data-move="2"][data-dir="1"]'));
    // 1曲目を後ろへ
    await page.click('#sets-list [data-move="0"][data-dir="1"]');
    await page.waitForFunction(() => document.querySelector('#sets-list .shelf-item .name').textContent === 'b-three');
    assert.deepEqual((await rowsOf(page)).map((r) => r.split('｜')[0]), ['b-three', 'a-two', 'c-one']);

    // 2曲目（a-two）を開く
    await page.click('#sets-list .shelf-item >> nth=1');
    await waitSong(page, '2/3 a-two', '1 / 2');
    // いまの曲を前へ動かすと、題名の「何曲目」も変わる
    await page.click('#sets-open');
    await waitRows(page, 3);
    await page.click('#sets-list [data-move="1"][data-dir="-1"]');
    await waitSong(page, '1/3 a-two', '1 / 2');
    assert.ok(await page.isDisabled('#prev'));
    // ほかの曲を外すと、曲数が減る
    await page.click('#sets-list [data-out="2"]');
    await waitSong(page, '1/2 a-two', '1 / 2');
    assert.deepEqual((await rowsOf(page)).map((r) => r.split('｜')[0]), ['a-two', 'b-three']);
    // いまの曲を外すと、セットリストから抜ける（楽譜は開いたまま）
    await page.click('#sets-list [data-out="0"]');
    await waitSong(page, 'a-two', '1 / 2');
    await waitRows(page, 1);

    // 一覧へ
    await page.click('#sets-back');
    await page.waitForSelector('#sets-new:not([hidden])');
    assert.deepEqual(await rowsOf(page), ['セットリスト 1｜1 曲']);
    await page.click('#sets-close');

    // 開き直しても残る
    await page.waitForTimeout(300);
    await page.reload();
    await waitSong(page, 'a-two', '1 / 2');
    await page.click('#sets-open');
    await waitRows(page, 1);
    assert.deepEqual(await rowsOf(page), ['セットリスト 1｜1 曲']);
    await page.click('#sets-close');

    // 本棚から消した曲は、セットリストからも外れる
    await page.click('#shelf-open');
    await page.waitForSelector('#shelf-list .shelf-item');
    page.once('dialog', (d) => d.accept());
    await page.click('#shelf-list li:has-text("b-three") .shelf-del');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 2);
    await page.click('#shelf-close');
    await page.click('#sets-open');
    await waitRows(page, 1);
    assert.deepEqual(await rowsOf(page), ['セットリスト 1｜0 曲']);

    // セットリストを消す（断ると残る）
    page.once('dialog', (d) => d.dismiss());
    await page.click('#sets-list [data-del-set]');
    await page.waitForTimeout(200);
    assert.equal((await rowsOf(page)).length, 1);
    page.once('dialog', (d) => d.accept());
    await page.click('#sets-list [data-del-set]');
    await page.waitForSelector('#sets-list .hint');
    assert.equal((await rowsOf(page)).length, 0);
    // PDF は本棚に残る
    await page.click('#sets-close');
    await page.click('#shelf-open');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 2);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('セットリスト：縦スクロールでは、いちばん下で「次へ」＝次の曲、いちばん上で「前へ」＝前の曲', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    await makeSet(page, '縦', 2);
    await page.click('#sets-list .shelf-item >> nth=0');
    await waitSong(page, '1/2 a-two', '1 / 2');
    await page.selectOption('#mode', 'scroll');
    await page.waitForSelector('#stage.scroll .column');
    // 途中では、曲をまたがずに動く
    await page.click('#next');
    await page.waitForFunction(() => document.getElementById('stage').scrollTop > 100);
    assert.equal(await page.textContent('#title'), '1/2 a-two');
    // いちばん下まで動かしてから「次へ」
    await page.evaluate(() => {
      const stage = document.getElementById('stage');
      stage.scrollTo({ top: stage.scrollHeight, behavior: 'instant' });
    });
    await page.waitForFunction(() => {
      const stage = document.getElementById('stage');
      return stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
    });
    await page.click('#next');
    await waitSong(page, '2/2 b-three', '1 / 3');
    await page.waitForSelector('#stage.scroll .column');
    await page.waitForFunction(() => document.getElementById('stage').scrollTop <= 1);
    // いちばん上で「前へ」＝前の曲の最後のページ
    await page.click('#prev');
    await waitSong(page, '1/2 a-two', '2 / 2');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('セットリスト：せまい画面（幅 375）でも、曲の行と足す欄が、横にはみ出さない', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
  try {
    const { page, errors } = await openPdf({ context });
    await page.click('#fold'); // せまい画面は、はじめ たたんである
    await makeSet(page, 'とても長い名前のセットリスト（10月の本番・第2部・アンコールつき）', 3);
    const box = await page.evaluate(() => {
      const el = document.querySelector('#sets .shelf-box');
      const right = Math.max(...[...el.querySelectorAll('button, select, input')].filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect().right));
      return { scroll: el.scrollWidth, client: el.clientWidth, right, inner: window.innerWidth };
    });
    assert.ok(box.scroll <= box.client, `欄が横にはみ出している（${box.scroll} > ${box.client}）`);
    assert.ok(box.right <= box.inner, `ボタンが画面の外にある（${box.right} > ${box.inner}）`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('セットリスト：曲集の PDF から、ページの範囲を1曲として並べる。範囲の端でめくると、となりの曲へ（同じ PDF の中は、開き直さない）', async () => {
  const BOOK = { name: 'book-eight.pdf', mimeType: 'application/pdf', buffer: makePdf(8) };
  const { page, errors } = await openPdf({ files: [BOOK, C] });
  await page.click('#sets-open');
  await page.waitForSelector('#sets-list .hint');
  await page.fill('#set-name', '曲集から');
  await page.click('#set-add');
  await page.waitForSelector('#set-songs:not([hidden])');

  await page.selectOption('#set-song', { label: 'book-eight' });
  await page.fill('#set-from', '3');
  await page.fill('#set-to', '4');
  await page.click('#set-song-add');
  await waitRows(page, 1);
  assert.equal(await page.inputValue('#set-from'), '', '足したら、ページの欄は空に戻る');
  await page.selectOption('#set-song', { label: 'book-eight' });
  await page.fill('#set-from', '7');
  await page.fill('#set-to', '6'); // 逆に入れても、入れ替わる
  await page.click('#set-song-add');
  await waitRows(page, 2);
  await page.selectOption('#set-song', { label: 'c-one' });
  await page.click('#set-song-add');
  await waitRows(page, 3);
  assert.deepEqual(await rowsOf(page), ['book-eight｜1 曲目・3〜4 ページ', 'book-eight｜2 曲目・6〜7 ページ', 'c-one｜3 曲目']);

  // 1曲目は、範囲の頭（3 ページ）から開く
  await page.click('#sets-list .shelf-item >> nth=0');
  await waitSong(page, '1/3 book-eight', '3 / 8');
  await waitShown(page, [3]);
  await page.evaluate(() => { window.__pdf.state.doc.__mark = 1; });
  await page.keyboard.press('ArrowRight');
  await waitSong(page, '1/3 book-eight', '4 / 8');
  // 範囲の終わりで「次へ」＝2曲目の頭（同じ PDF なので、開き直さない）
  await page.keyboard.press('ArrowRight');
  await waitSong(page, '2/3 book-eight', '6 / 8');
  await waitShown(page, [6]);
  assert.equal(await page.evaluate(() => window.__pdf.state.doc.__mark), 1, '同じ PDF は、開き直さない');
  // 範囲の頭で「前へ」＝1曲目の最後のページ
  await page.keyboard.press('ArrowLeft');
  await waitSong(page, '1/3 book-eight', '4 / 8');
  await page.keyboard.press('ArrowRight');
  await waitSong(page, '2/3 book-eight', '6 / 8');
  await page.keyboard.press('ArrowRight');
  await waitSong(page, '2/3 book-eight', '7 / 8');
  // 2曲目の終わりで「次へ」＝ほかの PDF の3曲目。「前へ」で、2曲目の最後（7 ページ）へ戻る
  await page.keyboard.press('ArrowRight');
  await waitSong(page, '3/3 c-one', '1 / 1');
  await page.click('#prev');
  await waitSong(page, '2/3 book-eight', '7 / 8');
  await waitShown(page, [7]);

  // 開き直しても、範囲は残る
  await page.reload();
  await page.waitForFunction(() => window.__pdf && window.__pdf.state.doc);
  await waitSong(page, '2/3 book-eight', '7 / 8');
  await page.click('#sets-open'); // セットリストの中にいるので、そのセットリストの中が出る
  await waitRows(page, 3);
  assert.deepEqual(await rowsOf(page), ['book-eight｜1 曲目・3〜4 ページ', 'book-eight｜2 曲目・6〜7 ページ', 'c-one｜3 曲目・1 ページ']);
  assert.deepEqual(errors, []);
  await page.close();
});
