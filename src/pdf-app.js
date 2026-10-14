// PDF の楽譜の画面。PDF はブラウザの中で読むだけで、外へは送らない（本棚も、この端末の中）。
import * as pdfjs from '../vendor/pdfjs/pdf.mjs';
import { FULL, layoutFor, normalize, visiblePages, step, fit, pixelRatioFor, findCrop, zoneAt, looksLikePdf, titleOf } from './pdf-layout.js';
import * as store from './pdf-store.js';
import { TOOLS, ERASER, toPage, drawStrokes, addPoint, hitStroke, withMark, emptyNotes, cleanNotes, clampBpm, cleanTurn, nextTurn } from './pdf-ink.js';
import { createMetronome } from './pdf-metronome.js';
import { buildPdf, exportName, exportPixels } from './pdf-export.js';
import { findInShelf } from './pdf-shelf.js';
import { MAX_SETS, MAX_SONGS, setName, cleanSets, moved, without, neighbor, indexAfterMove, indexAfterRemove, locate, itemId, makeItem, itemRange, rangeText } from './pdf-setlist.js';

const $ = (id) => document.getElementById(id);
const el = {
  file: $('file'),
  shelfOpen: $('shelf-open'),
  marksOpen: $('marks-open'),
  marks: $('marks'),
  marksClose: $('marks-close'),
  markName: $('mark-name'),
  markAdd: $('mark-add'),
  marksList: $('marks-list'),
  outlineTitle: $('outline-title'),
  outlineList: $('outline-list'),
  setsOpen: $('sets-open'),
  sets: $('sets'),
  setsClose: $('sets-close'),
  setsBack: $('sets-back'),
  setsTitle: $('sets-title'),
  setsNote: $('sets-note'),
  setsNew: $('sets-new'),
  setName: $('set-name'),
  setAdd: $('set-add'),
  setsList: $('sets-list'),
  setSongs: $('set-songs'),
  setSong: $('set-song'),
  setSongAdd: $('set-song-add'),
  setFrom: $('set-from'),
  setTo: $('set-to'),
  ink: $('ink'),
  inkRow: $('ink-row'),
  inkTools: [...document.querySelectorAll('.ink-tool')],
  inkUndo: $('ink-undo'),
  inkClear: $('ink-clear'),
  penOnly: $('pen-only'),
  exportPdf: $('export'),
  exportSave: $('export-save'),
  inkHint: $('ink-hint'),
  metro: $('metro'),
  bpm: $('bpm'),
  bpmDown: $('bpm-down'),
  bpmUp: $('bpm-up'),
  beats: $('beats'),
  beatDot: $('beat-dot'),
  toMxml: $('to-mxml'),
  alone: $('alone'),
  title: $('title'),
  status: $('status'),
  prev: $('prev'),
  next: $('next'),
  seek: $('seek'),
  position: $('position'),
  hide: $('hide'),
  fold: $('fold'),
  toolbar: $('toolbar'),
  mode: $('mode'),
  half: $('half'),
  crop: $('crop'),
  turn: $('turn'),
  tone: $('tone'),
  autoRow: $('auto-row'),
  auto: $('auto'),
  speed: $('speed'),
  speedOut: $('speed-out'),
  stage: $('stage'),
  empty: $('empty'),
  offline: $('offline'),
  pager: $('pager'),
  shelf: $('shelf'),
  shelfClose: $('shelf-close'),
  shelfNote: $('shelf-note'),
  shelfList: $('shelf-list'),
  shelfTools: $('shelf-tools'),
  shelfFind: $('shelf-find'),
  shelfOrder: $('shelf-order'),
};

// pdf.js の部品（ワーカー・文字の対応表・基本のフォント・画像の読み手）は、同梱したものを使う
const VENDOR = new URL('../vendor/pdfjs/', import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', VENDOR).href;
// ワーカーは、ページを開いたときに1つ作って使い回す（最初の PDF を開くときに、待たせないため）
let sharedWorker = null;
try {
  sharedWorker = new pdfjs.PDFWorker({ name: 'gakufu-pdf' });
} catch {
  sharedWorker = null; // 作れないときは、開くたびに pdf.js が作る
}

const MAX_PIXELS = 5000000; // キャンバス1枚の画素の上限（iPad の Safari は、合計が大きいと描けなくなる）
const CROP_SIDE = 320; // 余白を調べるときに描く絵の、長い辺の画素
const SPREAD_GAP = 4; // 見開きの、ページの間
const SCROLL_MAX_WIDTH = 1200; // 縦スクロールの、ページの幅の上限
const SCROLL_PAD = 8;
const SPEED_STEP = 6; // 自動スクロール：速さ 1 あたりの、1秒に進む画素
const SWIPE_MIN = 40;
const TAP_MAX = 400; // ペンだけで書くとき、指のタップとみなす長さ（ミリ秒）。手のひらを置いたままの時は、めくらない
const EXPORT_SIDE = 2000; // 書き出す PDF の、ページの絵の長い辺の画素
const EXPORT_QUALITY = 0.85; // 書き出す絵（JPEG）の質
const PEN_REST = 600; // ペンを離してから、これだけの間は、指でめくらない（書いている手のひらでめくらないように）
const INK_MAX_PIXELS = 3000000; // 書き込みを描くキャンバスの、画素の上限
const ERASER_REACH = 0.012; // 消しゴムの大きさ（紙の幅に対する割合）
const NOTES_SAVE_MS = 600; // 書き込み・しおりを、変えてから保存するまでの間

// ---------------------------------------------------------------- 設定を覚える（この端末の中だけ）

const SETTINGS_KEY = 'gakufu-viewer:pdf-settings';
const settings = { mode: 'auto', half: false, crop: false, tone: 'plain', speed: 4, tool: 'black', bpm: 100, beats: 4, folded: false, shelfOrder: 'opened', penOnly: false, penSeen: false };

function hasOption(select, value) {
  return [...select.options].some((o) => o.value === value);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 覚えられなくても、そのまま使える
  }
}

{
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    saved = {}; // プライベートブラウズなどでは覚えない
  }
  if (hasOption(el.mode, saved.mode)) settings.mode = saved.mode;
  if (hasOption(el.tone, saved.tone)) settings.tone = saved.tone;
  settings.half = saved.half === true;
  settings.crop = saved.crop === true;
  if (Number.isFinite(saved.speed)) settings.speed = Math.min(20, Math.max(1, Math.round(saved.speed)));
  el.mode.value = settings.mode;
  el.tone.value = settings.tone;
  el.half.checked = settings.half;
  el.crop.checked = settings.crop;
  el.speed.value = String(settings.speed);
  el.speedOut.textContent = String(settings.speed);
  el.stage.dataset.tone = settings.tone;
  if (TOOLS[saved.tool] || saved.tool === ERASER) settings.tool = saved.tool;
  settings.bpm = clampBpm(saved.bpm);
  if (hasOption(el.beats, String(saved.beats))) settings.beats = Number(saved.beats);
  el.bpm.value = String(settings.bpm);
  el.beats.value = String(settings.beats);
  if (hasOption(el.shelfOrder, saved.shelfOrder)) settings.shelfOrder = saved.shelfOrder;
  el.shelfOrder.value = settings.shelfOrder;
  settings.penOnly = saved.penOnly === true;
  settings.penSeen = saved.penSeen === true;
  // せまい画面（スマホ）では、はじめは たたんでおく（操作の欄が、画面の半分を越えるため）
  settings.folded = typeof saved.folded === 'boolean' ? saved.folded : window.innerWidth < 600;
}

// ---------------------------------------------------------------- 状態

const state = {
  doc: null,
  meta: null, // 本棚の覚え（id が null のときは、本棚に入っていない）
  count: 0,
  pos: { page: 1, half: false },
  layout: null, // 'single'・'spread'・'scroll'
  gen: 0, // 描き直しの番号（古い描き直しの結果を捨てるため）
  openToken: 0,
  bases: new Map(), // ページ番号 → ページと大きさ
  crops: new Map(), // ページ番号 → 余白カットの範囲（回した紙の上で測る）
  turn: 0, // 紙の向き（0・90・180・270。時計回り。PDF ごとに本棚に覚える）
  canvases: new Map(), // 鍵 → 描いたキャンバス
  slots: [], // 縦スクロールの、ページごとの枠
  scrollWidth: 0,
  observer: null,
  auto: 0, // 自動スクロールの requestAnimationFrame の番号
  box: { w: 0, h: 0 }, // 最後に描いたときの、表示の場所の大きさ
  notes: emptyNotes(), // しおり（marks）と書き込み（ink：ページ番号 → 線の並び）
  inkMode: false, // 書き込み中かどうか
  undo: [], // 元に戻せる操作（この PDF を開いている間だけ）
  outline: null, // PDF の目次（[{ title, page, level }]。まだ読んでいなければ null）
  sets: [], // セットリスト（[{ id, name, items, made }]。items は曲の並び＝本棚の番号か { id, from, to }）
  shelf: [], // 最後に読んだ、本棚の一覧（最近開いた順）
  playing: null, // いま開いている曲の、セットリストの中の位置（{ id, index }。セットリストの外なら null）
  editing: null, // セットリストの欄で、中を見ているセットリストの番号（一覧なら null）
  crossing: false, // となりの曲を開いている途中
  exported: null, // 作った書き込みつきの PDF（File）
};

window.__pdf = { state, settings, get metronome() { return metronome; } }; // 画面のテスト用

function setStatus(text) {
  el.status.textContent = text;
}

function setBarHidden(hidden) {
  document.body.classList.toggle('bar-hidden', hidden);
  el.pager.hidden = !hidden || !state.doc;
}

function panelOpen() {
  return !el.shelf.hidden || !el.marks.hidden || !el.sets.hidden;
}

// たたむ：めくる行だけを残す（設定の行をかくして、楽譜を広く見せる）
function setFolded(folded) {
  el.toolbar.classList.toggle('folded', folded);
  el.fold.textContent = folded ? 'ひらく' : 'たたむ';
  el.fold.setAttribute('aria-expanded', String(!folded));
}

function showError(text) {
  setBarHidden(false); // かくしていても・たたんでいても、知らせは見えるようにする
  setFolded(false);
  setStatus(text);
}

// ---------------------------------------------------------------- 画面スリープ防止（楽譜を開いている間）

let wakeLock = null;

async function holdWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || !state.doc || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // 電池が少ないときなどは断られる。そのまま使える
  }
}

document.addEventListener('visibilitychange', holdWakeLock);

// ---------------------------------------------------------------- ページを描く

function basePage(n) {
  let base = state.bases.get(n);
  if (!base) {
    const { turn } = state;
    base = state.doc.getPage(n).then((page) => {
      // rotation を渡すと、PDF に書いてある向きの代わりになる。もとの向きに、回した分を足す
      const rotation = (page.rotate + turn) % 360;
      const view = page.getViewport({ scale: 1, rotation });
      return { page, w: view.width, h: view.height, rotation };
    });
    state.bases.set(n, base);
  }
  return base;
}

// 余白カットの範囲。小さく描いて、中身のある所を調べる
function cropOf(n) {
  if (!settings.crop) return Promise.resolve(FULL);
  let crop = state.crops.get(n);
  if (!crop) {
    crop = basePage(n).then(async ({ page, w, h, rotation }) => {
      const viewport = page.getViewport({ scale: CROP_SIDE / Math.max(w, h), rotation });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      try {
        await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
        return findCrop(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
      } catch {
        return FULL; // 調べられないページは、切らない
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
    state.crops.set(n, crop);
  }
  return crop;
}

// ページの形：もとの大きさ・余白カットの範囲・切った後の縦横比（幅 ÷ 高さ）
async function shape(n) {
  const [base, crop] = await Promise.all([basePage(n), cropOf(n)]);
  return { ...base, crop, ratio: (base.w * (crop.r - crop.l)) / (base.h * (crop.b - crop.t)) };
}

// ページ n を、画面の w × h の大きさで描いたキャンバス。同じものは使い回す
function getCanvas(n, w, h) {
  const key = `${n}:${w}x${h}:${settings.crop ? 'cut' : 'full'}:${state.turn}`;
  let entry = state.canvases.get(key);
  if (entry) return entry;
  const canvas = document.createElement('canvas');
  entry = { key, canvas, task: null, dropped: false, ready: null };
  entry.ready = shape(n).then((s) => {
    if (entry.dropped) return false;
    const ratio = pixelRatioFor(w, h, window.devicePixelRatio, MAX_PIXELS);
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    const scale = canvas.width / (s.w * (s.crop.r - s.crop.l));
    const viewport = s.page.getViewport({ scale, rotation: s.rotation, offsetX: -s.crop.l * s.w * scale, offsetY: -s.crop.t * s.h * scale });
    entry.task = s.page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' });
    return entry.task.promise.then(() => true);
  }).catch(() => false); // 取り消したとき・描けなかったときは false
  state.canvases.set(key, entry);
  return entry;
}

function dropCanvas(entry) {
  entry.dropped = true;
  if (entry.task) entry.task.cancel();
  entry.canvas.width = 0;
  entry.canvas.height = 0;
  state.canvases.delete(entry.key);
}

function dropAllCanvases(keep = new Set()) {
  for (const entry of [...state.canvases.values()]) {
    if (!keep.has(entry.key)) dropCanvas(entry);
  }
}

function sheetFor(n, w, h, canvas = null) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.dataset.page = String(n);
  sheet.style.width = `${w}px`;
  sheet.style.height = `${h}px`;
  if (canvas) sheet.append(canvas);
  return sheet;
}

// ---------------------------------------------------------------- 書き込みを描く

// その紙に、書き込み用のキャンバスを重ねる（紙のキャンバスを置いた後に呼ぶ）
function attachInk(sheet) {
  const n = Number(sheet.dataset.page);
  const gen = state.gen;
  const { turn } = state;
  shape(n).then((s) => {
    if (gen !== state.gen || !sheet.isConnected) return;
    const w = sheet.clientWidth;
    const h = sheet.clientHeight;
    if (!w || !h) return;
    const ratio = pixelRatioFor(w, h, window.devicePixelRatio, INK_MAX_PIXELS);
    const canvas = document.createElement('canvas');
    canvas.className = 'ink';
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    if (sheet.inkInfo) sheet.inkInfo.canvas.remove();
    // aspect は、もとの紙の 高さ ÷ 幅（横に倒した向きでは、画面の幅と高さが入れ替わる）
    sheet.inkInfo = { n, canvas, crop: s.crop, turn, aspect: turn % 180 ? s.w / s.h : s.h / s.w };
    sheet.append(canvas);
    paintInk(sheet);
  }).catch(() => {});
}

// その紙の書き込みを描き直す。live は、いま書いている途中の線
function paintInk(sheet, live = null) {
  const info = sheet.inkInfo;
  if (!info) return;
  const { canvas, crop, turn } = info;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = state.notes.ink[info.n] ?? [];
  drawStrokes(ctx, live ? [...strokes, live] : strokes, canvas.width, canvas.height, crop, turn);
}

// 画面に出ている紙のうち、そのページのもの（pages を省くと全部）の書き込みを描き直す
function repaintInk(pages = null) {
  for (const sheet of el.stage.querySelectorAll('.sheet')) {
    if (!pages || pages.includes(Number(sheet.dataset.page))) paintInk(sheet);
  }
}

function layerOf(role, sheets) {
  const layer = document.createElement('div');
  layer.className = role ? `layer ${role}` : 'layer';
  layer.append(...sheets);
  return layer;
}

function setStage(nodes) {
  el.stage.replaceChildren(el.empty, ...nodes);
}

// ---------------------------------------------------------------- 1ページ・見開き・半ページめくり

function samePos(a, b) {
  return a.page === b.page && a.half === b.half;
}

// その位置で画面に出すページと、その大きさ
async function planFor(pos, layout, box) {
  const pages = visiblePages(pos, layout, state.count);
  const shapes = await Promise.all(pages.map(shape));
  const boxW = layout === 'spread' ? Math.floor((box.w - SPREAD_GAP) / 2) : box.w;
  return pages.map((n, i) => ({ n, ...fit(boxW, box.h, shapes[i].ratio) }));
}

async function drawPaged() {
  const gen = ++state.gen;
  const { pos, layout } = state;
  const box = { w: el.stage.clientWidth, h: el.stage.clientHeight };
  state.box = box;
  if (!box.w || !box.h) return;
  let plan;
  let entries;
  try {
    plan = await planFor(pos, layout, box);
    if (gen !== state.gen) return;
    entries = plan.map((p) => getCanvas(p.n, p.w, p.h));
    const drawn = await Promise.all(entries.map((e) => e.ready));
    if (gen !== state.gen) return;
    if (drawn.includes(false)) throw new Error('render');
  } catch {
    if (gen === state.gen) showError(`${pos.page} ページ目を描けませんでした`);
    return;
  }
  const sheets = plan.map((p, i) => sheetFor(p.n, p.w, p.h, entries[i].canvas));
  const inkAfter = () => sheets.forEach(attachInk); // 画面に置いてから重ねる（大きさを読むため）
  if (pos.half && sheets.length === 2) {
    // 半ページめくりの途中：上半分に次のページ、下半分にいまのページ
    const divider = document.createElement('div');
    divider.className = 'divider';
    setStage([layerOf('bottom', [sheets[0]]), layerOf('top', [sheets[1]]), divider]);
  } else {
    setStage([layerOf('', sheets)]);
  }
  inkAfter();
  el.stage.dataset.drawn = `${box.w}x${box.h}`; // 描き終わった印（画面のテストが、並び直しの終わりを知るため）
  if (el.status.textContent.endsWith('描けませんでした')) setStatus('');
  // 次と前のページを先に描いておく（めくった時に、すぐ出るように）。それ以外のキャンバスは片付ける
  const keep = new Set(entries.map((e) => e.key));
  for (const dir of [1, -1]) {
    const near = step(pos, dir, layout, state.count, settings.half);
    if (samePos(near, pos)) continue;
    try {
      const ahead = await planFor(near, layout, box);
      if (gen !== state.gen) return;
      for (const p of ahead) keep.add(getCanvas(p.n, p.w, p.h).key);
    } catch {
      // 先に描けなくても、めくった時に描く
    }
  }
  dropAllCanvases(keep);
}

// ---------------------------------------------------------------- 縦スクロール

function teardownScroll() {
  stopAuto();
  if (state.observer) state.observer.disconnect();
  state.observer = null;
  state.slots = [];
  el.stage.classList.remove('scroll');
}

// 枠の高さを、そのページの形に合わせる。画面より上の枠が変わったときは、見えている所がずれないようにする
async function sizeSlot(slot, gen) {
  if (slot.sized) return;
  const s = await shape(slot.n);
  if (gen !== state.gen || slot.sized) return;
  const h = Math.max(1, Math.round(state.scrollWidth / s.ratio));
  const delta = h - slot.h;
  slot.sized = true;
  if (!delta) return;
  const above = slot.el.offsetTop + slot.h <= el.stage.scrollTop;
  slot.el.style.height = `${h}px`;
  slot.h = h;
  if (above) el.stage.scrollTop += delta;
}

async function showSlot(slot, gen) {
  slot.want = true;
  try {
    await sizeSlot(slot, gen);
  } catch {
    return;
  }
  if (gen !== state.gen || !slot.want || slot.entry) return;
  const entry = getCanvas(slot.n, state.scrollWidth, slot.h);
  slot.entry = entry;
  const drawn = await entry.ready;
  if (drawn && slot.entry === entry && slot.want) {
    slot.el.inkInfo = null;
    slot.el.replaceChildren(entry.canvas);
    attachInk(slot.el);
  }
}

function hideSlot(slot) {
  slot.want = false;
  if (!slot.entry) return;
  dropCanvas(slot.entry);
  slot.entry = null;
  slot.el.inkInfo = null;
  slot.el.replaceChildren();
}

function scrollToPage(page) {
  const slot = state.slots[page - 1];
  if (slot) el.stage.scrollTop = Math.max(0, slot.el.offsetTop - SCROLL_PAD);
}

async function buildScroll() {
  const gen = ++state.gen;
  teardownScroll();
  dropAllCanvases();
  const box = { w: el.stage.clientWidth, h: el.stage.clientHeight };
  state.box = box;
  if (!box.w || !box.h) return;
  let guess;
  try {
    guess = (await shape(state.pos.page)).ratio; // ほかのページも、まずは同じ形とみなす
  } catch {
    if (gen === state.gen) showError(`${state.pos.page} ページ目を描けませんでした`);
    return;
  }
  if (gen !== state.gen) return;
  const width = Math.max(1, Math.min(box.w - SCROLL_PAD * 2, SCROLL_MAX_WIDTH));
  const height = Math.max(1, Math.round(width / guess));
  state.scrollWidth = width;
  const column = document.createElement('div');
  column.className = 'column';
  state.slots = [];
  for (let n = 1; n <= state.count; n++) {
    const slot = { n, el: sheetFor(n, width, height), h: height, sized: false, want: false, entry: null };
    state.slots.push(slot);
    column.append(slot.el);
  }
  el.stage.classList.add('scroll');
  setStage([column]);
  el.stage.dataset.drawn = `${box.w}x${box.h}`;
  scrollToPage(state.pos.page);
  // 画面の近くに来たページだけ描き、遠くへ行ったページは片付ける
  state.observer = new IntersectionObserver((records) => {
    for (const record of records) {
      const slot = state.slots[Number(record.target.dataset.page) - 1];
      if (!slot) continue;
      if (record.isIntersecting) showSlot(slot, gen);
      else hideSlot(slot);
    }
  }, { root: el.stage, rootMargin: '50% 0px' });
  for (const slot of state.slots) state.observer.observe(slot.el);
  // 残りのページの高さを、いまのページから近い順に合わせていく
  const order = [];
  for (let n = state.pos.page; n <= state.count; n++) order.push(n);
  for (let n = state.pos.page - 1; n >= 1; n--) order.push(n);
  for (const n of order) {
    try {
      await sizeSlot(state.slots[n - 1], gen);
    } catch {
      // 形が分からないページは、そのままの高さにしておく
    }
    if (gen !== state.gen) return;
  }
}

let scrollTicking = false;

el.stage.addEventListener('scroll', () => {
  if (state.layout !== 'scroll' || scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    if (state.layout !== 'scroll' || !state.slots.length) return;
    // 画面の上から3割の所にあるページを、いまのページとする
    const y = el.stage.scrollTop + el.stage.clientHeight * 0.3;
    let page = 1;
    for (const slot of state.slots) {
      if (slot.el.offsetTop > y) break;
      page = slot.n;
    }
    if (page !== state.pos.page) {
      state.pos = { page, half: false };
      showPosition();
    }
  });
}, { passive: true });

// ---------------------------------------------------------------- 自動スクロール

function stopAuto() {
  if (state.auto) cancelAnimationFrame(state.auto);
  state.auto = 0;
  el.auto.setAttribute('aria-pressed', 'false');
  el.auto.textContent = '自動スクロール';
}

function startAuto() {
  if (state.layout !== 'scroll' || state.auto) return;
  let last = performance.now();
  let rest = 0; // 1画素に満たない分を、次のコマへ持ち越す
  const tick = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    rest += settings.speed * SPEED_STEP * dt;
    const whole = Math.trunc(rest);
    if (whole > 0) {
      rest -= whole;
      el.stage.scrollTop += whole;
      if (el.stage.scrollTop + el.stage.clientHeight >= el.stage.scrollHeight - 1) {
        stopAuto(); // 最後まで行ったら止まる
        return;
      }
    }
    state.auto = requestAnimationFrame(tick);
  };
  state.auto = requestAnimationFrame(tick);
  el.auto.setAttribute('aria-pressed', 'true');
  el.auto.textContent = '自動スクロールを止める';
}

// ---------------------------------------------------------------- 位置とめくり

let saveTimer = 0;

// 前回のページを本棚に書く（めくるたびには書かず、少し待ってから）
function savePage() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const { meta } = state;
  if (!meta || meta.id == null || meta.lastPage === state.pos.page) return;
  meta.lastPage = state.pos.page;
  store.update(meta.id, { lastPage: meta.lastPage }).catch(() => {});
}

// いま開いている PDF のページは、その場でも控える（本棚に書き終わる前にページを閉じても、続きから開けるように）
const LAST_KEY = 'gakufu-viewer:pdf-last';

function rememberPage() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePage, 400);
  const { meta } = state;
  if (!meta || meta.id == null) return;
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: meta.id, name: meta.name, size: meta.size, page: state.pos.page }));
  } catch {
    // 控えられなくても、本棚には書く
  }
}

// 控えたページ（その PDF の控えが無ければ null）
function notedPage(meta) {
  try {
    const noted = JSON.parse(localStorage.getItem(LAST_KEY));
    const same = noted && noted.id === meta.id && noted.name === meta.name && noted.size === meta.size;
    return same && Number.isFinite(noted.page) ? noted.page : null;
  } catch {
    return null;
  }
}

// ページを閉じる・ほかのアプリへ移るときは、待たずに書く
window.addEventListener('pagehide', savePage);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePage();
});

function showPosition() {
  if (!state.doc) {
    el.position.textContent = '';
    el.pager.textContent = '';
    return;
  }
  const pages = visiblePages(state.pos, state.layout, state.count);
  const text = `${pages.join('-')} / ${state.count}`;
  // セットリストの中では、端のページでも、となりの曲があれば めくれる
  const set = playingSet();
  const more = (dir) => Boolean(set) && neighbor(set.items, state.playing.index, dir) >= 0;
  el.position.textContent = text;
  el.pager.textContent = set ? `曲 ${state.playing.index + 1}/${set.items.length}・${text}` : text;
  el.seek.value = String(state.pos.page);
  const scroll = state.layout === 'scroll';
  el.prev.disabled = !scroll && !more(-1) && samePos(step(state.pos, -1, state.layout, state.count, settings.half), state.pos);
  el.next.disabled = !scroll && !more(1) && samePos(step(state.pos, 1, state.layout, state.count, settings.half), state.pos);
  rememberPage();
}

function go(dir) {
  if (!state.doc) return;
  if (state.layout === 'scroll') {
    if ((atScrollEnd(dir) || atRangeEnd(dir)) && crossSong(dir)) return;
    el.stage.scrollBy({ top: dir * el.stage.clientHeight * 0.85, behavior: 'smooth' });
    return;
  }
  if (atRangeEnd(dir) && crossSong(dir)) return; // 曲集の中の曲：その曲のページの端で、となりの曲へ
  const next = step(state.pos, dir, state.layout, state.count, settings.half);
  if (samePos(next, state.pos)) {
    crossSong(dir); // 端のページ：セットリストの中なら、となりの曲へ
    return;
  }
  state.pos = next;
  showPosition();
  drawPaged();
}

function goTo(page) {
  if (!state.doc) return;
  state.pos = normalize({ page, half: false }, state.layout, state.count, settings.half);
  showPosition();
  if (state.layout === 'scroll') scrollToPage(state.pos.page);
  else drawPaged();
}

function applyTouch() {
  // 1ページ・見開きでは、左右にはらう動きをこのページで受け取る（広げて見ているときは、ブラウザに任せて動かせるようにする）
  const zoomed = (window.visualViewport?.scale ?? 1) > 1.01;
  // 書き込み中は、指やペンの動きを全部このページで受け取る（めくるのは「前へ」「次へ」）。
  // 「ペンだけで書く」のときは、指はふだんどおり（ペンで画面が動かないようにするのは、touchstart の所）
  el.stage.style.touchAction = state.inkMode && !settings.penOnly ? 'none' : state.layout === 'scroll' ? 'pan-y pinch-zoom' : zoomed ? 'auto' : 'pinch-zoom';
}

// 表示の形を決め直して、描き直す（開いたとき・設定を変えたとき・画面の大きさが変わったとき）
function relayout() {
  if (!state.doc) return;
  // 「自動」は、画面（窓）の向きで決める。楽譜の場所の形で決めると、操作の欄が高いときに、縦長の画面でも見開きになってしまう
  state.layout = layoutFor(settings.mode, window.innerWidth, window.innerHeight);
  state.pos = normalize(state.pos, state.layout, state.count, settings.half);
  el.autoRow.hidden = state.layout !== 'scroll';
  applyTouch();
  showPosition();
  if (state.layout === 'scroll') {
    buildScroll();
  } else {
    teardownScroll();
    drawPaged();
  }
}

// ---------------------------------------------------------------- 開く・閉じる

function closeDocument() {
  state.gen += 1;
  dropExport();
  savePage();
  saveNotesNow();
  setInkMode(false);
  state.notes = emptyNotes();
  state.undo = [];
  state.outline = null;
  el.inkUndo.disabled = true;
  teardownScroll();
  dropAllCanvases();
  state.bases.clear();
  state.crops.clear();
  state.turn = 0;
  if (state.doc) state.doc.loadingTask.destroy().catch(() => {});
  state.doc = null;
  state.meta = null;
  state.count = 0;
  state.layout = null;
  setStage([]);
}

function setControls(on) {
  el.seek.disabled = !on;
  el.hide.disabled = !on;
  el.marksOpen.disabled = !on;
  el.ink.disabled = !on;
  el.turn.disabled = !on;
  if (!on) {
    el.prev.disabled = true;
    el.next.disabled = true;
  }
}

function openFailure(name, err) {
  const title = titleOf(name);
  if (err && err.name === 'PasswordException') return `「${title}」は、パスワードつきの PDF なので開けません`;
  return `「${title}」を開けませんでした（PDF として読めません）`;
}

// bytes は、pdf.js に渡すと使えなくなる（ワーカーへ移る）。呼ぶ側は、写しを渡す。
// start：開くページ（'last' は最後のページ。無ければ前回のページ）／playing：セットリストの中の位置（無ければ、セットリストから抜ける）
async function openDocument(meta, bytes, { start = null, playing = null } = {}) {
  const token = ++state.openToken;
  setStatus(`「${titleOf(meta.name)}」を開いています…`);
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    worker: sharedWorker ?? undefined,
    cMapUrl: new URL('cmaps/', VENDOR).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
    wasmUrl: new URL('wasm/', VENDOR).href,
    iccUrl: new URL('iccs/', VENDOR).href,
    enableXfa: false,
    isEvalSupported: false,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    task.destroy().catch(() => {});
    if (token === state.openToken) showError(openFailure(meta.name, err));
    return false;
  }
  if (token !== state.openToken) {
    task.destroy().catch(() => {});
    return false;
  }
  // しおりと書き込みを読む（本棚に入っている PDF だけ。読めなければ、空から始める）
  let notes = null;
  if (meta.id != null) notes = await store.notesOf(meta.id).catch(() => null);
  if (token !== state.openToken) {
    task.destroy().catch(() => {});
    return false;
  }
  closeDocument();
  state.doc = doc;
  state.meta = meta;
  state.count = doc.numPages;
  state.notes = cleanNotes(notes, state.count);
  state.turn = cleanTurn(meta.turn);
  const noted = (meta.id != null ? notedPage(meta) : null) ?? meta.lastPage ?? 1;
  state.pos = { page: start === 'last' ? state.count : start ?? noted, half: false };
  el.empty.hidden = true;
  setPlaying(playing);
  el.seek.max = String(state.count);
  setControls(true);
  setStatus('');
  if (meta.id != null) {
    meta.pages = state.count;
    store.update(meta.id, { pages: state.count, opened: Date.now() }).catch(() => {});
  }
  holdWakeLock();
  relayout();
  return true;
}

async function openFromShelf(id, options = {}) {
  let bytes = null;
  let meta = null;
  try {
    meta = (await store.list()).find((m) => m.id === id) ?? null;
    bytes = meta ? await store.bytesOf(id) : null;
  } catch {
    bytes = null;
  }
  if (!meta || !bytes) {
    showError('本棚から読めませんでした。「ファイルを選ぶ」で、もう一度開いてください');
    return false;
  }
  return openDocument(meta, bytes, options);
}

el.file.addEventListener('change', async () => {
  const files = [...el.file.files];
  el.file.value = '';
  if (!files.length) return;
  const problems = [];
  let opened = false;
  for (const file of files) {
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      problems.push(`「${file.name}」を読めませんでした`);
      continue;
    }
    if (!looksLikePdf(new Uint8Array(bytes))) {
      problems.push(`「${file.name}」は PDF ではないので、開けません`);
      continue;
    }
    let meta;
    try {
      meta = await store.put(file.name, bytes);
    } catch {
      // 本棚に入れられない（端末の空きが足りないなど）ときも、開くだけは開く
      meta = { id: null, name: file.name, lastPage: 1 };
      problems.push(`「${file.name}」は本棚に入れられませんでした（端末の空きが足りないかもしれません）`);
    }
    if (opened) continue; // 2本目からは、本棚に入れるだけ
    opened = await openDocument(meta, bytes.slice(0));
    if (!opened) {
      problems.push(el.status.textContent);
      if (meta.id != null) await store.remove(meta.id).catch(() => {}); // 読めなかったものは、本棚に残さない
    }
  }
  if (problems.length) showError(problems.join('／'));
  else if (files.length > 1) setStatus(`${files.length} 本を本棚に入れました`);
});

// ---------------------------------------------------------------- 本棚

async function renderShelf() {
  let items = [];
  let keep = false;
  try {
    items = await store.list();
    keep = await store.persistent();
  } catch {
    items = [];
  }
  el.shelfNote.textContent = keep
    ? 'PDF は、この端末のブラウザの中だけに保存します（外へは送りません）。「消す」で消えるのは、ここに保存した写しだけです。ブラウザのデータを消すと、本棚も空になります。'
    : 'この端末では保存できないので、ページを閉じると本棚は空になります。';
  state.shelf = items;
  drawShelf();
}

// 本棚の一覧を描く（探す言葉と並び順は、欄のいまの値）
function drawShelf() {
  el.shelfTools.hidden = !state.shelf.length;
  const items = findInShelf(state.shelf, el.shelfFind.value, settings.shelfOrder);
  const rows = items.map((meta) => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn shelf-item';
    open.dataset.id = String(meta.id);
    if (state.meta && state.meta.id === meta.id) open.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = titleOf(meta.name);
    const sub = document.createElement('span');
    sub.className = 'sub';
    // いま開いている PDF は、いまのページを出す（本棚に書き終わる前でも、合うように）
    const last = state.meta && state.meta.id === meta.id ? state.pos.page : meta.lastPage ?? 1;
    sub.textContent = meta.pages ? `${meta.pages} ページ・前回は ${last} ページ目` : 'まだ開いていません';
    open.append(name, sub);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn sub shelf-del';
    del.dataset.del = String(meta.id);
    del.dataset.name = titleOf(meta.name);
    del.textContent = '消す';
    li.append(open, del);
    return li;
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = state.shelf.length
      ? `「${el.shelfFind.value.trim()}」に合う PDF は、ありません。`
      : 'まだありません。「ファイルを選ぶ」で開いた PDF が、ここに並びます。';
    rows.push(li);
  }
  el.shelfList.replaceChildren(...rows);
}

function setShelfOpen(open) {
  el.shelf.hidden = !open;
  if (!open) return;
  el.shelfFind.value = ''; // 開くたびに、全部を出す
  renderShelf();
}

el.shelfFind.addEventListener('input', drawShelf);
el.shelfOrder.addEventListener('change', () => {
  settings.shelfOrder = el.shelfOrder.value;
  saveSettings();
  drawShelf();
});

el.shelfOpen.addEventListener('click', () => setShelfOpen(true));
el.shelfClose.addEventListener('click', () => setShelfOpen(false));
el.shelf.addEventListener('click', (e) => {
  if (e.target === el.shelf) setShelfOpen(false); // 外の暗い所を押しても閉じる
});
el.shelfList.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-id]');
  const del = e.target.closest('[data-del]');
  if (open) {
    setShelfOpen(false);
    await openFromShelf(Number(open.dataset.id));
  } else if (del) {
    if (!window.confirm(`「${del.dataset.name}」を本棚から消しますか？（もとのファイルは消えません）`)) return;
    const id = Number(del.dataset.del);
    if (state.meta && state.meta.id === id) {
      clearTimeout(notesTimer); // 開いたままにする。覚え（ページ・しおり・書き込み）は、もう書かない
      notesTimer = 0;
      state.meta.id = null;
    }
    await store.remove(id).catch(() => {});
    await loadSets(); // セットリストからも外れる
    renderShelf();
  }
});

// ---------------------------------------------------------------- 操作

el.prev.addEventListener('click', () => {
  el.prev.blur(); // ペダルのスペースやエンターが、このボタンに入らないようにする
  go(-1);
});
el.next.addEventListener('click', () => {
  el.next.blur();
  go(1);
});
el.seek.addEventListener('input', () => {
  if (state.doc) el.position.textContent = `${el.seek.value} / ${state.count}`;
});
el.seek.addEventListener('change', () => goTo(Number(el.seek.value)));
el.hide.addEventListener('click', () => setBarHidden(true));
el.fold.addEventListener('click', () => {
  settings.folded = !el.toolbar.classList.contains('folded');
  setFolded(settings.folded);
  saveSettings();
});
setFolded(settings.folded);

// 設定を変えた後は、その部品から離れる（そのままだと、キーボードやペダルの入力が、選び欄やチェックに入ってしまう）
for (const control of [el.mode, el.half, el.crop, el.tone, el.seek]) {
  control.addEventListener('change', () => control.blur());
}

el.mode.addEventListener('change', () => {
  settings.mode = el.mode.value;
  saveSettings();
  relayout();
});
el.half.addEventListener('change', () => {
  settings.half = el.half.checked;
  saveSettings();
  relayout();
});
el.crop.addEventListener('change', () => {
  settings.crop = el.crop.checked;
  saveSettings();
  relayout();
});
// 右に回す：横倒しの PDF を直す。全部のページを 90 度ずつ回し、向きは PDF ごとに本棚に覚える
el.turn.addEventListener('click', () => {
  el.turn.blur();
  if (!state.doc) return;
  state.turn = nextTurn(state.turn);
  const { meta } = state;
  meta.turn = state.turn;
  if (meta.id != null) store.update(meta.id, { turn: state.turn }).catch(() => {});
  // 紙の形と余白カットの範囲は、向きで変わる。調べ直して、描き直す
  state.gen += 1;
  dropExport();
  dropAllCanvases();
  state.bases.clear();
  state.crops.clear();
  relayout();
});
el.tone.addEventListener('change', () => {
  settings.tone = el.tone.value;
  el.stage.dataset.tone = settings.tone;
  saveSettings();
});
el.speed.addEventListener('input', () => {
  settings.speed = Number(el.speed.value);
  el.speedOut.textContent = el.speed.value;
  saveSettings();
});
el.auto.addEventListener('click', () => {
  if (state.auto) stopAuto();
  else startAuto();
});

// ---------------------------------------------------------------- しおり・書き込みを保存する

let notesTimer = 0;

function saveNotesNow() {
  if (!notesTimer) return;
  clearTimeout(notesTimer);
  notesTimer = 0;
  const { meta } = state;
  if (meta && meta.id != null) store.saveNotes(meta.id, state.notes).catch(() => {});
}

// 変えたら、少し待ってから保存する（本棚に入っていない PDF は、開いている間だけ覚える）
function notesChanged() {
  dropExport(); // 作ってあった書き出しは、古くなる
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveNotesNow, NOTES_SAVE_MS);
}

window.addEventListener('pagehide', saveNotesNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNotesNow();
});

// ---------------------------------------------------------------- しおり

function shelfRow(title, sub, data, level = 0) {
  const open = document.createElement('button');
  open.type = 'button';
  open.className = level ? `btn shelf-item level-${Math.min(level, 2)}` : 'btn shelf-item';
  Object.assign(open.dataset, data);
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = title;
  const small = document.createElement('span');
  small.className = 'sub';
  small.textContent = sub;
  open.append(name, small);
  return open;
}

function hintRow(text) {
  const li = document.createElement('li');
  li.className = 'hint';
  li.textContent = text;
  return li;
}

// PDF に入っている目次を読む（[{ title, page, level }]。無ければ空）
async function readOutline(doc) {
  const out = [];
  const walk = async (items, level) => {
    for (const item of items ?? []) {
      if (out.length >= 300) return;
      try {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        const target = Array.isArray(dest) ? dest[0] : null;
        const index = target && typeof target === 'object' ? await doc.getPageIndex(target) : target;
        if (Number.isInteger(index)) out.push({ title: String(item.title ?? '').trim() || `${index + 1} ページ目`, page: index + 1, level });
      } catch {
        // 行き先の分からない項目は、出さない
      }
      if (level < 2) await walk(item.items, level + 1);
    }
  };
  try {
    await walk(await doc.getOutline(), 0);
  } catch {
    return [];
  }
  return out;
}

function renderMarks() {
  const rows = state.notes.marks.map((mark) => {
    const li = document.createElement('li');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn sub shelf-del';
    del.dataset.delMark = String(mark.page);
    del.textContent = '消す';
    li.append(shelfRow(mark.name, `${mark.page} ページ目`, { page: String(mark.page) }), del);
    return li;
  });
  if (!rows.length) rows.push(hintRow('まだありません。名前を入れて「いまのページに付ける」を押すと、ここに並びます（押すと、そのページへ飛びます）。'));
  el.marksList.replaceChildren(...rows);
  el.markAdd.textContent = `いまのページ（${state.pos.page}）に付ける`;
}

function renderOutline() {
  const items = state.outline ?? [];
  el.outlineTitle.hidden = !items.length;
  el.outlineList.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    li.append(shelfRow(item.title, `${item.page} ページ目`, { page: String(item.page) }, item.level));
    return li;
  }));
}

function setMarksOpen(open) {
  el.marks.hidden = !open;
  if (!open || !state.doc) return;
  renderMarks();
  renderOutline();
  if (state.outline === null) {
    const doc = state.doc;
    readOutline(doc).then((items) => {
      if (state.doc !== doc) return;
      state.outline = items;
      renderOutline();
    });
  }
}

function addMark() {
  if (!state.doc) return;
  state.notes.marks = withMark(state.notes.marks, state.pos.page, el.markName.value);
  el.markName.value = '';
  notesChanged();
  renderMarks();
}

el.marksOpen.addEventListener('click', () => setMarksOpen(true));
el.marksClose.addEventListener('click', () => setMarksOpen(false));
el.marks.addEventListener('click', (e) => {
  if (e.target === el.marks) setMarksOpen(false);
});
el.markAdd.addEventListener('click', addMark);
el.markName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addMark();
});
el.marks.addEventListener('click', (e) => {
  const jump = e.target.closest('[data-page]');
  const del = e.target.closest('[data-del-mark]');
  if (jump) {
    setMarksOpen(false);
    goTo(Number(jump.dataset.page));
  } else if (del) {
    const page = Number(del.dataset.delMark);
    state.notes.marks = state.notes.marks.filter((m) => m.page !== page);
    notesChanged();
    renderMarks();
  }
});

// ---------------------------------------------------------------- セットリスト（本番の曲順）

const SET_KEY = 'gakufu-viewer:pdf-set';

function playingSet() {
  return state.playing ? state.sets.find((s) => s.id === state.playing.id) ?? null : null;
}

// 題名。セットリストの中では、頭に「何曲目/全部の曲数」を付ける
function showTitle() {
  if (!state.meta) return;
  const set = playingSet();
  const title = titleOf(state.meta.name);
  el.title.textContent = set ? `${state.playing.index + 1}/${set.items.length} ${title}` : title;
}

// いま開いている曲が、どのセットリストの何曲目か（セットリストの外なら null）。開き直しても続けられるように、控える
function setPlaying(playing) {
  state.playing = playing;
  try {
    if (playing) localStorage.setItem(SET_KEY, JSON.stringify(playing));
    else localStorage.removeItem(SET_KEY);
  } catch {
    // 控えられなくても、そのまま使える
  }
  showTitle();
  if (state.doc && state.layout) showPosition();
}

// 控えたセットリストの位置（その位置の曲が、この PDF でなければ null）
function notedSet(pdfId) {
  try {
    const noted = JSON.parse(localStorage.getItem(SET_KEY));
    const set = noted ? state.sets.find((s) => s.id === noted.id) : null;
    return set && itemId(set.items[noted.index]) === pdfId ? { id: set.id, index: noted.index } : null;
  } catch {
    return null;
  }
}

// セットリストと本棚を読み直す（本棚に無い曲は外れる）。いま開いている曲の位置も、合わせ直す
async function loadSets() {
  let shelf = [];
  let rows = [];
  try {
    shelf = await store.list();
    rows = await store.sets();
  } catch {
    rows = [];
  }
  state.shelf = shelf;
  state.sets = cleanSets(rows, shelf.map((m) => m.id));
  if (!state.playing) return;
  const set = playingSet();
  const index = set && state.meta && state.meta.id != null ? locate(set.items, state.playing.index, state.meta.id) : -1;
  setPlaying(index < 0 ? null : { id: set.id, index });
}

// セットリストの index 曲目を開く。start：'first'＝その曲の頭・'last'＝その曲の最後のページ
async function openSetSong(set, index, start = 'first') {
  const item = set.items[index];
  const id = itemId(item);
  const playing = { id: set.id, index };
  if (state.doc && state.meta && state.meta.id === id) {
    // 同じ PDF の中（曲集の、となりの曲など）：開き直さずに、そのページへ
    setPlaying(playing);
    const range = itemRange(item, state.count);
    goTo(start === 'last' ? range.to : range.from);
    return true;
  }
  const page = typeof item === 'number' ? (start === 'last' ? 'last' : 1) : start === 'last' ? item.to ?? 'last' : item.from;
  state.crossing = true;
  try {
    return await openFromShelf(id, { start: page, playing });
  } finally {
    state.crossing = false;
  }
}

// 曲集の中の曲（ページの範囲がある曲）で、その範囲の端にいるか（dir：1＝終わりの側・-1＝始めの側）
function atRangeEnd(dir) {
  const set = playingSet();
  const item = set ? set.items[state.playing.index] : null;
  if (!item || typeof item !== 'object') return false;
  const { from, to } = itemRange(item, state.count);
  if (state.layout === 'scroll') {
    const sheet = el.stage.querySelector(`.sheet[data-page="${dir > 0 ? to : from}"]`);
    if (!sheet) return false;
    const r = sheet.getBoundingClientRect();
    const box = el.stage.getBoundingClientRect();
    return dir > 0 ? r.bottom <= box.bottom + 2 : r.top >= box.top - 2;
  }
  const next = step(state.pos, dir, state.layout, state.count, settings.half);
  const shown = visiblePages(next, state.layout, state.count);
  return dir > 0 ? Math.min(...shown) > to : Math.max(...shown) < from;
}

// セットリストの、となりの曲へ移る（次の曲は頭から・前の曲は最後のページから）。となりの曲があれば true
function crossSong(dir) {
  const set = playingSet();
  if (!set) return false;
  const to = neighbor(set.items, state.playing.index, dir);
  if (to < 0) return false;
  if (!state.crossing) openSetSong(set, to, dir < 0 ? 'last' : 'first'); // 開いている途中に、もう一度押しても、曲を飛ばさない
  return true;
}

// 縦スクロールで、端まで来ているか
function atScrollEnd(dir) {
  const { scrollTop, scrollHeight, clientHeight } = el.stage;
  return dir > 0 ? scrollTop + clientHeight >= scrollHeight - 2 : scrollTop <= 1;
}

function setButton(text, label, data) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn sub set-move';
  button.textContent = text;
  if (label) button.setAttribute('aria-label', label);
  Object.assign(button.dataset, data);
  return button;
}

// セットリストの欄：一覧（editing が null）か、1つのセットリストの中身
function renderSets() {
  const set = state.sets.find((s) => s.id === state.editing) ?? null;
  if (!set) state.editing = null;
  el.setsBack.hidden = !set;
  el.setsNew.hidden = Boolean(set);
  el.setSongs.hidden = !set;
  el.setsTitle.textContent = set ? set.name : 'セットリスト';
  const rows = [];
  if (!set) {
    el.setsNote.textContent = '本番の曲順に、本棚の PDF を並べておけます。名前を入れて「作る」を押してください。';
    el.setAdd.disabled = state.sets.length >= MAX_SETS;
    for (const item of state.sets) {
      const li = document.createElement('li');
      const open = shelfRow(item.name, `${item.items.length} 曲`, { set: String(item.id) });
      if (state.playing && state.playing.id === item.id) open.setAttribute('aria-current', 'true');
      li.append(open, setButton('消す', '', { delSet: String(item.id), name: item.name }));
      rows.push(li);
    }
    if (!rows.length) rows.push(hintRow('まだありません。'));
  } else {
    el.setsNote.textContent = '曲を押すと、その曲の頭から開きます。最後のページで「次へ」を押すと次の曲へ、最初のページで「前へ」を押すと前の曲の最後へ移ります。曲集の PDF は、「始め」「終わり」のページを入れて足すと、その曲だけを1曲として並べられます。';
    const byId = new Map(state.shelf.map((m) => [m.id, m]));
    set.items.forEach((item, i) => {
      const meta = byId.get(itemId(item));
      if (!meta) return;
      const li = document.createElement('li');
      const pages = rangeText(item) || (meta.pages ? `${meta.pages} ページ` : '');
      const open = shelfRow(titleOf(meta.name), pages ? `${i + 1} 曲目・${pages}` : `${i + 1} 曲目`, { song: String(i) });
      if (state.playing && state.playing.id === set.id && state.playing.index === i) open.setAttribute('aria-current', 'true');
      const up = setButton('↑', '前へ動かす', { move: String(i), dir: '-1' });
      up.disabled = i === 0;
      const down = setButton('↓', '後ろへ動かす', { move: String(i), dir: '1' });
      down.disabled = i === set.items.length - 1;
      li.append(open, up, down, setButton('外す', '', { out: String(i) }));
      rows.push(li);
    });
    if (!rows.length) {
      rows.push(hintRow(state.shelf.length
        ? 'まだ曲がありません。下の欄で本棚の PDF を選んで「足す」を押してください。'
        : '本棚が空です。先に「ファイルを選ぶ」で、PDF を開いてください。'));
    }
    // 足す曲の選び欄（本棚から。名前の順）。まだ入れていない曲を、先に選んでおく
    const shelf = [...state.shelf].sort((a, b) => titleOf(a.name).localeCompare(titleOf(b.name), 'ja'));
    el.setSong.replaceChildren(...shelf.map((m) => {
      const option = document.createElement('option');
      option.value = String(m.id);
      option.textContent = titleOf(m.name);
      return option;
    }));
    const fresh = shelf.find((m) => !set.items.some((item) => itemId(item) === m.id));
    if (fresh) el.setSong.value = String(fresh.id);
    el.setSong.disabled = !shelf.length;
    el.setSongAdd.disabled = !shelf.length || set.items.length >= MAX_SONGS;
  }
  el.setsList.replaceChildren(...rows);
}

async function setSetsOpen(open) {
  el.sets.hidden = !open;
  if (!open) return;
  if (state.playing) state.editing = state.playing.id; // セットリストの中にいるときは、そのセットリストから出す
  renderSets(); // 前に開いたときの中身が残らないように、まず、いま分かっている中身で出す
  await loadSets();
  renderSets();
}

async function addSet() {
  if (state.sets.length >= MAX_SETS) return;
  const row = await store.saveSet({ name: setName(el.setName.value, state.sets.length + 1), items: [] }).catch(() => null);
  if (!row) return;
  el.setName.value = '';
  await loadSets();
  state.editing = row.id; // 作ったら、そのまま曲を足せるように、中を出す
  renderSets();
}

// セットリストの曲の並びを書き換える。reindex：いま開いている曲の、新しい位置（外したら -1）
async function changeSet(set, items, reindex = (index) => index) {
  const next = { ...set, items };
  state.sets = state.sets.map((s) => (s.id === set.id ? next : s));
  if (state.playing && state.playing.id === set.id) {
    const index = reindex(state.playing.index);
    setPlaying(index < 0 ? null : { id: set.id, index });
  }
  renderSets();
  await store.saveSet(next).catch(() => {});
}

el.setsOpen.addEventListener('click', () => setSetsOpen(true));
el.setsClose.addEventListener('click', () => setSetsOpen(false));
el.sets.addEventListener('click', (e) => {
  if (e.target === el.sets) setSetsOpen(false);
});
el.setsBack.addEventListener('click', () => {
  state.editing = null;
  renderSets();
});
el.setAdd.addEventListener('click', addSet);
el.setName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSet();
});
el.setSongAdd.addEventListener('click', () => {
  const set = state.sets.find((s) => s.id === state.editing);
  const id = Number(el.setSong.value);
  if (!set || !state.shelf.some((m) => m.id === id) || set.items.length >= MAX_SONGS) return;
  changeSet(set, [...set.items, makeItem(id, el.setFrom.value, el.setTo.value)]);
  el.setFrom.value = '';
  el.setTo.value = '';
});
el.setsList.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-set]');
  const del = e.target.closest('[data-del-set]');
  const song = e.target.closest('[data-song]');
  const move = e.target.closest('[data-move]');
  const out = e.target.closest('[data-out]');
  const set = state.sets.find((s) => s.id === state.editing) ?? null;
  if (open) {
    state.editing = Number(open.dataset.set);
    renderSets();
  } else if (del) {
    if (!window.confirm(`セットリスト「${del.dataset.name}」を消しますか？（PDF は本棚に残ります）`)) return;
    await store.removeSet(Number(del.dataset.delSet)).catch(() => {});
    await loadSets();
    renderSets();
  } else if (song && set) {
    setSetsOpen(false);
    await openSetSong(set, Number(song.dataset.song));
  } else if (move && set) {
    const index = Number(move.dataset.move);
    const dir = Number(move.dataset.dir);
    changeSet(set, moved(set.items, index, dir), (current) => indexAfterMove(current, index, dir, set.items.length));
  } else if (out && set) {
    const index = Number(out.dataset.out);
    changeSet(set, without(set.items, index), (current) => indexAfterRemove(current, index));
  }
});

// ---------------------------------------------------------------- 書き込み

function setTool(tool) {
  settings.tool = tool;
  for (const button of el.inkTools) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
}

function setInkMode(on) {
  state.inkMode = on;
  el.ink.setAttribute('aria-pressed', String(on));
  el.ink.textContent = on ? '書き込みを終える' : '書き込み';
  el.inkRow.hidden = !on;
  document.body.classList.toggle('inking', on);
  if (on) {
    stopAuto();
    setBarHidden(false); // 書き込み中は、操作の欄を出したままにする（めくるボタンと道具を使うため）
  }
  el.hide.disabled = on || !state.doc;
  applyTouch();
}

// 「ペンだけで書く」：Apple Pencil で書き、指ではめくる・動かす
function setPenOnly(on) {
  settings.penOnly = on;
  el.penOnly.checked = on;
  document.body.classList.toggle('pen-only', on);
  el.inkHint.textContent = on ? 'ペンで書きます。指のタップ・はらう動きで、めくれます' : '書き込み中は「前へ」「次へ」でめくります';
  applyTouch();
}

// この指（またはペン・マウス）の動きで、書くかどうか
function writes(e) {
  return state.inkMode && (!settings.penOnly || e.pointerType === 'pen');
}

el.penOnly.addEventListener('change', () => {
  settings.penSeen = true; // 自分で切り替えたら、あとは自動で入れない
  setPenOnly(el.penOnly.checked);
  saveSettings();
  el.penOnly.blur();
});
setPenOnly(settings.penOnly);

// ペンで画面が動かないようにする（縦スクロール・広げて見ているとき。iPad の Safari は、Apple Pencil を touchType 'stylus' で知らせる）
function stylusIn(list) {
  return [...list].some((t) => t.touchType === 'stylus');
}
for (const type of ['touchstart', 'touchmove']) {
  el.stage.addEventListener(type, (e) => {
    if (state.inkMode && settings.penOnly && stylusIn(e.changedTouches)) e.preventDefault();
  }, { passive: false });
}

function pushUndo(op) {
  state.undo.push(op);
  if (state.undo.length > 100) state.undo.shift();
  el.inkUndo.disabled = false;
  notesChanged();
}

function strokesOf(n) {
  state.notes.ink[n] ??= [];
  return state.notes.ink[n];
}

function undoInk() {
  const op = state.undo.pop();
  el.inkUndo.disabled = !state.undo.length;
  if (!op) return;
  if (op.type === 'add') {
    const list = strokesOf(op.n);
    const at = list.indexOf(op.stroke);
    if (at >= 0) list.splice(at, 1);
  } else if (op.type === 'remove') {
    const list = strokesOf(op.n);
    for (const item of [...op.items].reverse()) list.splice(Math.min(item.index, list.length), 0, item.stroke);
  } else if (op.type === 'clear') {
    for (const [n, list] of op.pages) state.notes.ink[n] = list;
  }
  notesChanged();
  repaintInk();
}

// いま出ているページの書き込みを、全部消す（「元に戻す」で戻せる）
function clearInk() {
  if (!state.doc) return;
  const pages = visiblePages(state.pos, state.layout, state.count)
    .filter((n) => (state.notes.ink[n] ?? []).length)
    .map((n) => [n, state.notes.ink[n]]);
  if (!pages.length) return;
  for (const [n] of pages) delete state.notes.ink[n];
  pushUndo({ type: 'clear', pages });
  repaintInk();
}

el.ink.addEventListener('click', () => setInkMode(!state.inkMode));
for (const button of el.inkTools) {
  button.addEventListener('click', () => {
    setTool(button.dataset.tool);
    saveSettings();
  });
}
el.inkUndo.addEventListener('click', undoInk);
el.inkClear.addEventListener('click', clearInk);
setTool(settings.tool);

let drawing = null; // 書いている途中（{ id, sheet, stroke } か、消しゴムなら { id, sheet, removed }）
let inkFrame = 0;
let penAt = -Infinity; // 最後にペンが触れていた時刻（手のひらでめくらないように）

function inkPoint(sheet, e) {
  const rect = sheet.getBoundingClientRect();
  return toPage((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, sheet.inkInfo.crop, sheet.inkInfo.turn);
}

function eraseAt(x, y) {
  const { sheet, removed } = drawing;
  const list = strokesOf(sheet.inkInfo.n);
  for (let i = list.length - 1; i >= 0; i--) {
    if (hitStroke(list[i], x, y, sheet.inkInfo.aspect, ERASER_REACH)) removed.push({ index: i, stroke: list.splice(i, 1)[0] });
  }
}

function inkMove(e) {
  const [x, y] = inkPoint(drawing.sheet, e);
  if (drawing.removed) eraseAt(x, y);
  else addPoint(drawing.stroke.p, x, y);
}

function paintLive() {
  if (inkFrame || !drawing) return;
  inkFrame = requestAnimationFrame(() => {
    inkFrame = 0;
    if (drawing) paintInk(drawing.sheet, drawing.stroke ?? null);
  });
}

el.stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') penAt = performance.now();
  // はじめて Apple Pencil で書いたら、「ペンだけで書く」にする（指でめくれるように）。自分で切り替えた後は、入れない
  if (state.inkMode && e.pointerType === 'pen' && !settings.penOnly && !settings.penSeen) {
    settings.penSeen = true;
    setPenOnly(true);
    saveSettings();
  }
  if (!writes(e) || !state.doc || drawing || e.button > 0) return;
  const sheet = e.target instanceof Element ? e.target.closest('.sheet') : null;
  if (!sheet || !sheet.inkInfo) return;
  e.preventDefault();
  drawing = settings.tool === ERASER ? { id: e.pointerId, sheet, removed: [] } : { id: e.pointerId, sheet, stroke: { t: settings.tool, p: [] } };
  inkMove(e);
  try {
    el.stage.setPointerCapture(e.pointerId);
  } catch {
    // つかめなくても、紙の上では書ける
  }
  paintInk(sheet, drawing.stroke ?? null);
});
el.stage.addEventListener('pointermove', (e) => {
  if (!drawing || e.pointerId !== drawing.id) return;
  const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  for (const one of events.length ? events : [e]) inkMove(one);
  paintLive();
});

function endInk(e) {
  if (e.pointerType === 'pen') penAt = performance.now();
  if (!drawing || e.pointerId !== drawing.id) return;
  const { sheet, stroke, removed } = drawing;
  drawing = null;
  const n = sheet.inkInfo.n;
  if (stroke && stroke.p.length >= 2) {
    strokesOf(n).push(stroke);
    pushUndo({ type: 'add', n, stroke });
  } else if (removed && removed.length) {
    pushUndo({ type: 'remove', n, items: removed });
  }
  repaintInk([n]);
}

el.stage.addEventListener('pointerup', endInk);
el.stage.addEventListener('pointercancel', endInk);

// ---------------------------------------------------------------- 書き込みつきの PDF を書き出す
// 1ページずつ、紙と書き込みを重ねて絵に描き、PDF にまとめる（回した向きのまま。余白カット・色は使わない）。
// 作り終えたら「保存・共有する」を出す（iPad の共有は、押した直後でないと断られるため、ボタンを分ける）

let exporting = 0; // 作っている途中の番号（0 なら作っていない）

function dropExport() {
  state.exported = null;
  el.exportSave.hidden = true;
  if (exporting) exporting = 0; // 作っている途中なら、やめる
  el.exportPdf.disabled = false;
}

async function exportPdf() {
  if (!state.doc || exporting) return;
  const job = Date.now();
  exporting = job;
  state.exported = null;
  el.exportSave.hidden = true;
  el.exportPdf.disabled = true;
  const { doc, count, turn } = state; // 閉じた・回したときは、dropExport で取り消す
  const title = titleOf(state.meta.name);
  const pages = [];
  const canvas = document.createElement('canvas');
  try {
    for (let n = 1; n <= count; n++) {
      if (exporting !== job || doc !== state.doc) return;
      setStatus(`書き込みつきの PDF を作っています… ${n} / ${count} ページ`);
      const { page, w, h, rotation } = await basePage(n);
      const size = exportPixels(w, h, EXPORT_SIDE);
      canvas.width = size.w;
      canvas.height = size.h;
      const ctx = canvas.getContext('2d');
      const viewport = page.getViewport({ scale: size.w / w, rotation });
      await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
      drawStrokes(ctx, state.notes.ink[n] ?? [], canvas.width, canvas.height, FULL, turn);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', EXPORT_QUALITY));
      if (!blob) throw new Error('絵にできませんでした');
      pages.push({ width: w, height: h, image: { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height } });
    }
    if (exporting !== job || doc !== state.doc) return;
    state.exported = new File([buildPdf(pages)], exportName(title), { type: 'application/pdf' });
    el.exportSave.hidden = false;
    setStatus(`できました（${count} ページ・${Math.max(1, Math.round(state.exported.size / 1048576))} MB）。「保存・共有する」を押してください`);
  } catch {
    if (exporting === job) showError('書き込みつきの PDF を作れませんでした');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    if (exporting === job) {
      exporting = 0;
      el.exportPdf.disabled = false;
    }
  }
}

async function saveExport() {
  const file = state.exported;
  if (!file) return;
  // iPad・iPhone：共有の画面から「"ファイル"に保存」や AirDrop へ。共有できないとき（PC・枠の中など）は、ダウンロードする
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // 共有の画面を閉じただけ
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

el.exportPdf.addEventListener('click', exportPdf);
el.exportSave.addEventListener('click', saveExport);

// ---------------------------------------------------------------- メトロノーム

let beatTimer = 0;

const metronome = createMetronome((beat) => {
  el.beatDot.classList.add('on');
  el.beatDot.classList.toggle('first', beat === 0);
  el.pager.classList.add('beat');
  clearTimeout(beatTimer);
  beatTimer = setTimeout(() => {
    el.beatDot.classList.remove('on', 'first');
    el.pager.classList.remove('beat');
  }, 90);
});

function setMetronome(on) {
  if (on) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iPad の消音モードでも鳴るように（Safari 16.4 以降）
    } catch {
      // 対応していない端末では何もしない
    }
    metronome.set(settings.bpm, settings.beats);
    try {
      metronome.start();
    } catch {
      showError('この端末では、メトロノームを鳴らせません');
      return;
    }
  } else {
    metronome.stop();
  }
  el.metro.setAttribute('aria-pressed', String(metronome.running));
  el.metro.textContent = metronome.running ? 'メトロノームを止める' : 'メトロノーム';
}

function setBpm(value) {
  settings.bpm = clampBpm(value, settings.bpm);
  el.bpm.value = String(settings.bpm);
  metronome.set(settings.bpm, settings.beats);
  saveSettings();
}

el.metro.addEventListener('click', () => {
  el.metro.blur();
  setMetronome(!metronome.running);
});
el.bpm.addEventListener('change', () => {
  setBpm(el.bpm.value);
  el.bpm.blur();
});
el.bpmDown.addEventListener('click', () => setBpm(settings.bpm - 4));
el.bpmUp.addEventListener('click', () => setBpm(settings.bpm + 4));
el.beats.addEventListener('change', () => {
  settings.beats = Number(el.beats.value);
  metronome.set(settings.bpm, settings.beats);
  saveSettings();
  el.beats.blur();
});

// タップ：右＝次・左＝前・真ん中＝操作の欄を出す／かくす。左右にはらっても、めくれる
// 書き込み中は、書く動きでは、めくらない（「ペンだけで書く」のときは、指でめくれる）
let pointerStart = null;
let swiped = false;
let inkTap = false; // 書き込み中に、指でめくってよいタップだったか

// ペンで書いている途中か、離したすぐ後か（このときの指は、手のひらとみなす）
function penBusy() {
  return Boolean(drawing) || performance.now() - penAt < PEN_REST;
}

el.stage.addEventListener('pointerdown', (e) => {
  inkTap = false;
  if (writes(e) || (state.inkMode && penBusy())) {
    pointerStart = null;
    return;
  }
  pointerStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  swiped = false;
});
el.stage.addEventListener('pointerup', (e) => {
  const start = pointerStart;
  pointerStart = null;
  if (start && state.inkMode) inkTap = performance.now() - start.t < TAP_MAX && !penBusy();
  if (!start || !state.doc || state.layout === 'scroll') return;
  if (state.inkMode && penBusy()) return;
  if ((window.visualViewport?.scale ?? 1) > 1.01) return; // 広げて見ているときは、めくらない
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
    swiped = true;
    go(dx < 0 ? 1 : -1);
  }
});
el.stage.addEventListener('pointercancel', () => {
  pointerStart = null;
});
el.stage.addEventListener('click', (e) => {
  if (swiped) {
    swiped = false;
    return;
  }
  if (!state.doc) return;
  if (state.inkMode && !inkTap) return;
  inkTap = false;
  const rect = el.stage.getBoundingClientRect();
  const zone = zoneAt(e.clientX - rect.left, rect.width);
  if (zone === 'menu' && state.inkMode) return; // 書き込み中は、操作の欄を出したまま
  if (zone !== 'menu') {
    go(zone === 'next' ? 1 : -1);
  } else if (state.auto) {
    stopAuto(); // 自動スクロール中は、真ん中のタップで止めて、操作の欄を出す
    setBarHidden(false);
  } else {
    setBarHidden(!document.body.classList.contains('bar-hidden'));
  }
});

const NEXT_KEYS = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
const PREV_KEYS = ['ArrowLeft', 'ArrowUp', 'PageUp'];

document.addEventListener('keydown', (e) => {
  if (!state.doc || panelOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
  const tag = e.target instanceof Element ? e.target.tagName : '';
  if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'checkbox')) return;
  if ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT')) return;
  if (NEXT_KEYS.includes(e.key)) go(1);
  else if (PREV_KEYS.includes(e.key)) go(-1);
  else if (e.key === 'Home') goTo(1);
  else if (e.key === 'End') goTo(state.count);
  else return;
  e.preventDefault();
});

// 画面の大きさが変わったら（向きを変えた・操作の欄を出した／かくした）、描き直す
let resizeTimer = 0;

new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.doc) return;
    if (el.stage.clientWidth === state.box.w && el.stage.clientHeight === state.box.h) return;
    relayout();
  }, 120);
}).observe(el.stage);

if (window.visualViewport) window.visualViewport.addEventListener('resize', applyTouch);

// ---------------------------------------------------------------- はじめ

// 枠の中（コード進行練習補助のタブ）で開いているときは、MusicXML のページへの行き来を出さない（タブで切り替える）。
// 代わりに、このページだけを別のタブで開く入口を出す（画面を広く使える。本棚も、そちらのほうが残りやすい）
if (window.top === window.self) el.toMxml.hidden = false;
else el.alone.hidden = false;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(
    () => navigator.serviceWorker.ready.then(() => {
      el.offline.textContent = 'この端末に保存済み（電波が無くても開けます）';
    }),
    () => {
      // 保存できない環境（プライベートブラウズなど）では、ふつうに使う
    },
  );
}

// 残しておいてもらえるように頼む（断られても、そのまま使える）
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

setControls(false);
setStatus('');
// 本棚にあれば、最後に開いた PDF を、前回のページから開く
// （セットリストの途中だったら、その続きとして開く）
store.list().then(async (items) => {
  if (!items.length) return false;
  await loadSets();
  if (state.doc || state.openToken !== 0) return false;
  return openFromShelf(items[0].id, { playing: notedSet(items[0].id) });
}).catch(() => {});
