// vendor/pdfjs/ の中のファイルの一覧（files.json）を作り直す。sw.js が、オフライン用に保存するときに読む。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'pdfjs');

export function listPdfjs() {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== 'files.json')
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = listPdfjs();
  fs.writeFileSync(path.join(dir, 'files.json'), `${JSON.stringify(list)}${String.fromCharCode(10)}`);
  console.log(`files.json：${list.length} 個`);
}
