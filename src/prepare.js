// alphaTab に渡す前に MusicXML を整える層。
// ブラウザでは標準の DOMParser / XMLSerializer を使う。Node のテストでは外から渡す。
//
// してること
//  (1) 2段目が TAB の段（clef の sign が TAB）のときだけ、そこに重ねて書かれた音を外し、残った1段を「五線＋TAB」で描く
//  (2) hammer-on / pull-off を読み取り、読み込み後のモデルに付け直す
//  (3) コード名を自前で組み立てる（分数コードのベース音・小節の途中の <offset> つきのコードを落とさない）
//  (4) ハーモニクスを読み取り、読み込み後のモデルに付け直す（alphaTab 1.8.4 は <harmonic> を読まない）

const ELEMENT_NODE = 1;
const TICKS_PER_QUARTER = 960; // alphaTab の4分音符の長さ

export function elementChildren(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE) out.push(n);
  }
  return out;
}

export function firstChild(el, name) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE && n.nodeName === name) return n;
  }
  return null;
}

function childText(el, name) {
  const c = firstChild(el, name);
  return c ? c.textContent.trim() : null;
}

function staffOf(el) {
  return childText(el, 'staff') ?? '1';
}

function numberOr(text, fallback) {
  const v = Number.parseFloat(text);
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------- (1) TAB の段

/** 2段目が TAB の段（clef number="2" の sign が TAB）か。最初に出てくる attributes で決める。 */
export function hasTabSecondStaff(part) {
  for (const measure of elementChildren(part)) {
    if (measure.nodeName !== 'measure') continue;
    for (const attrs of elementChildren(measure)) {
      if (attrs.nodeName !== 'attributes') continue;
      if (childText(attrs, 'staves') !== '2') continue;
      for (const clef of elementChildren(attrs)) {
        if (clef.nodeName !== 'clef') continue;
        if (clef.getAttribute('number') === '2') return childText(clef, 'sign') === 'TAB';
      }
    }
  }
  return false;
}

/**
 * 2段目（TAB の段）に重ねて書かれた音を外す。
 * 外した音の長さは <forward> に置き換え、同じ小節の後ろの <backup> がずれないようにする。
 * 2段目の調弦（staff-details）は1段目へ移し、読み込んだ後に「五線＋TAB」で描けるようにする。
 * 返り値：外した音の数
 */
export function stripTabStaff(doc, part) {
  let removed = 0;
  for (const measure of elementChildren(part)) {
    if (measure.nodeName !== 'measure') continue;
    for (const el of elementChildren(measure)) {
      switch (el.nodeName) {
        case 'note': {
          if (staffOf(el) !== '2') break;
          removed++;
          const isChord = !!firstChild(el, 'chord');
          const duration = childText(el, 'duration');
          if (!isChord && duration !== null && !firstChild(el, 'grace')) {
            const fwd = doc.createElement('forward');
            const d = doc.createElement('duration');
            d.appendChild(doc.createTextNode(duration));
            fwd.appendChild(d);
            measure.replaceChild(fwd, el);
          } else {
            measure.removeChild(el);
          }
          break;
        }
        case 'forward': {
          const s = firstChild(el, 'staff');
          if (s && s.textContent.trim() === '2') el.removeChild(s);
          break;
        }
        case 'direction':
        case 'harmony':
          if (staffOf(el) === '2') measure.removeChild(el);
          break;
        case 'attributes':
          fixAttributes(el);
          break;
        case 'print':
          for (const layout of elementChildren(el)) {
            if (layout.nodeName === 'staff-layout' && layout.getAttribute('number') === '2') {
              el.removeChild(layout);
            }
          }
          break;
      }
    }
  }
  return removed;
}

function fixAttributes(attrs) {
  let staffOneDetails = null;
  for (const c of elementChildren(attrs)) {
    const num = c.getAttribute('number');
    if (c.nodeName === 'staves') {
      attrs.removeChild(c);
    } else if (c.nodeName === 'staff-details') {
      if (num === '2') {
        c.setAttribute('number', '1');
        if (staffOneDetails) attrs.removeChild(staffOneDetails);
      } else if (num === '1' || !num) {
        staffOneDetails = c;
      }
    } else if (num === '2' && (c.nodeName === 'clef' || c.nodeName === 'key' || c.nodeName === 'time' || c.nodeName === 'transpose')) {
      attrs.removeChild(c);
    }
  }
}

// ---------------------------------------------------------------- (3) コード名

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const KIND_SUFFIX = {
  major: '',
  minor: 'm',
  augmented: 'aug',
  diminished: 'dim',
  dominant: '7',
  'major-seventh': 'maj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'augmented-seventh': 'aug7',
  'half-diminished': 'm7b5',
  'major-minor': 'm(maj7)',
  'major-sixth': '6',
  'minor-sixth': 'm6',
  'dominant-ninth': '9',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  'dominant-11th': '11',
  'major-11th': 'maj11',
  'minor-11th': 'm11',
  'dominant-13th': '13',
  'major-13th': 'maj13',
  'minor-13th': 'm13',
  'suspended-second': 'sus2',
  'suspended-fourth': 'sus4',
  power: '5',
  pedal: '',
  none: 'N.C.',
  other: '',
};

function alterText(alter) {
  switch (Math.round(numberOr(alter, 0))) {
    case -2: return 'bb';
    case -1: return 'b';
    case 1: return '#';
    case 2: return '##';
    default: return '';
  }
}

/** ルート音の文字（例：F#）。 */
function stepName(el, stepTag, alterTag) {
  if (!el) return '';
  const step = childText(el, stepTag) ?? '';
  return step + alterText(childText(el, alterTag));
}

function degreeText(deg) {
  const value = childText(deg, 'degree-value') ?? '';
  const alter = alterText(childText(deg, 'degree-alter'));
  const typeEl = firstChild(deg, 'degree-type');
  const type = typeEl ? typeEl.textContent.trim() : 'add';
  const typeAttr = typeEl ? typeEl.getAttribute('text') : null;
  if (typeAttr !== null && typeAttr !== '') return `${typeAttr}${alter}${value}`;
  if (type === 'alter') return `${alter}${value}`;
  if (type === 'subtract') return `omit${value}`;
  return `add${alter}${value}`;
}

/**
 * <harmony> から、ベース音を含めたコード名を組み立てる（例：C/E・Am7/G・F#m7b5）。
 * kind の text 属性が書かれていれば、それを優先する（music21 は自分の書き方をここに入れる）。
 */
export function buildChordName(harmony) {
  const root = stepName(firstChild(harmony, 'root'), 'root-step', 'root-alter');
  const kindEl = firstChild(harmony, 'kind');
  let suffix = '';
  if (kindEl) {
    const textAttr = kindEl.getAttribute('text');
    const kind = kindEl.textContent.trim();
    if (textAttr) suffix = textAttr;
    else suffix = KIND_SUFFIX[kind] ?? '';
    if (kind === 'none' && !textAttr) return 'N.C.';
  }
  const degrees = elementChildren(harmony).filter((c) => c.nodeName === 'degree').map(degreeText);
  if (degrees.length > 0) {
    const parens = kindEl && kindEl.getAttribute('parentheses-degrees') === 'yes';
    suffix += parens ? `(${degrees.join(',')})` : degrees.join('');
  }
  const bassEl = firstChild(harmony, 'bass');
  const bass = stepName(bassEl, 'bass-step', 'bass-alter');
  return root + suffix + (bass ? `/${bass}` : '');
}

/**
 * alphaTab は「ルート音＋kind の text 属性」をそのままコード名にする。
 * そこで text 属性に、組み立てた名前のルート音より後ろを入れ、ベース音・degree は外す。
 */
function rewriteHarmony(doc, harmony, name) {
  const rootEl = firstChild(harmony, 'root');
  const root = stepName(rootEl, 'root-step', 'root-alter');
  let kindEl = firstChild(harmony, 'kind');
  if (!kindEl) {
    kindEl = doc.createElement('kind');
    harmony.appendChild(kindEl);
  }
  const rest = rootEl && name.startsWith(root) ? name.slice(root.length) : name;
  if (!rootEl) {
    // ルートの無いコード（N.C. など）。alphaTab は root が無いと名前の頭が空になるので、そのまま text に入れる
    kindEl.setAttribute('text', rest);
  } else if (rest === '') {
    // text が空だと alphaTab は kind の中身から記号を作るので、中身を major にして空の名前にする
    while (kindEl.firstChild) kindEl.removeChild(kindEl.firstChild);
    kindEl.appendChild(doc.createTextNode('major'));
    kindEl.setAttribute('text', '');
  } else {
    kindEl.setAttribute('text', rest);
  }
  kindEl.removeAttribute('parentheses-degrees');
  for (const c of elementChildren(harmony)) {
    if (c.nodeName === 'degree' || c.nodeName === 'bass' || c.nodeName === 'inversion') harmony.removeChild(c);
  }
}

// ---------------------------------------------------------------- 小節の中を歩く

function pitchOf(note) {
  const p = firstChild(note, 'pitch');
  if (!p) return null;
  const step = STEP_SEMITONES[childText(p, 'step')];
  if (step === undefined) return null;
  const octave = numberOr(childText(p, 'octave'), 4);
  return (octave + 1) * 12 + step + Math.round(numberOr(childText(p, 'alter'), 0));
}

function technicalOf(note) {
  const notations = elementChildren(note).filter((c) => c.nodeName === 'notations');
  const out = [];
  for (const n of notations) for (const c of elementChildren(n)) if (c.nodeName === 'technical') out.push(c);
  return out;
}

/**
 * 1つのパートを小節ごとに歩き、音の位置を記録しながら、
 * コード名の書き換え・<offset> つきのコードの移動をする。
 * 返り値：{ notes, hammerPairs, harmonics, chords }
 */
function walkPart(doc, part) {
  const notes = []; // { measure, staff, tick, pitch, string, fret }
  const hammerPairs = []; // { origin, destination, kind }（notes の番号）
  const harmonics = []; // { note, kind }
  const chords = []; // { measure, tick, name }
  const pending = new Map(); // number → { index, kind }
  let divisions = 1;
  let measureIndex = -1;

  for (const measure of elementChildren(part)) {
    if (measure.nodeName !== 'measure') continue;
    measureIndex++;
    let cursor = 0;
    let lastStart = 0;
    const moves = []; // 小節の途中へ動かすコード { harmony, target }
    const starts = []; // { el, pos }（和音でない・装飾音でない音の始まり）

    for (const el of elementChildren(measure)) {
      switch (el.nodeName) {
        case 'attributes': {
          const d = childText(el, 'divisions');
          if (d !== null) divisions = numberOr(d, divisions);
          break;
        }
        case 'backup':
          cursor -= numberOr(childText(el, 'duration'), 0);
          if (cursor < 0) cursor = 0;
          break;
        case 'forward':
          cursor += numberOr(childText(el, 'duration'), 0);
          break;
        case 'harmony': {
          const offsetEl = firstChild(el, 'offset');
          const offset = offsetEl ? numberOr(offsetEl.textContent, 0) : 0;
          const name = buildChordName(el);
          rewriteHarmony(doc, el, name);
          if (offsetEl) el.removeChild(offsetEl);
          const target = cursor + offset;
          chords.push({ measure: measureIndex, tick: Math.round((target * TICKS_PER_QUARTER) / divisions), name });
          if (offset !== 0) moves.push({ harmony: el, target });
          break;
        }
        case 'note': {
          const isChord = !!firstChild(el, 'chord');
          const isGrace = !!firstChild(el, 'grace');
          const start = isChord ? lastStart : cursor;
          if (!isChord) {
            lastStart = start;
            if (!isGrace) {
              cursor = start + numberOr(childText(el, 'duration'), 0);
              starts.push({ el, pos: start });
            }
          }
          if (firstChild(el, 'rest')) break;
          const info = {
            measure: measureIndex,
            staff: numberOr(staffOf(el), 1),
            tick: Math.round((start * TICKS_PER_QUARTER) / divisions),
            pitch: pitchOf(el),
            string: null,
            fret: null,
          };
          const index = notes.length;
          notes.push(info);
          for (const tech of technicalOf(el)) {
            for (const t of elementChildren(tech)) {
              if (t.nodeName === 'string') info.string = numberOr(t.textContent, null);
              else if (t.nodeName === 'fret') info.fret = numberOr(t.textContent, null);
              else if (t.nodeName === 'hammer-on' || t.nodeName === 'pull-off') {
                const key = t.getAttribute('number') || '1';
                const type = t.getAttribute('type');
                if (type === 'start') {
                  pending.set(key, { index, kind: t.nodeName });
                } else if (type === 'stop' && pending.has(key)) {
                  const p = pending.get(key);
                  pending.delete(key);
                  hammerPairs.push({ origin: p.index, destination: index, kind: p.kind });
                }
              } else if (t.nodeName === 'harmonic') {
                const kind = firstChild(t, 'artificial') ? 'artificial' : 'natural';
                harmonics.push({ note: index, kind });
              }
            }
          }
          break;
        }
      }
    }

    // <offset> つきのコードは alphaTab が落とすので、その位置で始まる最初の音の前へ動かす
    for (const { harmony, target } of moves) {
      const hit = starts.find((s) => s.pos >= target);
      measure.removeChild(harmony);
      if (hit) measure.insertBefore(harmony, hit.el);
      else measure.appendChild(harmony);
    }
  }
  return { notes, hammerPairs, harmonics, chords };
}

// ---------------------------------------------------------------- 入口

/**
 * 文字列の MusicXML を整える。
 * 返り値：{ xml, report }。report は applyToScore() に渡す。
 */
export function prepareMusicXml(text, env = globalThis) {
  const doc = parseXml(text, env);
  const root = doc.documentElement;
  const report = { parts: [], removedNotes: 0, format: root.nodeName };
  if (root.nodeName === 'score-partwise') {
    for (const part of elementChildren(root)) {
      if (part.nodeName !== 'part') continue;
      const info = { id: part.getAttribute('id'), tabStripped: false };
      if (hasTabSecondStaff(part)) {
        report.removedNotes += stripTabStaff(doc, part);
        info.tabStripped = true;
      }
      Object.assign(info, walkPart(doc, part));
      report.parts.push(info);
    }
  }
  const xml = new env.XMLSerializer().serializeToString(doc);
  return { xml, report };
}

export function parseXml(text, env = globalThis) {
  let doc;
  try {
    doc = new env.DOMParser().parseFromString(text, 'application/xml');
  } catch {
    throw new Error('MusicXML として読めませんでした');
  }
  const err = doc.getElementsByTagName('parsererror');
  if (err.length > 0 || !doc.documentElement) throw new Error('MusicXML として読めませんでした');
  return doc;
}

// ---------------------------------------------------------------- 読み込んだ後のモデル

/**
 * 練習番号（rehearsal）を、小節の最初の拍の文字に移す。
 * alphaTab 1.8.4 は、練習番号とコード名を同じ行に置いてしまい、小節の頭で文字が重なる。
 * 拍の文字は行を共有しないので、重ならない。
 */
function moveSectionsToText(score) {
  let moved = 0;
  for (const masterBar of score.masterBars) {
    const section = masterBar.section;
    if (!section) continue;
    const label = section.marker ? `[${section.marker}]${section.text ? ` ${section.text}` : ''}` : section.text;
    const track = score.tracks[0];
    const beat = track?.staves[0]?.bars[masterBar.index]?.voices[0]?.beats[0];
    if (!beat || !label) continue;
    beat.text = beat.text ? `${label} ${beat.text}` : label;
    masterBar.section = null;
    moved++;
  }
  return moved;
}

const HARMONIC_NATURAL = 1; // alphaTab.model.HarmonicType.Natural
const HARMONIC_ARTIFICIAL = 2; // alphaTab.model.HarmonicType.Artificial

/** alphaTab の ModelUtils.deltaFretToHarmonicValue と同じ表（外へ出ていないので写す） */
function harmonicValueForFret(fret) {
  switch (fret) {
    case 2: return 2.4;
    case 3: return 3.2;
    case 4: case 5: case 7: case 9: case 12: case 16: case 17: case 19: case 24: return fret;
    case 8: return 8.2;
    case 10: return 9.6;
    case 14: case 15: return 14.7;
    case 21: case 22: return 21.7;
    default: return 12;
  }
}

function modelNotesOf(track) {
  const out = [];
  track.staves.forEach((staff, staffIndex) => {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) {
          for (const note of beat.notes) out.push({ note, staff: staffIndex + 1, bar: bar.index, beat });
        }
      }
    }
  });
  return out;
}

/** 楽譜（XML）の音を、モデルの音へ対応づける。弦とフレットが書いてあればそれを、無ければ音の高さを使う。 */
function matchNotes(track, xmlNotes) {
  const byBar = new Map();
  for (const m of modelNotesOf(track)) {
    const key = `${m.staff}:${m.bar}`;
    if (!byBar.has(key)) byBar.set(key, []);
    byBar.get(key).push(m);
  }
  const used = new Set();
  return xmlNotes.map((x) => {
    const list = byBar.get(`${x.staff}:${x.measure}`) ?? [];
    let best = null;
    let bestScore = Infinity;
    for (const m of list) {
      if (used.has(m.note)) continue;
      const dt = Math.min(Math.abs(m.beat.displayStart - x.tick), Math.abs(m.beat.playbackStart - x.tick));
      if (dt > 2) continue;
      const tuningLength = m.note.beat.voice.bar.staff.tuning.length;
      const sameFret = x.string !== null && x.fret !== null && m.note.isStringed
        && tuningLength - m.note.string + 1 === x.string && m.note.fret === x.fret;
      const samePitch = x.pitch !== null && m.note.realValue === x.pitch;
      if (!sameFret && !samePitch) continue;
      const score = dt + (sameFret ? 0 : 0.5);
      if (score < bestScore) {
        best = m;
        bestScore = score;
      }
    }
    if (best) used.add(best.note);
    return best ? best.note : null;
  });
}

/**
 * 読み込み後のモデルを整える。
 *  - TAB の段を外したパートは、残った1段を「五線＋TAB」で描く
 *  - alphaTab 1.8.4 は、音を拍に入れた後で弦の番号を読むため、弦ごとの引き当てが空になる。これを作り直す
 *  - hammer-on / pull-off・ハーモニクスを付け直し、alphaTab の仕上げ（score.finish）をもう一度走らせる
 *  - 練習番号をコード名と重ならない所へ移す
 * 返り値：付け直した数などの記録
 */
export function applyToScore(score, report, settings) {
  const result = { hammerPulls: 0, hammerPullsMissed: 0, harmonics: 0, harmonicsMissed: 0, sections: 0 };
  report.parts.forEach((info, i) => {
    const track = score.tracks[i];
    if (!track) return;
    if (info.tabStripped) {
      for (const staff of track.staves) {
        staff.showStandardNotation = true;
        staff.showTablature = true;
      }
    }

    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            beat.noteStringLookup.clear();
            for (const note of beat.notes) {
              note.isHammerPullOrigin = false;
              if (note.isStringed) beat.noteStringLookup.set(note.string, note);
            }
          }
        }
      }
    }

    const mapped = matchNotes(track, info.notes ?? []);
    info.pendingPairs = [];
    for (const pair of info.hammerPairs ?? []) {
      const origin = mapped[pair.origin];
      const destination = mapped[pair.destination];
      if (origin && destination) {
        origin.isHammerPullOrigin = true;
        info.pendingPairs.push({ origin, destination });
      } else {
        result.hammerPullsMissed++;
      }
    }
    for (const h of info.harmonics ?? []) {
      const note = mapped[h.note];
      if (!note || !note.isStringed) {
        result.harmonicsMissed++;
        continue;
      }
      if (h.kind === 'artificial') {
        note.harmonicType = HARMONIC_ARTIFICIAL;
        note.harmonicValue = 12;
      } else {
        note.harmonicType = HARMONIC_NATURAL;
        note.harmonicValue = harmonicValueForFret(note.fret);
      }
      result.harmonics++;
    }
  });

  result.sections = moveSectionsToText(score);
  if (settings) score.finish(settings);

  for (const info of report.parts) {
    for (const { origin, destination } of info.pendingPairs ?? []) {
      if (origin.isHammerPullOrigin && origin.hammerPullDestination === destination) result.hammerPulls++;
      else result.hammerPullsMissed++;
    }
    delete info.pendingPairs;
  }
  return result;
}
