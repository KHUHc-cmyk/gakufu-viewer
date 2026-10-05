import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as alphaTab from '../vendor/alphatab/alphaTab.core.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const env = { DOMParser, XMLSerializer };
export { alphaTab };

export function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function loadScore(xmlText) {
  const bytes = new TextEncoder().encode(xmlText);
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
}

/** alphaTab のモデルで、段ごとの音の数を数える */
export function countNotesPerStaff(score) {
  const out = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      let n = 0;
      for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) n += beat.notes.length;
      out.push(n);
    }
  }
  return out;
}

/** 元の MusicXML で、段ごとの音の数（休符を除く）を数える */
export function countXmlNotesPerStaff(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const counts = {};
  const notes = doc.getElementsByTagName('note');
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.getElementsByTagName('rest').length > 0) continue;
    const st = n.getElementsByTagName('staff')[0];
    const key = st ? st.textContent.trim() : '1';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
