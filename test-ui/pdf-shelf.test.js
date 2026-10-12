// PDF の楽譜のページ：本棚を名前で探す・並べる、の画面のテスト（Playwright の Chromium）。npm run test:ui
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

const FILES = [
  { name: 'Morning Song.pdf', mimeType: 'application/pdf', buffer: makePdf(1) },
  { name: '夕べのワルツ.pdf', mimeType: 'application/pdf', buffer: makePdf(2) },
  { name: 'カノン.pdf', mimeType: 'application/pdf', buffer: makePdf(3) },
];

function names(page) {
  return page.evaluate(() => [...document.querySelectorAll('#shelf-list .shelf-item .name')].map((n) => n.textContent));
}

function waitNames(page, want) {
  return page.waitForFunction((list) => JSON.stringify([...document.querySelectorAll('#shelf-list .shelf-item .name')].map((n) => n.textContent)) === JSON.stringify(list), want);
}

async function openPage(context, files) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('Warning:')) errors.push(m.text());
  });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  if (files) {
    await page.setInputFiles('#file', files);
    await page.waitForFunction((n) => document.getElementById('status').textContent === `${n} 本を本棚に入れました`, files.length);
  }
  return { page, errors };
}

test('本棚：空のときは、探す欄を出さない', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPage(context, null);
    await page.click('#shelf-open');
    await page.waitForSelector('#shelf-list .hint');
    assert.ok(await page.isHidden('#shelf-tools'));
    assert.match(await page.textContent('#shelf-list'), /まだありません/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('本棚：名前で探せる（全角・半角、大文字・小文字、ひらがな・カタカナ を区別しない）。並び順を変えられて、覚える', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPage(context, FILES);
    await page.click('#shelf-open');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 3);
    assert.ok(await page.isVisible('#shelf-tools'));
    // はじめは、最近開いた順（開いた1本が先頭）
    assert.equal(await page.inputValue('#shelf-order'), 'opened');
    assert.equal((await names(page))[0], 'Morning Song');

    // 打つたびに絞り込む
    await page.fill('#shelf-find', 'かのん');
    await waitNames(page, ['カノン']);
    await page.fill('#shelf-find', 'ＭＯＲＮＩＮＧ　song');
    await waitNames(page, ['Morning Song']);
    await page.fill('#shelf-find', 'わるつ');
    await waitNames(page, ['夕べのワルツ']);
    await page.fill('#shelf-find', 'zzz');
    await page.waitForSelector('#shelf-list .hint');
    assert.equal(await page.textContent('#shelf-list .hint'), '「zzz」に合う PDF は、ありません。');
    // 探す欄にスペースを打っても、ページはめくれない
    await page.locator('#shelf-find').press('Space');
    assert.equal(await page.textContent('#position'), '1 / 1');
    await page.fill('#shelf-find', '');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 3);

    // 名前の順
    await page.selectOption('#shelf-order', 'name');
    await waitNames(page, ['Morning Song', 'カノン', '夕べのワルツ']);

    // 探して、押すと開く
    await page.fill('#shelf-find', 'かのん');
    await waitNames(page, ['カノン']);
    await page.click('#shelf-list .shelf-item');
    await page.waitForFunction(() => document.getElementById('title').textContent === 'カノン' && document.getElementById('position').textContent === '1 / 3');
    assert.ok(await page.isHidden('#shelf'));

    // 開き直すと、探す言葉は消えて全部が出る。並び順は覚えている（ページを読み直しても）
    await page.click('#shelf-open');
    await waitNames(page, ['Morning Song', 'カノン', '夕べのワルツ']);
    assert.equal(await page.inputValue('#shelf-find'), '');
    await page.click('#shelf-close');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('title').textContent === 'カノン');
    await page.click('#shelf-open');
    await waitNames(page, ['Morning Song', 'カノン', '夕べのワルツ']);
    assert.equal(await page.inputValue('#shelf-order'), 'name');

    // 絞り込んだまま消すと、残りが出る
    await page.fill('#shelf-find', 'morning');
    await waitNames(page, ['Morning Song']);
    page.once('dialog', (d) => d.accept());
    await page.click('#shelf-list .shelf-del');
    await page.waitForSelector('#shelf-list .hint');
    assert.equal(await page.textContent('#shelf-list .hint'), '「morning」に合う PDF は、ありません。');
    await page.fill('#shelf-find', '');
    await waitNames(page, ['カノン', '夕べのワルツ']);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('本棚：せまい画面（幅 375）でも、探す欄と並びの欄が、横にはみ出さない', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
  try {
    const { page, errors } = await openPage(context, FILES);
    await page.click('#fold'); // せまい画面は、はじめ たたんである
    await page.click('#shelf-open');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 3);
    const box = await page.evaluate(() => {
      const el = document.querySelector('#shelf .shelf-box');
      const right = Math.max(...[...el.querySelectorAll('button, select, input')].filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect().right));
      return { scroll: el.scrollWidth, client: el.clientWidth, right, inner: window.innerWidth };
    });
    assert.ok(box.scroll <= box.client, `欄が横にはみ出している（${box.scroll} > ${box.client}）`);
    assert.ok(box.right <= box.inner, `欄が画面の外にある（${box.right} > ${box.inner}）`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
