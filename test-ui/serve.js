// 手元で開くための静的サーバー：npm run serve → 表示された URL をブラウザで開く
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { url } = await startServer(root, Number(process.env.PORT ?? 8080));
console.log(`開く：${url}`);
