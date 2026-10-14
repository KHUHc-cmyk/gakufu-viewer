// PDF の楽譜のページ：「右に回す」（紙の向き）の、画面のテスト（Playwright の Chromium）。npm run test:ui
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { root } from '../test/helpers.js';
import { makePdf } from '../test/fixtures/make-pdf.js';
import { turned } from '../src/pdf-ink.js';

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
const BOOK = { name: 'book.pdf', mimeType: 'application/pdf', buffer: makePdf(4) };
const SIDEWAYS = { name: 'sideways.pdf', mimeType: 'application/pdf', buffer: makePdf(2, { rotate: 90 }) };
const TALL = 595 / 842; // 縦長の紙の 幅 ÷ 高さ
const WIDE = 842 / 595;

// 試験用の PDF の、五線のような横線がある所（もとの紙の中の割合。紙の上のほう）
const STAFF = { l: 0.3, t: 0.19, r: 0.7, b: 0.25 };

/** もとの紙の中の四角を、turn だけ回した紙の中の四角に直す */
function turnedRect(rect, turn) {
  const [x0, y0] = turned(rect.l, rect.t, turn);
  const [x1, y1] = turned(rect.r, rect.b, turn);
  return { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
}

function waitShown(page, pages) {
  return page.waitForFunction((want) => {
    const sheets = [...document.querySelectorAll('#stage .layer .sheet')];
    return JSON.stringify(sheets.map((s) => Number(s.dataset.page))) === JSON.stringify(want) && sheets.every((s) => s.querySelector('canvas'));
  }, pages);
}

/** ページ n の紙が、turn だけ回って出るまで待つ（五線が、回した先にあり、その反対の側には無い） */
function waitTurned(page, n, turn) {
  const here = turnedRect(STAFF, turn);
  const there = turnedRect(STAFF, (turn + 180) % 360);
  return page.waitForFunction(([num, a, b]) => {
    const canvas = document.querySelector(`#stage .sheet[data-page="${num}"] canvas:not(.ink)`);
    if (!canvas || !canvas.width) return false;
    const ctx = canvas.getContext('2d');
    const dark = (rect) => {
      const x = Math.floor(rect.l * canvas.width);
      const y = Math.floor(rect.t * canvas.height);
      const w = Math.max(1, Math.floor((rect.r - rect.l) * canvas.width));
      const h = Math.max(1, Math.floor((rect.b - rect.t) * canvas.height));
      const data = ctx.getImageData(x, y, w, h).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && data[i] < 160) count += 1;
      return count;
    };
    return dark(a) > 500 && dark(b) < 20;
  }, [n, here, there]);
}

function waitRatio(page, ratio, slack = 0.02) {
  return page.waitForFunction(([want, by]) => {
    const r = document.querySelector('#stage .sheet')?.getBoundingClientRect();
    return r && r.height > 0 && Math.abs(r.width / r.height - want) < by;
  }, [ratio, slack]);
}

/** ページ n に重ねた書き込みの絵：色の付いた点の数と、まんなかの位置（紙の中の割合） */
function inkStats(page, n) {
  return page.evaluate((num) => {
    const canvas = document.querySelector(`#stage .sheet[data-page="${num}"] canvas.ink`);
    if (!canvas) return null;
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let all = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] < 40) continue;
        all += 1;
        sx += x;
        sy += y;
      }
    }
    return { all, cx: all ? sx / all / width : null, cy: all ? sy / all / height : null };
  }, n);
}

function waitInk(page, n, min = 1) {
  return page.waitForFunction(([num, least]) => {
    const canvas = document.querySelector(`#stage .sheet[data-page="${num}"] canvas.ink`);
    if (!canvas) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] >= 40) count += 1;
    return count >= least;
  }, [n, min]);
}

/** 画面の並び直しが終わるまで待つ（紙のキャンバスには、書き込み用のキャンバスが重なる） */
function settle(page) {
  return page.waitForFunction(() => {
    const stage = document.getElementById('stage');
    if (stage.dataset.drawn !== `${stage.clientWidth}x${stage.clientHeight}`) return false;
    return [...stage.querySelectorAll('.sheet')].every((s) => !s.querySelector('canvas:not(.ink)') || s.querySelector('canvas.ink'));
  });
}

/** ページ n の紙の上に、画面に出ている紙の中の割合で線を引く（[[fx, fy], …]） */
async function draw(page, n, points) {
  await page.waitForTimeout(200); // 並び直しは、大きさが変わってから 0.12 秒後に始まる
  await settle(page);
  const box = await page.locator(`#stage .sheet[data-page="${n}"]`).boundingBox();
  const at = ([fx, fy]) => [box.x + box.width * fx, box.y + box.height * fy];
  const [x0, y0] = at(points[0]);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    const [x, y] = at(point);
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
}

function turnOf(page) {
  return page.evaluate(() => window.__pdf.state.turn);
}

async function openPdf({ files = [FIVE], context = null, first = [1] } = {}) {
  const page = context ? await context.newPage() : await browser.newPage({ viewport: { width: 820, height: 1180 } });
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
  }
  return { page, errors };
}

test('右に回す：楽譜を開くまでは押せない。押すたびに 90 度ずつ回り、4回で元に戻る', async () => {
  const { page, errors } = await openPdf({ files: null });
  assert.ok(await page.isDisabled('#turn'));
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1]);
  assert.ok(await page.isEnabled('#turn'));
  await waitRatio(page, TALL);
  await waitTurned(page, 1, 0);

  await page.click('#turn');
  await waitRatio(page, WIDE);
  await waitTurned(page, 1, 90);
  assert.equal(await turnOf(page), 90);
  // 回した紙は、画面の幅に収まる
  const box = await page.locator('#stage .sheet').boundingBox();
  assert.ok(box.width <= 820 && box.x >= 0, JSON.stringify(box));
  // ほかのページも回っている。めくれる
  await page.click('#next');
  await waitShown(page, [2]);
  await waitTurned(page, 2, 90);
  await page.click('#prev');
  await waitShown(page, [1]);

  await page.click('#turn');
  await waitRatio(page, TALL);
  await waitTurned(page, 1, 180);
  await page.click('#turn');
  await waitRatio(page, WIDE);
  await waitTurned(page, 1, 270);

  // 縦スクロールでも、回したまま出る
  await page.selectOption('#mode', 'scroll');
  await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
  await waitRatio(page, WIDE, 0.03);
  await waitTurned(page, 1, 270);
  await page.selectOption('#mode', 'auto');
  await waitShown(page, [1]);

  await page.click('#turn');
  await waitRatio(page, TALL);
  await waitTurned(page, 1, 0);
  assert.equal(await turnOf(page), 0);
  // 押した後は、ボタンから離れる（ペダルのスペースで、もう一度回ってしまわないように）
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'turn');
  await page.keyboard.press('Space');
  await waitShown(page, [2]);
  assert.equal(await turnOf(page), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('右に回す：向きは PDF ごとに覚える。開き直しても残り、ほかの PDF は回らない', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    await page.click('#next');
    await waitShown(page, [2]);
    await page.click('#turn');
    await waitTurned(page, 2, 90);
    await page.waitForTimeout(600);
    await page.reload();
    await waitShown(page, [2]);
    await waitRatio(page, WIDE);
    await waitTurned(page, 2, 90);
    assert.equal(await turnOf(page), 90);

    await page.setInputFiles('#file', [BOOK]);
    await page.waitForFunction(() => document.getElementById('title').textContent === 'book');
    await waitShown(page, [1]);
    await waitRatio(page, TALL);
    await waitTurned(page, 1, 0);
    assert.equal(await turnOf(page), 0);

    // 同じ PDF を選び直しても、回したまま
    await page.setInputFiles('#file', [FIVE]);
    await page.waitForFunction(() => document.getElementById('title').textContent === 'five-pages');
    await waitTurned(page, 2, 90);
    assert.equal(await turnOf(page), 90);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('右に回す：書き込みは、紙といっしょに回る。回したまま書く・消す・余白カットでも、紙の同じ所', async () => {
  const { page, errors } = await openPdf();
  await page.click('#ink');
  // 枠の線（紙の左上から 20%・14% の所）のすぐ内側に、短い線を引く
  await draw(page, 1, [[0.25, 0.2], [0.3, 0.2]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 1);
  const saved = await page.evaluate(() => JSON.stringify(window.__pdf.state.notes.ink[1]));

  // 右へ回すと、紙の左上は 右上に来る。線も、枠の角のすぐ内側のまま付いてくる
  await page.click('#turn');
  await waitRatio(page, WIDE);
  await waitTurned(page, 1, 90);
  await waitInk(page, 1, 20);
  const side = await inkStats(page, 1);
  assert.ok(Math.abs(side.cx - 0.8) < 0.02 && Math.abs(side.cy - 0.275) < 0.03, `回した後の位置（${JSON.stringify(side)}）`);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__pdf.state.notes.ink[1])), saved, '覚えてある線は、書き換えない');

  // 余白カット：回した紙は 13%〜87%・18%〜82% のあたりで切れる。線は、右上へ寄る
  await page.click('#ink');
  await page.check('#crop');
  await waitRatio(page, 602 / 355, 0.12);
  await waitInk(page, 1, 20);
  const cut = await inkStats(page, 1);
  assert.ok(cut.cx > 0.86 && cut.cx < 0.95 && cut.cy > 0.1 && cut.cy < 0.2, `切った後の位置（${JSON.stringify(cut)}）`);
  await page.uncheck('#crop');
  await waitRatio(page, WIDE);
  await waitInk(page, 1, 20);

  // 回したまま、消しゴムで消せる（画面に見えている所をなぞる）。元に戻せる
  await page.click('#ink');
  await page.click('.ink-tool[data-tool="eraser"]');
  await draw(page, 1, [[0.8, 0.2], [0.8, 0.35]]);
  await page.waitForFunction(() => (window.__pdf.state.notes.ink[1] ?? []).length === 0);
  await page.click('#ink-undo');
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 1);
  // 線から離れた所をなぞっても、消えない
  await draw(page, 1, [[0.2, 0.2], [0.2, 0.35]]);
  assert.equal(await page.evaluate(() => window.__pdf.state.notes.ink[1].length), 1);

  // 回したまま書いた線は、もとの紙の位置で覚える（画面で右へ引くと、もとの紙では上へ）
  await page.click('.ink-tool[data-tool="black"]');
  await draw(page, 1, [[0.5, 0.5], [0.6, 0.5]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 2);
  const p = await page.evaluate(() => window.__pdf.state.notes.ink[1][1].p);
  const near = (a, b) => Math.abs(a - b) < 0.02;
  assert.ok(near(p[0], 0.5) && near(p[1], 0.5), `始め（${p.slice(0, 2)}）`);
  assert.ok(near(p.at(-2), 0.5) && near(p.at(-1), 0.4), `終わり（${p.slice(-2)}）`);

  // 元の向きに戻すと、はじめの線は、はじめの所に出る
  await page.click('#ink-undo');
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 1);
  for (const turn of [180, 270, 0]) {
    await page.click('#turn');
    await waitTurned(page, 1, turn);
  }
  await waitRatio(page, TALL);
  await waitInk(page, 1, 20);
  const back = await inkStats(page, 1);
  assert.ok(Math.abs(back.cx - 0.275) < 0.02 && Math.abs(back.cy - 0.2) < 0.02, `戻した後の位置（${JSON.stringify(back)}）`);
  assert.deepEqual(errors, []);
  await page.close();
});

test('右に回す：PDF に向きが書いてあるもの（スキャンに多い）は、その向きで出て、そこから回る', async () => {
  const { page, errors } = await openPdf({ files: [SIDEWAYS] });
  await waitRatio(page, WIDE);
  await waitTurned(page, 1, 90);
  assert.equal(await turnOf(page), 0);
  await page.click('#turn');
  await waitRatio(page, TALL);
  await waitTurned(page, 1, 180);
  assert.equal(await turnOf(page), 90);
  assert.deepEqual(errors, []);
  await page.close();
});

/** ページ n の紙の 幅 ÷ 高さ が want になるまで待つ */
function waitSheetRatio(page, n, ratio, slack = 0.03) {
  return page.waitForFunction(([num, want, by]) => {
    const r = document.querySelector(`#stage .sheet[data-page="${num}"]`)?.getBoundingClientRect();
    return r && r.height > 0 && Math.abs(r.width / r.height - want) < by;
  }, [n, ratio, slack]);
}

function turnsOf(page) {
  return page.evaluate(() => JSON.stringify(window.__pdf.state.turns));
}

test('このページだけ回す：そのページだけが回り、ほかは回らない。PDF ごとに覚え、「右に回す」と重なる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    assert.ok(await page.isEnabled('#turn-page'));
    await page.click('#next');
    await waitShown(page, [2]);
    await page.click('#turn-page');
    await waitRatio(page, WIDE);
    await waitTurned(page, 2, 90);
    assert.equal(await turnsOf(page), '{"2":90}');
    assert.equal(await turnOf(page), 0);
    assert.match(await page.textContent('#status'), /2 ページだけ/);
    // 押した後は、ボタンから離れる（ペダルのスペースで、もう一度回ってしまわないように）
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'turn-page');
    // となりのページは、もとの向きのまま
    await page.click('#next');
    await waitShown(page, [3]);
    await waitRatio(page, TALL);
    await waitTurned(page, 3, 0);
    await page.click('#prev');
    await waitShown(page, [2]);
    await waitTurned(page, 2, 90);

    // 開き直しても残る
    await page.waitForTimeout(600);
    await page.reload();
    await waitShown(page, [2]);
    await waitTurned(page, 2, 90);
    assert.equal(await turnsOf(page), '{"2":90}');

    // 「右に回す」は全部のページを回し、このページの分は、その上に足す
    await page.click('#turn');
    await waitRatio(page, TALL);
    await waitTurned(page, 2, 180);
    await page.click('#prev');
    await waitShown(page, [1]);
    await waitTurned(page, 1, 90);

    // 縦スクロールでも、ページごとの向きで出る
    await page.selectOption('#mode', 'scroll');
    await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
    await waitSheetRatio(page, 1, WIDE);
    await waitSheetRatio(page, 2, TALL);
    await page.selectOption('#mode', 'auto');
    await waitShown(page, [1]);
    await page.click('#turn');
    await page.click('#turn');
    await page.click('#turn');
    await waitTurned(page, 1, 0);

    // 3回押すと（4回で1周）、ほかのページと同じ向きに戻り、覚えからも消える
    await page.click('#next');
    await waitShown(page, [2]);
    await waitTurned(page, 2, 90);
    for (const turn of [180, 270, 0]) {
      await page.click('#turn-page');
      await waitTurned(page, 2, turn);
    }
    assert.equal(await turnsOf(page), '{}');
    assert.match(await page.textContent('#status'), /同じに戻しました/);

    // ほかの PDF は回らない
    await page.click('#turn-page');
    await waitTurned(page, 2, 90);
    await page.setInputFiles('#file', [BOOK]);
    await page.waitForFunction(() => document.getElementById('title').textContent === 'book');
    await waitShown(page, [1]);
    assert.equal(await turnsOf(page), '{}');
    await page.click('#next');
    await waitShown(page, [2]);
    await waitTurned(page, 2, 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('このページだけ回す：書き込みは、そのページの紙といっしょに回る', async () => {
  const { page, errors } = await openPdf();
  await page.click('#next');
  await waitShown(page, [2]);
  await page.click('#turn-page');
  await waitRatio(page, WIDE);
  await waitTurned(page, 2, 90);
  // 回した紙の右上（もとの紙の左上）に書く
  await page.click('#ink');
  await draw(page, 2, [[0.78, 0.25], [0.78, 0.3]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[2]?.length === 1);
  const p = await page.evaluate(() => window.__pdf.state.notes.ink[2][0].p);
  assert.ok(p[0] < 0.35 && p[1] < 0.3, `もとの紙の左上で覚える（${p.slice(0, 2)}）`);
  await page.click('#ink');
  // 元の向きに戻すと、線は もとの紙の左上に出る
  for (const turn of [180, 270, 0]) {
    await page.click('#turn-page');
    await waitTurned(page, 2, turn);
  }
  await waitRatio(page, TALL);
  await waitInk(page, 2, 10);
  const back = await inkStats(page, 2);
  assert.ok(back.cx < 0.35 && back.cy < 0.3, `戻した後の位置（${JSON.stringify(back)}）`);
  assert.deepEqual(errors, []);
  await page.close();
});
