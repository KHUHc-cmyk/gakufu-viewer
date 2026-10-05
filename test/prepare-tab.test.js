import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMusicXml, applyToScore } from '../src/prepare.js';
import { env, readText, loadScore, countNotesPerStaff, countXmlNotesPerStaff } from './helpers.js';

for (const name of ['aura_lea_jazz', 'jingle_bells_pop']) {
  test(`${name}: TAB の段を外すと、音の数が1段目と一致する`, () => {
    const text = readText(`samples/${name}.musicxml`);
    const xmlCounts = countXmlNotesPerStaff(text);
    assert.ok(xmlCounts['2'] > 0, '元の楽譜には2段目の音がある');

    const { xml, report } = prepareMusicXml(text, env);
    assert.equal(report.parts.length, 1);
    assert.equal(report.parts[0].tabStripped, true);

    const score = loadScore(xml);
    applyToScore(score, report);
    const staves = score.tracks[0].staves;
    assert.equal(staves.length, 1, '1段になる');
    assert.deepEqual(countNotesPerStaff(score), [xmlCounts['1']]);
    assert.equal(staves[0].showStandardNotation, true);
    assert.equal(staves[0].showTablature, true);
    assert.equal(staves[0].tuning.length, 6, '6弦の調弦が残る');

    // 小節の長さが崩れていない（各声部の長さが小節の長さを超えない）
    const before = loadScore(text);
    assert.equal(score.masterBars.length, before.masterBars.length);
  });

  test(`${name}: 弦とフレットが元の1段目と同じ`, () => {
    const text = readText(`samples/${name}.musicxml`);
    const { xml } = prepareMusicXml(text, env);
    const after = loadScore(xml);
    const before = loadScore(text);
    const list = (staff) => {
      const out = [];
      for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
        for (const n of beat.notes) out.push(`${bar.index}:${beat.playbackStart}:${n.realValue}:${n.string}:${n.fret}`);
      }
      return out.sort();
    };
    // 元の2段目（TAB の段）の弦・フレットと、整えた後の1段目が同じになる
    assert.deepEqual(list(after.tracks[0].staves[0]), list(before.tracks[0].staves[1]));
  });
}
