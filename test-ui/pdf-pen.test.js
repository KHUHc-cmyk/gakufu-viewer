// PDF の楽譜のページ：「ペンだけで書く」（Apple Pencil で書き、指でめくる）の、画面のテスト（Playwright の Chromium）。npm run test:ui
// ペンの動きは、pointerType が 'pen' の PointerEvent を、紙に直接送って作る（マウスは「指」として扱われる）
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

const FIVE = { name: 'five-pages.pdf', mimeType: 'application/pdf', buffer: makePdf(5) };
const PEN_REST = 700; // アプリの PEN_REST（0.6 秒）より少し長く待つ

function waitShown(page, pages) {
  return page.waitForFunction((want) => {
    const sheets = [...document.querySelectorAll('#stage .layer .sheet')];
    return JSON.stringify(sheets.map((s) => Number(s.dataset.page))) === JSON.stringify(want) && sheets.every((s) => s.querySelector('canvas'));
  }, pages);
}

function settle(page) {
  return page.waitForFunction(() => {
    const stage = document.getElementById('stage');
    if (stage.dataset.drawn !== `${stage.clientWidth}x${stage.clientHeight}`) return false;
    return [...stage.querySelectorAll('.sheet')].every((s) => !s.querySelector('canvas:not(.ink)') || s.querySelector('canvas.ink'));
  });
}

function strokeCount(page, n) {
  return page.evaluate((num) => (window.__pdf.state.notes.ink[num] ?? []).length, n);
}

/** ページ n の紙の上を、ペンでなぞる（紙の中の割合 [[fx, fy], …]）。lift が false なら、離さない */
async function pen(page, n, points, { lift = true } = {}) {
  await page.waitForTimeout(200);
  await settle(page);
  await page.evaluate(([num, pts, up]) => {
    const sheet = document.querySelector(`#stage .sheet[data-page="${num}"]`);
    const r = sheet.getBoundingClientRect();
    const send = (type, [fx, fy]) => sheet.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'pen',
      isPrimary: true,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: r.left + r.width * fx,
      clientY: r.top + r.height * fy,
    }));
    if (pts.length) send('pointerdown', pts[0]);
    for (const p of pts.slice(1)) send('pointermove', p);
    if (up) send('pointerup', pts.at(-1) ?? [0.5, 0.5]);
  }, [n, points, lift]);
}

/** ペンを離す（pen の lift: false の続き） */
function penUp(page) {
  return page.evaluate(() => {
    document.querySelector('#stage .sheet').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'pen', isPrimary: true }));
  });
}

/** 楽譜の場所の、横の割合 fx・縦の真ん中を、マウス（指の代わり）で押す。hold はミリ秒 */
async function tap(page, fx, hold = 0) {
  await settle(page);
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height / 2);
  await page.mouse.down();
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function openPdf() {
  const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('Warning:')) errors.push(m.text());
  });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1]);
  return { page, errors };
}

const touchAction = (page) => page.evaluate(() => document.getElementById('stage').style.touchAction);
const position = (page) => page.textContent('#position');

test('ペンだけで書く：はじめてペンで書くと入る。ペンで書け、指（マウス）では書かずにめくれる。開き直しても覚えている', async () => {
  const { page, errors } = await openPdf();
  await page.click('#ink');
  assert.equal(await page.isChecked('#pen-only'), false);
  assert.equal(await touchAction(page), 'none');

  await pen(page, 1, [[0.3, 0.3], [0.5, 0.32], [0.6, 0.35]]);
  assert.equal(await strokeCount(page, 1), 1, 'ペンの線が入る');
  assert.equal(await page.isChecked('#pen-only'), true, 'はじめてペンで書くと、「ペンだけで書く」に入る');
  assert.notEqual(await touchAction(page), 'none', '指では画面を動かせる');
  assert.match(await page.textContent('#ink-hint'), /指のタップ/);

  // 指（マウス）で押しても、線は入らない。右を押すと次へ、左を押すと前へ。真ん中では、操作の欄をかくさない
  await page.waitForTimeout(PEN_REST);
  await tap(page, 0.85);
  await waitShown(page, [2]);
  assert.equal(await position(page), '2 / 5');
  await tap(page, 0.15);
  await waitShown(page, [1]);
  await tap(page, 0.5);
  assert.equal(await page.evaluate(() => document.body.classList.contains('bar-hidden')), false);
  assert.equal(await strokeCount(page, 1), 1, '指では書かない');
  assert.equal(await page.textContent('#ink'), '書き込みを終える', '書き込みは続いている');

  // 開き直しても覚えている
  await page.reload();
  await page.waitForFunction(() => window.__pdf && window.__pdf.state.doc);
  await page.click('#ink');
  assert.equal(await page.isChecked('#pen-only'), true);
  assert.notEqual(await touchAction(page), 'none');
  assert.deepEqual(errors, []);
  await page.close();
});

test('ペンだけで書く：ペンで書いている間と、離してすぐ・指を長く置いたときは、めくらない（手のひらよけ）', async () => {
  const { page, errors } = await openPdf();
  await page.click('#ink');
  await page.check('#pen-only');

  await pen(page, 1, [[0.3, 0.5], [0.4, 0.5]], { lift: false });
  await tap(page, 0.85);
  assert.equal(await position(page), '1 / 5', '書いている間は、めくらない');
  await penUp(page);
  assert.equal(await strokeCount(page, 1), 1);
  await tap(page, 0.85);
  assert.equal(await position(page), '1 / 5', '離してすぐは、めくらない');

  await page.waitForTimeout(PEN_REST);
  await tap(page, 0.85, 600);
  assert.equal(await position(page), '1 / 5', '長く置いた指（手のひら）では、めくらない');
  await tap(page, 0.85);
  await waitShown(page, [2]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('ペンだけで書く：自分で外すと、指でも書け、タップでめくらない。ペンで書いても、もう自動では入らない', async () => {
  const { page, errors } = await openPdf();
  await page.click('#ink');
  await page.check('#pen-only');
  await page.uncheck('#pen-only');
  assert.equal(await touchAction(page), 'none');

  await tap(page, 0.85);
  assert.equal(await position(page), '1 / 5');
  assert.equal(await strokeCount(page, 1), 1, '指（マウス）のタップで、点が付く');

  await pen(page, 1, [[0.3, 0.6], [0.5, 0.6]]);
  assert.equal(await strokeCount(page, 1), 2);
  assert.equal(await page.isChecked('#pen-only'), false, '自分で外した後は、自動で入れない');

  // 書き込みを終えると、ふだんどおりタップでめくれる
  await page.click('#ink');
  await page.waitForTimeout(PEN_REST);
  await tap(page, 0.85);
  await waitShown(page, [2]);
  assert.deepEqual(errors, []);
  await page.close();
});
