import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as alphaTab from '../vendor/alphatab/alphaTab.core.mjs';
import { loadScore } from '../src/load.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const env = { DOMParser, XMLSerializer };
export { alphaTab };

export function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function readBytes(rel) {
  return new Uint8Array(fs.readFileSync(path.join(root, rel)));
}

/** アプリと同じ道すじ（src/load.js）で読み込む */
export async function load(bytesOrText) {
  const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  const settings = new alphaTab.Settings();
  const result = await loadScore(alphaTab, bytes, settings, env);
  return { ...result, settings };
}

/** 整える層を通さずに、alphaTab だけで読む */
export function loadRaw(bytesOrText) {
  const bytes = typeof bytesOrText === 'string' ? new TextEncoder().encode(bytesOrText) : bytesOrText;
  return alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
}

export function* eachNote(staff) {
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) for (const note of beat.notes) yield { bar, beat, note };
}

/** alphaTab のモデルで、段ごとの音の数を数える */
export function countNotesPerStaff(score) {
  const out = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      let n = 0;
      for (const _ of eachNote(staff)) n++;
      out.push(n);
    }
  }
  return out;
}

/** 元の MusicXML で、段ごとの音の数（休符を除く）を数える。キーは「パート番号:段」 */
export function countXmlNotesPerStaff(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const counts = {};
  const parts = doc.getElementsByTagName('part');
  for (let p = 0; p < parts.length; p++) {
    const notes = parts[p].getElementsByTagName('note');
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.getElementsByTagName('rest').length > 0) continue;
      const st = n.getElementsByTagName('staff')[0];
      const key = `${p + 1}:${st ? st.textContent.trim() : '1'}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** 再生で鳴る音（MIDI の note-on）の数 */
export function countNoteOns(score, settings = new alphaTab.Settings()) {
  const midiFile = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midiFile);
  new alphaTab.midi.MidiFileGenerator(score, settings, handler).generate();
  const events = midiFile.tracks ? midiFile.tracks.flatMap((t) => t.events) : midiFile.events;
  return events.filter((e) => e.type === 0x90).length;
}

/** モデルにある全部のコード名（小節:位置:名前） */
export function chordNames(score) {
  const out = [];
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
        if (beat.chord) out.push(`${bar.index}:${beat.playbackStart}:${beat.chord.name}`);
      }
    }
  }
  return out;
}

// ---- .mxl（zip）を作る
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** files: [{ name, text または data, store? }] → zip のバイト列 */
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = f.data ? Buffer.from(f.data) : Buffer.from(f.text);
    const data = f.store ? raw : zlib.deflateRawSync(raw);
    const method = f.store ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

export function makeMxl(xmlText, { name = 'score.musicxml', container = true, store = false } = {}) {
  const files = [];
  if (container) {
    files.push({ name: 'mimetype', text: 'application/vnd.recordare.musicxml', store: true });
    files.push({
      name: 'META-INF/container.xml',
      text: `<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="${name}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`,
    });
  }
  files.push({ name, text: xmlText, store });
  return makeZip(files);
}

/** zip の1つの中身を取り出す（テスト用。deflate と格納だけ） */
export function readZipEntry(bytes, entry) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  const start = p + 30 + b.readUInt16LE(p + 26) + b.readUInt16LE(p + 28);
  const data = b.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? zlib.inflateRawSync(data) : data;
}
