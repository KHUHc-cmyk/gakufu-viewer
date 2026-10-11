// PDF の楽譜の画面。PDF はブラウザの中で読むだけで、外へは送らない（本棚も、この端末の中）。
import * as pdfjs from '../vendor/pdfjs/pdf.mjs';
import { FULL, layoutFor, normalize, visiblePages, step, fit, pixelRatioFor, findCrop, zoneAt, looksLikePdf, titleOf } from './pdf-layout.js';
import * as store from './pdf-store.js';

const $ = (id) => document.getElementById(id);
const el = {
  file: $('file'),
  shelfOpen: $('shelf-open'),
  toMxml: $('to-mxml'),
  alone: $('alone'),
  title: $('title'),
  status: $('status'),
  prev: $('prev'),
  next: $('next'),
  seek: $('seek'),
  position: $('position'),
  hide: $('hide'),
  mode: $('mode'),
  half: $('half'),
  crop: $('crop'),
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

// ---------------------------------------------------------------- 設定を覚える（この端末の中だけ）

const SETTINGS_KEY = 'gakufu-viewer:pdf-settings';
const settings = { mode: 'auto', half: false, crop: false, tone: 'plain', speed: 4 };

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
  crops: new Map(), // ページ番号 → 余白カットの範囲
  canvases: new Map(), // 鍵 → 描いたキャンバス
  slots: [], // 縦スクロールの、ページごとの枠
  scrollWidth: 0,
  observer: null,
  auto: 0, // 自動スクロールの requestAnimationFrame の番号
  box: { w: 0, h: 0 }, // 最後に描いたときの、表示の場所の大きさ
};

window.__pdf = { state, settings }; // 画面のテスト用

function setStatus(text) {
  el.status.textContent = text;
}

function setBarHidden(hidden) {
  document.body.classList.toggle('bar-hidden', hidden);
  el.pager.hidden = !hidden || !state.doc;
}

function showError(text) {
  setBarHidden(false); // かくしていても、知らせは見えるようにする
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
    base = state.doc.getPage(n).then((page) => {
      const view = page.getViewport({ scale: 1 });
      return { page, w: view.width, h: view.height };
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
    crop = basePage(n).then(async ({ page, w, h }) => {
      const viewport = page.getViewport({ scale: CROP_SIDE / Math.max(w, h) });
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
  const key = `${n}:${w}x${h}:${settings.crop ? 'cut' : 'full'}`;
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
    const viewport = s.page.getViewport({ scale, offsetX: -s.crop.l * s.w * scale, offsetY: -s.crop.t * s.h * scale });
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
  if (pos.half && sheets.length === 2) {
    // 半ページめくりの途中：上半分に次のページ、下半分にいまのページ
    const divider = document.createElement('div');
    divider.className = 'divider';
    setStage([layerOf('bottom', [sheets[0]]), layerOf('top', [sheets[1]]), divider]);
  } else {
    setStage([layerOf('', sheets)]);
  }
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
  if (drawn && slot.entry === entry && slot.want) slot.el.replaceChildren(entry.canvas);
}

function hideSlot(slot) {
  slot.want = false;
  if (!slot.entry) return;
  dropCanvas(slot.entry);
  slot.entry = null;
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
  el.position.textContent = text;
  el.pager.textContent = text;
  el.seek.value = String(state.pos.page);
  const scroll = state.layout === 'scroll';
  el.prev.disabled = !scroll && samePos(step(state.pos, -1, state.layout, state.count, settings.half), state.pos);
  el.next.disabled = !scroll && samePos(step(state.pos, 1, state.layout, state.count, settings.half), state.pos);
  rememberPage();
}

function go(dir) {
  if (!state.doc) return;
  if (state.layout === 'scroll') {
    el.stage.scrollBy({ top: dir * el.stage.clientHeight * 0.85, behavior: 'smooth' });
    return;
  }
  const next = step(state.pos, dir, state.layout, state.count, settings.half);
  if (samePos(next, state.pos)) return;
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
  el.stage.style.touchAction = state.layout === 'scroll' ? 'pan-y pinch-zoom' : zoomed ? 'auto' : 'pinch-zoom';
}

// 表示の形を決め直して、描き直す（開いたとき・設定を変えたとき・画面の大きさが変わったとき）
function relayout() {
  if (!state.doc) return;
  state.layout = layoutFor(settings.mode, el.stage.clientWidth, el.stage.clientHeight);
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
  savePage();
  teardownScroll();
  dropAllCanvases();
  state.bases.clear();
  state.crops.clear();
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

// bytes は、pdf.js に渡すと使えなくなる（ワーカーへ移る）。呼ぶ側は、写しを渡す
async function openDocument(meta, bytes) {
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
  closeDocument();
  state.doc = doc;
  state.meta = meta;
  state.count = doc.numPages;
  state.pos = { page: (meta.id != null ? notedPage(meta) : null) ?? meta.lastPage ?? 1, half: false };
  el.empty.hidden = true;
  el.title.textContent = titleOf(meta.name);
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

async function openFromShelf(id) {
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
  return openDocument(meta, bytes);
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
    sub.textContent = meta.pages ? `${meta.pages} ページ・前回は ${meta.lastPage ?? 1} ページ目` : 'まだ開いていません';
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
    li.textContent = 'まだありません。「ファイルを選ぶ」で開いた PDF が、ここに並びます。';
    rows.push(li);
  }
  el.shelfList.replaceChildren(...rows);
}

function setShelfOpen(open) {
  el.shelf.hidden = !open;
  if (open) renderShelf();
}

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
    await store.remove(id).catch(() => {});
    if (state.meta && state.meta.id === id) state.meta.id = null; // 開いたままにする。覚えは、もう書かない
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

// タップ：右＝次・左＝前・真ん中＝操作の欄を出す／かくす。左右にはらっても、めくれる
let pointerStart = null;
let swiped = false;

el.stage.addEventListener('pointerdown', (e) => {
  pointerStart = { x: e.clientX, y: e.clientY };
  swiped = false;
});
el.stage.addEventListener('pointerup', (e) => {
  const start = pointerStart;
  pointerStart = null;
  if (!start || !state.doc || state.layout === 'scroll') return;
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
  const rect = el.stage.getBoundingClientRect();
  const zone = zoneAt(e.clientX - rect.left, rect.width);
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
  if (!state.doc || !el.shelf.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
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
store.list().then((items) => {
  if (items.length && !state.doc && state.openToken === 0) return openFromShelf(items[0].id);
  return false;
}).catch(() => {});
