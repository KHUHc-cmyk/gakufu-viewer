// ファイルのバイト列を、alphaTab のモデルにする。整える層を通せるものは通す。
// ブラウザと Node のテストの両方から使う。
import { isZip, extractMusicXmlFromZip } from './mxl.js';
import { prepareMusicXml, applyToScore } from './prepare.js';

/** バイト列を文字列にする（UTF-8。先頭に BOM があれば UTF-16 も） */
export function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}

function looksLikeMusicXml(text) {
  const head = text.slice(0, 4000);
  return head.includes('<score-partwise') || head.includes('<score-timewise');
}

/**
 * 返り値：{ score, mode, report, applied }
 *  mode … 'prepared'（整える層を通した）／'raw'（そのまま alphaTab に渡した）
 */
export async function loadScore(alphaTab, input, settings, env = globalThis) {
  const original = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bytes = original;
  let note = null;
  if (isZip(original)) {
    bytes = null;
    try {
      bytes = await extractMusicXmlFromZip(original);
    } catch (e) {
      // 戻せないときは、alphaTab に zip のまま読ませる（alphaTab も .mxl を読める）
      note = e.message;
    }
  }
  if (bytes) {
    const text = decodeText(bytes);
    if (looksLikeMusicXml(text)) {
      const { xml, report } = prepareMusicXml(text, env);
      const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), settings);
      const applied = applyToScore(score, report, settings);
      return { score, mode: 'prepared', report, applied, note };
    }
  }
  // MusicXML でないもの（Guitar Pro など。zip の Guitar Pro 7 は、中に別の .xml があっても元のまま）は alphaTab に任せる
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(original, settings);
  return { score, mode: 'raw', report: null, applied: null, note };
}
