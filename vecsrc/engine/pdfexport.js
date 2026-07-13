/*
 * pdfexport.js
 * --------------------
 * Flat vector-PDF writer at artboard size. Takes the same shape model
 * that pdf-import.js produces (top-left origin, y-down, points) and
 * writes a single-page PDF 1.4 with plain path fills/strokes — no
 * layers, no transparency groups, no fonts. RGB and grayscale colors
 * are written natively; CMYK colors are preserved as CMYK (k/K);
 * separation/spot colors are flattened to their RGB appearance.
 *
 * Browser: window.VecPDF.exportPDF(doc) -> Uint8Array
 * Node:    require('./pdf-export.js').exportPDF(doc)
 *
 * doc = {
 *   width, height,          // artboard size in points (required)
 *   shapes: [ {             // same model as pdf-import.js
 *     subpaths: [ {start:{x,y}, segments:[seg], closed} ],
 *     fill:   {space, values, rgb} | null,
 *     stroke: {space, values, rgb} | null,
 *     strokeWidth,
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

function colorOps(col, isStroke) {
  if (!col) return '';
  const up = isStroke;
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

function buildContent(doc) {
  const lines = [];
  // Flip to top-left-origin y-down space so shape coordinates can be
  // written exactly as stored. All geometry goes inside this one q/Q.
  lines.push('q');
  lines.push('1 0 0 -1 0 ' + fmt(doc.height) + ' cm');
  for (const shape of doc.shapes || []) {
    if (!shape || !shape.subpaths || !shape.subpaths.length) continue;
    if (!shape.fill && !shape.stroke) continue;
    lines.push('q');
    if (shape.fill) lines.push(colorOps(shape.fill, false));
    if (shape.stroke) {
      lines.push(colorOps(shape.stroke, true));
      lines.push(fmt(shape.strokeWidth || 1) + ' w');
    }
    lines.push(...pathOps(shape.subpaths));
    lines.push(paintOp(shape));
    lines.push('Q');
  }
  lines.push('Q');
  return lines.join('\n');
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
  const content = buildContent(doc);
  const title = escapePdfString(doc.title || 'Untitled');
  const creator = escapePdfString(doc.creator || 'vecsrc Vector Studio');

  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
    fmt(doc.width) + ' ' + fmt(doc.height) + '] /Contents 4 0 R /Resources << >> >>';
  objects[4] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
  objects[5] = '<< /Title (' + title + ') /Creator (' + creator + ') /Producer (vecsrc pdf-export) >>';

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
