// 試験用の PDF を作る（中身は、枠の線・五線のような横線・大きなページ番号だけ。楽譜ではない）。
// ファイルには書き出さない。テストが、その場で作って使う。
const NL = String.fromCharCode(10);

/**
 * count ページの PDF（Buffer）を返す。
 * margin：紙の端から、中身（枠の線）までの余白。大きくすると、余白カットで大きく切れる。
 * sizes：ページごとの紙の大きさ [[幅, 高さ], …]（足りない分は width × height）
 */
export function makePdf(count, { width = 595, height = 842, margin = 120, sizes = [] } = {}) {
  const objects = [];
  const add = (body) => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // 2：ページの一覧（後で入れる）
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let i = 1; i <= count; i++) {
    const [w, h] = sizes[i - 1] ?? [width, height];
    const lines = ['0 0 0 RG', '3 w', `${margin} ${margin} ${w - margin * 2} ${h - margin * 2} re S`, '1 w'];
    for (let k = 1; k <= 5; k++) {
      const y = h - margin - 40 - k * 8;
      lines.push(`${margin + 20} ${y} m ${w - margin - 20} ${y} l S`);
    }
    lines.push(`BT /F1 120 Tf ${Math.round(w / 2 - 40)} ${Math.round(h / 2 - 40)} Td (${i}) Tj ET`);
    const stream = lines.join(NL);
    kids.push(`${objects.length + 1} 0 R`);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    add(`<< /Length ${Buffer.byteLength(stream)} >>${NL}stream${NL}${stream}${NL}endstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`;

  let out = `%PDF-1.4${NL}`;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj${NL}${body}${NL}endobj${NL}`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref${NL}0 ${objects.length + 1}${NL}0000000000 65535 f ${NL}`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n ${NL}`;
  out += `trailer${NL}<< /Size ${objects.length + 1} /Root 1 0 R >>${NL}startxref${NL}${xref}${NL}%%EOF${NL}`;
  return Buffer.from(out, 'latin1');
}
