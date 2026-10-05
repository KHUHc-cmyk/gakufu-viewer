// 画面のテスト（Playwright の Chromium）。npm run test:ui
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { root, makeMxl, readText } from '../test/helpers.js';

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

async function openPage(width, height, colorScheme = 'light') {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 外へ出る通信が無いことを確かめる
  const outside = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['blob:', 'data:'].includes(u.protocol)) outside.push(r.url());
  });
  await page.goto(baseUrl);
  await page.waitForSelector('#play:not([disabled])', { timeout: 60000 });
  await page.waitForFunction(() => window.__app.api.renderer.boundsLookup?.staffSystems.length > 0);
  return { page, errors, outside };
}

function renderedBarCount(page) {
  return page.evaluate(() => {
    const lookup = window.__app.api.renderer.boundsLookup;
    return new Set(lookup.staffSystems.flatMap((s) => s.bars.map((b) => b.index))).size;
  });
}

function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function tapBar(page, index) {
  const p = await page.evaluate((i) => {
    const bar = window.__app.api.renderer.boundsLookup.staffSystems.flatMap((s) => s.bars).find((b) => b.index === i).realBounds;
    const r = document.querySelector('.at-surface').getBoundingClientRect();
    return { x: r.left + bar.x + bar.w / 2, y: r.top + bar.y + bar.h / 2 };
  }, index);
  await page.mouse.click(p.x, p.y);
}

for (const [width, height] of [[820, 1180], [1180, 820]]) {
  test(`幅 ${width}px：見本が開き、小節の数が合い、横にはみ出さない`, async () => {
    const { page, errors, outside } = await openPage(width, height);
    assert.equal(await page.evaluate(() => window.__app.state.score.masterBars.length), 18);
    assert.equal(await renderedBarCount(page), 18);
    assert.ok((await overflow(page)) <= 0, '横にはみ出さない');
    assert.match(await page.textContent('#status'), /18小節/);
    assert.deepEqual(errors, []);
    assert.deepEqual(outside, []);
    await page.close();
  });

  test(`幅 ${width}px：再生ボタンの状態が変わる`, async () => {
    const { page } = await openPage(width, height);
    assert.equal(await page.getAttribute('#play', 'data-state'), 'stopped');
    assert.equal(await page.textContent('#play'), '再生');
    await page.click('#play');
    await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing');
    assert.equal(await page.textContent('#play'), '一時停止');
    await page.click('#play');
    await page.waitForFunction(() => document.getElementById('play').dataset.state === 'stopped');
    assert.equal(await page.textContent('#play'), '再生');
    await page.close();
  });
}

test('暗い設定でも開け、横にはみ出さない', async () => {
  const { page, errors } = await openPage(820, 1180, 'dark');
  assert.equal(await renderedBarCount(page), 18);
  assert.ok((await overflow(page)) <= 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('小節をタップすると、その小節の頭へ移る', async () => {
  const { page } = await openPage(820, 1180);
  await tapBar(page, 4);
  await page.waitForFunction(() => {
    const { api, state } = window.__app;
    // 再生側（ワーカー）から返る位置は、時間と tick の換算で 1〜2 tick ずれることがある
    return Math.abs(api.tickPosition - api.tickCache.getMasterBarStart(state.score.masterBars[4])) <= 5;
  });
  assert.match(await page.textContent('#position'), /小節 5 [/] 18/);
  await page.close();
});

test('テンポ・くり返し・メトロノーム・カウントイン', async () => {
  const { page } = await openPage(1180, 820);
  await page.fill('#tempo', '70');
  await page.dispatchEvent('#tempo', 'input');
  assert.equal(await page.textContent('#tempo-out'), '70%');
  assert.equal(await page.evaluate(() => window.__app.api.playbackSpeed), 0.7);

  await page.fill('#loop-from', '3');
  await page.fill('#loop-to', '6');
  await page.check('#loop');
  const range = await page.evaluate(() => {
    const { api, state } = window.__app;
    const mb = state.score.masterBars;
    return {
      looping: api.isLooping,
      start: api.playbackRange.startTick,
      end: api.playbackRange.endTick,
      expectedStart: api.tickCache.getMasterBarStart(mb[2]),
      expectedEnd: api.tickCache.getMasterBarStart(mb[5]) + mb[5].calculateDuration(),
    };
  });
  assert.equal(range.looping, true);
  assert.equal(range.start, range.expectedStart);
  assert.equal(range.end, range.expectedEnd);
  await page.uncheck('#loop');
  assert.equal(await page.evaluate(() => window.__app.api.isLooping), false);

  await page.check('#metronome');
  await page.check('#countin');
  assert.deepEqual(await page.evaluate(() => [window.__app.api.metronomeVolume, window.__app.api.countInVolume]), [1, 1]);
  await page.close();
});

test('ファイルを選ぶ：.musicxml と .mxl を一度に開ける', async () => {
  const { page, errors } = await openPage(820, 1180);
  const guitar = readText('test/fixtures/scale_guitar_tab_extras.musicxml');
  await page.setInputFiles('#file', [
    { name: '音階.musicxml', mimeType: 'application/xml', buffer: Buffer.from(guitar) },
    { name: '音階.mxl', mimeType: 'application/octet-stream', buffer: Buffer.from(makeMxl(guitar)) },
  ]);
  await page.waitForFunction(() => /4小節/.test(document.getElementById('status').textContent));
  await page.waitForSelector('#play:not([disabled])');
  // 描画はワーカーで後から終わるので、新しい楽譜の小節が並ぶまで待つ
  await page.waitForFunction(() => {
    const lookup = window.__app.api.renderer.boundsLookup;
    return lookup && new Set(lookup.staffSystems.flatMap((s) => s.bars.map((b) => b.index))).size === 4;
  });
  assert.equal(await renderedBarCount(page), 4);
  const options = await page.$$eval('#file-group option', (os) => os.map((o) => o.textContent));
  assert.deepEqual(options, ['音階.musicxml', '音階.mxl']);

  await page.selectOption('#scores', { label: '音階.mxl' });
  await page.waitForFunction(() => /4小節/.test(document.getElementById('status').textContent) && window.__app.state.playerReady);
  assert.equal(await page.evaluate(() => window.__app.state.score.tracks[0].staves.length), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('読めないファイルを選ぶと、日本語で知らせる', async () => {
  const { page } = await openPage(820, 1180);
  await page.setInputFiles('#file', [{ name: 'メモ.txt', mimeType: 'text/plain', buffer: Buffer.from('これは楽譜ではありません') }]);
  await page.waitForFunction(() => /読めませんでした/.test(document.getElementById('status').textContent));
  await page.close();
});
