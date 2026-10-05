// 音の確認のための1ページ：samples の1本を読み、再生ボタン1つで鳴らす。
import * as alphaTab from '../vendor/alphatab/alphaTab.mjs';
import { prepareMusicXml, applyToScore } from './prepare.js';

const SAMPLE = 'samples/aura_lea_jazz.musicxml';
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const useScriptProcessor = params.get('out') === 'sp';

if (useScriptProcessor) {
  const alt = document.getElementById('alt');
  alt.href = './';
  alt.textContent = 'ふつうの鳴らし方のページ';
}

// iPad の消音スイッチ（消音モード）でも Web Audio の音が出るようにする（Safari 16.4 以降）
try {
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
} catch {
  // 対応していない端末では何もしない
}

const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const ink = dark ? '#f2f2f7' : '#1d1d1f';
const sub = dark ? '#a1a1a6' : '#6e6e73';

const api = new alphaTab.AlphaTabApi(document.getElementById('score'), {
  core: {
    fontDirectory: new URL('../vendor/alphatab/font/', import.meta.url).href,
    useWorkers: true,
  },
  display: {
    resources: {
      mainGlyphColor: ink,
      secondaryGlyphColor: sub,
      scoreInfoColor: ink,
      staffLineColor: sub,
      barSeparatorColor: sub,
      barNumberColor: sub,
    },
  },
  player: {
    playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
    soundFont: new URL('../vendor/alphatab/soundfont/sonivox.sf2', import.meta.url).href,
    outputMode: useScriptProcessor
      ? alphaTab.PlayerOutputMode.WebAudioScriptProcessor
      : alphaTab.PlayerOutputMode.WebAudioAudioWorklets,
    enableCursor: true,
    scrollElement: document.scrollingElement,
  },
});
window.__api = api; // 画面のテスト用

let scoreLoaded = false;
let playerReady = false;

function refreshButton() {
  if (!(scoreLoaded && playerReady)) return;
  playBtn.disabled = false;
  const playing = api.playerState === alphaTab.synth.PlayerState.Playing;
  playBtn.textContent = playing ? '停止' : '再生';
  playBtn.dataset.state = playing ? 'playing' : 'stopped';
}

api.scoreLoaded.on(() => {
  scoreLoaded = true;
  refreshButton();
});
api.soundFontLoad.on((e) => {
  if (e.total > 0) statusEl.textContent = `音源を読み込んでいます… ${Math.floor((e.loaded / e.total) * 100)}%`;
});
api.playerReady.on(() => {
  playerReady = true;
  statusEl.textContent = '準備ができました';
  refreshButton();
});
api.playerStateChanged.on(() => refreshButton());
api.error.on((e) => {
  statusEl.textContent = `うまく動きませんでした：${e && e.message ? e.message : e}`;
});

playBtn.addEventListener('click', () => {
  if (api.playerState === alphaTab.synth.PlayerState.Playing) {
    api.stop();
  } else {
    api.play();
  }
});

async function loadSample() {
  try {
    const res = await fetch(SAMPLE);
    if (!res.ok) throw new Error(`${res.status}`);
    const { xml, report } = prepareMusicXml(await res.text());
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), api.settings);
    applyToScore(score, report);
    api.renderScore(score);
  } catch (e) {
    statusEl.textContent = `楽譜を読めませんでした：${e.message}`;
  }
}
loadSample();
