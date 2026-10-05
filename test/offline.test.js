// オフライン用の保存（sw.js）に、アプリが使うファイルが全部入っているか
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root, readText } from './helpers.js';

function assets() {
  const context = vm.createContext({ self: { addEventListener() {}, location: { origin: '' } } });
  return new vm.Script(`${readText('sw.js')};ASSETS`).runInContext(context);
}

test('sw.js：保存する一覧のファイルが、どれも実際にある', () => {
  for (const url of assets()) {
    if (url === './') continue;
    assert.ok(fs.existsSync(path.join(root, url)), `${url} が無い`);
  }
});

test('sw.js：画面・部品・音源・フォント・見本が全部入っている', () => {
  const list = new Set(assets().map((u) => u.replace(/^[.][/]/, '')));
  const needed = [
    'index.html',
    ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`),
    ...fs.readdirSync(path.join(root, 'vendor/alphatab')).filter((f) => f.endsWith('.mjs')).map((f) => `vendor/alphatab/${f}`),
    'vendor/alphatab/font/Bravura.woff2',
    'vendor/alphatab/soundfont/sonivox.sf2',
    ...fs.readdirSync(path.join(root, 'samples')).map((f) => `samples/${f}`),
  ];
  for (const f of needed) assert.ok(list.has(f), `${f} が保存の一覧に無い`);
});

test('sw.js：見本の選び欄に出ている見本が、全部保存される', () => {
  const html = readText('index.html');
  const list = new Set(assets());
  const samples = html.split('value="sample:').slice(1).map((s) => `./${s.slice(0, s.indexOf('"'))}`);
  assert.ok(samples.length >= 2);
  for (const s of samples) assert.ok(list.has(s), `${s} が保存の一覧に無い`);
});
