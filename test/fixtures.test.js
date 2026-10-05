// 自作の音階だけの試験用（test/fixtures/。作り直すときは make-fixtures.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, loadRaw, readText, eachNote, countNotesPerStaff, countXmlNotesPerStaff, countNoteOns, chordNames } from './helpers.js';

const guitar = readText('test/fixtures/scale_guitar_tab_extras.musicxml');
const piano = readText('test/fixtures/scale_piano_two_staves.musicxml');
const twoParts = readText('test/fixtures/scale_two_parts.musicxml');

test('ギター試験用：TAB の段を外すと、音の数が1段目と一致する', async () => {
  const { score } = await load(guitar);
  assert.deepEqual(countNotesPerStaff(score), [countXmlNotesPerStaff(guitar)['1:1']]);
});

test('ギター試験用：分数コードのベース音・degree・小節の途中のコードが名前に入る', async () => {
  const { score } = await load(guitar);
  assert.deepEqual(chordNames(score), [
    '0:0:C/E',
    '0:1920:Am7/G',
    '1:0:Fadd9/A',
    '2:0:G7/B',
    '3:0:Bbmaj7/D',
    '3:1920:C',
  ]);
});

test('ギター試験用：ハーモニクスは、ふつうの音（フレットどおりの高さ）として鳴る', async () => {
  const { score } = await load(guitar);
  const notes = score.tracks[0].staves[0].bars[2].voices[0].beats.flatMap((b) => b.notes);
  assert.deepEqual(notes.map((n) => n.harmonicType), [0, 0, 0, 0]);
  // 1弦12フレット=E5(76)・2弦12フレット=B4(71)・3弦7フレット=D4(62)・4弦2フレット=E3(52)
  assert.deepEqual(notes.map((n) => n.realValue), [76, 71, 62, 52]);
});

test('ギター試験用：3連符が読める', async () => {
  const { score } = await load(guitar);
  const beats = score.tracks[0].staves[0].bars[1].voices[0].beats;
  assert.deepEqual(beats.slice(0, 6).map((b) => [b.tupletNumerator, b.tupletDenominator]), Array(6).fill([3, 2]));
  assert.deepEqual(beats.map((b) => b.playbackStart), [0, 320, 640, 960, 1280, 1600, 1920]);
});

test('ギター試験用：hammer-on と pull-off が付く', async () => {
  const { score, applied } = await load(guitar);
  assert.equal(applied.hammerPulls, 2);
  const origins = [...eachNote(score.tracks[0].staves[0])].filter(({ note }) => note.isHammerPullOrigin);
  assert.deepEqual(origins.map(({ note }) => [note.fret, note.hammerPullDestination.fret]), [[1, 3], [7, 5]]);
});

test('ギター試験用：再生で音が2重にならない', async () => {
  const { score, settings } = await load(guitar);
  assert.equal(countNoteOns(score, settings) * 2, countNoteOns(loadRaw(guitar)));
});

test('2段のピアノ譜：音を外さない（音の数が減らない）', async () => {
  const xmlCounts = countXmlNotesPerStaff(piano);
  const { score, report, settings } = await load(piano);
  assert.equal(report.parts[0].tabStripped, false);
  assert.equal(score.tracks[0].staves.length, 2);
  assert.deepEqual(countNotesPerStaff(score), [xmlCounts['1:1'], xmlCounts['1:2']]);
  assert.deepEqual(countNotesPerStaff(score), countNotesPerStaff(loadRaw(piano)));
  assert.equal(countNoteOns(score, settings), countNoteOns(loadRaw(piano)));
  assert.equal(score.tracks[0].staves[1].showTablature, false);
});

test('2パート（五線のフルート＋TAB だけのギター）：音を外さない', async () => {
  const xmlCounts = countXmlNotesPerStaff(twoParts);
  const { score, report } = await load(twoParts);
  assert.deepEqual(report.parts.map((p) => p.tabStripped), [false, false]);
  assert.equal(score.tracks.length, 2);
  assert.deepEqual(countNotesPerStaff(score), [xmlCounts['1:1'], xmlCounts['2:1']]);
  assert.deepEqual(countNotesPerStaff(score), countNotesPerStaff(loadRaw(twoParts)));
});
