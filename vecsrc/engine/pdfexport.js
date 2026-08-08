/*
 * pdfexport.js
 * --------------------
 * Flat vector-PDF writer at artboard size. Takes the same shape model
 * that pdf-import.js produces (top-left origin, y-down, points) and
 * writes a single-page PDF 1.4 with plain path fills/strokes — no
 * layers, no fonts. RGB and grayscale colors are written natively; CMYK
 * colors are preserved as CMYK (k/K); spot inks are written as real
 * /Separation colorspaces when they carry an alternate build, so plates
 * survive the trip. Constant object opacity becomes an /ExtGState.
 *
 * Browser: window.VecPDF.exportPDF(doc) -> Uint8Array
 * Node:    require('./pdf-export.js').exportPDF(doc)
 *
 * doc = {
 *   width, height,          // artboard size in points (required)
 *   shapes: [ {             // same model as pdf-import.js
 *     subpaths: [ {start:{x,y}, segments:[seg], closed} ],
 *     fill:   {space, values, rgb, name?, alt?} | null,
 *     stroke: {space, values, rgb, name?, alt?} | null,
 *     strokeWidth,
 *     strokeCap?, strokeJoin?, strokeMiter?, strokeDash?, strokeAlign?,
 *     opacity?,             // 0..1, constant alpha
 *     fillRule: 'nonzero' | 'evenodd'
 *   } ],
 *   title?, creator?        // Info dictionary strings
 * }
 */
(function (global) {
'use strict';

function fmt(n) {
  if (!isFinite(n)) n = 0;
  // enough precision for print work, short enough to keep files small
  const s = Math.abs(n) < 1e-4 ? '0' : n.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

// Names in the resource dictionaries have to survive PDF name syntax, so
// anything outside the safe set is written as #xx (PANTONE 185 C ->
// PANTONE#20185#20C, which is exactly what Illustrator writes).
function pdfName(s) {
  return String(s || 'Spot').replace(/[^A-Za-z0-9._-]/g,
    ch => '#' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
}

const ALT_SPACE = { cmyk: 'DeviceCMYK', rgb: 'DeviceRGB', gray: 'DeviceGray' };

// res collects the resources a color/shape needs — separation colorspaces and
// constant-alpha graphics states — so the page can declare them afterwards.
function newRes() { return { seps: new Map(), alphas: new Map() }; }

function sepId(res, col) {
  if (!col.alt || !ALT_SPACE[col.alt.space] || !Array.isArray(col.alt.values)) return null;
  const key = col.name + '|' + col.alt.space + '|' + col.alt.values.map(fmt).join(',');
  let e = res.seps.get(key);
  if (!e) {
    e = { id: 'CS' + res.seps.size, name: col.name, alt: col.alt };
    res.seps.set(key, e);
  }
  return e.id;
}

function alphaId(res, a) {
  const key = fmt(a);
  let id = res.alphas.get(key);
  if (!id) { id = 'GS' + res.alphas.size; res.alphas.set(key, id); }
  return id;
}

function colorOps(col, isStroke, res) {
  if (!col) return '';
  const up = isStroke;
  if (col.space === 'separation' && res) {
    // Write the plate as a real /Separation so the ink stays an ink; only an
    // ink with no usable alternate build falls back to its RGB appearance.
    const id = sepId(res, col);
    if (id) {
      const tint = col.values && col.values.length ? col.values[0] : 1;
      return '/' + id + (up ? ' CS ' : ' cs ') + fmt(tint) + (up ? ' SCN' : ' scn');
    }
  }
  if (col.space === 'cmyk' && col.values && col.values.length === 4) {
    return col.values.map(fmt).join(' ') + (up ? ' K' : ' k');
  }
  if (col.space === 'gray' && col.values && col.values.length === 1) {
    return fmt(col.values[0]) + (up ? ' G' : ' g');
  }
  const rgb = col.rgb || [0, 0, 0];
  return rgb.map(fmt).join(' ') + (up ? ' RG' : ' rg');
}

function pathOps(subpaths) {
  const out = [];
  for (const sp of subpaths || []) {
    if (!sp || !sp.start) continue;
    out.push(fmt(sp.start.x) + ' ' + fmt(sp.start.y) + ' m');
    for (const seg of sp.segments || []) {
      if (seg.type === 'line') {
        out.push(fmt(seg.to.x) + ' ' + fmt(seg.to.y) + ' l');
      } else if (seg.type === 'cubic') {
        out.push(
          fmt(seg.c1.x) + ' ' + fmt(seg.c1.y) + ' ' +
          fmt(seg.c2.x) + ' ' + fmt(seg.c2.y) + ' ' +
          fmt(seg.to.x) + ' ' + fmt(seg.to.y) + ' c');
      }
    }
    if (sp.closed) out.push('h');
  }
  return out;
}

function paintOp(shape, fill, stroke) {
  const eo = shape.fillRule === 'evenodd';
  if (fill && stroke) return eo ? 'B*' : 'B';
  if (fill) return eo ? 'f*' : 'f';
  if (stroke) return 'S';
  return 'n';
}

const CAP_CODE = { butt: 0, round: 1, square: 2 };
const JOIN_CODE = { miter: 0, round: 1, bevel: 2 };

function strokeStateOps(shape, res) {
  const out = [colorOps(shape.stroke, true, res), fmt(shape.strokeWidth || 1) + ' w'];
  if (shape.strokeCap && CAP_CODE[shape.strokeCap]) out.push(CAP_CODE[shape.strokeCap] + ' J');
  if (shape.strokeJoin && JOIN_CODE[shape.strokeJoin]) out.push(JOIN_CODE[shape.strokeJoin] + ' j');
  if (shape.strokeMiter > 1) out.push(fmt(shape.strokeMiter) + ' M');
  if (Array.isArray(shape.strokeDash) && shape.strokeDash.length) {
    out.push('[' + shape.strokeDash.map(fmt).join(' ') + '] 0 d');
  }
  return out;
}

function subpathsBBox(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const put = p => {
    if (!p) return;
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
  };
  for (const sp of subpaths || []) {
    put(sp.start);
    for (const seg of sp.segments || []) { put(seg.c1); put(seg.c2); put(seg.to); }
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Inside/outside strokes: PDF only centers strokes, so draw at double weight
// clipped to the shape (inside) or to everything but the shape (outside) —
// the same construction Illustrator writes for aligned strokes. Caps and joins
// come out at that doubled size, which only shows on open or dashed paths.
function alignedStrokeOps(shape, res) {
  const align = shape.strokeAlign;
  const lines = ['q'];
  if (align === 'inside') {
    lines.push(...pathOps(shape.subpaths));
    lines.push(shape.fillRule === 'evenodd' ? 'W* n' : 'W n');
  } else {
    const b = subpathsBBox(shape.subpaths);
    const pad = (shape.strokeWidth || 1) * 2 + 10;
    lines.push(fmt(b.x - pad) + ' ' + fmt(b.y - pad) + ' ' +
      fmt(b.w + 2 * pad) + ' ' + fmt(b.h + 2 * pad) + ' re');
    lines.push(...pathOps(shape.subpaths));
    lines.push('W* n'); // even-odd against the enclosing rect = outside only
  }
  lines.push(...strokeStateOps({ ...shape, strokeWidth: (shape.strokeWidth || 1) * 2 }, res));
  lines.push(...pathOps(shape.subpaths));
  lines.push('S', 'Q');
  return lines;
}

function buildContent(doc, res) {
  const lines = [];
  // Flip to top-left-origin y-down space so shape coordinates can be
  // written exactly as stored. All geometry goes inside this one q/Q.
  lines.push('q');
  lines.push('1 0 0 -1 0 ' + fmt(doc.height) + ' cm');
  for (const shape of doc.shapes || []) {
    if (!shape || !shape.subpaths || !shape.subpaths.length) continue;
    if (!shape.fill && !shape.stroke) continue;
    const alpha = shape.opacity == null ? 1 : shape.opacity;
    const aligned = shape.stroke && shape.strokeAlign && shape.strokeAlign !== 'center';
    lines.push('q');
    if (alpha < 1) lines.push('/' + alphaId(res, alpha) + ' gs');
    if (shape.fill) lines.push(colorOps(shape.fill, false, res));
    if (shape.stroke && !aligned) lines.push(...strokeStateOps(shape, res));
    if (shape.fill || !aligned) {
      lines.push(...pathOps(shape.subpaths));
      lines.push(paintOp(shape, shape.fill, shape.stroke && !aligned));
    }
    if (aligned) lines.push(...alignedStrokeOps(shape, res));
    lines.push('Q');
  }
  lines.push('Q');
  return lines.join('\n');
}

// Resource objects for whatever buildContent registered. Returns the
// /Resources dictionary string plus the objects it points at, numbered from
// `first`.
function buildResources(res, first) {
  const objects = [];
  let next = first;
  const cs = [], gs = [];
  for (const sep of res.seps.values()) {
    const csNum = next++, fnNum = next++;
    const zeros = sep.alt.values.map(() => '0').join(' ');
    const ones = sep.alt.values.map(() => '0 1').join(' ');
    objects[csNum] = '[/Separation /' + pdfName(sep.name) + ' /' + ALT_SPACE[sep.alt.space] +
      ' ' + fnNum + ' 0 R]';
    objects[fnNum] = '<< /FunctionType 2 /Domain [0 1] /C0 [' + zeros + '] /C1 [' +
      sep.alt.values.map(fmt).join(' ') + '] /N 1 /Range [' + ones + '] >>';
    cs.push('/' + sep.id + ' ' + csNum + ' 0 R');
  }
  for (const [alpha, id] of res.alphas) {
    const num = next++;
    objects[num] = '<< /Type /ExtGState /ca ' + alpha + ' /CA ' + alpha + ' >>';
    gs.push('/' + id + ' ' + num + ' 0 R');
  }
  const parts = [];
  if (cs.length) parts.push('/ColorSpace << ' + cs.join(' ') + ' >>');
  if (gs.length) parts.push('/ExtGState << ' + gs.join(' ') + ' >>');
  return { dict: '<< ' + parts.join(' ') + ' >>', objects, next };
}

function escapePdfString(s) {
  return String(s).replace(/[\\()]/g, ch => '\\' + ch).replace(/[^\x20-\x7e]/g, ' ');
}

function strToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/**
 * Build a flat vector PDF. Returns a Uint8Array.
 */
function exportPDF(doc) {
  if (!doc || !(doc.width > 0) || !(doc.height > 0)) {
    throw new Error('exportPDF: doc.width and doc.height (points) are required');
  }
  const res = newRes();
  const content = buildContent(doc, res);
  const title = escapePdfString(doc.title || 'Untitled');
  const creator = escapePdfString(doc.creator || 'vecsrc Vector Studio');
  const resources = buildResources(res, 6);

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
    fmt(doc.width) + ' ' + fmt(doc.height) + '] /Contents 4 0 R /Resources ' + resources.dict + ' >>';
  objects[4] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
  objects[5] = '<< /Title (' + title + ') /Creator (' + creator + ') /Producer (vecsrc pdf-export) >>';
  for (let i = 6; i < resources.next; i++) objects[i] = resources.objects[i];

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xrefPos = out.length;
  out += 'xref\n0 ' + objects.length + '\n';
  out += '0000000000 65535 f \n';
  for (let i = 1; i < objects.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R /Info 5 0 R >>\n';
  out += 'startxref\n' + xrefPos + '\n%%EOF\n';

  return strToBytes(out);
}

/**
 * Convenience: trigger a browser download of the exported PDF.
 */
function downloadPDF(doc, filename) {
  const bytes = exportPDF(doc);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || (doc.title ? doc.title + '.pdf' : 'export.pdf');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const api = global.VecPDF || (global.VecPDF = {});
api.exportPDF = exportPDF;
api.downloadPDF = downloadPDF;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
