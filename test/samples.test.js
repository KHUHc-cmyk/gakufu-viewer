// samples/ の2本（music21 の出力。1パート・五線＋TAB の2段）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, loadRaw, readText, eachNote, countNotesPerStaff, countXmlNotesPerStaff, countNoteOns, chordNames } from './helpers.js';

for (const name of ['aura_lea_jazz', 'jingle_bells_pop']) {
  const text = readText(`samples/${name}.musicxml`);

  test(`${name}：TAB の段を外すと1段になり、音の数が1段目と一致する`, async () => {
    const xmlCounts = countXmlNotesPerStaff(text);
    assert.ok(xmlCounts['1:2'] > 0, '元の楽譜には2段目の音がある');
    const { score, mode, report } = await load(text);
    assert.equal(mode, 'prepared');
    assert.equal(report.parts[0].tabStripped, true);
    const staves = score.tracks[0].staves;
    assert.equal(staves.length, 1);
    assert.deepEqual(countNotesPerStaff(score), [xmlCounts['1:1']]);
    assert.equal(staves[0].showStandardNotation, true);
    assert.equal(staves[0].showTablature, true);
    assert.equal(staves[0].tuning.length, 6);
    assert.equal(score.masterBars.length, loadRaw(text).masterBars.length);
  });

  test(`${name}：弦とフレットと位置が、元の TAB の段と同じ`, async () => {
    const { score } = await load(text);
    const list = (staff) => [...eachNote(staff)].map(({ bar, beat, note }) => `${bar.index}:${beat.playbackStart}:${note.string}:${note.fret}`).sort();
    assert.deepEqual(list(score.tracks[0].staves[0]), list(loadRaw(text).tracks[0].staves[1]));
  });

  test(`${name}：再生で音が2重にならない（鳴る音の数が、そのまま読んだときの半分）`, async () => {
    const { score, settings } = await load(text);
    const raw = countNoteOns(loadRaw(text));
    assert.equal(countNoteOns(score, settings) * 2, raw);
  });

  test(`${name}：hammer-on / pull-off が全部付く`, async () => {
    const { score, applied, report } = await load(text);
    const xmlStarts = (text.match(/<(hammer-on|pull-off) type="start"/g) ?? []).length / 2; // 2段に同じものがある
    assert.ok(xmlStarts > 0);
    assert.equal(report.parts[0].hammerPairs.length, xmlStarts);
    assert.equal(applied.hammerPulls, xmlStarts);
    assert.equal(applied.hammerPullsMissed, 0);
    let origins = 0;
    for (const { note } of eachNote(score.tracks[0].staves[0])) {
      if (note.isHammerPullOrigin) {
        origins++;
        assert.ok(note.hammerPullDestination, '行き先がある');
        assert.equal(note.hammerPullDestination.string, note.string, '同じ弦');
      }
    }
    assert.equal(origins, xmlStarts);
  });

  test(`${name}：タイが残る`, async () => {
    const { score } = await load(text);
    const xmlTies = (text.split('<tie type="start"/>').length - 1) / 2;
    let ties = 0;
    for (const { note } of eachNote(score.tracks[0].staves[0])) if (note.isTieDestination && note.tieOrigin) ties++;
    assert.equal(ties, xmlTies);
  });

  test(`${name}：コード名が1つも落ちない（小節の途中のものも）`, async () => {
    const { score, report } = await load(text);
    const xmlHarmonies = (text.match(/<harmony>/g) ?? []).length;
    assert.equal(report.parts[0].chords.length, xmlHarmonies);
    const names = chordNames(score);
    assert.equal(names.length, xmlHarmonies);
    assert.deepEqual(names, report.parts[0].chords.map((c) => `${c.measure}:${c.tick}:${c.name}`));
  });
}

test('aura_lea_jazz：小節の途中の <offset> つきのコード（D・Db7・C7）が3つとも出る', async () => {
  const text = readText('samples/aura_lea_jazz.musicxml');
  const { score } = await load(text);
  const names = chordNames(score).map((s) => s.split(':')[2]);
  const i = names.indexOf('D');
  assert.ok(i >= 0);
  assert.deepEqual(names.slice(i, i + 3), ['D', 'Db7', 'C7']);
  // alphaTab だけで読むと、2つ目以降が落ちる（直したことの確かめ）
  const raw = chordNames(loadRaw(text)).map((s) => s.split(':')[2]);
  assert.ok(!raw.includes('Db7'));
});
