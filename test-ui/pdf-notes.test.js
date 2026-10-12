// PDF の楽譜のページ：しおり・書き込み・メトロノームの、画面のテスト（Playwright の Chromium）。npm run test:ui
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
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});

after(async () => {
  await browser?.close();
  server?.close();
});

const FIVE = { name: 'five-pages.pdf', mimeType: 'application/pdf', buffer: makePdf(5) };
const BOOK = { name: 'book.pdf', mimeType: 'application/pdf', buffer: makePdf(4, { outline: [['Intro', 1], ['Song Two', 3]] }) };

function waitShown(page, pages) {
  return page.waitForFunction((want) => {
    const sheets = [...document.querySelectorAll('#stage .layer .sheet')];
    return JSON.stringify(sheets.map((s) => Number(s.dataset.page))) === JSON.stringify(want) && sheets.every((s) => s.querySelector('canvas'));
  }, pages);
}

/** ページ n に重ねた書き込みの絵：色の付いた点の数・赤い点の数・黄色い点の数・まんなかの位置（紙の中の割合） */
function inkStats(page, n) {
  return page.evaluate((num) => {
    const canvas = document.querySelector(`#stage .sheet[data-page="${num}"] canvas.ink`);
    if (!canvas) return null;
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let all = 0;
    let red = 0;
    let yellow = 0;
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 40) continue;
        all += 1;
        sx += x;
        sy += y;
        if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 90) red += 1;
        if (data[i] > 200 && data[i + 1] > 160 && data[i + 2] < 90) yellow += 1;
      }
    }
    return { all, red, yellow, cx: all ? sx / all / width : null, cy: all ? sy / all / height : null };
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

function strokeCount(page, n) {
  return page.evaluate((num) => (window.__pdf.state.notes.ink[num] ?? []).length, n);
}

/** 画面の並び直しが終わるまで待つ（操作の欄の高さが変わると、楽譜を描き直す。紙のキャンバスには、書き込み用のキャンバスが重なる） */
function settle(page) {
  return page.waitForFunction(() => {
    const stage = document.getElementById('stage');
    if (stage.dataset.drawn !== `${stage.clientWidth}x${stage.clientHeight}`) return false;
    return [...stage.querySelectorAll('.sheet')].every((s) => !s.querySelector('canvas:not(.ink)') || s.querySelector('canvas.ink'));
  });
}

/** ページ n の紙の上に、紙の中の割合で線を引く（[[fx, fy], …]） */
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

// ---------------------------------------------------------------- しおり

test('しおり：楽譜を開くまでは押せない。開くと押せる', async () => {
  const { page } = await openPdf({ files: null });
  assert.ok(await page.isDisabled('#marks-open'));
  assert.ok(await page.isDisabled('#ink'));
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1]);
  assert.ok(await page.isEnabled('#marks-open'));
  assert.ok(await page.isEnabled('#ink'));
  await page.close();
});

test('しおり：いまのページに名前を付け、押すとそのページへ飛ぶ。開き直しても残り、消せる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitShown(page, [3]);
    await page.click('#marks-open');
    assert.equal(await page.textContent('#mark-add'), 'いまのページ（3）に付ける');
    assert.match(await page.textContent('#marks-list'), /まだありません/);
    await page.fill('#mark-name', 'サビ');
    await page.click('#mark-add');
    await page.waitForFunction(() => document.querySelectorAll('#marks-list .shelf-item').length === 1);
    assert.equal(await page.inputValue('#mark-name'), '');
    // 開いている間は、キーでめくれない
    await page.locator('#mark-name').blur();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    assert.equal(await page.textContent('#position'), '3 / 5');
    await page.click('#marks-close');
    assert.ok(await page.isHidden('#marks'));

    // 名前を入れずに付けると「◯ ページ目」。Enter でも付く
    await page.keyboard.press('Home');
    await waitShown(page, [1]);
    await page.click('#marks-open');
    await page.locator('#mark-name').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#marks-list .shelf-item').length === 2);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#marks-list .shelf-item')].map((b) => `${b.querySelector('.name').textContent}｜${b.querySelector('.sub').textContent}`));
    assert.deepEqual(rows, ['1 ページ目｜1 ページ目', 'サビ｜3 ページ目']);

    // 押すと飛ぶ
    await page.click('#marks-list .shelf-item >> nth=1');
    await waitShown(page, [3]);
    assert.ok(await page.isHidden('#marks'));

    // 開き直しても残る
    await page.waitForTimeout(900);
    await page.reload();
    await waitShown(page, [3]);
    await page.click('#marks-open');
    await page.waitForFunction(() => document.querySelectorAll('#marks-list .shelf-item').length === 2);

    // 消す
    await page.click('#marks-list .shelf-del >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('#marks-list .shelf-item').length === 1);
    assert.match(await page.textContent('#marks-list .shelf-item'), /サビ/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('しおり：PDF に目次が入っていれば、それも並び、押すとそのページへ飛ぶ', async () => {
  const { page, errors } = await openPdf({ files: [BOOK] });
  await page.click('#marks-open');
  await page.waitForFunction(() => document.querySelectorAll('#outline-list .shelf-item').length === 2);
  assert.ok(await page.isVisible('#outline-title'));
  const rows = await page.evaluate(() => [...document.querySelectorAll('#outline-list .shelf-item')].map((b) => `${b.querySelector('.name').textContent}｜${b.querySelector('.sub').textContent}`));
  assert.deepEqual(rows, ['Intro｜1 ページ目', 'Song Two｜3 ページ目']);
  await page.click('#outline-list .shelf-item >> nth=1');
  await waitShown(page, [3]);
  // 目次の無い PDF では、目次の見出しを出さない
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1]);
  await page.click('#marks-open');
  await page.waitForTimeout(400);
  assert.ok(await page.isHidden('#outline-title'));
  assert.equal(await page.locator('#outline-list .shelf-item').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------------------------------------------------------------- 書き込み

test('書き込み：ペンで線が引ける。書き込み中はタップでめくらず、「次へ」でめくる。戻ると線が出る', async () => {
  const { page, errors } = await openPdf();
  assert.ok(await page.isHidden('#ink-row'));
  await page.click('#ink');
  assert.ok(await page.isVisible('#ink-row'));
  assert.equal(await page.textContent('#ink'), '書き込みを終える');
  assert.ok(await page.isDisabled('#hide'), '書き込み中は、操作の欄をかくせない');
  assert.equal(await page.evaluate(() => document.getElementById('stage').style.touchAction), 'none');

  await draw(page, 1, [[0.3, 0.3], [0.6, 0.35]]);
  await waitInk(page, 1, 50);
  assert.equal(await strokeCount(page, 1), 1);
  const black = await inkStats(page, 1);
  assert.equal(black.red, 0);
  assert.ok(Math.abs(black.cx - 0.45) < 0.03 && Math.abs(black.cy - 0.325) < 0.03, `線は、引いた所に出る（${JSON.stringify(black)}）`);

  // 右の端をタップしても、めくらない（点が1つ付く）
  await settle(page);
  let box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);
  await page.waitForTimeout(200);
  assert.equal(await page.textContent('#position'), '1 / 5');
  assert.equal(await strokeCount(page, 1), 2);

  // 赤・蛍光ペン
  await page.click('.ink-tool[data-tool="red"]');
  await draw(page, 1, [[0.3, 0.5], [0.6, 0.5]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 3);
  await page.click('.ink-tool[data-tool="marker"]');
  await draw(page, 1, [[0.3, 0.7], [0.6, 0.7]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 4);
  const colors = await inkStats(page, 1);
  assert.ok(colors.red > 50, `赤い線（${JSON.stringify(colors)}）`);
  assert.ok(colors.yellow > 200, `蛍光ペン（${JSON.stringify(colors)}）`);

  // 「次へ」でめくる。次のページには、書き込みが無い
  await page.click('#next');
  await waitShown(page, [2]);
  await page.waitForSelector('#stage .sheet[data-page="2"] canvas.ink', { state: 'attached' });
  assert.equal((await inkStats(page, 2)).all, 0);
  await page.click('#prev');
  await waitShown(page, [1]);
  await waitInk(page, 1, 300);

  // 書き込みを終えると、タップでめくれる
  await page.click('#ink');
  assert.ok(await page.isHidden('#ink-row'));
  await page.waitForTimeout(200);
  await settle(page);
  box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await waitShown(page, [2]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('書き込み：元に戻す・消しゴム・このページを消す', async () => {
  const { page, errors } = await openPdf();
  await page.click('#ink');
  assert.ok(await page.isDisabled('#ink-undo'));
  await draw(page, 1, [[0.3, 0.3], [0.6, 0.3]]);
  await draw(page, 1, [[0.3, 0.6], [0.6, 0.6]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 2);
  assert.ok(await page.isEnabled('#ink-undo'));

  // 元に戻す：最後の線が消える
  await page.click('#ink-undo');
  assert.equal(await strokeCount(page, 1), 1);
  const one = await inkStats(page, 1);
  assert.ok(Math.abs(one.cy - 0.3) < 0.03, `残るのは上の線（${JSON.stringify(one)}）`);

  // 消しゴム：線を横切ると、その線が消える。元に戻すと、戻る
  await page.click('.ink-tool[data-tool="eraser"]');
  await draw(page, 1, [[0.45, 0.2], [0.45, 0.4]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 0);
  assert.equal((await inkStats(page, 1)).all, 0);
  await page.click('#ink-undo');
  assert.equal(await strokeCount(page, 1), 1);
  await waitInk(page, 1, 50);
  // 線の無い所をこすっても、何も消えない
  await draw(page, 1, [[0.2, 0.8], [0.7, 0.8]]);
  assert.equal(await strokeCount(page, 1), 1);

  // このページを消す → 元に戻す
  await page.click('.ink-tool[data-tool="blue"]');
  await draw(page, 1, [[0.3, 0.5], [0.5, 0.55]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 2);
  await page.click('#ink-clear');
  assert.equal(await strokeCount(page, 1), 0);
  assert.equal((await inkStats(page, 1)).all, 0);
  await page.click('#ink-undo');
  assert.equal(await strokeCount(page, 1), 2);
  await waitInk(page, 1, 100);
  assert.deepEqual(errors, []);
  await page.close();
});

test('書き込み：開き直しても残る。選んだ道具も覚える', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context });
    await page.click('#ink');
    await page.click('.ink-tool[data-tool="red"]');
    await draw(page, 1, [[0.3, 0.3], [0.6, 0.4]]);
    await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 1);
    await page.waitForTimeout(900);
    await page.reload();
    await waitShown(page, [1]);
    await waitInk(page, 1, 50);
    assert.ok((await inkStats(page, 1)).red > 50);
    assert.ok(await page.isHidden('#ink-row'), '開き直した直後は、書き込み中ではない');
    await page.click('#ink');
    assert.equal(await page.getAttribute('.ink-tool[data-tool="red"]', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('.ink-tool[data-tool="black"]', 'aria-pressed'), 'false');

    // 別の PDF を開くと、前の PDF の書き込みは出ない。戻ると出る
    await page.click('#ink');
    await page.setInputFiles('#file', [BOOK]);
    await page.waitForFunction(() => document.getElementById('title').textContent === 'book');
    await waitShown(page, [1]);
    await page.waitForSelector('#stage .sheet[data-page="1"] canvas.ink', { state: 'attached' });
    assert.equal((await inkStats(page, 1)).all, 0);
    await page.setInputFiles('#file', [FIVE]);
    await page.waitForFunction(() => document.getElementById('title').textContent === 'five-pages');
    await waitInk(page, 1, 50);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('書き込み：余白カットや縦スクロールに変えても、紙の同じ所に出る', async () => {
  const { page, errors } = await openPdf();
  await page.click('#ink');
  // 枠の線（紙の左上から 20%・14% の所）のすぐ内側に、短い線を引く
  await draw(page, 1, [[0.25, 0.2], [0.3, 0.2]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 1);
  const plain = await inkStats(page, 1);
  assert.ok(Math.abs(plain.cx - 0.275) < 0.02 && Math.abs(plain.cy - 0.2) < 0.02, JSON.stringify(plain));
  await page.click('#ink');

  // 余白カット：紙は 18%〜82%・13%〜87% のあたりで切れる。線は、枠の線のすぐ内側のまま（左上へ寄る）
  await page.check('#crop');
  await page.waitForFunction(() => {
    const r = document.querySelector('#stage .sheet')?.getBoundingClientRect();
    return r && Math.abs(r.width / r.height - 355 / 602) < 0.04;
  });
  await waitInk(page, 1, 20);
  const cut = await inkStats(page, 1);
  assert.ok(cut.cx > 0.1 && cut.cx < 0.2 && cut.cy > 0.05 && cut.cy < 0.14, `切った後の位置（${JSON.stringify(cut)}）`);

  // 切ったまま書いた線も、切らない表示に戻すと、紙の同じ所に出る
  await page.click('#ink');
  await draw(page, 1, [[0.5, 0.5], [0.55, 0.5]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 2);
  const second = await page.evaluate(() => window.__pdf.state.notes.ink[1][1].p.slice(0, 2));
  assert.ok(Math.abs(second[0] - 0.5) < 0.02 && Math.abs(second[1] - 0.5) < 0.02, `紙の真ん中（${JSON.stringify(second)}）`);
  await page.click('#ink');
  await page.uncheck('#crop');
  await page.waitForFunction(() => {
    const r = document.querySelector('#stage .sheet')?.getBoundingClientRect();
    return r && Math.abs(r.width / r.height - 595 / 842) < 0.01;
  });
  await waitInk(page, 1, 40);

  // 縦スクロールでも出る。書き込み中に、縦スクロールの紙にも書ける
  await page.selectOption('#mode', 'scroll');
  await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
  await waitInk(page, 1, 40);
  await page.click('#ink');
  await draw(page, 1, [[0.3, 0.6], [0.6, 0.6]]);
  await page.waitForFunction(() => window.__pdf.state.notes.ink[1].length === 3);
  assert.deepEqual(errors, []);
  await page.close();
});

test('書き込み：見開きでは、書いた側のページに入る', async () => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1, 2]);
  await page.click('#ink');
  await draw(page, 2, [[0.3, 0.3], [0.6, 0.3]]);
  await page.waitForFunction(() => (window.__pdf.state.notes.ink[2] ?? []).length === 1);
  assert.equal(await strokeCount(page, 1), 0);
  assert.equal((await inkStats(page, 1)).all, 0);
  assert.ok((await inkStats(page, 2)).all > 50);
  await page.close();
});

// ---------------------------------------------------------------- メトロノーム

test('メトロノーム：押すと鳴り始め、拍の印が光る。速さと拍子を変えられ、もう一度押すと止まる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf({ context, files: null });
    assert.equal(await page.inputValue('#bpm'), '100');
    await page.click('#bpm-up');
    assert.equal(await page.inputValue('#bpm'), '104');
    await page.click('#bpm-down');
    await page.click('#bpm-down');
    assert.equal(await page.inputValue('#bpm'), '96');
    await page.fill('#bpm', '999');
    await page.locator('#bpm').dispatchEvent('change');
    assert.equal(await page.inputValue('#bpm'), '240');
    await page.fill('#bpm', '5');
    await page.locator('#bpm').dispatchEvent('change');
    assert.equal(await page.inputValue('#bpm'), '40');
    await page.fill('#bpm', '200');
    await page.locator('#bpm').dispatchEvent('change');
    await page.selectOption('#beats', '3');

    await page.click('#metro');
    assert.equal(await page.getAttribute('#metro', 'aria-pressed'), 'true');
    assert.equal(await page.textContent('#metro'), 'メトロノームを止める');
    await page.waitForFunction(() => window.__pdf.metronome.count >= 4);
    await page.waitForFunction(() => document.getElementById('beat-dot').classList.contains('on'));
    await page.waitForFunction(() => document.getElementById('beat-dot').classList.contains('first'));
    // 鳴らしたままでも、楽譜を開いてめくれる
    await page.setInputFiles('#file', [FIVE]);
    await waitShown(page, [1]);
    await page.keyboard.press('ArrowRight');
    await waitShown(page, [2]);
    assert.equal(await page.getAttribute('#metro', 'aria-pressed'), 'true');

    await page.click('#metro');
    assert.equal(await page.getAttribute('#metro', 'aria-pressed'), 'false');
    assert.equal(await page.textContent('#metro'), 'メトロノーム');
    const stopped = await page.evaluate(() => window.__pdf.metronome.count);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.__pdf.metronome.count), stopped, '止めた後は、拍が進まない');

    // 速さと拍子は、開き直しても残る
    await page.reload();
    await page.waitForFunction(() => window.__pdf);
    assert.equal(await page.inputValue('#bpm'), '200');
    assert.equal(await page.inputValue('#beats'), '3');
    assert.equal(await page.getAttribute('#metro', 'aria-pressed'), 'false');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('せまい画面（幅 375）：はじめは たたんであり、楽譜が1ページで出る。道具の行が横にはみ出さない', async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 760 } });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  await page.setInputFiles('#file', [FIVE]);
  await waitShown(page, [1]);
  // はじめは たたんである（めくる行だけ）。楽譜の場所が、画面の半分より広い
  assert.equal(await page.textContent('#fold'), 'ひらく');
  assert.ok(await page.isHidden('#tools-row'));
  const stage = await page.locator('#stage').boundingBox();
  assert.ok(stage.height > 760 * 0.6, `楽譜の場所の高さ ${stage.height}`);
  // ひらいても、操作の欄は画面の6割まで。楽譜は1ページのまま（縦長の画面）
  await page.click('#fold');
  assert.ok(await page.isVisible('#tools-row'));
  const bar = await page.locator('#toolbar').boundingBox();
  assert.ok(bar.height <= 760 * 0.6 + 1, `操作の欄の高さ ${bar.height}`);
  await page.waitForTimeout(300);
  await waitShown(page, [1]);
  await page.click('#ink');
  assert.ok(await page.isVisible('#ink-row'));
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  // たたんでも、書き込みの道具は出たまま
  await page.click('#fold');
  assert.ok(await page.isHidden('#tools-row'));
  assert.ok(await page.isVisible('#ink-row'));
  await page.click('#fold');
  await page.click('#marks-open');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);
  await page.close();
});
