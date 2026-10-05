// 圧縮された形式（.mxl）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, readText, countNotesPerStaff, chordNames, makeMxl, makeZip } from './helpers.js';

const guitar = readText('test/fixtures/scale_guitar_tab_extras.musicxml');
const sample = readText('samples/aura_lea_jazz.musicxml');

test('.mxl（container.xml あり・deflate）を、.musicxml と同じに読める', async () => {
  for (const text of [guitar, sample]) {
    const plain = await load(text);
    const zipped = await load(makeMxl(text));
    assert.equal(zipped.mode, 'prepared');
    assert.deepEqual(countNotesPerStaff(zipped.score), countNotesPerStaff(plain.score));
    assert.deepEqual(chordNames(zipped.score), chordNames(plain.score));
    assert.deepEqual(zipped.applied, plain.applied);
  }
});

test('.mxl（圧縮なしで格納）も読める', async () => {
  const { mode, score } = await load(makeMxl(guitar, { store: true, name: 'a/b.xml' }));
  assert.equal(mode, 'prepared');
  assert.equal(score.tracks[0].staves.length, 1);
});

test('.mxl（container.xml なし）でも、中の .musicxml を見つけて読める', async () => {
  const { mode, score } = await load(makeMxl(guitar, { container: false }));
  assert.equal(mode, 'prepared');
  assert.equal(score.tracks[0].staves.length, 1);
});

test('楽譜の入っていない zip は、読めないと分かる（落ちずにエラーになる）', async () => {
  await assert.rejects(load(makeZip([{ name: 'readme.txt', text: 'hello' }])));
});
