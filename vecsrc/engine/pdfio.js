// PDFIO — bridges VecPDF (pdfimport.js / pdfexport.js) onto the VECCORE
// document model. Import turns PDF/.ai vector pages into veccore shapes
// with color capture; export writes the artboard as a flat vector PDF.
//
// Color capture: shapes render with hex fills like everything else, but
// non-RGB source colors (CMYK builds, grayscale, spot inks) keep their
// print data in shape.fillInfo / shape.strokeInfo — {space, values, name,
// alt} — and the document gets a doc.swatches palette. Export prefers that
// info over the hex preview, so CMYK/gray/spot survive an import→edit→export
// trip, and separation plates build on the same data (see separate.js).
const PDFIO = (() => {
  'use strict';

  const C = typeof VECCORE !== 'undefined' ? VECCORE : require('./veccore.js');
  const S = typeof SEPARATE !== 'undefined' ? SEPARATE : require('./separate.js');
  const P = (() => {
    if (typeof VecPDF !== 'undefined') return VecPDF;
    const api = require('./pdfimport.js');
    require('./pdfexport.js'); // merges exportPDF into the same namespace
    return api;
  })();

  // ---------- colors ----------
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => {
      const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
      return n.toString(16).padStart(2, '0');
    }).join('');
  }

  function hexToRgb(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.replace(/./g, ch => ch + ch);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
    const n = parseInt(h, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  const PRINT_SPACES = { cmyk: 1, gray: 1, separation: 1 };

  function colorInfo(col) { // print-color data worth keeping past the hex preview
    if (!col || !PRINT_SPACES[col.space]) return null;
    const o = { space: col.space, values: col.values.slice() };
    if (col.name) o.name = col.name;
    // A spot's alternate space is its ink definition — keep it so plates can
    // re-emit the separation instead of guessing the ink back out of RGB.
    if (col.alt) o.alt = { space: col.alt.space, values: col.alt.values.slice() };
    return o;
  }

  // veccore fill/stroke (+ optional info) -> VecPDF color
  function toExportColor(hex, info) {
    if (info && PRINT_SPACES[info.space] && Array.isArray(info.values)) {
      const col = { space: info.space, values: info.values.slice(), rgb: hexToRgb(hex), name: info.name };
      if (info.alt) col.alt = { space: info.alt.space, values: info.alt.values.slice() };
      return col;
    }
    const rgb = hexToRgb(hex);
    return { space: 'rgb', values: rgb, rgb };
  }

  // ---------- geometry ----------
  // VecPDF subpaths -> veccore cmds
  function cmdsFromSubpaths(subpaths) {
    const cmds = [];
    for (const sp of subpaths) {
      cmds.push(['M', sp.start.x, sp.start.y]);
      for (const seg of sp.segments) {
        if (seg.type === 'cubic') {
          cmds.push(['C', seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.to.x, seg.to.y]);
        } else {
          cmds.push(['L', seg.to.x, seg.to.y]);
        }
      }
      if (sp.closed) cmds.push(['Z']);
    }
    return cmds;
  }

  // veccore cmds -> VecPDF subpaths
  function subpathsFromCmds(cmds) {
    const subs = [];
    let cur = null;
    for (const c of cmds) {
      if (c[0] === 'M') {
        cur = { start: { x: c[1], y: c[2] }, segments: [], closed: false };
        subs.push(cur);
      } else if (!cur) {
        continue;
      } else if (c[0] === 'L') {
        cur.segments.push({ type: 'line', to: { x: c[1], y: c[2] } });
      } else if (c[0] === 'C') {
        cur.segments.push({
          type: 'cubic',
          c1: { x: c[1], y: c[2] }, c2: { x: c[3], y: c[4] }, to: { x: c[5], y: c[6] },
        });
      } else if (c[0] === 'Z') {
        cur.closed = true;
        cur = null;
      }
    }
    return subs.filter(s => s.segments.length);
  }

  // ---------- import ----------
  function shapesFromPage(page) {
    return page.shapes.map((s, i) => {
      const shape = {
        type: 'path',
        name: (s.fill && s.fill.name) || (s.stroke && s.stroke.name) || 'Path ' + (i + 1),
        cmds: cmdsFromSubpaths(s.subpaths),
        fill: s.fill ? rgbToHex(s.fill.rgb) : null,
        stroke: s.stroke ? { color: rgbToHex(s.stroke.rgb), w: s.strokeWidth || 1 } : null,
        opacity: 1,
      };
      const fi = s.fill && colorInfo(s.fill);
      const si = s.stroke && colorInfo(s.stroke);
      if (fi) shape.fillInfo = fi;
      if (si) shape.strokeInfo = si;
      return shape;
    });
  }

  // Parse PDF/.ai bytes into a fresh veccore doc (one page -> one artboard).
  // Returns {doc, pageCount, isAI, colors}.
  async function docFromPDF(bytes, filename, pageIndex = 0) {
    const parsed = await P.parsePDF(bytes);
    const page = parsed.pages[Math.max(0, Math.min(pageIndex, parsed.pages.length - 1))];
    const doc = C.newDoc({ w: page.width / 72, h: page.height / 72, units: 'in' });
    doc.name = String(filename || 'Imported').replace(/\.(pdf|ai)$/i, '');
    for (const s of shapesFromPage(page)) C.addShape(doc, s);
    // The captured palette becomes the document's swatches, spot inks and all.
    doc.swatches = parsed.colors.map(c => C.makeSwatch(c)).filter(Boolean);
    return { doc, pageCount: parsed.pageCount, isAI: parsed.isAI, colors: parsed.colors };
  }

  // ---------- export ----------
  // One veccore shape -> VecPDF shape, or null when there is nothing to paint.
  // Carries stroke attributes and per-object opacity across to the writer.
  function exportShape(s) {
    const subpaths = subpathsFromCmds(s.cmds);
    if (!subpaths.length) return null;
    if (s.fill == null && !s.stroke) return null;
    const o = {
      subpaths,
      fill: s.fill != null ? toExportColor(s.fill, s.fillInfo) : null,
      stroke: s.stroke ? toExportColor(s.stroke.color, s.strokeInfo) : null,
      strokeWidth: s.stroke ? s.stroke.w : 0,
      opacity: s.opacity == null ? 1 : s.opacity,
      fillRule: 'nonzero',
    };
    if (s.stroke) {
      o.strokeCap = C.strokeProp(s.stroke, 'cap');
      o.strokeJoin = C.strokeProp(s.stroke, 'join');
      o.strokeMiter = C.strokeProp(s.stroke, 'miter');
      o.strokeAlign = C.strokeProp(s.stroke, 'align');
      if (s.stroke.dash) o.strokeDash = s.stroke.dash.slice();
    }
    if (s.overprint != null) o.overprint = !!s.overprint;
    return o;
  }

  // Visible-layer shapes only, in z order.
  function exportShapes(doc) {
    const hidden = new Set((doc.layers || []).filter(l => !l.visible).map(l => l.id));
    const out = [];
    for (const s of doc.shapes) {
      if (hidden.has(s.layer)) continue;
      const e = exportShape(s);
      if (e) out.push(e);
    }
    return out;
  }

  // Flat vector PDF of the whole artboard. Returns a Uint8Array.
  function exportDocPDF(doc) {
    return P.exportPDF({
      width: doc.artboard.w,
      height: doc.artboard.h,
      shapes: exportShapes(doc),
      title: doc.name || 'Untitled',
    });
  }

  // ---------- separation plates ----------
  // An ink whose alternate is blank paper (0/0/0/0 — white ink, the usual
  // case on colored foam) would render invisible in every viewer, so the
  // plate's *alternate* falls back to a light gray. The ink name and tint —
  // the only things the press reads — are untouched.
  const BLANK_ALT = [0, 0, 0, 0.2];

  function plateInk(ink) {
    const cmyk = ink.cmyk.slice(0, 4);
    const blank = cmyk.every(v => v <= 1e-4);
    return { name: ink.name, type: ink.type, cmyk: blank ? BLANK_ALT.slice() : cmyk };
  }

  // Build the VecPDF plate description for one separated plate.
  function platePDFDoc(doc, plate, opts = {}) {
    const colorShapes = [], spotShapes = [];
    for (const e of plate.entries) {
      const base = exportShape(e.shape);
      if (!base) continue;
      if (!e.knockout) colorShapes.push(base);
      const spot = {
        subpaths: base.subpaths,
        fillTint: e.fillTint,
        strokeTint: e.strokeTint,
        strokeWidth: base.strokeWidth,
        fillRule: base.fillRule,
      };
      // A knockout hole must never overprint, or it would not clear the plate.
      if (e.knockout) spot.overprint = false;
      else if (e.shape.overprint != null) spot.overprint = !!e.shape.overprint;
      spotShapes.push(spot);
    }
    return {
      width: doc.artboard.w,
      height: doc.artboard.h,
      ink: plateInk(plate.ink),
      colorShapes, spotShapes,
      marks: opts.marks !== false,
      margin: opts.margin,
      title: doc.name || 'Untitled',
    };
  }

  // Every ink in the document as its own press-ready plate PDF.
  // Returns [{ink, filename, objects, knockouts, bytes}].
  function exportPlatePDFs(doc, opts = {}) {
    return S.separatePlates(doc, opts).map(plate => ({
      ink: plate.ink,
      filename: S.plateFilename(doc, plate.ink),
      objects: plate.objects,
      knockouts: plate.knockouts,
      bytes: P.exportPlatePDF(platePDFDoc(doc, plate, opts)),
    }));
  }

  return {
    docFromPDF, exportDocPDF, exportShape, exportShapes, shapesFromPage,
    exportPlatePDFs, platePDFDoc,
    cmdsFromSubpaths, subpathsFromCmds, rgbToHex, hexToRgb,
  };
})();
if (typeof module !== 'undefined') module.exports = PDFIO;
if (typeof window !== 'undefined') window.PDFIO = PDFIO;
