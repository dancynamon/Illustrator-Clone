// SEPARATE — ink separation for print output. Pure logic: no DOM, no PDF
// writing, so it unit-tests under plain node.
//
// An ink is one plate on press: the four process inks (Cyan/Magenta/Yellow/
// Black) plus every named spot the document carries. Shape colors keep their
// print data in shape.fillInfo / shape.strokeInfo (see pdfio.js) and the spot
// registry lives in doc.swatches; this module reads those, never the hex
// preview — unless a shape is RGB-only, which has no print meaning, so it is
// converted to process build and preflight warns about it.
//
// Spot identity is the ink NAME, normalized to an upper-case key so
// "PANTONE 185 C" and "pantone 185 c" are one plate. Tints and the ink's
// alternate CMYK ride along untouched: nothing here downconverts a spot ink
// to RGB, and a plate always carries the ink's real name.
//
// Overprint is a per-shape tri-state: shape.overprint === true (overprint),
// === false (knockout), undefined (inherit the plate default).
//
// doc.substrate is the material the piece prints on (hex, or null for white
// paper). It is never an ink and never reaches a plate's Spot layer; it only
// backs the reference art, because white ink on blue foam is invisible
// against white and obvious against the foam.
const SEPARATE = (() => {
  'use strict';

  const C = typeof VECCORE !== 'undefined' ? VECCORE : require('./veccore.js');

  const EPS = 1e-4;                 // below this an ink contributes nothing
  const HAIRLINE_PT = 0.25;         // thinnest stroke a press holds reliably
  const DUP_TOL = 0.04;             // per-channel CMYK tolerance for "same ink"

  // ---------- colors ----------
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function hexToRgb(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.replace(/./g, ch => ch + ch);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
    const n = parseInt(h, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
  }

  function rgbToCmyk(rgb) {
    const k = 1 - Math.max(rgb[0], rgb[1], rgb[2]);
    if (k >= 1 - EPS) return [0, 0, 0, 1];
    const d = 1 - k;
    return [(1 - rgb[0] - k) / d, (1 - rgb[1] - k) / d, (1 - rgb[2] - k) / d, k].map(clamp01);
  }

  function cmykToRgb(v) {
    return [
      clamp01((1 - v[0]) * (1 - v[3])),
      clamp01((1 - v[1]) * (1 - v[3])),
      clamp01((1 - v[2]) * (1 - v[3])),
    ];
  }

  function cmykToHex(v) { return rgbToHex(cmykToRgb(v)); }

  // ---------- ink identity ----------
  const PROCESS_INKS = [
    { key: 'CYAN', name: 'Cyan', cmyk: [1, 0, 0, 0] },
    { key: 'MAGENTA', name: 'Magenta', cmyk: [0, 1, 0, 0] },
    { key: 'YELLOW', name: 'Yellow', cmyk: [0, 0, 1, 0] },
    { key: 'BLACK', name: 'Black', cmyk: [0, 0, 0, 1] },
  ];
  const PROCESS_CHANNEL = { CYAN: 0, MAGENTA: 1, YELLOW: 2, BLACK: 3 };

  function inkKey(name) { return String(name == null ? '' : name).trim().toUpperCase(); }
  function isProcessKey(key) { return PROCESS_CHANNEL[key] !== undefined; }

  // Loose key for "the printer would call these the same ink": drops spacing
  // and punctuation, so PANTONE 185 C === Pantone-185C.
  function looseKey(name) { return inkKey(name).replace(/[^A-Z0-9]/g, ''); }

  // Alternate (appearance) CMYK for one ink contribution.
  function altCmyk(ink) {
    if (ink.type === 'process') return PROCESS_INKS[PROCESS_CHANNEL[ink.key]].cmyk.slice();
    const a = ink.alt;
    if (a && a.space === 'cmyk' && a.values.length >= 4) return a.values.slice(0, 4).map(clamp01);
    if (a && a.space === 'rgb' && a.values.length >= 3) return rgbToCmyk(a.values);
    if (a && a.space === 'gray' && a.values.length >= 1) return [0, 0, 0, clamp01(1 - a.values[0])];
    if (ink.rgb) return rgbToCmyk(ink.rgb);
    return [0, 0, 0, 1];
  }

  // ---------- color -> ink contributions ----------
  // One veccore color (hex preview + optional print info) -> the inks it lays
  // down, each with its tint. Spot colors yield exactly one ink.
  function colorInks(hex, info) {
    if (info && info.space === 'separation') {
      const name = info.name || 'Spot';
      const tint = info.values && info.values.length ? clamp01(info.values[0]) : 1;
      if (tint <= EPS) return [];
      const ink = { key: inkKey(name), name, type: 'spot', tint, rgb: hexToRgb(hex) };
      if (info.alt) ink.alt = { space: info.alt.space, values: info.alt.values.slice() };
      return [ink];
    }
    let cmyk;
    if (info && info.space === 'cmyk' && info.values.length >= 4) cmyk = info.values.map(clamp01);
    else if (info && info.space === 'gray' && info.values.length >= 1) cmyk = [0, 0, 0, clamp01(1 - info.values[0])];
    else cmyk = rgbToCmyk(hexToRgb(hex));
    const out = [];
    PROCESS_INKS.forEach((p, i) => {
      if (cmyk[i] > EPS) out.push({ key: p.key, name: p.name, type: 'process', tint: cmyk[i] });
    });
    return out;
  }

  function shapeColors(shape) { // [{hex, info, on}] for the paints a shape carries
    const out = [];
    if (shape.fill != null) out.push({ hex: shape.fill, info: shape.fillInfo || null, on: 'fill' });
    if (shape.stroke) out.push({ hex: shape.stroke.color, info: shape.strokeInfo || null, on: 'stroke' });
    return out;
  }

  // Inks one shape uses -> Map key -> {ink, fillTint, strokeTint}.
  function shapeInks(shape) {
    const map = new Map();
    for (const col of shapeColors(shape)) {
      for (const ink of colorInks(col.hex, col.info)) {
        let e = map.get(ink.key);
        if (!e) { e = { ink, fillTint: null, strokeTint: null }; map.set(ink.key, e); }
        if (col.on === 'fill') e.fillTint = Math.max(e.fillTint || 0, ink.tint);
        else e.strokeTint = Math.max(e.strokeTint || 0, ink.tint);
      }
    }
    return map;
  }

  // ---------- document inks ----------
  // Shapes that will actually print: visible layers, something to paint with.
  function printableShapes(doc) {
    const hidden = new Set((doc.layers || []).filter(l => !l.visible).map(l => l.id));
    return (doc.shapes || []).filter(s =>
      !hidden.has(s.layer) && (s.fill != null || s.stroke) && s.cmds && s.cmds.length);
  }

  function spotSwatches(doc) {
    return (doc.swatches || []).filter(s => s && s.space === 'separation' && s.name);
  }

  // Every ink in the document: process inks that are used, then every spot —
  // including spots registered in doc.swatches that no object uses any more,
  // so a stray or orphaned ink is visible instead of silently dropped.
  function documentInks(doc, opts = {}) {
    const byKey = new Map();
    function slot(ink) {
      let e = byKey.get(ink.key);
      if (!e) {
        e = {
          key: ink.key, name: ink.name, type: ink.type,
          cmyk: altCmyk(ink), rgb: null,
          objects: 0, fills: 0, strokes: 0, maxTint: 0,
        };
        e.rgb = cmykToRgb(e.cmyk);
        byKey.set(ink.key, e);
      }
      return e;
    }
    if (opts.allProcess) for (const p of PROCESS_INKS) slot({ key: p.key, name: p.name, type: 'process' });
    for (const sw of spotSwatches(doc)) {
      const e = slot({ key: inkKey(sw.name), name: sw.name, type: 'spot', alt: sw.alt, rgb: sw.rgb });
      e.registered = true;
    }
    for (const s of printableShapes(doc)) {
      for (const [, use] of shapeInks(s)) {
        const e = slot(use.ink);
        e.objects++;
        if (use.fillTint != null) e.fills++;
        if (use.strokeTint != null) e.strokes++;
        e.maxTint = Math.max(e.maxTint, use.fillTint || 0, use.strokeTint || 0);
      }
    }
    const list = [...byKey.values()];
    const order = k => (isProcessKey(k) ? PROCESS_CHANNEL[k] : 100);
    return list.sort((a, b) => order(a.key) - order(b.key));
  }

  function findInk(doc, key, opts) {
    const k = inkKey(key);
    return documentInks(doc, opts).find(i => i.key === k) || null;
  }

  // ---------- separation preview ----------
  // Repaint one color as it looks with only `visible` inks on press. Returns
  // null when the object lays down no visible ink at all (it disappears, the
  // way Illustrator's separation preview shows it).
  function previewHex(hex, info, visible) {
    if (!visible) return hex;
    const inks = colorInks(hex, info);
    if (!inks.length) return hex;
    const live = inks.filter(i => visible.has(i.key));
    if (!live.length) return null;
    if (live.length === inks.length) return hex;
    const cmyk = [0, 0, 0, 0];
    for (const ink of live) {
      const a = altCmyk(ink);
      for (let c = 0; c < 4; c++) cmyk[c] = clamp01(cmyk[c] + a[c] * ink.tint);
    }
    return cmykToHex(cmyk);
  }

  // ---------- plates ----------
  // One plate per ink, holding only the geometry that actually uses that ink.
  // (The plate PDF pairs this with a reference layer carrying the full
  // artwork — see pdfio.platePDFDoc — but a plate's entries are ink only.)
  //
  // Knockout: an object that does NOT use the ink but sits above ink geometry
  // and overlaps it still punches a hole in the plate unless it overprints —
  // that is what the press does, so those objects come along as zero-tint
  // entries (entry.knockout). Pass {knockouts:false} for ink geometry only.
  function separatePlates(doc, opts = {}) {
    const shapes = printableShapes(doc);
    const inks = documentInks(doc, opts).filter(i => i.objects > 0);
    const wantKnockouts = opts.knockouts !== false;
    const uses = shapes.map(s => shapeInks(s));
    const boxes = shapes.map(s => C.tightBBox(s.cmds));

    return inks.map(ink => {
      const entries = [];
      let objects = 0, knockouts = 0;
      const below = []; // bounds of the ink geometry already laid down
      shapes.forEach((shape, i) => {
        const use = uses[i].get(ink.key);
        const box = boxes[i];
        if (use) {
          entries.push({
            shape, fillTint: use.fillTint, strokeTint: use.strokeTint, knockout: false,
          });
          objects++;
          if (box) below.push(box);
          return;
        }
        if (!wantKnockouts || shape.overprint === true || !box) return;
        if (!below.some(b => C.rectsIntersect(b, box))) return;
        entries.push({
          shape,
          fillTint: shape.fill != null ? 0 : null,
          strokeTint: shape.stroke ? 0 : null,
          knockout: true,
        });
        knockouts++;
      });
      return { ink, entries, objects, knockouts };
    });
  }

  // Press-desk filename: "Sign 24x18_WHITE_spot+color.pdf" (house convention).
  function plateFilename(doc, ink) {
    const base = String((doc && doc.name) || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').trim();
    const nm = String(ink.name).replace(/[\\/:*?"<>|]+/g, '-').trim();
    return base + '_' + nm + '_spot+color.pdf';
  }

  // ---------- substrate ----------
  const PAPER = '#ffffff';

  function substrateOf(doc) { // null when the piece runs on white paper
    const hex = doc && doc.substrate;
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    return hex.toLowerCase() === PAPER ? null : hex.toLowerCase();
  }

  function setSubstrate(doc, hex) {
    if (hex == null) { doc.substrate = null; return true; }
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
    doc.substrate = hex.toLowerCase();
    return true;
  }

  // Substrate as a print color, so the reference layer stays free of RGB.
  function substrateColor(doc) {
    const hex = substrateOf(doc);
    if (!hex) return null;
    const rgb = hexToRgb(hex);
    return { space: 'cmyk', values: rgbToCmyk(rgb), rgb };
  }

  // ---------- ink management ----------
  // All of these mutate doc in place and return how many objects changed, so
  // the caller can run them inside its own history commit.
  function eachColorInfo(doc, fn) { // fn(shape, key) with key 'fillInfo'|'strokeInfo'
    for (const s of doc.shapes || []) { fn(s, 'fillInfo'); fn(s, 'strokeInfo'); }
  }

  function infoIsInk(info, key) {
    return !!(info && info.space === 'separation' && inkKey(info.name) === key);
  }

  function setShapeColor(shape, which, hex, info) {
    if (which === 'fillInfo') {
      if (shape.fill == null) return false;
      shape.fill = hex;
      if (info) shape.fillInfo = info; else delete shape.fillInfo;
    } else {
      if (!shape.stroke) return false;
      shape.stroke.color = hex;
      if (info) shape.strokeInfo = info; else delete shape.strokeInfo;
    }
    return true;
  }

  function renameInk(doc, key, newName) {
    const k = inkKey(key), nm = String(newName || '').trim();
    if (!nm || isProcessKey(k)) return 0;
    let n = 0;
    eachColorInfo(doc, (s, w) => {
      const info = s[w];
      if (infoIsInk(info, k)) { info.name = nm; n++; }
    });
    for (const sw of spotSwatches(doc)) if (inkKey(sw.name) === k) sw.name = nm;
    return n;
  }

  // Spot -> process: every object using the ink gets the ink's alternate CMYK
  // scaled by its tint, and the spot leaves the registry.
  function convertSpotToProcess(doc, key) {
    const k = inkKey(key);
    if (isProcessKey(k)) return 0;
    let n = 0;
    eachColorInfo(doc, (s, w) => {
      const info = s[w];
      if (!infoIsInk(info, k)) return;
      const tint = info.values && info.values.length ? clamp01(info.values[0]) : 1;
      const alt = altCmyk({ type: 'spot', alt: info.alt, rgb: hexToRgb(w === 'fillInfo' ? s.fill : s.stroke.color) });
      const cmyk = alt.map(v => clamp01(v * tint));
      if (setShapeColor(s, w, cmykToHex(cmyk), { space: 'cmyk', values: cmyk })) n++;
    });
    doc.swatches = (doc.swatches || []).filter(sw => !(sw.space === 'separation' && inkKey(sw.name) === k));
    return n;
  }

  // Process -> spot: objects painted with that process ink ALONE become a
  // named separation at the same tint. Objects mixing it with other process
  // inks are left alone — splitting a build across plates is not a rename.
  function convertProcessToSpot(doc, key, name) {
    const k = inkKey(key), nm = String(name || '').trim();
    const ch = PROCESS_CHANNEL[k];
    if (ch === undefined || !nm) return 0;
    const cmyk = PROCESS_INKS[ch].cmyk.slice();
    let n = 0;
    eachColorInfo(doc, (s, w) => {
      const hex = w === 'fillInfo' ? s.fill : (s.stroke && s.stroke.color);
      if (hex == null) return;
      const inks = colorInks(hex, s[w] || null);
      if (inks.length !== 1 || inks[0].key !== k) return;
      const info = {
        space: 'separation', name: nm, values: [inks[0].tint],
        alt: { space: 'cmyk', values: cmyk.slice() },
      };
      if (setShapeColor(s, w, cmykToHex(cmyk.map(v => v * inks[0].tint)), info)) n++;
    });
    if (n) registerSwatch(doc, nm, cmyk);
    return n;
  }

  function registerSwatch(doc, name, cmyk) {
    if (!doc.swatches) doc.swatches = [];
    const k = inkKey(name);
    if (doc.swatches.some(sw => sw.space === 'separation' && inkKey(sw.name) === k)) return;
    doc.swatches.push({
      space: 'separation', values: [1], rgb: cmykToRgb(cmyk), name,
      alt: { space: 'cmyk', values: cmyk.slice() }, uses: 0,
    });
  }

  // Merge: everything printing with `fromKey` prints with `toKey` instead,
  // keeping each object's tint. Both directions (spot<->process) work.
  function mergeInks(doc, fromKey, toKey) {
    const from = inkKey(fromKey), to = inkKey(toKey);
    if (!from || !to || from === to) return 0;
    const target = findInk(doc, to, { allProcess: true });
    if (!target) return 0;
    let n = 0;
    eachColorInfo(doc, (s, w) => {
      const hex = w === 'fillInfo' ? s.fill : (s.stroke && s.stroke.color);
      if (hex == null) return;
      const inks = colorInks(hex, s[w] || null);
      const hit = inks.find(i => i.key === from);
      if (!hit) return;
      if (inks.length !== 1) return; // only pure uses of the ink remap cleanly
      if (target.type === 'spot') {
        const info = {
          space: 'separation', name: target.name, values: [hit.tint],
          alt: { space: 'cmyk', values: target.cmyk.slice() },
        };
        if (setShapeColor(s, w, cmykToHex(target.cmyk.map(v => v * hit.tint)), info)) n++;
      } else {
        const cmyk = [0, 0, 0, 0];
        cmyk[PROCESS_CHANNEL[to]] = hit.tint;
        if (setShapeColor(s, w, cmykToHex(cmyk), { space: 'cmyk', values: cmyk })) n++;
      }
    });
    if (n) doc.swatches = (doc.swatches || []).filter(sw => !(sw.space === 'separation' && inkKey(sw.name) === from));
    return n;
  }

  // Delete only an ink nothing prints with — dropping a used ink would throw
  // away artwork, which is never what "remove this swatch" means.
  function deleteInk(doc, key) {
    const k = inkKey(key);
    const ink = findInk(doc, k);
    if (!ink || ink.objects > 0 || isProcessKey(k)) return false;
    const before = (doc.swatches || []).length;
    doc.swatches = (doc.swatches || []).filter(sw => !(sw.space === 'separation' && inkKey(sw.name) === k));
    return doc.swatches.length < before;
  }

  function setOverprint(doc, ids, value) { // value: true | false | null (inherit)
    const set = new Set(ids);
    let n = 0;
    for (const s of doc.shapes || []) {
      if (!set.has(s.id)) continue;
      if (value == null) delete s.overprint; else s.overprint = !!value;
      n++;
    }
    return n;
  }

  // ---------- preflight ----------
  // Everything that bites on press, checked before plates go out the door.
  // An issue carries scope:'flat' when it only concerns the flat artboard
  // PDF and has no bearing on plates, so plate export can skip it, and
  // fix:'<name>' when the caller can offer a one-click way out of it.
  function preflight(doc, opts = {}) {
    const minStroke = opts.minStroke != null ? opts.minStroke : HAIRLINE_PT;
    const issues = [];
    const shapes = printableShapes(doc);

    if (!shapes.length) {
      issues.push({ level: 'error', code: 'empty', message: 'Nothing to print: no visible artwork.', ids: [] });
    }

    const substrate = substrateOf(doc);
    if (substrate) {
      issues.push({
        level: 'warn', code: 'substrate', scope: 'flat', fix: 'paper',
        message: 'Substrate ' + substrate + ' is set, so a flat PDF export lays it down ' +
          'as a full-bleed flood. Fine for a proof; switch to Paper before sending ' +
          'artwork to a printer. Plates are unaffected.',
        ids: [],
      });
    }

    const rgbIds = [];
    for (const s of shapes) {
      for (const col of shapeColors(s)) {
        if (!col.info || col.info.space === 'rgb') { rgbIds.push(s.id); break; }
      }
    }
    if (rgbIds.length) {
      issues.push({
        level: 'warn', code: 'rgb',
        message: rgbIds.length + ' object' + (rgbIds.length === 1 ? '' : 's') +
          ' still carry RGB color; they will be converted to a process build on plate.',
        ids: rgbIds,
      });
    }

    const inks = documentInks(doc);
    for (const ink of inks) {
      if (ink.objects === 0) {
        issues.push({
          level: 'warn', code: 'unused-ink',
          message: 'Ink "' + ink.name + '" is used by zero objects.', ids: [], ink: ink.key,
        });
      }
    }

    const spots = inks.filter(i => i.type === 'spot');
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i], b = spots[j];
        const sameName = looseKey(a.name) === looseKey(b.name);
        const sameBuild = a.cmyk.every((v, c) => Math.abs(v - b.cmyk[c]) <= DUP_TOL);
        if (!sameName && !sameBuild) continue;
        issues.push({
          level: 'warn', code: 'duplicate-spot',
          message: 'Spots "' + a.name + '" and "' + b.name + '" are near-duplicates (' +
            (sameName ? 'same name, different spelling' : 'same CMYK build') +
            '); merge them or the job runs two plates.',
          ids: [], ink: a.key, other: b.key,
        });
      }
    }

    const thin = shapes.filter(s => s.stroke && s.stroke.w > 0 && s.stroke.w < minStroke);
    if (thin.length) {
      issues.push({
        level: 'warn', code: 'hairline',
        message: thin.length + ' hairline stroke' + (thin.length === 1 ? '' : 's') +
          ' below ' + minStroke + ' pt; thicken or they may drop out on press.',
        ids: thin.map(s => s.id),
      });
    }
    return issues;
  }

  return {
    PROCESS_INKS, PROCESS_CHANNEL, HAIRLINE_PT,
    inkKey, looseKey, isProcessKey, altCmyk,
    hexToRgb, rgbToHex, rgbToCmyk, cmykToRgb, cmykToHex,
    colorInks, shapeInks, shapeColors, printableShapes, spotSwatches,
    documentInks, findInk, previewHex, separatePlates, plateFilename,
    PAPER, substrateOf, setSubstrate, substrateColor,
    renameInk, convertSpotToProcess, convertProcessToSpot, mergeInks, deleteInk,
    registerSwatch, setOverprint, preflight,
  };
})();
if (typeof module !== 'undefined') module.exports = SEPARATE;
if (typeof window !== 'undefined') window.SEPARATE = SEPARATE;
