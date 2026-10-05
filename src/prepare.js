// alphaTab に渡す前に MusicXML を整える層。
// ブラウザでは標準の DOMParser / XMLSerializer を使う。Node のテストでは外から渡す。

const ELEMENT_NODE = 1;

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
 * (1) 2段目（TAB の段）に重ねて書かれた音を外す。
 * 外した音の長さは <forward> に置き換え、同じ小節の後ろの <backup> がずれないようにする。
 * 2段目の調弦（staff-details）は1段目へ移し、読み込んだ後に「五線＋TAB」で描けるようにする。
 * 返り値：外した音の数
 */
export function stripTabStaff(doc, part) {
  const removed = { notes: 0 };
  for (const measure of elementChildren(part)) {
    if (measure.nodeName !== 'measure') continue;
    for (const el of elementChildren(measure)) {
      switch (el.nodeName) {
        case 'note': {
          if (staffOf(el) !== '2') break;
          removed.notes++;
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
        case 'forward':
        case 'direction':
        case 'harmony':
          if (staffOf(el) === '2') {
            if (el.nodeName === 'forward') {
              const s = firstChild(el, 'staff');
              if (s) el.removeChild(s);
            } else {
              measure.removeChild(el);
            }
          }
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
  return removed.notes;
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
      } else if (num === '1' || num === null) {
        staffOneDetails = c;
      }
    } else if (num === '2' && (c.nodeName === 'clef' || c.nodeName === 'key' || c.nodeName === 'time' || c.nodeName === 'transpose')) {
      attrs.removeChild(c);
    }
  }
}

/**
 * 文字列の MusicXML を整える。
 * 返り値：{ xml, report }。report.parts[i].tabStripped が true のパートだけ、読み込み後に五線＋TAB にする。
 */
export function prepareMusicXml(text, env = globalThis) {
  const doc = parseXml(text, env);
  const root = doc.documentElement;
  const report = { parts: [], removedNotes: 0 };
  if (root.nodeName === 'score-partwise') {
    for (const part of elementChildren(root)) {
      if (part.nodeName !== 'part') continue;
      const info = { id: part.getAttribute('id'), tabStripped: false };
      if (hasTabSecondStaff(part)) {
        report.removedNotes += stripTabStaff(doc, part);
        info.tabStripped = true;
      }
      report.parts.push(info);
    }
  }
  const xml = new env.XMLSerializer().serializeToString(doc);
  return { xml, report };
}

export function parseXml(text, env = globalThis) {
  const doc = new env.DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror');
  if (err.length > 0) throw new Error('MusicXML として読めませんでした');
  return doc;
}

/** 読み込み後のモデルを整える。TAB の段を外したパートは、残った1段を「五線＋TAB」で描く。 */
export function applyToScore(score, report) {
  report.parts.forEach((info, i) => {
    const track = score.tracks[i];
    if (!track || !info.tabStripped) return;
    for (const staff of track.staves) {
      staff.showStandardNotation = true;
      staff.showTablature = true;
    }
  });
}
