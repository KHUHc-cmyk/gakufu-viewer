// PDF の楽譜のページ：書き込みつきの PDF を作る、の画面のテスト（Playwright の Chromium）。npm run test:ui
// 作った PDF を、pdf.js でもう一度開いて、ページの数・大きさ・赤い線の位置を確かめる
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

async function draw(page, n, points) {
  await page.waitForTimeout(200);
  await settle(page);
  const box = await page.locator(`#stage .sheet[data-page="${n}"]`).boundingBox();
  const at = ([fx, fy]) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...at(point), { steps: 6 });
  await page.mouse.up();
}

async function openPdf() {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  // PC の Chrome の共有の画面は出さない（ダウンロードの道を通す）
  await context.addInitScript(() => Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('Warning:')) errors.push(m.text());
  });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1]);
  return { page, context, errors };
}

/** 作った PDF を pdf.js で開いて、ページの数・1ページ目の大きさ・赤い点のまんなか（紙の中の割合）を返す */
function inspectExport(page) {
  return page.evaluate(async () => {
    const pdfjs = await import(new URL('vendor/pdfjs/pdf.mjs', location.href).href);
    const data = new Uint8Array(await window.__pdf.state.exported.arrayBuffer());
    const task = pdfjs.getDocument({ data });
    const doc = await task.promise;
    const first = await doc.getPage(1);
    const viewport = first.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await first.render({ canvas, canvasContext: ctx, viewport }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 150 && px[i + 1] < 90 && px[i + 2] < 90) {
        red += 1;
        sx += (i / 4) % canvas.width;
        sy += Math.floor(i / 4 / canvas.width);
      }
    }
    const out = { pages: doc.numPages, w: canvas.width, h: canvas.height, red, cx: red ? sx / red / canvas.width : null, cy: red ? sy / red / canvas.height : null };
    await task.destroy();
    return out;
  });
}

test('書き出す：書き込みつきの PDF を作ると、全部のページが入り、赤い線が同じ所に出る。「保存・共有する」でファイルが出る', async () => {
  const { page, context, errors } = await openPdf();
  await page.click('#ink');
  assert.ok(await page.isHidden('#export-save'));
  await page.click('.ink-tool[data-tool="red"]');
  await draw(page, 1, [[0.3, 0.5], [0.6, 0.5]]);
  await page.waitForFunction(() => (window.__pdf.state.notes.ink[1] ?? []).length === 1);

  await page.click('#export');
  await page.waitForSelector('#export-save', { state: 'visible', timeout: 60000 });
  assert.match(await page.textContent('#status'), /できました（5 ページ/);
  const got = await inspectExport(page);
  assert.equal(got.pages, 5);
  assert.deepEqual([got.w, got.h], [595, 842]);
  assert.ok(got.red > 200, `赤い線が入っている（${JSON.stringify(got)}）`);
  assert.ok(Math.abs(got.cx - 0.45) < 0.03 && Math.abs(got.cy - 0.5) < 0.03, `赤い線の位置（${JSON.stringify(got)}）`);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-save')]);
  assert.equal(download.suggestedFilename(), 'five-pages（書き込みつき）.pdf');
  const saved = fs.readFileSync(await download.path());
  assert.equal(saved.subarray(0, 8).toString('latin1'), '%PDF-1.4');

  // 書き足すと、作った PDF は古くなる（「保存・共有する」が消える）
  await draw(page, 1, [[0.3, 0.7], [0.6, 0.7]]);
  await page.waitForSelector('#export-save', { state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__pdf.state.exported), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('書き出す：右に回した PDF は、回した向きのまま書き出す（線も紙といっしょに回る）', async () => {
  const { page, context, errors } = await openPdf();
  await page.click('#ink');
  await page.click('.ink-tool[data-tool="red"]');
  await draw(page, 1, [[0.3, 0.5], [0.6, 0.5]]);
  await page.waitForFunction(() => (window.__pdf.state.notes.ink[1] ?? []).length === 1);
  await page.click('#turn');
  await page.waitForFunction(() => {
    const r = document.querySelector('#stage .sheet')?.getBoundingClientRect();
    return r && r.width > r.height;
  });

  await page.click('#export');
  await page.waitForSelector('#export-save', { state: 'visible', timeout: 60000 });
  const got = await inspectExport(page);
  assert.deepEqual([got.w, got.h], [842, 595], '横長のページになる');
  // もとの (0.45, 0.5) は、右へ 90 度回すと (1 − 0.5, 0.45) に出る
  assert.ok(Math.abs(got.cx - 0.5) < 0.03 && Math.abs(got.cy - 0.45) < 0.03, `回した線の位置（${JSON.stringify(got)}）`);
  assert.deepEqual(errors, []);
  await context.close();
});
