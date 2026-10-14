// PDF の楽譜のページ：とび先（押すと、ほかのページへ飛ぶ印）の、画面のテスト（Playwright の Chromium）。npm run test:ui
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

function waitShown(page, pages) {
  return page.waitForFunction((want) => {
    const sheets = [...document.querySelectorAll('#stage .layer .sheet')];
    return JSON.stringify(sheets.map((s) => Number(s.dataset.page))) === JSON.stringify(want) && sheets.every((s) => s.querySelector('canvas'));
  }, pages);
}

/** 画面の並び直しが終わるまで待つ（紙のキャンバスには、書き込み用のキャンバスが重なる） */
async function settle(page) {
  await page.waitForTimeout(200); // 並び直しは、大きさが変わってから 0.12 秒後に始まる
  await page.waitForFunction(() => {
    const stage = document.getElementById('stage');
    if (stage.dataset.drawn !== `${stage.clientWidth}x${stage.clientHeight}`) return false;
    return [...stage.querySelectorAll('.sheet')].every((s) => !s.querySelector('canvas:not(.ink)') || s.querySelector('canvas.ink'));
  });
}

/** ページ n の紙の上の (fx, fy)（紙の中の割合）を、マウスでなぞる・押す */
async function stroke(page, n, points) {
  await settle(page);
  const box = await page.locator(`#stage .sheet[data-page="${n}"]`).boundingBox();
  const at = ([fx, fy]) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(...at(point), { steps: 6 });
  await page.mouse.up();
}

function linksOf(page, n) {
  return page.evaluate((num) => JSON.stringify(window.__pdf.state.notes.links[num] ?? []), n);
}

/** ページ送りの欄で、そのページへ飛ぶ */
async function seekTo(page, n) {
  await page.evaluate((num) => {
    const seek = document.getElementById('seek');
    seek.value = String(num);
    seek.dispatchEvent(new Event('change'));
  }, n);
  await waitShown(page, [n]);
}

async function openPdf(context = null) {
  const page = context ? await context.newPage() : await browser.newPage({ viewport: { width: 820, height: 1180 } });
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

/** 書き込みを始め、ページ 3 の at の所に、to ページへのとび先を置く */
async function putLink(page, to = '1', at = [0.8, 0.9]) {
  await page.click('#ink');
  await page.click('.ink-tool[data-tool="link"]');
  assert.ok(await page.isVisible('#link-box'), '「とび先」を選ぶと、飛ぶページの欄が出る');
  await page.fill('#link-to', to);
  await stroke(page, 3, [at]);
}

test('とび先：書き込みで置き、押すとそのページへ飛ぶ。「戻る」で帰り、ほかの めくり方では「戻る」が消える', async () => {
  const { page, errors } = await openPdf();
  await seekTo(page, 3);
  await putLink(page);
  await page.waitForFunction(() => (window.__pdf.state.notes.links[3] ?? []).length === 1);
  const [link] = JSON.parse(await linksOf(page, 3));
  assert.ok(Math.abs(link.x - 0.8) < 0.02 && Math.abs(link.y - 0.9) < 0.02 && link.to === 1, JSON.stringify(link));
  assert.match(await page.textContent('#status'), /3 ページに、1 ページへのとび先/);
  // 書き込み中は、印を押しても飛ばない（紙の上をなぞれる）。ほかの道具では、飛ぶページの欄はかくれる
  assert.equal(await page.locator('.jump').count(), 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.jump')).pointerEvents), 'none');
  await page.click('.ink-tool[data-tool="black"]');
  assert.ok(await page.isHidden('#link-box'));
  await page.click('#ink');

  // 印は、置いた所に出る
  await settle(page);
  const sheet = await page.locator('#stage .sheet[data-page="3"]').boundingBox();
  const mark = await page.locator('.jump').boundingBox();
  const cx = (mark.x + mark.width / 2 - sheet.x) / sheet.width;
  const cy = (mark.y + mark.height / 2 - sheet.y) / sheet.height;
  assert.ok(Math.abs(cx - 0.8) < 0.02 && Math.abs(cy - 0.9) < 0.02, `印の位置（${cx}, ${cy}）`);
  assert.equal(await page.textContent('.jump'), '→ 1');

  await page.click('.jump');
  await waitShown(page, [1]);
  assert.ok(await page.isVisible('#jump-back'));
  assert.equal(await page.textContent('#jump-back'), '← 3 ページへ戻る');
  await page.click('#jump-back');
  await waitShown(page, [3]);
  assert.ok(await page.isHidden('#jump-back'));
  // 押した後は、ボタンから離れる（ペダルのスペースで、もう一度飛ばないように）
  await settle(page);
  await page.click('.jump');
  await waitShown(page, [1]);
  assert.notEqual(await page.evaluate(() => document.activeElement?.className ?? ''), 'jump');
  await page.click('#next');
  await waitShown(page, [2]);
  assert.ok(await page.isHidden('#jump-back'), 'ふつうにめくったら、「戻る」は消える');
  assert.deepEqual(errors, []);
  await page.close();
});

test('とび先：消しゴムで消せて、「元に戻す」で戻る。おかしなページは置かない。開き直しても残り、回しても付いてくる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf(context);
    await seekTo(page, 3);
    await putLink(page, '9');
    assert.match(await page.textContent('#status'), /1〜5 の数で/);
    assert.equal(await linksOf(page, 3), '[]');

    await page.fill('#link-to', '5');
    await stroke(page, 3, [[0.5, 0.5]]);
    await page.waitForFunction(() => (window.__pdf.state.notes.links[3] ?? []).length === 1);
    await page.click('.ink-tool[data-tool="eraser"]');
    await stroke(page, 3, [[0.4, 0.5], [0.6, 0.5]]);
    await page.waitForFunction(() => window.__pdf.state.notes.links[3].length === 0);
    assert.equal(await page.locator('.jump').count(), 0);
    await page.click('#ink-undo');
    await page.waitForFunction(() => window.__pdf.state.notes.links[3].length === 1);
    assert.equal(await page.locator('.jump').count(), 1);
    await page.click('#ink');

    // 開き直しても残る
    await page.waitForTimeout(900);
    await page.reload();
    await waitShown(page, [3]);
    await page.waitForSelector('.jump');
    assert.equal(await page.textContent('.jump'), '→ 5');

    // 右に回しても、紙の同じ所に付いてくる（まんなかは、まんなか）。押せば飛ぶ
    await page.click('#turn');
    await page.waitForFunction(() => {
      const r = document.querySelector('#stage .sheet[data-page="3"]')?.getBoundingClientRect();
      return r && r.width > r.height && document.querySelector('#stage .sheet[data-page="3"] .jump');
    });
    await settle(page);
    const sheet = await page.locator('#stage .sheet[data-page="3"]').boundingBox();
    const mark = await page.locator('.jump').boundingBox();
    assert.ok(Math.abs((mark.x + mark.width / 2 - sheet.x) / sheet.width - 0.5) < 0.02);
    await page.click('.jump');
    await waitShown(page, [5]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('とび先：縦スクロールでも押せて、そのページへ動く', async () => {
  const { page, errors } = await openPdf();
  await seekTo(page, 3);
  await putLink(page, '1', [0.5, 0.3]);
  await page.waitForFunction(() => (window.__pdf.state.notes.links[3] ?? []).length === 1);
  await page.click('#ink');
  await page.selectOption('#mode', 'scroll');
  await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
  await page.waitForFunction(() => window.__pdf.state.pos.page === 3);
  await page.waitForSelector('#stage .sheet[data-page="3"] .jump');
  await page.click('#stage .sheet[data-page="3"] .jump');
  await page.waitForFunction(() => window.__pdf.state.pos.page === 1);
  assert.ok(await page.isVisible('#jump-back'));
  await page.click('#jump-back');
  await page.waitForFunction(() => window.__pdf.state.pos.page === 3);
  assert.deepEqual(errors, []);
  await page.close();
});
