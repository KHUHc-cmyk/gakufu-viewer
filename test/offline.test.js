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

test('sw.js：画面・部品・音源・フォントが全部入っている', () => {
  const list = new Set(assets().map((u) => u.replace(/^[.][/]/, '')));
  const needed = [
    'index.html',
    ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`),
    ...fs.readdirSync(path.join(root, 'vendor/alphatab')).filter((f) => f.endsWith('.mjs')).map((f) => `vendor/alphatab/${f}`),
    'vendor/alphatab/font/Bravura.woff2',
    'vendor/alphatab/soundfont/sonivox.sf2',
  ];
  for (const f of needed) assert.ok(list.has(f), `${f} が保存の一覧に無い`);
});

// 見本は 2026-10-11 に外した（samples/ は、テストの材料として残すだけ。画面にも、保存の一覧にも、公開するファイルにも入れない）
test('見本：選び欄・保存の一覧・公開するファイルのどこにも入っていない', () => {
  assert.ok(!readText('index.html').includes('samples/'));
  assert.ok(!readText('src/app.js').includes('samples/'));
  for (const url of assets()) assert.ok(!url.includes('samples/'), `${url} が保存の一覧にある`);
  const copy = readText('.github/workflows/pages.yml').split('cp -r ')[1].split('_site/')[0];
  assert.deepEqual(copy.trim().split(' '), ['index.html', 'sw.js', 'src', 'vendor']);
});
