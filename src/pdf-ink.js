// PDF の楽譜への書き込み（ペン・蛍光ペン・消しゴム）と、しおりの計算（画面にはさわらない。Node のテストからも読む）。
// 線の位置は、紙の全体に対する割合（0〜1）で持つ。余白カットや画面の大きさが変わっても、紙の同じ所に出る。
// 線：{ t: 道具の名前, p: [x0, y0, x1, y1, …] }

// 太さ（width）は、紙の幅に対する割合
export const TOOLS = Object.freeze({
  black: Object.freeze({ color: '#111111', width: 0.0035, alpha: 1 }),
  red: Object.freeze({ color: '#d6202a', width: 0.0035, alpha: 1 }),
  blue: Object.freeze({ color: '#1a5fd0', width: 0.0035, alpha: 1 }),
  marker: Object.freeze({ color: '#ffd400', width: 0.024, alpha: 0.4 }),
});

export const ERASER = 'eraser';
const MIN_STEP = 0.0012; // これより近い点は、足さない（線を軽くする）
const MAX_POINTS = 4000; // 線1本の点の上限
const MAX_MARKS = 200;
const MARK_NAME_MAX = 40;

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

export function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// 画面に出ている紙の中の割合（fx, fy）→ 紙の全体に対する割合。crop は、余白カットの範囲
export function toPage(fx, fy, crop) {
  return [round4(crop.l + clamp01(fx) * (crop.r - crop.l)), round4(crop.t + clamp01(fy) * (crop.b - crop.t))];
}

// 紙の全体に対する割合 → 画面に出ている紙の中の割合（余白カットで切れた所は、0〜1 の外になる）
export function fromPage(x, y, crop) {
  return [(x - crop.l) / (crop.r - crop.l), (y - crop.t) / (crop.b - crop.t)];
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
  return { marks: [], ink: {} };
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
  return out;
}

// メトロノームの速さ（1分間の拍の数）。40〜240 に収める
export function clampBpm(value, fallback = 100) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(240, Math.max(40, n));
}
