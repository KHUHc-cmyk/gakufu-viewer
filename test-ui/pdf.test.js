// PDF の楽譜のページ（pdf.html）の、画面のテスト（Playwright の Chromium）。npm run test:ui
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { root, readText } from '../test/helpers.js';
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

// 試験用の PDF（5ページ・3ページ）。紙は A4 の縦、中身は枠の線と大きなページ番号
const FIVE = { name: 'five-pages.pdf', mimeType: 'application/pdf', buffer: makePdf(5) };
const THREE = { name: 'three-pages.pdf', mimeType: 'application/pdf', buffer: makePdf(3) };

/** いま画面に出ているページの番号（1ページ・見開き・半ページめくり） */
function shown(page) {
  return page.evaluate(() => [...document.querySelectorAll('#stage .layer .sheet')].map((s) => Number(s.dataset.page)));
}

function waitShown(page, pages) {
  return page.waitForFunction((want) => {
    const now = [...document.querySelectorAll('#stage .layer .sheet')].map((s) => Number(s.dataset.page));
    return JSON.stringify(now) === JSON.stringify(want) && [...document.querySelectorAll('#stage .layer .sheet')].every((s) => s.querySelector('canvas'));
  }, pages);
}

function waitPosition(page, text) {
  return page.waitForFunction((want) => document.getElementById('position').textContent === want, text);
}

/** ページ n のキャンバスの、暗い点の数（全体と、真ん中の4分の1） */
function ink(page, n) {
  return page.evaluate((num) => {
    const canvas = document.querySelector(`#stage .sheet[data-page="${num}"] canvas`);
    if (!canvas || !canvas.width) return null;
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let all = 0;
    let middle = 0;
    let left = width;
    let top = height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4] > 128) continue;
        all += 1;
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > width * 0.375 && x < width * 0.625 && y > height * 0.375 && y < height * 0.625) middle += 1;
      }
    }
    return { all, middle, left: left / width, top: top / height, width, height };
  }, n);
}

/** 縦スクロールの動きが止まるまで待つ（0.3 秒、位置が変わらなければ止まったとみなす） */
async function waitScrollEnd(page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const top = await page.evaluate(() => document.getElementById('stage').scrollTop);
    if (top === last) return;
    last = top;
    await page.waitForTimeout(300);
  }
}

function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** ページが、表示の場所からはみ出していないか */
function sheetsInside(page) {
  return page.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    return [...document.querySelectorAll('#stage .layer .sheet')].every((s) => {
      const r = s.getBoundingClientRect();
      return r.width > 50 && r.left >= stage.left - 1 && r.right <= stage.right + 1 && r.top >= stage.top - 1 && r.bottom <= stage.bottom + 1;
    });
  });
}

async function clickStage(page, at) {
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.click(box.x + box.width * at, box.y + box.height / 2);
}

/** pdf.html を開く。files があれば、それを選んで、1ページ目（first）が出るまで待つ */
async function openPdf(width, height, { files = [FIVE], colorScheme = 'light', first = [1], context = null } = {}) {
  const page = context ? await context.newPage() : await browser.newPage({ viewport: { width, height }, colorScheme });
  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('Warning:')) warnings.push(m.text());
  });
  // 外へ出る通信が無いことを確かめる
  const outside = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['blob:', 'data:'].includes(u.protocol)) outside.push(r.url());
  });
  await page.goto(`${baseUrl}pdf.html`);
  await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
  if (files && files.length) {
    await page.setInputFiles('#file', files);
    await waitShown(page, first);
  }
  return { page, errors, warnings, outside };
}

for (const colorScheme of ['light', 'dark']) {
  test(`はじめ（${colorScheme}）：何も開かず、案内が出る。題名は「楽譜ビューア(PDF)」`, async () => {
    const { page, errors, warnings, outside } = await openPdf(820, 1180, { files: null, colorScheme });
    assert.equal(await page.title(), '楽譜ビューア(PDF)');
    assert.match(await page.textContent('#empty'), /「ファイルを選ぶ」で、PDF の楽譜を開いてください/);
    assert.ok(await page.isVisible('#empty'));
    assert.ok(await page.isDisabled('#prev'));
    assert.ok(await page.isDisabled('#next'));
    assert.ok(await page.isDisabled('#seek'));
    assert.ok(await page.isHidden('#auto-row'));
    assert.ok((await overflow(page)) <= 0, '横にはみ出さない');
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(outside, []);
    await page.close();
  });
}

test('開く：1ページ目が画面に収まって出る。線も字も描ける。外へは何も送らない', async () => {
  const { page, errors, warnings, outside } = await openPdf(820, 1180);
  assert.equal(await page.textContent('#position'), '1 / 5');
  assert.equal(await page.textContent('#title'), 'five-pages');
  assert.ok(await page.isHidden('#empty'));
  assert.ok(await sheetsInside(page));
  assert.ok((await overflow(page)) <= 0, '横にはみ出さない');
  const first = await ink(page, 1);
  assert.ok(first.all > 500, `線が描けている（${JSON.stringify(first)}）`);
  assert.ok(first.middle > 100, `ページ番号の字が描けている（${JSON.stringify(first)}）`);
  // 紙の縦横比（A4 の縦）のまま
  const ratio = await page.evaluate(() => {
    const r = document.querySelector('#stage .sheet').getBoundingClientRect();
    return r.width / r.height;
  });
  assert.ok(Math.abs(ratio - 595 / 842) < 0.01, `縦横比 ${ratio}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(outside, []);
  await page.close();
});

test('めくる：ボタン・キーボード（ペダル）・タップ・スライダー。端では止まる', async () => {
  const { page, errors } = await openPdf(820, 1180);
  assert.ok(await page.isDisabled('#prev'));
  await page.click('#next');
  await waitShown(page, [2]);
  assert.equal(await page.textContent('#position'), '2 / 5');
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [3]);
  await page.keyboard.press('PageDown');
  await waitShown(page, [4]);
  await page.keyboard.press('ArrowLeft');
  await waitShown(page, [3]);
  await page.keyboard.press('Space');
  await waitShown(page, [4]);
  await page.keyboard.press('PageUp');
  await waitShown(page, [3]);
  // タップ：右＝次・左＝前
  await clickStage(page, 0.9);
  await waitShown(page, [4]);
  await clickStage(page, 0.1);
  await waitShown(page, [3]);
  // 端
  await page.keyboard.press('End');
  await waitShown(page, [5]);
  assert.ok(await page.isDisabled('#next'));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  assert.deepEqual(await shown(page), [5]);
  await page.keyboard.press('Home');
  await waitShown(page, [1]);
  assert.ok(await page.isDisabled('#prev'));
  // スライダー
  await page.locator('#seek').fill('4');
  await page.locator('#seek').dispatchEvent('change');
  await waitShown(page, [4]);
  assert.equal(await page.textContent('#position'), '4 / 5');
  assert.ok((await ink(page, 4)).middle > 100);
  assert.deepEqual(errors, []);
  await page.close();
});

test('はらう：左へはらうと次、右へはらうと前', async () => {
  const { page } = await openPdf(820, 1180);
  const box = await page.locator('#stage').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.6, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y + 5, { steps: 4 });
  await page.mouse.up();
  await waitShown(page, [2]);
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y + 5, { steps: 4 });
  await page.mouse.up();
  await waitShown(page, [1]);
  await page.close();
});

test('真ん中をタップ：操作の欄をかくす／出す。かくすと、楽譜が大きくなり、ページの数字が下に出る', async () => {
  const { page, errors } = await openPdf(820, 1180);
  const before = await page.evaluate(() => document.querySelector('#stage .sheet').getBoundingClientRect().height);
  assert.ok(await page.isHidden('#pager'));
  await clickStage(page, 0.5);
  await page.waitForFunction(() => document.body.classList.contains('bar-hidden'));
  assert.ok(await page.isHidden('#toolbar'));
  await page.waitForFunction((h) => document.querySelector('#stage .sheet')?.getBoundingClientRect().height > h + 20, before);
  assert.equal(await page.textContent('#pager'), '1 / 5');
  assert.ok(await page.isVisible('#pager'));
  assert.ok(await sheetsInside(page));
  // かくしたままでも、めくれる
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [2]);
  assert.equal(await page.textContent('#pager'), '2 / 5');
  await clickStage(page, 0.5);
  await page.waitForFunction(() => !document.body.classList.contains('bar-hidden'));
  assert.ok(await page.isVisible('#toolbar'));
  // 「たたむ」は、めくる行だけを残す。楽譜が大きくなる
  const open = await page.evaluate(() => document.getElementById('toolbar').getBoundingClientRect().height);
  assert.equal(await page.textContent('#fold'), 'たたむ');
  await page.click('#fold');
  assert.equal(await page.textContent('#fold'), 'ひらく');
  assert.ok(await page.isHidden('#mode'));
  assert.ok(await page.isVisible('#next'));
  assert.ok((await page.evaluate(() => document.getElementById('toolbar').getBoundingClientRect().height)) < open - 60);
  await page.click('#fold');
  assert.ok(await page.isVisible('#mode'));
  // 「かくす」ボタンでも、かくせる
  await page.click('#hide');
  assert.ok(await page.isHidden('#toolbar'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('見開き：横長の画面では（自動）2ページ並び、2ページずつめくる', async () => {
  const { page, errors } = await openPdf(1180, 820, { first: [1, 2] });
  assert.equal(await page.textContent('#position'), '1-2 / 5');
  assert.ok(await sheetsInside(page));
  const side = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll('#stage .layer .sheet')].map((s) => s.getBoundingClientRect());
    return { gap: b.left - a.right, sameTop: Math.abs(a.top - b.top) };
  });
  assert.ok(side.gap >= 0 && side.gap < 12, `左右に並ぶ（${JSON.stringify(side)}）`);
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [3, 4]);
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [5]);
  assert.equal(await page.textContent('#position'), '5 / 5');
  assert.ok(await page.isDisabled('#next'));
  await page.keyboard.press('ArrowLeft');
  await waitShown(page, [3, 4]);
  // 「1ページ」を選ぶと、横長でも1ページ
  await page.selectOption('#mode', 'single');
  await waitShown(page, [3]);
  // 縦長の画面で「見開き」を選ぶと、2ページ並ぶ
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.selectOption('#mode', 'spread');
  await waitShown(page, [3, 4]);
  assert.ok(await sheetsInside(page));
  assert.deepEqual(errors, []);
  await page.close();
});

test('画面の向きを変える：縦では1ページ、横にすると見開きになる（自動）', async () => {
  const { page } = await openPdf(820, 1180);
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [2]);
  await page.setViewportSize({ width: 1180, height: 820 });
  await waitShown(page, [1, 2]); // 2ページ目は、見開きの右に入る
  assert.ok(await sheetsInside(page));
  await page.setViewportSize({ width: 820, height: 1180 });
  await waitShown(page, [1]);
  assert.ok(await sheetsInside(page));
  await page.close();
});

test('半ページめくり：上半分に次のページが出て、もう1回で次のページになる。戻るときは同じ道を戻る', async () => {
  const { page, errors } = await openPdf(820, 1180);
  await page.check('#half');
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [1, 2]);
  assert.equal(await page.textContent('#position'), '1-2 / 5');
  const layers = await page.evaluate(() => [...document.querySelectorAll('#stage .layer')].map((l) => `${l.className}:${l.querySelector('.sheet').dataset.page}`));
  assert.deepEqual(layers, ['layer bottom:1', 'layer top:2']);
  assert.equal(await page.locator('#stage .divider').count(), 1);
  // 上の層は上半分だけ、下の層は下半分だけが見える
  const clips = await page.evaluate(() => [...document.querySelectorAll('#stage .layer')].map((l) => getComputedStyle(l).clipPath));
  assert.match(clips[0], /inset[(]50% 0(px)? 0(px)?/);
  assert.match(clips[1], /inset[(]0(px)? 0(px)? 50%/);
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [2]);
  assert.equal(await page.locator('#stage .divider').count(), 0);
  await page.keyboard.press('ArrowLeft');
  await waitShown(page, [1, 2]);
  await page.keyboard.press('ArrowLeft');
  await waitShown(page, [1]);
  // 設定を外すと、ふつうのめくりに戻る
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [1, 2]);
  await page.uncheck('#half');
  await waitShown(page, [1]);
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [2]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('余白カット：中身のある所だけを大きく出す。外すと、もとの紙の形に戻る', async () => {
  const { page, errors } = await openPdf(820, 1180);
  const plain = await ink(page, 1);
  assert.ok(plain.left > 0.15 && plain.top > 0.1, `もとは余白がある（${JSON.stringify(plain)}）`);
  await page.check('#crop');
  // 中身は、紙 595 × 842 のうち 355 × 602（余白 120）。縦横比が変わる
  await page.waitForFunction(() => {
    const r = document.querySelector('#stage .sheet')?.getBoundingClientRect();
    return r && Math.abs(r.width / r.height - 355 / 602) < 0.04 && document.querySelector('#stage .sheet canvas');
  });
  await waitShown(page, [1]);
  const cut = await ink(page, 1);
  assert.ok(cut.left < 0.06 && cut.top < 0.06, `中身が端の近くまで来る（${JSON.stringify(cut)}）`);
  assert.ok(cut.middle > 100, `字も描けている（${JSON.stringify(cut)}）`);
  assert.ok(await sheetsInside(page));
  // めくっても効く
  await page.keyboard.press('ArrowRight');
  await waitShown(page, [2]);
  assert.ok((await ink(page, 2)).left < 0.06);
  await page.uncheck('#crop');
  await page.waitForFunction(() => {
    const r = document.querySelector('#stage .sheet')?.getBoundingClientRect();
    return r && Math.abs(r.width / r.height - 595 / 842) < 0.01 && document.querySelector('#stage .sheet canvas');
  });
  assert.deepEqual(errors, []);
  await page.close();
});

test('縦スクロール：全部のページが縦に並び、近くのページだけ描く。動かすと、いまのページが変わる', async () => {
  const { page, errors } = await openPdf(820, 1180);
  await page.selectOption('#mode', 'scroll');
  await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
  assert.ok(await page.isVisible('#auto-row'));
  await page.waitForFunction(() => document.querySelector('#stage .sheet[data-page="1"] canvas'));
  assert.ok((await ink(page, 1)).middle > 100);
  // 幅に合わせる（はみ出さない）
  const fitWidth = await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const r = document.querySelector('#stage .sheet').getBoundingClientRect();
    return { sheet: r.width, stage: stage.clientWidth, scrolls: stage.scrollHeight > stage.clientHeight * 3 };
  });
  assert.ok(fitWidth.sheet <= fitWidth.stage && fitWidth.sheet > fitWidth.stage - 40, JSON.stringify(fitWidth));
  assert.ok(fitWidth.scrolls);
  // 遠くのページは、まだ描かない
  assert.equal(await page.locator('#stage .sheet[data-page="5"] canvas').count(), 0);
  // 最後のページへ動かす
  await page.keyboard.press('End');
  await waitPosition(page, '5 / 5');
  await page.waitForFunction(() => document.querySelector('#stage .sheet[data-page="5"] canvas'));
  assert.ok((await ink(page, 5)).middle > 100);
  // 遠くなった1ページ目は、片付ける
  await page.waitForFunction(() => !document.querySelector('#stage .sheet[data-page="1"] canvas'));
  // スライダーで 2 ページ目へ
  await page.locator('#seek').fill('2');
  await page.locator('#seek').dispatchEvent('change');
  await waitPosition(page, '2 / 5');
  // キー（ペダル）で、画面1枚ぶんずつ進む
  const before = await page.evaluate(() => document.getElementById('stage').scrollTop);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((top) => document.getElementById('stage').scrollTop > top + 300, before);
  await waitScrollEnd(page); // なめらかに動いている途中で、いまのページが変わることがある
  // 1ページ表示に戻すと、いまのページが出る
  const now = Number((await page.textContent('#position')).split(' / ')[0]);
  await page.selectOption('#mode', 'single');
  await waitShown(page, [now]);
  assert.ok(await page.isHidden('#auto-row'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('縦スクロール＋余白カット：ページの高さが切った後の形になり、見ている所がずれない', async () => {
  const { page, errors } = await openPdf(820, 1180);
  await page.check('#crop');
  await page.selectOption('#mode', 'scroll');
  await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
  await page.locator('#seek').fill('4');
  await page.locator('#seek').dispatchEvent('change');
  await waitPosition(page, '4 / 5');
  await page.waitForFunction(() => document.querySelector('#stage .sheet[data-page="4"] canvas'));
  const state = await page.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const sheets = [...document.querySelectorAll('#stage .column .sheet')].map((s) => s.getBoundingClientRect());
    return { ratios: sheets.map((r) => r.width / r.height), top4: sheets[3].top - stage.top };
  });
  for (const ratio of state.ratios) assert.ok(Math.abs(ratio - 355 / 602) < 0.04, `切った後の形（${JSON.stringify(state)}）`);
  assert.ok(Math.abs(state.top4 - 8) < 3, `4ページ目の頭が、画面の上にある（${JSON.stringify(state)}）`);
  assert.ok((await ink(page, 4)).left < 0.06);
  assert.deepEqual(errors, []);
  await page.close();
});

test('自動スクロール：押すと少しずつ進み、速さを変えられ、もう一度押すと止まる', async () => {
  const { page, errors } = await openPdf(820, 1180);
  await page.selectOption('#mode', 'scroll');
  await page.waitForFunction(() => document.querySelector('#stage .sheet[data-page="1"] canvas'));
  const top = () => page.evaluate(() => document.getElementById('stage').scrollTop);
  await page.locator('#speed').fill('20');
  await page.locator('#speed').dispatchEvent('input');
  assert.equal(await page.textContent('#speed-out'), '20');
  await page.click('#auto');
  assert.equal(await page.getAttribute('#auto', 'aria-pressed'), 'true');
  await page.waitForFunction(() => document.getElementById('stage').scrollTop > 60);
  await page.click('#auto');
  assert.equal(await page.getAttribute('#auto', 'aria-pressed'), 'false');
  const stopped = await top();
  await page.waitForTimeout(300);
  assert.ok(Math.abs((await top()) - stopped) <= 1, '止まっている');
  // 動いている間に真ん中をタップすると、止まる
  await page.click('#auto');
  await page.waitForFunction((t) => document.getElementById('stage').scrollTop > t + 30, stopped);
  await clickStage(page, 0.5);
  assert.equal(await page.getAttribute('#auto', 'aria-pressed'), 'false');
  assert.ok(await page.isVisible('#toolbar'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('色：セピア・夜（白黒を逆に）を選べる', async () => {
  const { page } = await openPdf(820, 1180);
  const filter = () => page.evaluate(() => getComputedStyle(document.querySelector('#stage .sheet canvas')).filter);
  assert.equal(await filter(), 'none');
  await page.selectOption('#tone', 'sepia');
  assert.match(await filter(), /sepia/);
  await page.selectOption('#tone', 'night');
  assert.match(await filter(), /invert/);
  await page.close();
});

test('本棚：開いた PDF が残り、開き直すと前回のページから出る。消すと、本棚から無くなる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf(820, 1180, { context, files: [FIVE, THREE] });
    assert.match(await page.textContent('#status'), /2 本を本棚に入れました/);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitShown(page, [3]);
    await page.waitForTimeout(700); // 前回のページを書き終えるのを待つ

    // 開き直すと、最後に開いた PDF が、前回のページから出る
    await page.reload();
    await waitShown(page, [3]);
    assert.equal(await page.textContent('#position'), '3 / 5');
    assert.equal(await page.textContent('#title'), 'five-pages');

    // 本棚に2本ある（最近開いた順）
    await page.click('#shelf-open');
    await page.waitForSelector('#shelf-list .shelf-item');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#shelf-list .shelf-item')].map((b) => b.textContent));
    assert.equal(rows.length, 2);
    assert.match(rows[0], /five-pages.*5 ページ・前回は 3 ページ目/);
    assert.match(rows[1], /three-pages.*まだ開いていません/);
    assert.match(await page.textContent('#shelf-note'), /外へは送りません/);

    // 本棚から、もう1本を開く
    await page.click('#shelf-list .shelf-item >> nth=1');
    await waitShown(page, [1]);
    assert.equal(await page.textContent('#position'), '1 / 3');
    assert.ok(await page.isHidden('#shelf'));

    // 消す（確かめの問いに「はい」）
    page.once('dialog', (d) => d.accept());
    await page.click('#shelf-open');
    await page.waitForSelector('#shelf-list .shelf-item');
    await page.click('#shelf-list .shelf-del >> nth=1');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 1);
    assert.match(await page.textContent('#shelf-list .shelf-item'), /three-pages/);
    await page.click('#shelf-close');
    await page.reload();
    await waitShown(page, [1]);
    assert.equal(await page.textContent('#title'), 'three-pages');
    await page.click('#shelf-open');
    await page.waitForFunction(() => document.querySelectorAll('#shelf-list .shelf-item').length === 1);

    // 「いいえ」なら消えない
    page.once('dialog', (d) => d.dismiss());
    await page.click('#shelf-list .shelf-del');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#shelf-list .shelf-item').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('同じ PDF をもう一度選ぶと、本棚に2つは並ばず、前回のページから開く', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page } = await openPdf(820, 1180, { context });
    await page.keyboard.press('End');
    await waitShown(page, [5]);
    await page.waitForTimeout(700);
    await page.setInputFiles('#file', [FIVE]);
    await page.waitForTimeout(300);
    await waitShown(page, [5]);
    await page.click('#shelf-open');
    await page.waitForSelector('#shelf-list .shelf-item');
    assert.equal(await page.locator('#shelf-list .shelf-item').count(), 1);
  } finally {
    await context.close();
  }
});

test('読めないファイル：日本語で知らせ、本棚に残さない。開いていた楽譜は、そのまま', async () => {
  const { page, errors } = await openPdf(820, 1180);
  await page.click('#hide');
  await page.setInputFiles('#file', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('これは楽譜ではありません') }]);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('PDF ではないので、開けません'));
  assert.ok(await page.isVisible('#toolbar'), 'かくしていても、知らせが見える');
  assert.deepEqual(await shown(page), [1]);
  // 先頭だけ PDF で、中身が壊れている
  await page.setInputFiles('#file', [{ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 こわれた中身') }]);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('「broken」を開けませんでした'));
  assert.deepEqual(await shown(page), [1]);
  assert.equal(await page.textContent('#title'), 'five-pages');
  await page.click('#shelf-open');
  await page.waitForSelector('#shelf-list .shelf-item');
  const names = await page.evaluate(() => [...document.querySelectorAll('#shelf-list .shelf-item .name')].map((n) => n.textContent));
  assert.deepEqual(names, ['five-pages']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('設定（表示・半ページめくり・余白カット・色・速さ）は、開き直しても残る', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page } = await openPdf(820, 1180, { context });
    await page.selectOption('#tone', 'sepia');
    await page.check('#half');
    await page.check('#crop');
    await page.selectOption('#mode', 'scroll');
    await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
    await page.locator('#speed').fill('9');
    await page.locator('#speed').dispatchEvent('input');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#stage .column .sheet').length === 5);
    assert.equal(await page.inputValue('#mode'), 'scroll');
    assert.equal(await page.inputValue('#tone'), 'sepia');
    assert.equal(await page.getAttribute('#stage', 'data-tone'), 'sepia');
    assert.ok(await page.isChecked('#half'));
    assert.ok(await page.isChecked('#crop'));
    assert.equal(await page.inputValue('#speed'), '9');
    assert.equal(await page.textContent('#speed-out'), '9');
  } finally {
    await context.close();
  }
});

test('紙の大きさがページごとに違う PDF：どのページも、画面に収まる', async () => {
  const mixed = { name: 'mixed.pdf', mimeType: 'application/pdf', buffer: makePdf(3, { sizes: [[595, 842], [842, 595], [420, 595]] }) };
  const { page, errors } = await openPdf(820, 1180, { files: [mixed] });
  for (const n of [1, 2, 3]) {
    await waitShown(page, [n]);
    assert.ok(await sheetsInside(page), `${n} ページ目`);
    assert.ok((await ink(page, n)).middle > 50);
    await page.keyboard.press('ArrowRight');
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('行き来：単体で開くと「MusicXML の楽譜へ」「PDF の楽譜へ」が出る。枠の中では出ない', async () => {
  const { page } = await openPdf(820, 1180, { files: null });
  assert.ok(await page.isVisible('#to-mxml'));
  assert.ok(await page.isHidden('#alone'));
  await page.click('#to-mxml');
  await page.waitForFunction(() => document.title === '楽譜ビューア(MXML)');
  // ボタンは、ページのスクリプトが動いてから出る（題名より後）。出るまで待つ
  await page.waitForSelector('#to-pdf', { state: 'visible' });
  await page.click('#to-pdf');
  await page.waitForFunction(() => document.title === '楽譜ビューア(PDF)');
  await page.waitForSelector('#to-mxml', { state: 'visible' });
  // 枠（iframe）の中
  await page.setContent(`<iframe id="a" src="${baseUrl}pdf.html" style="width:800px;height:500px"></iframe><iframe id="b" src="${baseUrl}" style="width:800px;height:500px"></iframe>`);
  const inPdf = page.frameLocator('#a');
  const inMxml = page.frameLocator('#b');
  // 枠の中では「別のタブで大きく開く」が出る（スクリプトが最後まで動いた印）。行き来のボタンは出ない
  await inPdf.locator('#alone').waitFor({ state: 'visible' });
  assert.ok(await inPdf.locator('#to-mxml').isHidden());
  // MusicXML の側は、スクリプトが最後まで動く（知らせが「ファイルを選ぶ…」になる）のを待ってから確かめる
  await inMxml.locator('#status').filter({ hasText: 'ファイルを選ぶ' }).waitFor();
  assert.ok(await inMxml.locator('#to-pdf').isHidden());
  await page.close();
});

test('オフライン：一度開けば、電波が無くても、PDF のページが開き、PDF を開いてめくれる。2つのページを取り違えない', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page, errors } = await openPdf(820, 1180, { context, files: null });
    await page.waitForFunction(() => document.getElementById('offline').textContent.includes('保存済み'));
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__pdf && document.getElementById('status').textContent === '');
    assert.equal(await page.title(), '楽譜ビューア(PDF)');
    await page.setInputFiles('#file', [FIVE]);
    await waitShown(page, [1]);
    const first = await ink(page, 1);
    assert.ok(first.all > 500 && first.middle > 100, `電波が無くても描ける（${JSON.stringify(first)}）`);
    await page.keyboard.press('ArrowRight');
    await waitShown(page, [2]);
    // 電波が無いまま、MusicXML のページへ行って、戻る
    await page.goto(baseUrl);
    await page.waitForFunction(() => document.title === '楽譜ビューア(MXML)' && document.getElementById('play'));
    await page.goto(`${baseUrl}pdf.html`);
    await waitShown(page, [2]); // 本棚から、前回のページで開く
    assert.equal(await page.title(), '楽譜ビューア(PDF)');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('オフライン用の保存：pdf.js の部品（文字の対応表・フォント・画像の読み手）が全部入る', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  try {
    const { page } = await openPdf(820, 1180, { context, files: null });
    await page.waitForFunction(() => document.getElementById('offline').textContent.includes('保存済み'));
    const names = JSON.parse(readText('vendor/pdfjs/files.json'));
    const missing = await page.evaluate(async (list) => {
      const keys = await caches.keys();
      const cache = await caches.open(keys.find((k) => k.startsWith('gakufu-viewer-')));
      const out = [];
      for (const name of list) {
        if (!(await cache.match(`./vendor/pdfjs/${name}`))) out.push(name);
      }
      return out;
    }, names);
    assert.deepEqual(missing, []);
  } finally {
    await context.close();
  }
});
