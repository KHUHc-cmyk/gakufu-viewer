// メトロノーム（Web Audio）。音は、この端末の中で作って鳴らすだけ。
// 鳴らす時刻は、音の時計（AudioContext）で先に決めておく（画面の時計だけだと、拍がゆれる）。

const LOOKAHEAD_MS = 25; // 何ミリ秒ごとに、先の拍を用意するか
const AHEAD = 0.12; // 何秒先の拍まで、用意しておくか

/** onBeat(拍の番号) は、その拍が鳴る頃に呼ばれる（0 が小節の頭） */
export function createMetronome(onBeat) {
  let ctx = null;
  let timer = 0;
  let run = 0; // 止めた後に、古い知らせが届かないようにする番号
  let nextTime = 0;
  let beat = 0;
  let bpm = 100;
  let beats = 4;
  let count = 0;

  function click(time, accent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.6 : 0.35, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  function schedule() {
    while (nextTime < ctx.currentTime + AHEAD) {
      const now = beat;
      const mine = run;
      click(nextTime, now === 0);
      setTimeout(() => {
        if (mine === run && timer) onBeat(now);
      }, Math.max(0, (nextTime - ctx.currentTime) * 1000));
      beat = (beat + 1) % beats;
      nextTime += 60 / bpm;
      count += 1;
    }
  }

  return {
    get running() {
      return timer !== 0;
    },
    /** これまでに用意した拍の数（テスト用） */
    get count() {
      return count;
    },
    set(nextBpm, nextBeats) {
      bpm = nextBpm;
      beats = nextBeats;
      beat %= beats;
    },
    start() {
      if (timer) return;
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) throw new Error('no audio');
      ctx ??= new Ctor();
      ctx.resume();
      run += 1;
      beat = 0;
      nextTime = ctx.currentTime + 0.08;
      timer = setInterval(schedule, LOOKAHEAD_MS);
      schedule();
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      run += 1;
    },
  };
}
