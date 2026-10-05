import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { buildChordName } from '../src/prepare.js';

function name(inner) {
  const doc = new DOMParser().parseFromString(`<harmony>${inner}</harmony>`, 'application/xml');
  return buildChordName(doc.documentElement);
}
const root = (s, a) => `<root><root-step>${s}</root-step>${a ? `<root-alter>${a}</root-alter>` : ''}</root>`;
const bass = (s, a) => `<bass><bass-step>${s}</bass-step>${a ? `<bass-alter>${a}</bass-alter>` : ''}</bass>`;

test('コード名：kind の text 属性を優先する', () => {
  assert.equal(name(`${root('F', 1)}<kind text="m">minor</kind>`), 'F#m');
  assert.equal(name(`${root('E', -1)}<kind text="7">dominant</kind>`), 'Eb7');
  assert.equal(name(`${root('A')}<kind text="">major</kind>`), 'A');
});

test('コード名：text が無いときは kind から作る', () => {
  assert.equal(name(`${root('C')}<kind>major-seventh</kind>`), 'Cmaj7');
  assert.equal(name(`${root('B')}<kind>half-diminished</kind>`), 'Bm7b5');
  assert.equal(name(`${root('D')}<kind>suspended-fourth</kind>`), 'Dsus4');
  assert.equal(name('<kind>none</kind>'), 'N.C.');
});

test('コード名：分数コードのベース音を入れる', () => {
  assert.equal(name(`${root('C')}<kind text="">major</kind>${bass('E')}`), 'C/E');
  assert.equal(name(`${root('A')}<kind text="m7">minor-seventh</kind>${bass('G')}`), 'Am7/G');
  assert.equal(name(`${root('D')}<kind>major</kind>${bass('F', 1)}`), 'D/F#');
  assert.equal(name(`${root('B', -1)}<kind>major</kind>${bass('A', -1)}`), 'Bb/Ab');
});

test('コード名：degree（add・alter・omit）', () => {
  assert.equal(name(`${root('F')}<kind>major</kind><degree><degree-value>9</degree-value><degree-alter>0</degree-alter><degree-type>add</degree-type></degree>`), 'Fadd9');
  assert.equal(name(`${root('G')}<kind>dominant</kind><degree><degree-value>9</degree-value><degree-alter>-1</degree-alter><degree-type>alter</degree-type></degree>`), 'G7b9');
  assert.equal(name(`${root('C')}<kind>major</kind><degree><degree-value>3</degree-value><degree-alter>0</degree-alter><degree-type>subtract</degree-type></degree>`), 'Comit3');
});
