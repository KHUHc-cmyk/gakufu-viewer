// 圧縮された MusicXML（.mxl。中身は zip）から、楽譜の XML を取り出す。
// 外へは何も送らない。ブラウザの DecompressionStream（deflate-raw）で中身を戻す。

export function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** zip の目次を読む。返り値：[{ name, method, compressedSize, offset }] */
export function readZipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip の目次が見つかりません');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const entries = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error('zip の目次が壊れています');
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(bytes, entry) {
  const p = entry.offset;
  if (u32(bytes, p) !== 0x04034b50) throw new Error('zip の中身が壊れています');
  const start = p + 30 + u16(bytes, p + 26) + u16(bytes, p + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new Error('この圧縮の形式には対応していません');
  if (typeof DecompressionStream === 'undefined') throw new Error('この端末では圧縮された楽譜を戻せません');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** container.xml の rootfile の full-path を取り出す */
function fullPathOf(xml) {
  const at = xml.indexOf('full-path');
  if (at < 0) return null;
  let i = xml.indexOf('=', at);
  if (i < 0) return null;
  i++;
  while (i < xml.length && xml.charCodeAt(i) <= 32) i++; // 空白・タブ・改行を飛ばす
  const quote = xml[i];
  if (quote !== '"' && quote !== "'") return null;
  const end = xml.indexOf(quote, i + 1);
  return end < 0 ? null : xml.slice(i + 1, end);
}

/**
 * .mxl から楽譜の XML（バイト列）を取り出す。
 * META-INF/container.xml に書かれた本体を使う。無ければ、META-INF 以外の最初の .xml / .musicxml を使う。
 * 楽譜でない zip（Guitar Pro 7 など）のときは null を返す。
 */
export async function extractMusicXmlFromZip(bytes) {
  const entries = readZipEntries(bytes);
  let target = null;
  const container = entries.find((e) => e.name === 'META-INF/container.xml');
  if (container) {
    const xml = new TextDecoder().decode(await readEntry(bytes, container));
    const path = fullPathOf(xml);
    if (path) target = entries.find((e) => e.name === path) ?? null;
  }
  if (!target) {
    target = entries.find((e) => !e.name.startsWith('META-INF/') && /[.](musicxml|xml)$/i.test(e.name)) ?? null;
  }
  if (!target) return null;
  return readEntry(bytes, target);
}
