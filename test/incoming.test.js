// ほかのツールから URL で楽譜を受け取る所（src/incoming.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readText, incomingHash, packForUrl, load } from './helpers.js';
import { readIncoming, safeBackUrl, fromBase64Url, MAX_BYTES } from '../src/incoming.js';

const BACK = 'https://script.google.com/macros/s/TEST_ID/exec';

test('受け取り：渡した楽譜が、1バイトも変わらずに戻る（日本語の名前も）', async () => {
  const text = readText('samples/jingle_bells_pop.musicxml');
  const hash = await incomingHash([{ name: '8ビート_丸サ進行_C.musicxml', text }], BACK);
  const got = await readIncoming(hash);
  assert.equal(got.scores.length, 1);
  assert.equal(got.scores[0].name, '8ビート_丸サ進行_C.musicxml');
  assert.equal(new TextDecoder().decode(got.scores[0].bytes), text);
  assert.equal(got.back, BACK);
  const { score } = await load(got.scores[0].bytes);
  assert.equal(score.masterBars.length, 16);
});

test('受け取り：見本の2本は、URL にしても 2万字より短い', async () => {
  for (const name of ['aura_lea_jazz', 'jingle_bells_pop']) {
    const z = await packForUrl(readText(`samples/${name}.musicxml`));
    assert.ok(z.length < 20000, `${name} は ${z.length} 字`);
  }
});

test('受け取り：3本までを順に受け取り、名前が無ければ番号の名前を付ける', async () => {
  const text = readText('test/fixtures/scale_guitar_tab_extras.musicxml');
  const z = await packForUrl(text);
  const got = await readIncoming(`#z=${z}&name=${encodeURIComponent('い')}&z=${z}&z=${z}&z=${z}`);
  assert.deepEqual(got.scores.map((s) => s.name), ['い', '受け取った楽譜 2', '受け取った楽譜 3']);
  assert.equal(got.back, null);
});

test('受け取り：楽譜が無く、戻り先だけのときは、戻り先だけを返す', async () => {
  const got = await readIncoming(`#back=${encodeURIComponent(BACK)}`);
  assert.deepEqual(got.scores, []);
  assert.equal(got.back, BACK);
});

test('受け取り：戻り先は https://script.google.com/ のものだけ', () => {
  assert.equal(safeBackUrl(BACK), BACK);
  for (const bad of [
    'http://script.google.com/macros/s/x/exec',
    'https://example.com/',
    'https://script.google.com.example.com/',
    'https://example.com/@script.google.com/',
    'javascript:alert(1)',
    'data:text/html,x',
    '',
    null,
    123,
  ]) {
    assert.equal(safeBackUrl(bad), null, String(bad));
  }
});

test('受け取り：壊れた中身は、日本語の文で知らせる', async () => {
  await assert.rejects(readIncoming('#z=AAAA_-__'), /壊れています/);
  await assert.rejects(readIncoming('#z=%%%'), /壊れています/);
});

test('受け取り：戻した後が大きすぎる楽譜は、受け取らない', async () => {
  const z = await packForUrl('a'.repeat(MAX_BYTES + 1));
  assert.ok(z.length < 20000, '縮めた後は小さい');
  await assert.rejects(readIncoming(`#z=${z}`), /大きすぎます/);
});

test('受け取り：base64url の - と _ を戻せる', () => {
  assert.deepEqual([...fromBase64Url('-_8')], [0xfb, 0xff]);
});
