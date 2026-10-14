// PDF の楽譜への書き込み（ペン・蛍光ペン・消しゴム）と、しおりの計算（画面にはさわらない。Node のテストからも読む）。
// 線の位置は、紙の全体に対する割合（0〜1）で持つ。余白カットや画面の大きさが変わっても、紙の同じ所に出る。
// 紙を回していても（turn：0・90・180・270。時計回り）、線の位置は、回す前の紙（PDF のもとの向き）に対する割合で持つ。
// 線：{ t: 道具の名前, p: [x0, y0, x1, y1, …] }
// とび先：{ x, y, to }（紙の上の (x, y) に印を置き、押すと to ページへ飛ぶ。D.S.・コーダなど）

// 太さ（width）は、紙の幅に対する割合
export const TOOLS = Object.freeze({
  black: Object.freeze({ color: '#111111', width: 0.0035, alpha: 1 }),
  red: Object.freeze({ color: '#d6202a', width: 0.0035, alpha: 1 }),
  blue: Object.freeze({ color: '#1a5fd0', width: 0.0035, alpha: 1 }),
  marker: Object.freeze({ color: '#ffd400', width: 0.024, alpha: 0.4 }),
});

export const ERASER = 'eraser';
export const LINK = 'link';
const MIN_STEP = 0.0012; // これより近い点は、足さない（線を軽くする）
const MAX_POINTS = 4000; // 線1本の点の上限
const MAX_MARKS = 200;
const MARK_NAME_MAX = 40;
const MAX_LINKS = 30; // 1ページのとび先の上限

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

export function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// 紙の向き。決まった4つのほかは、回していないものとする
export function cleanTurn(value) {
  const n = Number(value);
  return n === 90 || n === 180 || n === 270 ? n : 0;
}

// 右へ 90 度回した、次の向き
export function nextTurn(turn) {
  return (cleanTurn(turn) + 90) % 360;
}

// ページごとの向き（{ ページ番号: 90・180・270 }。全部のページの向きに足す分）。回していないページ・ページの数を越えるものは持たない
export function cleanTurns(value, count) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, turn] of Object.entries(value)) {
    const n = Number(key);
    const t = cleanTurn(turn);
    if (Number.isInteger(n) && n >= 1 && n <= count && t) out[n] = t;
  }
  return out;
}

// ページ n の向き：全部のページの向き（turn）に、そのページだけの分（turns）を足す
export function turnAt(turn, turns, n) {
  return (cleanTurn(turn) + cleanTurn(turns?.[n])) % 360;
}

// もとの紙の中の割合 → 回した紙の中の割合
export function turned(x, y, turn) {
  if (turn === 90) return [1 - y, x];
  if (turn === 180) return [1 - x, 1 - y];
  if (turn === 270) return [y, 1 - x];
  return [x, y];
}

// 回した紙の中の割合 → もとの紙の中の割合
export function unturned(x, y, turn) {
  return turned(x, y, (360 - cleanTurn(turn)) % 360);
}

// 画面に出ている紙の中の割合（fx, fy）→ もとの紙の全体に対する割合。crop は、余白カットの範囲（回した紙の上で測ったもの）
export function toPage(fx, fy, crop, turn = 0) {
  const [x, y] = unturned(crop.l + clamp01(fx) * (crop.r - crop.l), crop.t + clamp01(fy) * (crop.b - crop.t), turn);
  return [round4(x), round4(y)];
}

// もとの紙の全体に対する割合 → 画面に出ている紙の中の割合（余白カットで切れた所は、0〜1 の外になる）
export function fromPage(x, y, crop, turn = 0) {
  const [u, v] = turned(x, y, turn);
  return [(u - crop.l) / (crop.r - crop.l), (v - crop.t) / (crop.b - crop.t)];
}

// 線を描く（画面の書き込み・書き出す PDF の両方で使う）。w × h は描く先の画素、crop は余白カットの範囲（回した紙の上で測ったもの）
export function drawStrokes(ctx, strokes, w, h, crop, turn = 0) {
  // もとの紙の幅 1 あたりの画素（線の太さの物差し。横に倒した向きでは、画面の高さの側になる）
  const unit = turn % 180 ? h / (crop.b - crop.t) : w / (crop.r - crop.l);
  const at = (x, y) => {
    const [fx, fy] = fromPage(x, y, crop, turn);
    return [fx * w, fy * h];
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    const tool = TOOLS[stroke.t];
    if (!tool) continue;
    const p = stroke.p;
    ctx.globalAlpha = tool.alpha;
    ctx.strokeStyle = tool.color;
    ctx.lineWidth = Math.max(1, tool.width * unit);
    ctx.beginPath();
    const [x0, y0] = at(p[0], p[1]);
    ctx.moveTo(x0, y0);
    if (p.length === 2) ctx.lineTo(x0 + 0.01, y0);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(...at(p[i], p[i + 1]));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// 線に点を足す。前の点に近すぎるとき・点が多すぎるときは足さない（足したら true）
export function addPoint(points, x, y) {
  const n = points.length;
  if (n >= MAX_POINTS * 2) return false;
  if (n >= 2 && Math.hypot(x - points[n - 2], y - points[n - 1]) < MIN_STEP) return false;
  points.push(x, y);
  return true;
}

// 点 (x, y) が、線に触れているか。aspect は、紙の 高さ ÷ 幅（たての割合を、幅の物差しに直すため）。
// reach は、消しゴムの大きさ（紙の幅に対する割合）
export function hitStroke(stroke, x, y, aspect, reach) {
  const tool = TOOLS[stroke.t];
  if (!tool) return false;
  const limit = reach + tool.width / 2;
  const p = stroke.p;
  const py = y * aspect;
  for (let i = 0; i < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1] * aspect;
    const last = i + 3 >= p.length;
    const bx = last ? ax : p[i + 2];
    const by = last ? ay : p[i + 3] * aspect;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (py - ay) * dy) / len)) : 0;
    if (Math.hypot(x - (ax + t * dx), py - (ay + t * dy)) <= limit) return true;
    if (last) break;
  }
  return false;
}

function cleanStroke(raw) {
  if (!raw || !TOOLS[raw.t] || !Array.isArray(raw.p) || raw.p.length < 2 || raw.p.length % 2 !== 0) return null;
  if (raw.p.length > MAX_POINTS * 2 || !raw.p.every((v) => Number.isFinite(v))) return null;
  return { t: raw.t, p: raw.p.map((v) => round4(clamp01(v))) };
}

// しおりの名前（前後の空白を取る。空なら「◯ ページ目」）
export function markName(name, page) {
  const text = String(name ?? '').trim().slice(0, MARK_NAME_MAX);
  return text || `${page} ページ目`;
}

// しおりを付ける（同じページには1つ。ページの順に並べる）
export function withMark(marks, page, name) {
  const rest = marks.filter((m) => m.page !== page);
  rest.push({ page, name: markName(name, page) });
  return rest.sort((a, b) => a.page - b.page).slice(0, MAX_MARKS);
}

export function emptyNotes() {
  return { marks: [], ink: {}, links: {} };
}

// とび先を足す（ページの数の外・上限を越えるものは足さない。足したら、その印。足せなければ null）
export function addLink(list, x, y, to, count) {
  if (!Number.isInteger(to) || to < 1 || to > count || list.length >= MAX_LINKS) return null;
  const link = { x: round4(clamp01(x)), y: round4(clamp01(y)), to };
  list.push(link);
  return link;
}

// 点 (x, y) が、とび先の印に触れているか（aspect・reach は hitStroke と同じ）
export function hitLink(link, x, y, aspect, reach) {
  return Math.hypot(x - link.x, (y - link.y) * aspect) <= reach;
}

// 保存してあった覚え（しおり・書き込み）を、決まった形に直す。おかしな中身は捨てる
export function cleanNotes(raw, count = Infinity) {
  const out = emptyNotes();
  if (!raw || typeof raw !== 'object') return out;
  const okPage = (page) => Number.isInteger(page) && page >= 1 && page <= count;
  if (Array.isArray(raw.marks)) {
    for (const m of raw.marks) {
      if (m && okPage(m.page)) out.marks = withMark(out.marks, m.page, m.name);
    }
  }
  if (raw.ink && typeof raw.ink === 'object') {
    for (const [key, list] of Object.entries(raw.ink)) {
      const page = Number(key);
      if (!okPage(page) || !Array.isArray(list)) continue;
      const strokes = list.map(cleanStroke).filter(Boolean);
      if (strokes.length) out.ink[page] = strokes;
    }
  }
  if (raw.links && typeof raw.links === 'object') {
    for (const [key, list] of Object.entries(raw.links)) {
      const page = Number(key);
      if (!okPage(page) || !Array.isArray(list)) continue;
      const links = [];
      for (const l of list) {
        if (l && Number.isFinite(l.x) && Number.isFinite(l.y)) addLink(links, l.x, l.y, l.to, count);
      }
      if (links.length) out.links[page] = links;
    }
  }
  return out;
}

// メトロノームの速さ（1分間の拍の数）。40〜240 に収める
export function clampBpm(value, fallback = 100) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(240, Math.max(40, n));
}
