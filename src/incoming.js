// ほかのツールから、URL の # より後ろで楽譜を受け取る（ファイルに保存せずに渡してもらう）。
// # より後ろはサーバーへ送られない。ブラウザの中で読むだけで、外へは何も送らない。
//
// 形：#name=<名前>&z=<楽譜>&name=<名前>&z=<楽譜>&back=<戻り先の URL>
//   z    … MusicXML（UTF-8）を deflate-raw で縮めて、base64url（+ と / の代わりに - と _）にしたもの
//   name … 楽譜の名前（encodeURIComponent したもの）。z と同じ順に並べる
//   back … 戻り先の URL（encodeURIComponent したもの）。https://script.google.com/ のものだけ受け取る
// 細かい決まりは docs/受け渡しの決まり.md

export const MAX_SCORES = 3; // 聴き比べの A／B／C に入る数
export const MAX_BYTES = 5 * 1024 * 1024; // 戻した後の大きさの上限（1本あたり）

export function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('この端末では、受け取った楽譜を戻せません');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error('受け取った楽譜が大きすぎます');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of chunks) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}

/** 戻り先として受け取ってよい URL だけを返す（それ以外は null） */
export function safeBackUrl(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname === 'script.google.com' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * location.hash を読む。返り値：{ scores: [{ name, bytes }], back }
 * 楽譜が壊れているときは、日本語の文で例外を投げる。
 */
export async function readIncoming(hash) {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const names = params.getAll('name');
  const scores = [];
  for (const [i, z] of params.getAll('z').slice(0, MAX_SCORES).entries()) {
    let bytes;
    try {
      bytes = await inflate(fromBase64Url(z));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('受け取った楽譜が大きすぎ')) throw e;
      if (e instanceof Error && e.message.startsWith('この端末では')) throw e;
      throw new Error('渡された中身が壊れています');
    }
    scores.push({ name: names[i] || `受け取った楽譜 ${i + 1}`, bytes });
  }
  return { scores, back: safeBackUrl(params.get('back')) };
}
