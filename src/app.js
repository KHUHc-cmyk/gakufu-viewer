// 楽譜ビューアの画面。楽譜はブラウザの中で読むだけで、外へは送らない。
import * as alphaTab from '../vendor/alphatab/alphaTab.mjs';
import { loadScore } from './load.js';
import { readIncoming, safeBackUrl } from './incoming.js';

const $ = (id) => document.getElementById(id);
const el = {
  toolbar: $('toolbar'),
  file: $('file'),
  back: $('back'),
  scores: $('scores'),
  fileGroup: $('file-group'),
  status: $('status'),
  play: $('play'),
  stop: $('stop'),
  tempo: $('tempo'),
  tempoOut: $('tempo-out'),
  loop: $('loop'),
  loopFrom: $('loop-from'),
  loopTo: $('loop-to'),
  loopFromHere: $('loop-from-here'),
  loopToHere: $('loop-to-here'),
  metronome: $('metronome'),
  countin: $('countin'),
  zoom: $('zoom'),
  fold: $('fold'),
  position: $('position'),
  score: $('score'),
  offline: $('offline'),
  slotButtons: [...document.querySelectorAll('.slot-btn')],
  slotSelects: [...document.querySelectorAll('.slot select')],
};

const PlayerState = alphaTab.synth.PlayerState;
const params = new URLSearchParams(location.search);

// iPad の消音モードでも Web Audio の音が出るようにする（Safari 16.4 以降）
try {
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
} catch {
  // 対応していない端末では何もしない
}

// ---------------------------------------------------------------- 設定を覚える（この端末の中だけ）

const SETTINGS_KEY = 'gakufu-viewer:settings';

let backUrl = null; // コード進行練習補助へ戻る URL（受け取ったときに覚える。リポジトリには書かない）

function setBackUrl(url) {
  backUrl = url;
  el.back.hidden = !url;
  if (url) el.back.href = url;
  else el.back.removeAttribute('href');
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {}; // プライベートブラウズなどでは覚えない
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      tempo: Number(el.tempo.value),
      metronome: el.metronome.checked,
      countin: el.countin.checked,
      zoom: el.zoom.value,
      backUrl,
    }));
  } catch {
    // 覚えられなくても、そのまま使える
  }
}

{
  const saved = loadSettings();
  if (Number.isFinite(saved.tempo)) el.tempo.value = String(saved.tempo);
  el.tempoOut.textContent = `${el.tempo.value}%`;
  el.metronome.checked = saved.metronome === true;
  el.countin.checked = saved.countin === true;
  if ([...el.zoom.options].some((o) => o.value === saved.zoom)) el.zoom.value = saved.zoom;
  setBackUrl(safeBackUrl(saved.backUrl));
}

// ---------------------------------------------------------------- 明暗

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function themeColors() {
  const dark = darkQuery.matches;
  const ink = dark ? '#f2f2f7' : '#1d1d1f';
  const sub = dark ? '#8e8e93' : '#6e6e73';
  return {
    mainGlyphColor: ink,
    secondaryGlyphColor: ink, // 2つ目以降の声部も薄くしない
    scoreInfoColor: ink,
    staffLineColor: sub,
    barSeparatorColor: sub,
    barNumberColor: sub,
  };
}

function applyTheme() {
  const res = api.settings.display.resources;
  for (const [key, value] of Object.entries(themeColors())) res[key] = alphaTab.model.Color.fromJson(value);
  api.updateSettings();
  if (state.score) api.render();
}

// ---------------------------------------------------------------- alphaTab

const api = new alphaTab.AlphaTabApi(el.score, {
  core: {
    fontDirectory: new URL('../vendor/alphatab/font/', import.meta.url).href,
    useWorkers: true,
  },
  display: {
    layoutMode: alphaTab.LayoutMode.Page,
    scale: Number(el.zoom.value),
    resources: themeColors(),
  },
  player: {
    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
    soundFont: new URL('../vendor/alphatab/soundfont/sonivox.sf2', import.meta.url).href,
    outputMode: params.get('out') === 'sp'
      ? alphaTab.PlayerOutputMode.WebAudioScriptProcessor
      : alphaTab.PlayerOutputMode.WebAudioAudioWorklets,
    enableCursor: true,
    enableUserInteraction: false, // 小節タップは自前で扱う
    scrollElement: document.scrollingElement,
    scrollMode: alphaTab.ScrollMode.Continuous,
    scrollOffsetY: -120,
  },
});

const state = {
  score: null,
  title: '',
  files: new Map(), // id → { name, bytes }
  nextFileId: 1,
  playerReady: false, // 音源と、いまの楽譜の MIDI の両方がそろった
  soundFontLoaded: false,
  scoreStatus: '',
  loadToken: 0,
  notice: '', // 次に開いた楽譜の名前の前に、1回だけ出す知らせ
  cache: new Map(), // id → 読み込んだ結果（聴き比べで行き来するとき、読み直さない）
  slots: { A: 'sample:samples/aura_lea_jazz.musicxml', B: 'sample:samples/jingle_bells_pop.musicxml', C: null },
  activeSlot: 'A',
  pendingPosition: null, // 切り替えの後に戻す位置 { barIndex, fraction, wasPlaying }
  currentBar: 0, // いまいる小節（0 始まり）。「ここから」「ここまで」で使う
};

window.__app = { api, state }; // 画面のテスト用

// ---------------------------------------------------------------- 表示の更新

function setStatus(text) {
  el.status.textContent = text;
}

function isPlaying() {
  return api.playerState === PlayerState.Playing;
}

function refreshButtons() {
  const ready = !!state.score && state.playerReady;
  el.play.disabled = !ready;
  el.stop.disabled = !ready;
  const playing = ready && isPlaying();
  el.play.textContent = playing ? '一時停止' : '再生';
  el.play.dataset.state = playing ? 'playing' : 'stopped';
}

function barCount() {
  return state.score ? state.score.masterBars.length : 0;
}

function showPosition(barIndex) {
  state.currentBar = barIndex;
  el.position.textContent = `小節 ${barIndex + 1} / ${barCount()}`;
}

/** 操作の欄をたたんで、楽譜を広く見せる（再生・停止・テンポの行だけ残す） */
function setFolded(folded) {
  el.toolbar.classList.toggle('folded', folded);
  el.fold.textContent = folded ? 'ひらく' : 'たたむ';
  el.fold.setAttribute('aria-expanded', String(!folded));
}

el.fold.addEventListener('click', () => setFolded(!el.toolbar.classList.contains('folded')));

/** うまくいかなかった知らせは、たたんでいても見えるようにする */
function showError(text) {
  setFolded(false);
  setStatus(text);
}

function updateScrollOffset() {
  api.settings.player.scrollOffsetY = -(el.toolbar.offsetHeight + 16);
  api.updateSettings();
}
new ResizeObserver(updateScrollOffset).observe(el.toolbar);

// ---------------------------------------------------------------- 画面スリープを止める

let wakeLock = null;

async function holdWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // 電池が少ないときなどは断られる。再生は続ける
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isPlaying()) holdWakeLock();
});

// ---------------------------------------------------------------- 楽譜を開く

async function bytesFor(value) {
  if (value.startsWith('sample:')) {
    const res = await fetch(value.slice('sample:'.length));
    if (!res.ok) throw new Error(`見本を読めませんでした（${res.status}）`);
    return new Uint8Array(await res.arrayBuffer());
  }
  const entry = state.files.get(value);
  if (!entry) throw new Error('ファイルが見つかりません');
  return entry.bytes;
}

function nameFor(value) {
  if (value.startsWith('sample:')) return el.scores.selectedOptions[0]?.textContent ?? '';
  return state.files.get(value)?.name ?? '';
}

/** いまの位置を「何小節目の、どのあたりか」で覚える */
function capturePosition() {
  if (!state.score || !api.tickCache) return null;
  const tick = api.tickPosition;
  const found = api.tickCache.findBeat(new Set(state.score.tracks.map((t) => t.index)), tick);
  if (!found) return { barIndex: 0, fraction: 0, wasPlaying: isPlaying() };
  const mb = found.masterBar;
  const length = Math.max(1, mb.end - mb.start);
  return {
    barIndex: mb.masterBar.index,
    fraction: Math.min(Math.max((tick - mb.start) / length, 0), 0.999),
    wasPlaying: isPlaying(),
  };
}

/** 覚えた位置を、いまの楽譜の tick にする（小節が足りなければ最後の小節） */
function tickForPosition(pos) {
  const bars = state.score.masterBars;
  const mb = bars[Math.min(pos.barIndex, bars.length - 1)];
  const start = api.tickCache.getMasterBarStart(mb);
  return Math.round(start + pos.fraction * mb.calculateDuration());
}

async function readScore(value) {
  if (state.cache.has(value)) return state.cache.get(value);
  const bytes = await bytesFor(value);
  const result = await loadScore(alphaTab, bytes, api.settings);
  state.cache.set(value, result);
  return result;
}

/**
 * 楽譜を開く。keep を渡すと、くり返しの範囲を残し、読み込んだ後にその位置へ移る（再生していたら続ける）。
 */
async function open(value, keep = null) {
  const token = ++state.loadToken;
  if (outputStarting) {
    await outputStarting.promise;
    if (token !== state.loadToken) return;
  }
  if (keep && keep.wasPlaying) api.pause();
  else api.stop();
  state.pendingPosition = keep;
  state.score = null;
  state.scoreStatus = '';
  state.playerReady = false;
  refreshButtons();
  setStatus('楽譜を読んでいます…');
  try {
    const result = await readScore(value);
    if (token !== state.loadToken) return;
    state.score = result.score;
    state.title = result.score.title || nameFor(value);
    el.loopFrom.max = el.loopTo.max = String(barCount());
    if (!keep) {
      el.loopFrom.value = '1';
      el.loopTo.value = String(Math.min(4, barCount()));
      state.currentBar = 0;
      el.position.textContent = '';
    }
    api.renderScore(result.score, result.score.tracks.map((t) => t.index));
    const notes = [];
    if (result.mode === 'raw') notes.push('整えずにそのまま表示');
    if (result.applied && result.applied.hammerPullsMissed + result.applied.harmonicsMissed > 0) {
      notes.push(`付け直せなかった奏法 ${result.applied.hammerPullsMissed + result.applied.harmonicsMissed}個`);
    }
    state.scoreStatus = `${state.notice}${state.title}（${barCount()}小節）${notes.length ? `・${notes.join('・')}` : ''}`;
    state.notice = '';
    setStatus(state.soundFontLoaded ? state.scoreStatus : '音源を読み込んでいます…');
  } catch (e) {
    if (token !== state.loadToken) return;
    console.error(e);
    showError(`この楽譜は読めませんでした：${e && e.message ? e.message : e}`);
  }
}

el.scores.addEventListener('change', () => {
  setActiveSlot(slotOf(el.scores.value));
  open(el.scores.value);
});

// ---------------------------------------------------------------- 聴き比べ（A／B／C）

const SLOT_NAMES = ['A', 'B', 'C'];

function slotOf(value) {
  if (state.activeSlot && state.slots[state.activeSlot] === value) return state.activeSlot;
  return SLOT_NAMES.find((n) => state.slots[n] === value) ?? null;
}

function setActiveSlot(name) {
  state.activeSlot = name;
  for (const b of el.slotButtons) b.setAttribute('aria-pressed', String(b.dataset.slot === name));
}

/** A／B／C の選び欄に、開ける楽譜を並べ直す */
function refreshSlotOptions() {
  for (const select of el.slotSelects) {
    const name = select.dataset.slot;
    select.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（なし）';
    select.appendChild(none);
    for (const opt of el.scores.querySelectorAll('option')) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.textContent;
      select.appendChild(o);
    }
    select.value = state.slots[name] ?? '';
  }
}

function switchToSlot(name) {
  const value = state.slots[name];
  if (!value) {
    setStatus(`${name} に楽譜を選んでください`);
    return;
  }
  setActiveSlot(name);
  if (value === el.scores.value && state.score) return;
  const keep = capturePosition();
  el.scores.value = value;
  open(value, keep);
}

for (const b of el.slotButtons) b.addEventListener('click', () => switchToSlot(b.dataset.slot));
for (const select of el.slotSelects) {
  select.addEventListener('change', () => {
    const name = select.dataset.slot;
    state.slots[name] = select.value || null;
    if (state.activeSlot === name && select.value) {
      state.activeSlot = null; // いまの楽譜と違えば切り替える
      switchToSlot(name);
    }
  });
}

/** 新しく開いたファイルを、空いている（または見本の入っている）A→B→C に入れる */
function assignFilesToSlots(ids) {
  const free = SLOT_NAMES.filter((n) => !state.slots[n] || state.slots[n].startsWith('sample:'));
  ids.slice(0, free.length).forEach((id, i) => {
    state.slots[free[i]] = id;
  });
}

/** 楽譜（[{ name, bytes }]）を「開いたファイル」に足し、1本目を開く */
function addScores(list) {
  const added = [];
  for (const f of list) {
    const id = `file:${state.nextFileId++}`;
    state.files.set(id, { name: f.name, bytes: f.bytes });
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = f.name;
    el.fileGroup.appendChild(opt);
    added.push(id);
  }
  if (added.length) {
    el.fileGroup.hidden = false;
    assignFilesToSlots(added);
    refreshSlotOptions();
    el.scores.value = added[0];
    setActiveSlot(slotOf(added[0]));
    open(added[0]);
  }
}

el.file.addEventListener('change', async () => {
  const files = [...el.file.files];
  el.file.value = ''; // 同じファイルをもう一度選べるように
  const list = [];
  for (const f of files) list.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  addScores(list);
});

// ---------------------------------------------------------------- ほかのツールから受け取る（URL の # より後ろ）

/** 受け取った楽譜があれば開く。開いたら true */
async function openIncoming() {
  if (location.hash.length < 2) return false;
  try {
    const incoming = await readIncoming(location.hash);
    if (incoming.back) {
      setBackUrl(incoming.back);
      saveSettings();
    }
    if (!incoming.scores.length) return false;
    addScores(incoming.scores);
    return true;
  } catch (e) {
    console.error(e);
    state.notice = `受け取った楽譜を読めませんでした（${e && e.message ? e.message : e}）／`;
    return false;
  }
}

// 開いたままの画面に、次の楽譜が渡されたとき
window.addEventListener('hashchange', async () => {
  if (!(await openIncoming()) && state.notice) {
    showError(state.notice.slice(0, -1));
    state.notice = '';
  }
});

// ---------------------------------------------------------------- 再生

// alphaTab 1.8.4：再生を始めてから音の出口（AudioWorklet）が動き出すまでの短い間に止めると、
// 中で例外になり、無音の出口が1つつながったまま残る。出口が動き出すまで、止める操作を待つ。
let outputStarting = null; // 再生を頼んでから、出口が動き出すまでの間だけ入っている

function markOutputStarting() {
  let resolve;
  const entry = { promise: new Promise((r) => { resolve = r; }) };
  entry.done = () => {
    if (outputStarting === entry) outputStarting = null;
    resolve();
  };
  outputStarting = entry;
  setTimeout(entry.done, 1000); // 合図が来なくても、止める操作を待たせ続けない
}

// alphaTab の出口は、くり返しにした音源（loop）を start したときに動き出す
const startSource = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function start(...args) {
  const result = startSource.apply(this, args);
  if (this.loop && outputStarting) outputStarting.done();
  return result;
};

function startPlaying() {
  markOutputStarting();
  api.play();
}

el.play.addEventListener('click', async () => {
  if (!state.score) return;
  if (outputStarting) await outputStarting.promise;
  else if (!isPlaying()) markOutputStarting();
  api.playPause();
});
el.stop.addEventListener('click', async () => {
  if (outputStarting) await outputStarting.promise;
  api.stop();
  if (el.loop.checked) applyLoop();
  showStartPosition();
});

/** 止めた後・最後まで鳴り終えた後の位置（くり返しの範囲の頭か、曲の頭） */
function showStartPosition() {
  if (!state.score) return;
  showPosition(el.loop.checked ? clampBar(el.loopFrom) : 0);
}

function applyTempo() {
  const v = Number(el.tempo.value);
  el.tempoOut.textContent = `${v}%`;
  api.playbackSpeed = v / 100;
}

/** テンポ・メトロノーム・カウントインを、画面の欄のとおりに再生側へ伝える */
function applyPlayerSettings() {
  applyTempo();
  api.metronomeVolume = el.metronome.checked ? 1 : 0;
  api.countInVolume = el.countin.checked ? 1 : 0;
}

el.tempo.addEventListener('input', applyTempo);
el.tempo.addEventListener('change', saveSettings);
el.tempoOut.addEventListener('click', () => {
  el.tempo.value = '100';
  applyTempo();
  saveSettings();
});

el.metronome.addEventListener('change', () => {
  api.metronomeVolume = el.metronome.checked ? 1 : 0;
  saveSettings();
});
el.countin.addEventListener('change', () => {
  api.countInVolume = el.countin.checked ? 1 : 0;
  saveSettings();
});

// ---------------------------------------------------------------- 楽譜の大きさ

el.zoom.addEventListener('change', () => {
  api.settings.display.scale = Number(el.zoom.value);
  api.updateSettings();
  if (state.score) api.render();
  saveSettings();
});

// ---------------------------------------------------------------- くり返し

function clampBar(input) {
  const n = barCount();
  let v = Math.round(Number(input.value));
  if (!Number.isFinite(v)) v = 1;
  v = Math.min(Math.max(v, 1), Math.max(n, 1));
  input.value = String(v);
  return v - 1;
}

function firstBeatOf(barIndex) {
  for (const track of state.score.tracks) {
    for (const staff of track.staves) {
      const beats = staff.bars[barIndex]?.voices[0]?.beats;
      if (beats && beats.length) return beats[0];
    }
  }
  return null;
}

function lastBeatOf(barIndex) {
  for (const track of state.score.tracks) {
    for (const staff of track.staves) {
      const beats = staff.bars[barIndex]?.voices[0]?.beats;
      if (beats && beats.length) return beats[beats.length - 1];
    }
  }
  return null;
}

function applyLoop() {
  if (!state.score || !api.tickCache) return;
  if (!el.loop.checked) {
    api.playbackRange = null;
    api.isLooping = false;
    api.clearPlaybackRangeHighlight();
    return;
  }
  let from = clampBar(el.loopFrom);
  let to = clampBar(el.loopTo);
  if (to < from) {
    [from, to] = [to, from];
    el.loopFrom.value = String(from + 1);
    el.loopTo.value = String(to + 1);
  }
  const fromBar = state.score.masterBars[from];
  const toBar = state.score.masterBars[to];
  const startTick = api.tickCache.getMasterBarStart(fromBar);
  const endTick = api.tickCache.getMasterBarStart(toBar) + toBar.calculateDuration();
  api.playbackRange = { startTick, endTick };
  api.isLooping = true;
  const a = firstBeatOf(from);
  const b = lastBeatOf(to);
  if (a && b) api.highlightPlaybackRange(a, b);
  if (api.tickPosition < startTick || api.tickPosition >= endTick) api.tickPosition = startTick;
}

el.loop.addEventListener('change', applyLoop);
el.loopFrom.addEventListener('change', applyLoop);
el.loopTo.addEventListener('change', applyLoop);

/** いまいる小節を、くり返しの範囲の端に入れる */
function setLoopEdge(input) {
  if (!state.score) return;
  const bar = String(state.currentBar + 1);
  input.value = bar;
  // 範囲が逆さになるときは、もう片方も同じ小節にそろえる
  if (Number(el.loopFrom.value) > Number(el.loopTo.value)) {
    (input === el.loopFrom ? el.loopTo : el.loopFrom).value = bar;
  }
  applyLoop();
}

el.loopFromHere.addEventListener('click', () => setLoopEdge(el.loopFrom));
el.loopToHere.addEventListener('click', () => setLoopEdge(el.loopTo));

// ---------------------------------------------------------------- 小節タップで頭出し

function barAt(x, y) {
  const lookup = api.renderer.boundsLookup;
  if (!lookup) return -1;
  for (const system of lookup.staffSystems) {
    const sb = system.realBounds;
    if (y < sb.y || y > sb.y + sb.h) continue;
    let best = -1;
    let bestDist = Infinity;
    for (const bar of system.bars) {
      const b = bar.realBounds;
      const dist = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = bar.index;
      }
    }
    return best;
  }
  return -1;
}

el.score.addEventListener('click', (e) => {
  if (!state.score || !api.tickCache) return;
  const surface = el.score.querySelector('.at-surface') ?? el.score;
  const rect = surface.getBoundingClientRect();
  const index = barAt(e.clientX - rect.left, e.clientY - rect.top);
  if (index < 0) return;
  api.tickPosition = api.tickCache.getMasterBarStart(state.score.masterBars[index]);
  showPosition(index);
});

// ---------------------------------------------------------------- alphaTab の知らせ

api.soundFontLoad.on((e) => {
  if (e.total > 0 && !state.soundFontLoaded) setStatus(`音源を読み込んでいます… ${Math.floor((e.loaded / e.total) * 100)}%`);
});
// 注意：alphaTab 1.8.4 では api.midiLoaded に登録すると、中で同じ getter を呼び続けて止まる（ワーカー使用時）。
// playerReady は「音源と MIDI がそろった」ときに、楽譜を読み込むたびに届くので、こちらを使う。
api.soundFontLoaded.on(() => {
  state.soundFontLoaded = true;
  if (state.scoreStatus) setStatus(state.scoreStatus);
});
api.playerReady.on(() => {
  state.playerReady = true;
  state.soundFontLoaded = true;
  if (state.scoreStatus) setStatus(state.scoreStatus);
  refreshButtons();
  applyPlayerSettings();
  if (el.loop.checked) applyLoop();
  const keep = state.pendingPosition;
  state.pendingPosition = null;
  if (keep && state.score && api.tickCache) {
    const tick = tickForPosition(keep);
    const range = api.playbackRange;
    if (!range || (tick >= range.startTick && tick < range.endTick)) api.tickPosition = tick;
    showPosition(Math.min(keep.barIndex, barCount() - 1));
    if (keep.wasPlaying) startPlaying();
  }
});
api.playerStateChanged.on((e) => {
  refreshButtons();
  if (e.state === PlayerState.Playing) holdWakeLock();
  else releaseWakeLock();
});
api.playedBeatChanged.on((beat) => {
  showPosition(beat.voice.bar.index);
});
api.playerFinished.on(showStartPosition);
api.error.on((e) => {
  console.error(e);
  showError(`うまく動きませんでした：${e && e.message ? e.message : e}`);
});

darkQuery.addEventListener('change', applyTheme);

// ---------------------------------------------------------------- オフライン

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

updateScrollOffset();
refreshSlotOptions();
setActiveSlot('A');
openIncoming().then((opened) => {
  if (!opened) open(el.scores.value);
});
