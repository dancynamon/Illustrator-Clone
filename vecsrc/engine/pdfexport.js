/*
 * pdfexport.js
 * --------------------
 * Vector-PDF writer at artboard size. Takes the same shape model that
 * pdf-import.js produces (top-left origin, y-down, points) and writes a
 * single-page PDF 1.5 with plain path fills/strokes — no transparency
 * groups, no embedded fonts. RGB and grayscale colors are written
 * natively, CMYK is preserved as CMYK (k/K), and spot colors are written
 * as real named /Separation color spaces — never flattened to RGB.
 *
 * Two writers share the plumbing:
 *   exportPDF(doc)        flat artboard PDF, everything on one level
 *   exportPlatePDF(plate) one ink's press plate: a 2-layer OCG document
 *                         (Color + Spot, house convention) at piece size,
 *                         with crop/registration marks and an ink label.
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
 *     strokeOffsetPath?,    // subpaths an inside/outside stroke rides on
 *     opacity?,             // 0..1, constant alpha
 *     fillRule: 'nonzero' | 'evenodd',
 *     overprint: true | false | undefined
 *   } ],
 *   substrate?: color,      // material the piece prints on, painted first
 *   title?, creator?        // Info dictionary strings
 * }
 *
 * plate = {
 *   width, height,          // piece (trim) size in points
 *   ink: { name, cmyk:[c,m,y,k], type:'spot'|'process' },
 *   substrate?: color,      // material the piece prints on, under the art
 *   colorShapes: [shape],   // Color layer: the whole artwork, own colors
 *   spotShapes:  [ {subpaths, fillTint, strokeTint, strokeWidth,
 *                   fillRule, overprint} ],   // Spot layer: the ink itself
 *   marks?: true,           // crop + registration marks and ink label
 *   margin?: 36,            // furniture margin in points (0 = piece only)
 *   title?, label?
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

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function rgbToCmyk(rgb) {
  const k = 1 - Math.max(rgb[0] || 0, rgb[1] || 0, rgb[2] || 0);
  if (k >= 1 - 1e-4) return [0, 0, 0, 1];
  const d = 1 - k;
  return [(1 - rgb[0] - k) / d, (1 - rgb[1] - k) / d, (1 - rgb[2] - k) / d, k].map(clamp01);
}

// A spot color's alternate space — what a viewer shows for the ink. The ink
// name and tint are the press truth; this is only the on-screen stand-in.
function altCmykOf(col) {
  const a = col.alt;
  if (a && a.space === 'cmyk' && a.values.length >= 4) return a.values.slice(0, 4).map(clamp01);
  if (a && a.space === 'rgb' && a.values.length >= 3) return rgbToCmyk(a.values);
  if (a && a.space === 'gray' && a.values.length >= 1) return [0, 0, 0, clamp01(1 - a.values[0])];
  return rgbToCmyk(col.rgb || [0, 0, 0]);
}

// PDF name objects: everything outside the regular character set is #xx.
function pdfName(s) {
  return '/' + String(s).replace(/[^!-~]|[#()<>\[\]{}\/%]/g, ch =>
    '#' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
}

function escapePdfString(s) {
  return String(s).replace(/[\\()]/g, ch => '\\' + ch).replace(/[^\x20-\x7e]/g, ' ');
}

function strToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/* ---------- page resources ---------- */
// Content is written before object numbers exist, so colorspaces and
// graphics states register by resource name here and get their objects
// allocated at assembly time.
function newRes() {
  return { seps: [], sepIdx: new Map(), gs: new Map(), alphaIdx: new Map(), fonts: false };
}

function sepRes(res, name, cmyk) {
  const key = name + '|' + cmyk.map(fmt).join(',');
  let hit = res.sepIdx.get(key);
  if (!hit) {
    hit = { res: '/CS' + res.seps.length, ink: name, cmyk };
    res.sepIdx.set(key, hit);
    res.seps.push(hit);
  }
  return hit.res;
}

// Overprint ('op') leaves the other plates alone; knockout ('ko') clears them.
function gsRes(res, mode) {
  const name = mode === 'op' ? '/GSop' : '/GSko';
  res.gs.set(name, mode === 'op'
    ? '<< /Type /ExtGState /OP true /op true /OPM 1 >>'
    : '<< /Type /ExtGState /OP false /op false /OPM 0 >>');
  return name;
}

// Constant object alpha. Shares the /ExtGState dict with overprint states.
function alphaRes(res, a) {
  const key = fmt(a);
  let name = res.alphaIdx.get(key);
  if (!name) {
    name = '/GSa' + res.alphaIdx.size;
    res.alphaIdx.set(key, name);
    res.gs.set(name, '<< /Type /ExtGState /ca ' + key + ' /CA ' + key + ' >>');
  }
  return name;
}

function colorOps(col, isStroke, res) {
  if (!col) return '';
  const up = isStroke;
  if (col.space === 'separation' && col.name) {
    const nm = sepRes(res, col.name, altCmykOf(col));
    const tint = col.values && col.values.length ? clamp01(col.values[0]) : 1;
    return nm + (up ? ' CS ' : ' cs ') + fmt(tint) + (up ? ' SCN' : ' scn');
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

function paintOp(shape) {
  const eo = shape.fillRule === 'evenodd';
  if (shape.fill && shape.stroke) return eo ? 'B*' : 'B';
  if (shape.fill) return eo ? 'f*' : 'f';
  if (shape.stroke) return 'S';
  return 'n';
}

const CAP_CODE = { butt: 0, round: 1, square: 2 };
const JOIN_CODE = { miter: 0, round: 1, bevel: 2 };

function strokeStateOps(shape, res, strokeCol) {
  const out = [colorOps(strokeCol, true, res), fmt(shape.strokeWidth || 1) + ' w'];
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

// Inside/outside strokes: PDF only centers strokes, so an aligned stroke is a
// centered stroke on shape.strokeOffsetPath — the path pushed half a weight to
// that side — which keeps caps, joins and dashes at their true size. The clip
// stays as a backstop against the stroke leaking across the edge where the
// shape is thinner than the stroke, and carries the whole job when the offset
// collapsed and there is no offset path to ride.
// strokeCol is passed through so a separation plate can restate the ink.
function alignedStrokeOps(shape, res, strokeCol) {
  const align = shape.strokeAlign;
  const off = shape.strokeOffsetPath;
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
  if (off && off.length) {
    lines.push(...strokeStateOps(shape, res, strokeCol));
    lines.push(...pathOps(off));
  } else {
    lines.push(...strokeStateOps({ ...shape, strokeWidth: (shape.strokeWidth || 1) * 2 }, res, strokeCol));
    lines.push(...pathOps(shape.subpaths));
  }
  lines.push('S', 'Q');
  return lines;
}

// One shape, inside its own q/Q so color, alpha and overprint stay local.
function shapeOps(shape, res, fillCol, strokeCol) {
  const alpha = shape.opacity == null ? 1 : shape.opacity;
  const aligned = strokeCol && shape.strokeAlign && shape.strokeAlign !== 'center';
  const lines = ['q'];
  if (alpha < 1) lines.push(alphaRes(res, alpha) + ' gs');
  if (shape.overprint === true) lines.push(gsRes(res, 'op') + ' gs');
  else if (shape.overprint === false) lines.push(gsRes(res, 'ko') + ' gs');
  if (fillCol) lines.push(colorOps(fillCol, false, res));
  if (strokeCol && !aligned) lines.push(...strokeStateOps(shape, res, strokeCol));
  if (fillCol || !aligned) {
    lines.push(...pathOps(shape.subpaths));
    lines.push(paintOp({ fill: fillCol, stroke: strokeCol && !aligned, fillRule: shape.fillRule }));
  }
  if (aligned) lines.push(...alignedStrokeOps(shape, res, strokeCol));
  lines.push('Q');
  return lines;
}

function buildContent(doc, res) {
  const lines = [];
  // Flip to top-left-origin y-down space so shape coordinates can be
  // written exactly as stored. All geometry goes inside this one q/Q.
  lines.push('q');
  lines.push('1 0 0 -1 0 ' + fmt(doc.height) + ' cm');
  // Colored stock goes down first, so artwork reads against the material it
  // prints on rather than against the page. White paper adds nothing.
  if (doc.substrate) {
    lines.push('q', colorOps(doc.substrate, false, res),
      '0 0 ' + fmt(doc.width) + ' ' + fmt(doc.height) + ' re', 'f', 'Q');
  }
  for (const shape of doc.shapes || []) {
    if (!shape || !shape.subpaths || !shape.subpaths.length) continue;
    if (!shape.fill && !shape.stroke) continue;
    lines.push(...shapeOps(shape, res, shape.fill, shape.stroke));
  }
  lines.push('Q');
  return lines.join('\n');
}

/* ---------- low-level file assembly ---------- */
function newWriter() { return { objs: [null] }; }

function addObj(w, body) { w.objs.push(body); return w.objs.length - 1; }

function ref(n) { return n + ' 0 R'; }

// Allocate the objects the content registered and return the /Resources dict.
function buildResources(w, res, extra) {
  const parts = [];
  if (res.seps.length) {
    const cs = res.seps.map(s => {
      const fn = addObj(w, '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [' +
        s.cmyk.map(fmt).join(' ') + '] /N 1 >>');
      const obj = addObj(w, '[/Separation ' + pdfName(s.ink) + ' /DeviceCMYK ' + ref(fn) + ']');
      return s.res + ' ' + ref(obj);
    });
    parts.push('/ColorSpace << ' + cs.join(' ') + ' >>');
  }
  if (res.gs.size) {
    const gs = [...res.gs.entries()].map(([nm, dict]) => nm + ' ' + ref(addObj(w, dict)));
    parts.push('/ExtGState << ' + gs.join(' ') + ' >>');
  }
  if (res.fonts) {
    const f = addObj(w, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    parts.push('/Font << /F1 ' + ref(f) + ' >>');
  }
  if (extra) parts.push(extra);
  return '<< ' + parts.join(' ') + ' >>';
}

// Serialize the object table with a valid xref. Bodies are latin1 strings.
function assemble(w, trailerExtra) {
  let out = '%PDF-1.5\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [0];
  for (let i = 1; i < w.objs.length; i++) {
    offsets[i] = out.length;
    out += i + ' 0 obj\n' + w.objs[i] + '\nendobj\n';
  }
  const xrefPos = out.length;
  out += 'xref\n0 ' + w.objs.length + '\n';
  out += '0000000000 65535 f \n';
  for (let i = 1; i < w.objs.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + w.objs.length + (trailerExtra || '') + ' >>\n';
  out += 'startxref\n' + xrefPos + '\n%%EOF\n';
  return strToBytes(out);
}

function streamObj(content) {
  return '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
}

function infoObj(doc) {
  return '<< /Title (' + escapePdfString(doc.title || 'Untitled') +
    ') /Creator (' + escapePdfString(doc.creator || 'vecsrc Vector Studio') +
    ') /Producer (vecsrc pdf-export) >>';
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

  const w = newWriter();
  const catalog = addObj(w, '');
  const pages = addObj(w, '');
  const page = addObj(w, '');
  const contents = addObj(w, streamObj(content));
  const info = addObj(w, infoObj(doc));
  const resources = buildResources(w, res, null);

  w.objs[catalog] = '<< /Type /Catalog /Pages ' + ref(pages) + ' >>';
  w.objs[pages] = '<< /Type /Pages /Kids [' + ref(page) + '] /Count 1 >>';
  w.objs[page] = '<< /Type /Page /Parent ' + ref(pages) + ' /MediaBox [0 0 ' +
    fmt(doc.width) + ' ' + fmt(doc.height) + '] /Contents ' + ref(contents) +
    ' /Resources ' + resources + ' >>';

  return assemble(w, ' /Root ' + ref(catalog) + ' /Info ' + ref(info));
}

/* ---------- prepress furniture ---------- */
const MARK_GAP = 6;      // clear space between trim and the start of a mark
const MARK_LEN = 18;     // crop-mark length
const REG_R = 5;         // registration bullseye radius
const LABEL_PT = 7;      // ink label type size

function circleOps(cx, cy, r) {
  const k = 0.5522847498307936 * r;
  return [
    fmt(cx + r) + ' ' + fmt(cy) + ' m',
    fmt(cx + r) + ' ' + fmt(cy + k) + ' ' + fmt(cx + k) + ' ' + fmt(cy + r) + ' ' + fmt(cx) + ' ' + fmt(cy + r) + ' c',
    fmt(cx - k) + ' ' + fmt(cy + r) + ' ' + fmt(cx - r) + ' ' + fmt(cy + k) + ' ' + fmt(cx - r) + ' ' + fmt(cy) + ' c',
    fmt(cx - r) + ' ' + fmt(cy - k) + ' ' + fmt(cx - k) + ' ' + fmt(cy - r) + ' ' + fmt(cx) + ' ' + fmt(cy - r) + ' c',
    fmt(cx + k) + ' ' + fmt(cy - r) + ' ' + fmt(cx + r) + ' ' + fmt(cy - k) + ' ' + fmt(cx + r) + ' ' + fmt(cy) + ' c',
    'h',
  ];
}

function line(x0, y0, x1, y1) {
  return fmt(x0) + ' ' + fmt(y0) + ' m ' + fmt(x1) + ' ' + fmt(y1) + ' l S';
}

// Crop marks, registration bullseyes and the ink label — all in the /All
// registration separation so they image on every plate at full strength.
function marksContent(plate, res, m, W, H) {
  const pw = plate.width, ph = plate.height;
  const reg = { space: 'separation', name: 'All', values: [1], alt: { space: 'cmyk', values: [1, 1, 1, 1] } };
  const paint = colorOps(reg, false, res);
  const paintS = colorOps(reg, true, res);
  const L = ['q', paint, paintS, '0.25 w'];

  // crop marks at the four trim corners
  for (const y of [m, m + ph]) {
    L.push(line(m - MARK_GAP - MARK_LEN, y, m - MARK_GAP, y));
    L.push(line(m + pw + MARK_GAP, y, m + pw + MARK_GAP + MARK_LEN, y));
  }
  for (const x of [m, m + pw]) {
    L.push(line(x, m - MARK_GAP - MARK_LEN, x, m - MARK_GAP));
    L.push(line(x, m + ph + MARK_GAP, x, m + ph + MARK_GAP + MARK_LEN));
  }

  // registration targets centered in each margin
  const targets = [
    [m + pw / 2, m / 2], [m + pw / 2, H - m / 2],
    [m / 2, m + ph / 2], [W - m / 2, m + ph / 2],
  ];
  for (const [cx, cy] of targets) {
    L.push('0.4 w');
    L.push(...circleOps(cx, cy, REG_R), 'S');
    L.push(...circleOps(cx, cy, REG_R * 0.45), 'f');
    L.push(line(cx - REG_R * 1.8, cy, cx + REG_R * 1.8, cy));
    L.push(line(cx, cy - REG_R * 1.8, cx, cy + REG_R * 1.8));
  }

  // ink label along the bottom margin
  res.fonts = true;
  // ASCII only: the label is written with WinAnsi Helvetica, and anything
  // outside that range would come out as a blank on the press proof.
  const label = plate.label || (plate.ink.name + '  |  ' + (plate.ink.type === 'spot' ? 'SPOT' : 'PROCESS'));
  const detail = (plate.title ? plate.title + '  |  ' : '') +
    fmt(pw / 72) + ' x ' + fmt(ph / 72) + ' in' +
    (plate.substrateName ? '  |  on ' + plate.substrateName : '');
  L.push('BT', '/F1 ' + LABEL_PT + ' Tf',
    '1 0 0 1 ' + fmt(m) + ' ' + fmt(Math.max(3, m / 2 - LABEL_PT)) + ' Tm',
    '(' + escapePdfString(label) + ') Tj', 'ET');
  L.push('BT', '/F1 ' + (LABEL_PT - 1.5) + ' Tf',
    '1 0 0 1 ' + fmt(m) + ' ' + fmt(Math.max(3, m / 2 - LABEL_PT) - LABEL_PT - 1) + ' Tm',
    '(' + escapePdfString(detail) + ') Tj', 'ET');
  L.push('Q');
  return L;
}

/**
 * Build one ink's press plate: a 2-layer OCG PDF (Color under, Spot on top)
 * at piece size, with the artwork that uses the ink and nothing else.
 * Returns a Uint8Array.
 */
function exportPlatePDF(plate) {
  if (!plate || !(plate.width > 0) || !(plate.height > 0)) {
    throw new Error('exportPlatePDF: plate.width and plate.height (points) are required');
  }
  if (!plate.ink || !plate.ink.name) throw new Error('exportPlatePDF: plate.ink.name is required');

  const marks = plate.marks !== false;
  const m = marks ? (plate.margin != null ? plate.margin : 36) : 0;
  const W = plate.width + 2 * m, H = plate.height + 2 * m;
  const res = newRes();
  const ink = { name: plate.ink.name, cmyk: (plate.ink.cmyk || [0, 0, 0, 1]).slice(0, 4).map(clamp01) };

  const L = [];
  L.push('q');
  // piece space: art coordinates are top-left origin, y-down, inside the trim
  L.push('1 0 0 -1 ' + fmt(m) + ' ' + fmt(H - m) + ' cm');

  // Color layer first (underneath): the whole artwork in its own colors, so
  // the plate can be checked against the job it was separated from.
  L.push('/OC /oc_color BDC');
  // On colored stock the material goes down first. It is not ink — it never
  // reaches the Spot layer — but without it white ink is invisible against
  // the page and the reference layer lies about what the piece looks like.
  if (plate.substrate) {
    L.push('q', colorOps(plate.substrate, false, res),
      '0 0 ' + fmt(plate.width) + ' ' + fmt(plate.height) + ' re', 'f', 'Q');
  }
  for (const s of plate.colorShapes || []) {
    if (!s || !s.subpaths || !s.subpaths.length) continue;
    if (!s.fill && !s.stroke) continue;
    L.push(...shapeOps(s, res, s.fill, s.stroke));
  }
  L.push('EMC');

  // Spot layer on top: only what this ink prints, as this one ink,
  // overprinting by default (house convention) so it composites over the
  // reference art instead of erasing it. This layer alone is the plate.
  L.push('/OC /oc_spot BDC');
  L.push(gsRes(res, 'op') + ' gs');
  const sepCol = t => ({
    space: 'separation', name: ink.name, values: [t],
    alt: { space: 'cmyk', values: ink.cmyk },
  });
  for (const s of plate.spotShapes || []) {
    if (!s || !s.subpaths || !s.subpaths.length) continue;
    const f = s.fillTint != null ? sepCol(s.fillTint) : null;
    const k = s.strokeTint != null ? sepCol(s.strokeTint) : null;
    if (!f && !k) continue;
    L.push(...shapeOps(s, res, f, k));
  }
  L.push('EMC');
  L.push('Q');

  if (marks) L.push(...marksContent({ ...plate, ink: plate.ink }, res, m, W, H));

  const content = L.join('\n');

  const w = newWriter();
  const catalog = addObj(w, '');
  const pages = addObj(w, '');
  const page = addObj(w, '');
  const contents = addObj(w, streamObj(content));
  const info = addObj(w, infoObj(plate));
  const ocColor = addObj(w, '<< /Type /OCG /Name (Color) >>');
  const ocSpot = addObj(w, '<< /Type /OCG /Name (Spot) >>');
  const resources = buildResources(w, res,
    '/Properties << /oc_color ' + ref(ocColor) + ' /oc_spot ' + ref(ocSpot) + ' >>');

  const ocgs = '[' + ref(ocColor) + ' ' + ref(ocSpot) + ']';
  w.objs[catalog] = '<< /Type /Catalog /Pages ' + ref(pages) +
    ' /OCProperties << /OCGs ' + ocgs + ' /D << /Order ' + ocgs + ' /ON ' + ocgs + ' >> >> >>';
  w.objs[pages] = '<< /Type /Pages /Kids [' + ref(page) + '] /Count 1 >>';
  w.objs[page] = '<< /Type /Page /Parent ' + ref(pages) +
    ' /MediaBox [0 0 ' + fmt(W) + ' ' + fmt(H) + ']' +
    ' /TrimBox [' + fmt(m) + ' ' + fmt(m) + ' ' + fmt(m + plate.width) + ' ' + fmt(m + plate.height) + ']' +
    ' /Contents ' + ref(contents) + ' /Resources ' + resources + ' >>';

  return assemble(w, ' /Root ' + ref(catalog) + ' /Info ' + ref(info));
}

/**
 * Convenience: trigger a browser download of the exported PDF.
 */
function downloadPDF(doc, filename) {
  const bytes = exportPDF(doc);
  downloadBytes(bytes, filename || (doc.title ? doc.title + '.pdf' : 'export.pdf'));
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'export.pdf';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const api = global.VecPDF || (global.VecPDF = {});
api.exportPDF = exportPDF;
api.exportPlatePDF = exportPlatePDF;
api.downloadPDF = downloadPDF;
api.downloadBytes = downloadBytes;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
