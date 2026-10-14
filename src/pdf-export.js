// 書き込みつきの PDF を組み立てる（画面にはさわらない。Node のテストからも読む）。
// 1ページ＝JPEG の絵1枚（紙と書き込みを重ねて描いたもの）。ページの大きさは、もとの PDF と同じ（ポイント）。
// pages：[{ width, height, image: { bytes: Uint8Array（JPEG）, w, h（画素） } }]

const NL = String.fromCharCode(10); // 改行（ソースに逆スラッシュを書かない決まり）
const ascii = (text) => new TextEncoder().encode(text);

function num(v) {
  return String(Math.round(v * 100) / 100);
}

export function buildPdf(pages) {
  if (!pages.length) throw new Error('ページがありません');
  const chunks = [];
  const offsets = [];
  let size = 0;
  const put = (part) => {
    const bytes = typeof part === 'string' ? ascii(part) : part;
    chunks.push(bytes);
    size += bytes.length;
  };
  const obj = (id, body) => {
    offsets[id] = size;
    put(`${id} 0 obj${NL}`);
    for (const part of body) put(part);
    put(`${NL}endobj${NL}`);
  };

  // 1：目録 2：ページの束 3 から：ページごとに（ページ・中身・絵）の3つ
  const pageId = (i) => 3 + i * 3;
  put(`%PDF-1.4${NL}`);
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 中身に文字でないものがある、という印
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(' ');
  obj(2, [`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`]);
  pages.forEach((p, i) => {
    const id = pageId(i);
    const w = num(p.width);
    const h = num(p.height);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`]);
    obj(id + 1, [`<< /Length ${draw.length} >>${NL}stream${NL}${draw}${NL}endstream`]);
    obj(id + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.image.bytes.length} >>${NL}stream${NL}`,
      p.image.bytes,
      `${NL}endstream`,
    ]);
  });

  const count = 3 + pages.length * 3;
  const xref = size;
  put(`xref${NL}0 ${count}${NL}0000000000 65535 f ${NL}`);
  for (let id = 1; id < count; id++) put(`${String(offsets[id]).padStart(10, '0')} 00000 n ${NL}`);
  put(`trailer${NL}<< /Size ${count} /Root 1 0 R >>${NL}startxref${NL}${xref}${NL}%%EOF${NL}`);

  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// 書き出すファイルの名前（もとの名前に「（書き込みつき）」を付ける）
export function exportName(title) {
  const base = String(title ?? '').trim() || '楽譜';
  return `${base}（書き込みつき）.pdf`;
}

// 書き出す絵の大きさ（画素）。長い辺を side に。もとのページ（ポイント）が小さくても、side まで大きくする
export function exportPixels(width, height, side = 2000) {
  const scale = side / Math.max(width, height);
  return { scale, w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}
