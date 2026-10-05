// テスト用の小さな MusicXML を作る（音階だけ。既存の曲は写さない）。
//   node test/fixtures/make-fixtures.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const NL = String.fromCharCode(10);
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>' + NL
  + '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">' + NL;

const GUITAR_TUNING = [['E', 2], ['A', 2], ['D', 3], ['G', 3], ['B', 3], ['E', 4]];

function staffDetails(number) {
  const lines = GUITAR_TUNING.map(([s, o], i) => `<staff-tuning line="${i + 1}"><tuning-step>${s}</tuning-step><tuning-octave>${o}</tuning-octave></staff-tuning>`).join('');
  return `<staff-details number="${number}"><staff-lines>6</staff-lines>${lines}</staff-details>`;
}

function pitch(p) {
  const m = /^([A-G])(#|b)?([0-9])$/.exec(p);
  const alter = m[2] === '#' ? '<alter>1</alter>' : m[2] === 'b' ? '<alter>-1</alter>' : '';
  return `<pitch><step>${m[1]}</step>${alter}<octave>${m[3]}</octave></pitch>`;
}

const TYPES = { 24: 'whole', 12: 'half', 6: 'quarter', 3: 'eighth', 2: 'eighth' };

/**
 * n = { p: 'C4', d: 6, s: 2, f: 1, chord, hammer: 'start'|'stop', pull: 'start'|'stop', harmonic: 'natural'|'artificial', triplet }
 */
function note(n, voice, staff) {
  const tech = [];
  if (n.hammer) tech.push(`<hammer-on type="${n.hammer}" number="1">${n.hammer === 'start' ? 'H' : ''}</hammer-on>`);
  if (n.pull) tech.push(`<pull-off type="${n.pull}" number="1">${n.pull === 'start' ? 'P' : ''}</pull-off>`);
  if (n.harmonic) tech.push(`<harmonic><${n.harmonic}/></harmonic>`);
  if (n.s) tech.push(`<string>${n.s}</string><fret>${n.f}</fret>`);
  const notations = [];
  if (n.triplet === 'start' || n.triplet === 'stop') notations.push(`<tuplet type="${n.triplet}"/>`);
  if (tech.length) notations.push(`<technical>${tech.join('')}</technical>`);
  const tm = n.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
  return `<note>${n.chord ? '<chord/>' : ''}${pitch(n.p)}<duration>${n.d}</duration><voice>${voice}</voice><type>${TYPES[n.d]}</type>${tm}<staff>${staff}</staff>${notations.length ? `<notations>${notations.join('')}</notations>` : ''}</note>`;
}

function harmony({ root, alter, kind, text, bass, bassAlter, degrees = [], offset }) {
  const r = `<root><root-step>${root}</root-step>${alter ? `<root-alter>${alter}</root-alter>` : ''}</root>`;
  const k = `<kind${text !== undefined ? ` text="${text}"` : ''}>${kind}</kind>`;
  const b = bass ? `<bass><bass-step>${bass}</bass-step>${bassAlter ? `<bass-alter>${bassAlter}</bass-alter>` : ''}</bass>` : '';
  const d = degrees.map((g) => `<degree><degree-value>${g.value}</degree-value><degree-alter>${g.alter ?? 0}</degree-alter><degree-type>${g.type}</degree-type></degree>`).join('');
  const o = offset ? `<offset>${offset}</offset>` : '';
  return `<harmony>${r}${k}${b}${d}${o}</harmony>`;
}

// ---- 1. ギター（五線＋TAB の2段）：分数コード・ハーモニクス・3連符・hammer-on / pull-off
function guitarTabExtras() {
  const measures = [
    {
      harmonies: [
        { root: 'C', kind: 'major', text: '', bass: 'E' },
        { root: 'A', kind: 'minor-seventh', text: 'm7', bass: 'G', offset: 12 },
      ],
      notes: [
        { p: 'C4', d: 6, s: 2, f: 1, hammer: 'start' },
        { p: 'D4', d: 6, s: 2, f: 3, hammer: 'stop' },
        { p: 'E4', d: 6, s: 1, f: 0 },
        { p: 'F4', d: 6, s: 1, f: 1 },
      ],
    },
    {
      harmonies: [{ root: 'F', kind: 'major', text: '', bass: 'A', degrees: [{ value: 9, type: 'add' }] }],
      notes: [
        { p: 'G4', d: 2, s: 1, f: 3, triplet: 'start' },
        { p: 'A4', d: 2, s: 1, f: 5, triplet: true },
        { p: 'B4', d: 2, s: 1, f: 7, triplet: 'stop' },
        { p: 'B4', d: 2, s: 1, f: 7, triplet: 'start', pull: 'start' },
        { p: 'A4', d: 2, s: 1, f: 5, triplet: true, pull: 'stop' },
        { p: 'G4', d: 2, s: 1, f: 3, triplet: 'stop' },
        { p: 'C5', d: 12, s: 1, f: 8 },
      ],
    },
    {
      harmonies: [{ root: 'G', kind: 'dominant', text: '7', bass: 'B' }],
      notes: [
        { p: 'E5', d: 6, s: 1, f: 12, harmonic: 'natural' },
        { p: 'B4', d: 6, s: 2, f: 12, harmonic: 'natural' },
        { p: 'D5', d: 6, s: 3, f: 7, harmonic: 'natural' },
        { p: 'E3', d: 6, s: 4, f: 2, harmonic: 'artificial' },
      ],
    },
    {
      harmonies: [{ root: 'B', alter: -1, kind: 'major-seventh', bass: 'D' }, { root: 'C', kind: 'major' }],
      notes: [
        { p: 'C4', d: 12, s: 2, f: 1 },
        { p: 'C3', d: 12, s: 5, f: 3 },
        { p: 'E3', d: 12, s: 4, f: 2, chord: true },
      ],
    },
  ];
  // 最後の小節の2つ目のコードは、3拍目（12）に置く
  measures[3].harmonies[1].offset = 12;

  const body = measures.map((m, i) => {
    let x = `<measure number="${i + 1}">`;
    if (i === 0) {
      x += '<attributes><divisions>6</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
        + '<clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>'
        + '<clef number="2"><sign>TAB</sign><line>5</line></clef>' + staffDetails(2) + '</attributes>';
      x += '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><staff>1</staff><sound tempo="90"/></direction>';
    }
    x += m.harmonies.map(harmony).join('');
    x += m.notes.map((n) => note(n, 1, 1)).join('');
    x += '<backup><duration>24</duration></backup>';
    x += m.notes.map((n) => note(n, 5, 2)).join('');
    if (i === measures.length - 1) x += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
    return x + '</measure>';
  }).join('');

  return HEAD + '<score-partwise version="4.0"><work><work-title>試験用：音階（ギター・五線＋TAB）</work-title></work>'
    + '<part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>'
    + `<part id="P1">${body}</part></score-partwise>` + NL;
}

// ---- 2. ピアノ（2段。2段目はヘ音記号）：音を外してはいけない
function pianoTwoStaves() {
  const rh = [['C4', 'D4', 'E4', 'F4'], ['G4', 'A4', 'B4', 'C5']];
  const lh = [
    [{ p: 'C3', d: 8 }, { p: 'E3', d: 8, chord: true }, { p: 'G3', d: 8, chord: true }, { p: 'G2', d: 8 }],
    [{ p: 'F3', d: 8 }, { p: 'C3', d: 8 }],
  ];
  const body = rh.map((r, i) => {
    let x = `<measure number="${i + 1}">`;
    if (i === 0) {
      x += '<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'
        + '<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>';
    }
    x += r.map((p) => `<note>${pitch(p)}<duration>4</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>`).join('');
    x += '<backup><duration>16</duration></backup>';
    x += lh[i].map((n) => `<note>${n.chord ? '<chord/>' : ''}${pitch(n.p)}<duration>${n.d}</duration><voice>5</voice><type>half</type><staff>2</staff></note>`).join('');
    return x + '</measure>';
  }).join('');
  return HEAD + '<score-partwise version="4.0"><work><work-title>試験用：音階（ピアノ2段）</work-title></work>'
    + '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>'
    + `<part id="P1">${body}</part></score-partwise>` + NL;
}

// ---- 3. 2パート（フルートの五線＋ギターの TAB だけの1段）：音を外してはいけない
function twoParts() {
  const flute = '<measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>'
    + ['C5', 'D5', 'E5', 'F5'].map((p) => `<note>${pitch(p)}<duration>1</duration><voice>1</voice><type>quarter</type></note>`).join('') + '</measure>';
  const tab = '<measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef>' + staffDetails(1) + '</attributes>'
    + [['C4', 2, 1], ['D4', 2, 3], ['E4', 1, 0], ['F4', 1, 1]].map(([p, s, f]) => `<note>${pitch(p)}<duration>1</duration><voice>1</voice><type>quarter</type><notations><technical><string>${s}</string><fret>${f}</fret></technical></notations></note>`).join('') + '</measure>';
  return HEAD + '<score-partwise version="4.0"><work><work-title>試験用：音階（2パート）</work-title></work>'
    + '<part-list><score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Guitar</part-name></score-part></part-list>'
    + `<part id="P1">${flute}</part><part id="P2">${tab}</part></score-partwise>` + NL;
}

const files = {
  'scale_guitar_tab_extras.musicxml': guitarTabExtras(),
  'scale_piano_two_staves.musicxml': pianoTwoStaves(),
  'scale_two_parts.musicxml': twoParts(),
};
for (const [name, text] of Object.entries(files)) {
  fs.writeFileSync(path.join(here, name), text);
  console.log(`作った：test/fixtures/${name}`);
}
