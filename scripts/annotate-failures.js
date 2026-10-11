// テストが落ちたとき、落ちたテストの名前とわけを、GitHub Actions の注記（::error）に出す。
// ログを開かなくても（サインインしなくても）、注記から、どのテストがなぜ落ちたかが分かるようにするため。
// 使い方：node scripts/annotate-failures.js テストの出力を写したファイル
import fs from 'node:fs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const MAX_NOTES = 9; // 1つの段に出せる注記は 10 個まで
const MAX_LINES = 14;

// 注記の中身に使えない字を、置き換える
function escapeData(text) {
  return text.split('%').join('%25').split(CR).join('%0D').split(NL).join('%0A');
}

function escapeTitle(text) {
  return escapeData(text).split(':').join('%3A').split(',').join('%2C');
}

/** node --test の出力（spec の形）から、落ちたテストを [{ title, body }] で返す */
export function failures(log) {
  const lines = log.split(CR + NL).join(NL).split(NL);
  const start = lines.findIndex((line) => line.includes('failing tests:'));
  if (start < 0) return [];
  const out = [];
  let current = null;
  let where = ''; // 「test at ファイル:行」は、名前の行の前に出る
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('test at ')) {
      where = line.trim();
      current = null;
    } else if (line.startsWith('✖ ')) {
      current = { title: line.slice(2).trim(), body: where ? [where] : [] };
      where = '';
      out.push(current);
    } else if (current && line.trim() && !line.trim().startsWith('at ') && current.body.length < MAX_LINES) {
      current.body.push(line.trimEnd());
    }
  }
  return out.map((f) => ({ title: f.title, body: f.body.join(NL) }));
}

const file = process.argv[2];
if (file && fs.existsSync(file)) {
  const list = failures(fs.readFileSync(file, 'utf8'));
  for (const f of list.slice(0, MAX_NOTES)) {
    console.log(`::error title=${escapeTitle(f.title.slice(0, 120))}::${escapeData(f.body || f.title)}`);
  }
  if (list.length > MAX_NOTES) console.log(`::error::ほかに ${list.length - MAX_NOTES} 本のテストが落ちています`);
  if (!list.length) console.log('::error::テストの出力から、落ちたテストを読み取れませんでした');
}
