// 楽譜ビューアの画面。楽譜はブラウザの中で読むだけで、外へは送らない。
import * as alphaTab from '../vendor/alphatab/alphaTab.mjs';
import { loadScore } from './load.js';

const $ = (id) => document.getElementById(id);
const el = {
  toolbar: $('toolbar'),
  file: $('file'),
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
  metronome: $('metronome'),
  countin: $('countin'),
  position: $('position'),
  score: $('score'),
};

const PlayerState = alphaTab.synth.PlayerState;
const params = new URLSearchParams(location.search);

// iPad の消音モードでも Web Audio の音が出るようにする（Safari 16.4 以降）
try {
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
} catch {
  // 対応していない端末では何もしない
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

async function open(value) {
  const token = ++state.loadToken;
  api.stop();
  state.score = null;
  state.scoreStatus = '';
  state.playerReady = false;
  refreshButtons();
  setStatus('楽譜を読んでいます…');
  try {
    const bytes = await bytesFor(value);
    const result = await loadScore(alphaTab, bytes, api.settings);
    if (token !== state.loadToken) return;
    state.score = result.score;
    state.title = result.score.title || nameFor(value);
    el.loopFrom.max = el.loopTo.max = String(barCount());
    el.loopFrom.value = '1';
    el.loopTo.value = String(Math.min(4, barCount()));
    el.position.textContent = '';
    api.renderScore(result.score, result.score.tracks.map((t) => t.index));
    const notes = [];
    if (result.mode === 'raw') notes.push('整えずにそのまま表示');
    if (result.applied && result.applied.hammerPullsMissed + result.applied.harmonicsMissed > 0) {
      notes.push(`付け直せなかった奏法 ${result.applied.hammerPullsMissed + result.applied.harmonicsMissed}個`);
    }
    state.scoreStatus = `${state.title}（${barCount()}小節）${notes.length ? `・${notes.join('・')}` : ''}`;
    setStatus(state.soundFontLoaded ? state.scoreStatus : '音源を読み込んでいます…');
  } catch (e) {
    if (token !== state.loadToken) return;
    console.error(e);
    setStatus(`この楽譜は読めませんでした：${e && e.message ? e.message : e}`);
  }
}

el.scores.addEventListener('change', () => open(el.scores.value));

el.file.addEventListener('change', async () => {
  const files = [...el.file.files];
  el.file.value = ''; // 同じファイルをもう一度選べるように
  let first = null;
  for (const f of files) {
    const id = `file:${state.nextFileId++}`;
    state.files.set(id, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = f.name;
    el.fileGroup.appendChild(opt);
    first ??= id;
  }
  if (first) {
    el.fileGroup.hidden = false;
    el.scores.value = first;
    open(first);
  }
});

// ---------------------------------------------------------------- 再生

el.play.addEventListener('click', () => {
  if (!state.score) return;
  api.playPause();
});
el.stop.addEventListener('click', () => {
  api.stop();
  if (el.loop.checked) applyLoop();
});

el.tempo.addEventListener('input', () => {
  const v = Number(el.tempo.value);
  el.tempoOut.textContent = `${v}%`;
  api.playbackSpeed = v / 100;
});

el.metronome.addEventListener('change', () => {
  api.metronomeVolume = el.metronome.checked ? 1 : 0;
});
el.countin.addEventListener('change', () => {
  api.countInVolume = el.countin.checked ? 1 : 0;
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
  el.position.textContent = `小節 ${index + 1} / ${barCount()}`;
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
  if (el.loop.checked) applyLoop();
});
api.playerStateChanged.on((e) => {
  refreshButtons();
  if (e.state === PlayerState.Playing) holdWakeLock();
  else releaseWakeLock();
});
api.playedBeatChanged.on((beat) => {
  el.position.textContent = `小節 ${beat.voice.bar.index + 1} / ${barCount()}`;
});
api.error.on((e) => {
  console.error(e);
  setStatus(`うまく動きませんでした：${e && e.message ? e.message : e}`);
});

darkQuery.addEventListener('change', applyTheme);

updateScrollOffset();
open(el.scores.value);
