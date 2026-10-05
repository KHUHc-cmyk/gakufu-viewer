// MusicXML 以外の形式は、整えずに alphaTab に任せる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, readText, alphaTab, countNotesPerStaff, makeZip, readZipEntry } from './helpers.js';
import { readZipEntries } from '../src/mxl.js';

const guitar = readText('test/fixtures/scale_guitar_tab_extras.musicxml');

async function gp7Bytes() {
  const { score } = await load(guitar);
  return new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings());
}

test('Guitar Pro 7（.gp）を開ける（テスト用の音階を alphaTab で .gp に書き出したもの）', async () => {
  const fromXml = await load(guitar);
  const { mode, score } = await load(await gp7Bytes());
  assert.equal(mode, 'raw');
  assert.deepEqual(countNotesPerStaff(score), countNotesPerStaff(fromXml.score));
  assert.equal(score.tracks[0].staves[0].showTablature, true);
});

test('中に .xml の入った Guitar Pro 7 でも、その .xml を楽譜と取り違えない', async () => {
  const gp = await gp7Bytes();
  // 元の .gp の中身を並べ直し、Preferences.xml を足した zip を作る
  const files = readZipEntries(gp).filter((e) => !e.name.endsWith('/')).map((e) => ({ name: e.name, data: readZipEntry(gp, e) }));
  files.push({ name: 'Content/Preferences.xml', text: '<?xml version="1.0"?><Preferences/>' });
  const { mode, score } = await load(makeZip(files));
  assert.equal(mode, 'raw');
  assert.equal(score.tracks[0].staves.length, 1);
});
