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

test('テンポは 200% まで上げられ、数字を押すと 100% に戻る', async () => {
  const { page, errors } = await openPage(1180, 820);
  await page.fill('#tempo', '200');
  await page.dispatchEvent('#tempo', 'input');
  assert.equal(await page.textContent('#tempo-out'), '200%');
  assert.equal(await page.evaluate(() => window.__app.api.playbackSpeed), 2);
  // 2倍の速さで、実際に先へ進む
  await page.click('#play');
  await page.waitForFunction(() => window.__app.state.currentBar >= 2, null, { timeout: 15000 });
  await page.click('#stop');
  await page.waitForFunction(() => document.getElementById('play').dataset.state === 'stopped');
  assert.match(await page.textContent('#position'), /小節 1 [/] 18/);
  await page.click('#tempo-out');
  assert.equal(await page.textContent('#tempo-out'), '100%');
  assert.equal(await page.inputValue('#tempo'), '100');
  assert.equal(await page.evaluate(() => window.__app.api.playbackSpeed), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('「ここから」「ここまで」で、いまの小節がくり返しの範囲に入る', async () => {
  const { page, errors } = await openPage(820, 1180);
  await tapBar(page, 4);
  await page.click('#loop-from-here');
  // はじめの範囲は 1〜4。5 から始めると逆さになるので、終わりも 5 にそろう
  assert.deepEqual([await page.inputValue('#loop-from'), await page.inputValue('#loop-to')], ['5', '5']);
  await tapBar(page, 7);
  await page.click('#loop-to-here');
  assert.deepEqual([await page.inputValue('#loop-from'), await page.inputValue('#loop-to')], ['5', '8']);
  await page.check('#loop');
  const range = await page.evaluate(() => {
    const { api, state } = window.__app;
    const mb = state.score.masterBars;
    return {
      start: api.playbackRange.startTick,
      end: api.playbackRange.endTick,
      expectedStart: api.tickCache.getMasterBarStart(mb[4]),
      expectedEnd: api.tickCache.getMasterBarStart(mb[7]) + mb[7].calculateDuration(),
    };
  });
  assert.equal(range.start, range.expectedStart);
  assert.equal(range.end, range.expectedEnd);
  // 範囲より前の小節で「ここまで」を押すと、始まりも同じ小節にそろう
  await page.uncheck('#loop');
  await tapBar(page, 1);
  await page.click('#loop-to-here');
  assert.deepEqual([await page.inputValue('#loop-from'), await page.inputValue('#loop-to')], ['2', '2']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('楽譜の大きさを変えても、小節の数が合い、横にはみ出さない', async () => {
  const { page, errors } = await openPage(820, 1180);
  const height = () => page.evaluate(() => document.querySelector('.at-surface').getBoundingClientRect().height);
  const before = await height();
  for (const [value, bigger] of [['1.25', true], ['0.8', false]]) {
    await page.selectOption('#zoom', value);
    await page.waitForFunction(
      ([h, up]) => {
        const now = document.querySelector('.at-surface').getBoundingClientRect().height;
        return up ? now > h * 1.05 : now < h * 0.95;
      },
      [before, bigger],
    );
    assert.equal(await renderedBarCount(page), 18);
    assert.ok((await overflow(page)) <= 0, `大きさ ${value} で横にはみ出さない`);
  }
  // 大きさを変えた後も、小節のタップが合う
  await tapBar(page, 6);
  assert.match(await page.textContent('#position'), /小節 7 [/] 18/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('操作の欄をたたむと、再生の行だけが残り、ひらくと戻る', async () => {
  const { page } = await openPage(820, 1180);
  const barHeight = () => page.evaluate(() => document.getElementById('toolbar').offsetHeight);
  const open = await barHeight();
  await page.click('#fold');
  assert.equal(await page.textContent('#fold'), 'ひらく');
  assert.ok((await barHeight()) < open / 2, 'たたむと半分より低くなる');
  assert.equal(await page.isVisible('#play'), true);
  assert.equal(await page.isVisible('#tempo'), true);
  assert.equal(await page.isVisible('#loop'), false);
  assert.equal(await page.isVisible('#scores'), false);
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing');
  await page.click('#stop');
  await page.click('#fold');
  assert.equal(await page.textContent('#fold'), 'たたむ');
  assert.equal(await barHeight(), open);
  assert.equal(await page.isVisible('#loop'), true);
  await page.close();
});

test('読めないファイルは、たたんでいても知らせが見える', async () => {
  const { page } = await openPage(820, 1180);
  await page.setInputFiles('#file', { name: 'こわれた.musicxml', mimeType: 'application/xml', buffer: Buffer.from('<score-partwise>') });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('読めませんでした'));
  await page.click('#fold');
  assert.equal(await page.isVisible('#status'), false);
  await page.evaluate(() => window.__app.api.error.trigger(new Error('試験')));
  assert.equal(await page.isVisible('#status'), true);
  assert.match(await page.textContent('#status'), /うまく動きませんでした/);
  await page.close();
});

test('テンポ・メトロノーム・カウントイン・大きさは、開き直しても残る', async () => {
  const { page, errors } = await openPage(820, 1180);
  await page.fill('#tempo', '150');
  await page.dispatchEvent('#tempo', 'input');
  await page.dispatchEvent('#tempo', 'change');
  await page.check('#metronome');
  await page.selectOption('#zoom', '1.25');
  await page.reload();
  await page.waitForSelector('#play:not([disabled])', { timeout: 60000 });
  assert.equal(await page.inputValue('#tempo'), '150');
  assert.equal(await page.textContent('#tempo-out'), '150%');
  assert.equal(await page.isChecked('#metronome'), true);
  assert.equal(await page.isChecked('#countin'), false);
  assert.equal(await page.inputValue('#zoom'), '1.25');
  assert.deepEqual(
    await page.evaluate(() => {
      const { api } = window.__app;
      return [api.playbackSpeed, api.metronomeVolume, api.countInVolume, api.settings.display.scale];
    }),
    [1.5, 1, 0, 1.25],
  );
  assert.deepEqual(errors, []);
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

// ---------------------------------------------------------------- 聴き比べ

function currentTick(page) {
  return page.evaluate(() => window.__app.api.tickPosition);
}

function barStart(page, index) {
  return page.evaluate((i) => window.__app.api.tickCache.getMasterBarStart(window.__app.state.score.masterBars[i]), index);
}

async function waitReadyFor(page, bars) {
  await page.waitForFunction((n) => {
    const { state } = window.__app;
    return state.playerReady && state.score && state.score.masterBars.length === n && state.pendingPosition === null;
  }, bars);
}

test('聴き比べ：はじめは A＝Aura Lea・B＝Jingle Bells で、A が選ばれている', async () => {
  const { page } = await openPage(820, 1180);
  assert.equal(await page.getAttribute('.slot-btn[data-slot="A"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.slot-btn[data-slot="B"]', 'aria-pressed'), 'false');
  assert.equal(await page.inputValue('select[data-slot="A"]'), 'sample:samples/aura_lea_jazz.musicxml');
  assert.equal(await page.inputValue('select[data-slot="B"]'), 'sample:samples/jingle_bells_pop.musicxml');
  assert.equal(await page.inputValue('select[data-slot="C"]'), '');
  assert.ok((await overflow(page)) <= 0);
  await page.close();
});

test('聴き比べ：止まっているとき、B に切り替えても同じ小節の頭にいる', async () => {
  const { page } = await openPage(1180, 820);
  await tapBar(page, 4);
  await page.waitForFunction(() => /小節 5/.test(document.getElementById('position').textContent));
  await page.click('.slot-btn[data-slot="B"]');
  await waitReadyFor(page, 16);
  assert.match(await page.textContent('#status'), /Jingle/);
  assert.equal(await page.getAttribute('.slot-btn[data-slot="B"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.slot-btn[data-slot="A"]', 'aria-pressed'), 'false');
  const start = await barStart(page, 4);
  await page.waitForFunction((s) => Math.abs(window.__app.api.tickPosition - s) <= 5, start);
  assert.match(await page.textContent('#position'), /小節 5 [/] 16/);
  assert.equal(await page.inputValue('#scores'), 'sample:samples/jingle_bells_pop.musicxml');
  await page.close();
});

test('聴き比べ：再生中に切り替えると、同じあたりの小節から再生が続く', async () => {
  const { page } = await openPage(1180, 820);
  await tapBar(page, 2);
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing');
  await page.waitForTimeout(800);
  const before = await page.evaluate(() => {
    const { api, state } = window.__app;
    return api.tickCache.findBeat(new Set([0]), api.tickPosition).masterBar.masterBar.index;
  });
  await page.click('.slot-btn[data-slot="B"]');
  await waitReadyFor(page, 16);
  await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing');
  const after = await page.evaluate(() => {
    const { api } = window.__app;
    return api.tickCache.findBeat(new Set([0]), api.tickPosition).masterBar.masterBar.index;
  });
  assert.ok(after >= before && after <= before + 1, `切り替え前 ${before + 1} 小節・後 ${after + 1} 小節`);
  await page.click('#play');
  await page.close();
});

test('聴き比べ：くり返しの範囲は、切り替えても残る', async () => {
  const { page } = await openPage(1180, 820);
  await page.fill('#loop-from', '3');
  await page.fill('#loop-to', '6');
  await page.check('#loop');
  await page.click('.slot-btn[data-slot="B"]');
  await waitReadyFor(page, 16);
  assert.equal(await page.inputValue('#loop-from'), '3');
  assert.equal(await page.inputValue('#loop-to'), '6');
  const ok = await page.evaluate(() => {
    const { api, state } = window.__app;
    return api.isLooping && api.playbackRange.startTick === api.tickCache.getMasterBarStart(state.score.masterBars[2]);
  });
  assert.equal(ok, true);
  await page.click('.slot-btn[data-slot="A"]');
  await waitReadyFor(page, 18);
  assert.match(await page.textContent('#status'), /Aura/);
  await page.close();
});

test('聴き比べ：選んだファイルは、見本の入っている A→B に入る', async () => {
  const { page } = await openPage(820, 1180);
  const guitar = readText('test/fixtures/scale_guitar_tab_extras.musicxml');
  await page.setInputFiles('#file', [
    { name: '一つ目.musicxml', mimeType: 'application/xml', buffer: Buffer.from(guitar) },
    { name: '二つ目.mxl', mimeType: 'application/octet-stream', buffer: Buffer.from(makeMxl(guitar)) },
  ]);
  await waitReadyFor(page, 4);
  const labels = await page.$$eval('.slot select', (ss) => ss.map((s) => s.selectedOptions[0].textContent));
  assert.deepEqual(labels, ['一つ目.musicxml', '二つ目.mxl', '（なし）']);
  assert.equal(await page.getAttribute('.slot-btn[data-slot="A"]', 'aria-pressed'), 'true');
  await page.click('.slot-btn[data-slot="C"]');
  assert.match(await page.textContent('#status'), /C に楽譜を選んでください/);
  await page.selectOption('select[data-slot="C"]', { label: '見本：Jingle Bells（ポップ）' });
  await page.click('.slot-btn[data-slot="C"]');
  await waitReadyFor(page, 16);
  await page.close();
});

// ---------------------------------------------------------------- 長い楽譜・すばやい操作

// 見本の小節をくり返して、長い楽譜を作る（実物でいちばん長いのは 131小節）
function makeLong(xml, bars) {
  const open = '<measure ';
  const close = '</measure>';
  const first = xml.indexOf(open);
  const last = xml.lastIndexOf(close) + close.length;
  const measures = xml.slice(first, last).split(close).filter((m) => m.includes(open)).map((m) => m.slice(m.indexOf(open)) + close);
  const out = [];
  for (let i = 0; i < bars; i++) {
    const m = measures[i % measures.length];
    const a = m.indexOf('number="') + 8;
    out.push(m.slice(0, a) + (i + 1) + m.slice(m.indexOf('"', a)));
  }
  return xml.slice(0, first) + out.join('') + xml.slice(last);
}

test('131小節の長い楽譜：開けて、全部の小節が並び、横にはみ出さず、再生できる', async () => {
  const { page, errors } = await openPage(820, 1180);
  const long = makeLong(readText('samples/aura_lea_jazz.musicxml'), 131);
  await page.setInputFiles('#file', [{ name: '長い曲.musicxml', mimeType: 'application/xml', buffer: Buffer.from(long) }]);
  await waitReadyFor(page, 131);
  await page.waitForFunction(() => window.__app.api.renderer.boundsLookup?.staffSystems.flatMap((s) => s.bars).length >= 131);
  assert.equal(await renderedBarCount(page), 131);
  assert.ok((await overflow(page)) <= 0, '横にはみ出さない');
  assert.match(await page.textContent('#status'), /131小節/);
  // 最後の小節までスクロールしてタップし、そこから鳴らせる
  await page.evaluate(() => {
    const bar = window.__app.api.renderer.boundsLookup.staffSystems.flatMap((s) => s.bars).find((b) => b.index === 130).realBounds;
    const top = document.querySelector('.at-surface').getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, top + bar.y + bar.h / 2 - window.innerHeight / 2);
  });
  await tapBar(page, 130);
  await page.waitForFunction(() => /小節 131 /.test(document.getElementById('position').textContent));
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing');
  await page.click('#play');
  assert.deepEqual(errors, []);
  await page.close();
});

test('再生の直後に止めても、エラーにならず、音の出口が残らない', async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // つながったままの音の出口（AudioWorkletNode）を数える
  await page.addInitScript(() => {
    window.__outputs = [];
    const Original = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Original {
      constructor(...args) {
        super(...args);
        const record = { connected: false };
        window.__outputs.push(record);
        const connect = this.connect.bind(this);
        const disconnect = this.disconnect.bind(this);
        this.connect = (...a) => { record.connected = true; return connect(...a); };
        this.disconnect = (...a) => { record.connected = false; return disconnect(...a); };
      }
    };
  });
  await page.goto(baseUrl);
  await page.waitForSelector('#play:not([disabled])', { timeout: 60000 });
  const connected = () => page.evaluate(() => window.__outputs.filter((o) => o.connected).length);
  const doubleTap = () => page.evaluate(() => { const b = document.getElementById('play'); b.click(); b.click(); });

  // 最初の再生（音の出口の部品を読み込む間）と、2回目以降の両方で試す
  for (let i = 0; i < 2; i++) {
    await doubleTap();
    await page.waitForFunction(() => window.__outputs.length > 0 && window.__outputs.every((o) => !o.connected));
    await page.waitForTimeout(300);
    assert.equal(await page.getAttribute('#play', 'data-state'), 'stopped');
    assert.equal(await connected(), 0);
    // その後も、ふつうに再生して止められる
    await page.click('#play');
    await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing' && window.__app.api.tickPosition > 0);
    assert.equal(await connected(), 1);
    await page.click('#play');
    await page.waitForFunction(() => document.getElementById('play').dataset.state === 'stopped');
    await page.waitForFunction(() => window.__outputs.every((o) => !o.connected));
  }
  // 再生の直後に「停止」を押しても同じ
  await page.evaluate(() => { document.getElementById('play').click(); document.getElementById('stop').click(); });
  await page.waitForTimeout(1500);
  assert.equal(await connected(), 0);
  assert.equal(await page.getAttribute('#play', 'data-state'), 'stopped');
  assert.deepEqual(errors, []);
  await page.close();
});

// ---------------------------------------------------------------- オフライン

test('オフライン：一度開けば、電波が無くても開けて再生できる', async () => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.waitForSelector('#play:not([disabled])', { timeout: 60000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || document.getElementById('offline').textContent !== '');
  await page.waitForFunction(() => document.getElementById('offline').textContent.includes('保存済み'));

  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#play:not([disabled])', { timeout: 60000 });
  assert.match(await page.textContent('#status'), /18小節/);
  await page.click('#play');
  await page.waitForFunction(() => document.getElementById('play').dataset.state === 'playing');
  await page.click('#play');
  // 見本の B も保存されている
  await page.click('.slot-btn[data-slot="B"]');
  await waitReadyFor(page, 16);
  // ?out=sp 付きでも開ける
  await page.goto(`${baseUrl}?out=sp`);
  await page.waitForSelector('#play:not([disabled])', { timeout: 60000 });
  await context.close();
});
