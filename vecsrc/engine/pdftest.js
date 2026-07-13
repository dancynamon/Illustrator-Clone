// pdftest — node tests for pdfio (vector-PDF import with color capture + flat export).
// Synthetic PDFs cover operators and graphics state; the samples/ PDFs (copied from
// the CAM engine this parser was ported from) cover real file layouts; export tests
// round-trip a document through buildPDF -> parsePDFDoc.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const C = require('./veccore.js');
const P = require('./pdfio.js');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : extra); }
}
function near(a, b, eps = 1e-3) { return Math.abs(a - b) <= eps; }
function bytes(str) { return new Uint8Array(Buffer.from(str, 'latin1')); }

// ---- inflate: validate the pure DEFLATE decoder against real zlib output ----
function inflateEquals(str) {
  const z = zlib.deflateSync(Buffer.from(str, 'latin1'));
  const got = Buffer.from(P.pdfInflate(new Uint8Array(z))).toString('latin1');
  return got === str;
}
ok(inflateEquals('hi'), 'inflate: short string (fixed huffman)');
ok(inflateEquals('ABCABCABC '.repeat(200)), 'inflate: repetitive (back-references)');
ok(inflateEquals('0 0 100 100 re f\n50 50 m 200 200 l S\n'.repeat(80)), 'inflate: mixed content');
{
  const z = zlib.deflateSync(Buffer.from('X'.repeat(500)), { level: 0 });
  ok(Buffer.from(P.pdfInflate(new Uint8Array(z))).toString('latin1') === 'X'.repeat(500), 'inflate: stored blocks');
}

// ---- helpers to assemble minimal PDFs around a content stream ----
function pagePDF(content, mediaBox) {
  const mb = mediaBox || '0 0 612 792';
  return '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Page /MediaBox [' + mb + '] /Contents 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
}
function parse(content, mediaBox) { return P.parsePDFDoc(bytes(pagePDF(content, mediaBox))); }
function multiObjPDF(objects) {
  let s = '%PDF-1.5\n';
  for (const o of objects) s += o.num + ' 0 obj\n' + o.body + '\nendobj\n';
  return s + 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
}
function streamObj(dict, content) { return '<< ' + dict + ' /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'; }

// ---- geometry: y-flip, rect, MediaBox ----
{
  // 100x50 rect at PDF (100,200): y-up -> studio top-left y = 792-250 = 542
  const r = parse('100 200 100 50 re f');
  ok(r.shapes.length === 1, 'rect: one shape', r.shapes.length);
  ok(near(r.artboard.w, 612) && near(r.artboard.h, 792), 'rect: letter artboard from MediaBox');
  const b = C.tightBBox(r.shapes[0].cmds);
  ok(near(b.x, 100) && near(b.y, 542) && near(b.w, 100) && near(b.h, 50), 'rect: y flipped into y-down space', JSON.stringify(b));
  ok(r.shapes[0].cmds[r.shapes[0].cmds.length - 1][0] === 'Z', 'rect: closed');
  ok(r.shapes[0].fill === '#000000' && r.shapes[0].stroke === null, 'rect: f -> default black fill, no stroke');
}
{
  // MediaBox with nonzero origin normalizes to artboard at (0,0)
  const r = parse('72 72 72 72 re f', '72 72 360 360');
  ok(near(r.artboard.w, 288) && near(r.artboard.h, 288), 'mediabox origin: artboard w/h from extent');
  const b = C.tightBBox(r.shapes[0].cmds);
  ok(near(b.x, 0) && near(b.y, 216) && near(b.w, 72), 'mediabox origin: content shifted to artboard space', JSON.stringify(b));
}
{
  // MediaBox inherited from the /Pages parent when absent on the page
  const pdf = multiObjPDF([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 288 144] >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
    { num: 4, body: streamObj('', '0 0 288 144 re f') },
  ]);
  const r = P.parsePDFDoc(bytes(pdf));
  ok(near(r.artboard.w, 288) && near(r.artboard.h, 144), 'mediabox: inherited from /Parent', JSON.stringify(r.artboard));
}

// ---- curves preserved as cubics ----
{
  const r = parse('0 0 m 0 100 100 100 100 0 c S');
  ok(r.shapes.length === 1, 'bezier: one shape');
  const cs = r.shapes[0].cmds.filter(c => c[0] === 'C');
  ok(cs.length === 1, 'bezier: kept as a single C command (not flattened)', JSON.stringify(r.shapes[0].cmds));
  // control points ride the y-flip too: PDF (0,100) -> (0,692)
  ok(near(cs[0][1], 0) && near(cs[0][2], 692) && near(cs[0][5], 100) && near(cs[0][6], 792), 'bezier: control points transformed', JSON.stringify(cs[0]));
}
{
  // v = current point as first control; y = second control is the endpoint
  const rv = parse('0 0 m 50 100 100 0 v S');
  const cv = rv.shapes[0].cmds.find(c => c[0] === 'C');
  ok(cv && near(cv[1], 0) && near(cv[2], 792), 'v operator: first control = current point', JSON.stringify(cv));
  const ry = parse('0 0 m 50 100 100 0 y S');
  const cy = ry.shapes[0].cmds.find(c => c[0] === 'C');
  ok(cy && near(cy[3], 100) && near(cy[4], 792) && near(cy[5], 100) && near(cy[6], 792), 'y operator: second control = endpoint', JSON.stringify(cy));
}

// ---- one shape per paint op: compound paths keep their holes ----
{
  const r = parse('0 0 100 100 re 25 25 50 50 re f');
  ok(r.shapes.length === 1, 'compound: one paint -> one shape', r.shapes.length);
  ok(r.shapes[0].cmds.filter(c => c[0] === 'M').length === 2, 'compound: both subpaths in one cmds list');
}
{
  const r = parse('0 0 100 100 re f 200 0 100 100 re f');
  ok(r.shapes.length === 2, 'two paints -> two shapes', r.shapes.length);
}

// ---- transforms: cm, q/Q nesting ----
{
  const r = parse('q 72 0 0 72 144 144 cm 0 0 1 1 re f Q');
  const b = C.tightBBox(r.shapes[0].cmds);
  // PDF: (144,144)-(216,216) y-up -> studio y: 792-216=576 .. 792-144=648
  ok(near(b.x, 144) && near(b.y, 576) && near(b.w, 72) && near(b.h, 72), 'cm: scale+translate with y-flip', JSON.stringify(b));
}
{
  const r = parse('72 0 0 72 0 0 cm 0 0 1 1 re f q 2 0 0 2 0 0 cm 2 0 1 1 re f Q 3 0 1 1 re f');
  ok(r.shapes.length === 3, 'q/Q: three shapes');
  const b1 = C.tightBBox(r.shapes[1].cmds), b2 = C.tightBBox(r.shapes[2].cmds);
  ok(near(b1.x, 288) && near(b1.w, 144), 'q/Q: inner rect gets nested 2x scale', JSON.stringify(b1));
  ok(near(b2.x, 216) && near(b2.w, 72), 'q/Q: Q restores the outer CTM', JSON.stringify(b2));
}

// ---- color capture ----
{
  const r = parse('1 0 0 rg 0 0 10 10 re f');
  ok(r.shapes[0].fill === '#ff0000', 'rg: rgb fill captured', r.shapes[0].fill);
}
{
  const r = parse('0 0.5 0 RG 4 w 0 0 m 100 0 l S');
  ok(r.shapes[0].fill === null, 'S: stroke only, no fill');
  ok(r.shapes[0].stroke && r.shapes[0].stroke.color === '#008000', 'RG: rgb stroke captured', JSON.stringify(r.shapes[0].stroke));
  ok(near(r.shapes[0].stroke.w, 4), 'w: line width captured', r.shapes[0].stroke.w);
}
{
  const r = parse('q 2 0 0 2 0 0 cm 3 w 0 0 m 100 0 l S Q');
  ok(near(r.shapes[0].stroke.w, 6), 'w: line width scales with the CTM', r.shapes[0].stroke.w);
}
{
  const r = parse('0.5 g 0 0 10 10 re f');
  ok(r.shapes[0].fill === '#808080', 'g: gray fill', r.shapes[0].fill);
}
{
  const r = parse('0 1 1 0 k 0 0 10 10 re f');
  ok(r.shapes[0].fill === '#ff0000', 'k: cmyk fill converted to rgb', r.shapes[0].fill);
  const rk = parse('0 0 0 1 K 1 w 0 0 m 10 0 l S');
  ok(rk.shapes[0].stroke.color === '#000000', 'K: cmyk stroke black', rk.shapes[0].stroke.color);
}
{
  const r = parse('/DeviceRGB cs 0 0 1 scn 0 0 10 10 re f');
  ok(r.shapes[0].fill === '#0000ff', 'scn: 3 components -> rgb', r.shapes[0].fill);
  const r1 = parse('/Sep cs 0.25 scn 0 0 10 10 re f');
  ok(r1.shapes[0].fill === '#404040', 'scn: 1 component -> gray', r1.shapes[0].fill);
  const r4 = parse('/DeviceCMYK CS 0 1 1 0 SCN 1 w 0 0 m 10 0 l S');
  ok(r4.shapes[0].stroke.color === '#ff0000', 'SCN: 4 components -> cmyk stroke', r4.shapes[0].stroke.color);
}
{
  const r = parse('1 0 0 rg 0 0 1 RG 2 w 0 0 100 100 re B');
  ok(r.shapes.length === 1 && r.shapes[0].fill === '#ff0000' && r.shapes[0].stroke.color === '#0000ff', 'B: fill and stroke on one shape');
}
{
  // colors are part of the saved graphics state
  const r = parse('1 0 0 rg q 0 1 0 rg 0 0 10 10 re f Q 20 0 10 10 re f');
  ok(r.shapes[0].fill === '#00ff00' && r.shapes[1].fill === '#ff0000', 'q/Q: fill color restored by Q', r.shapes.map(s => s.fill).join());
}

// ---- opacity via /ExtGState gs ----
{
  const content = '/GS1 gs 1 0 0 rg 0 0 100 100 re f';
  const pdf = multiObjPDF([
    { num: 1, body: '<< /Type /Page /MediaBox [0 0 612 792] /Contents 2 0 R /Resources << /ExtGState << /GS1 3 0 R >> >> >>' },
    { num: 2, body: streamObj('', content) },
    { num: 3, body: '<< /Type /ExtGState /ca 0.5 /CA 0.75 >>' },
  ]);
  const r = P.parsePDFDoc(bytes(pdf));
  ok(near(r.shapes[0].opacity, 0.5), 'gs: fill alpha from /ca', r.shapes[0].opacity);
}
{
  // inline ExtGState dict in resources
  const content = '/GS1 gs 0 0 m 100 0 l S';
  const pdf = multiObjPDF([
    { num: 1, body: '<< /Type /Page /MediaBox [0 0 612 792] /Contents 2 0 R /Resources << /ExtGState << /GS1 << /CA 0.25 >> >> >> >>' },
    { num: 2, body: streamObj('', content) },
  ]);
  const r = P.parsePDFDoc(bytes(pdf));
  ok(near(r.shapes[0].opacity, 0.25), 'gs: stroke alpha from inline /CA', r.shapes[0].opacity);
}

// ---- Form XObjects ----
{
  const formPDF = multiObjPDF([
    { num: 1, body: '<< /Type /Page /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Fm0 5 0 R >> >> >>' },
    { num: 4, body: streamObj('', '1 0 0 rg /Fm0 Do') },
    { num: 5, body: streamObj('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [2 0 0 2 72 144]', '0 0 100 100 re f') },
  ]);
  const r = P.parsePDFDoc(bytes(formPDF));
  ok(r.shapes.length === 1, 'Do: form geometry comes through', r.shapes.length);
  const b = C.tightBBox(r.shapes[0].cmds);
  ok(near(b.x, 72) && near(b.w, 200) && near(b.y, 792 - 344), 'Do: /Matrix applied under y-flip', JSON.stringify(b));
  ok(r.shapes[0].fill === '#ff0000', 'Do: graphics state (color) inherited into the form', r.shapes[0].fill);
}
{
  // self-referencing form terminates and emits once
  const cyclePDF = multiObjPDF([
    { num: 1, body: '<< /Type /Page /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /FmA 5 0 R >> >> >>' },
    { num: 4, body: streamObj('', '/FmA Do') },
    { num: 5, body: streamObj('/Type /XObject /Subtype /Form /BBox [0 0 72 72] /Resources << /XObject << /FmA 5 0 R >> >>', '0 0 72 72 re f\n/FmA Do') },
  ]);
  const r = P.parsePDFDoc(bytes(cyclePDF));
  ok(r.shapes.length === 1, 'Do: cycle guard -> one shape, no hang', r.shapes.length);
}

// ---- live text flag; clip discards ----
{
  const r = parse('BT /F1 12 Tf 100 700 Td (Hello) Tj ET');
  ok(r.shapes.length === 0 && r.hasLiveText === true && r.textShows === 1, 'text-only: no shapes, flag set');
  const m = parse('0 0 72 72 re f BT /F1 12 Tf 100 700 Td (Label) Tj ET');
  ok(m.shapes.length === 1 && m.hasLiveText === true, 'mixed: rect imported, live text flagged');
  const tj = parse('BT /F1 12 Tf [(Hel) -20 (lo)] TJ ET');
  ok(tj.hasLiveText === true, 'TJ array counts as live text');
}
{
  const r = parse('0 0 100 100 re W n 10 10 20 20 re f');
  ok(r.shapes.length === 1, 'W n: clip path discarded, painted path kept', r.shapes.length);
  const b = C.tightBBox(r.shapes[0].cmds);
  ok(near(b.w, 20), 'W n: kept shape is the painted one', JSON.stringify(b));
}

// ---- FlateDecode content end-to-end ----
{
  const content = '1 0 0 rg 36 36 72 72 re f';
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const head = Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length ' + z.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const r = P.parsePDFDoc(new Uint8Array(Buffer.concat([head, z, tail])));
  ok(r.shapes.length === 1 && r.shapes[0].fill === '#ff0000', 'flate: compressed content parsed with color');
}

// ---- imported shapes satisfy veccore's document validation ----
{
  const r = parse('1 0 0 rg 0 0 100 100 re f 0 1 0 RG 2 w 10 10 m 50 50 l S');
  const doc = C.newDoc({ units: 'in', w: r.artboard.w / 72, h: r.artboard.h / 72 });
  for (const s of r.shapes) C.addShape(doc, s);
  const rt = C.parseDoc(C.serializeDoc(doc));
  ok(rt.shapes.length === r.shapes.length, 'import -> doc -> serialize roundtrip keeps shapes');
  ok(rt.shapes.every(s => s.type === 'path'), 'imported shapes validate as paths');
}

// ---- not-a-PDF rejection ----
{
  let threw = false;
  try { P.parsePDFDoc(bytes('{"app":"aq-vector-studio"}')); } catch (e) { threw = true; }
  ok(threw, 'parsePDFDoc rejects non-PDF bytes');
}

// ---- sample PDFs (real files, ported parser's reference set) ----
const SAMPLES = path.join(__dirname, '..', 'samples');
function sample(name) { return new Uint8Array(fs.readFileSync(path.join(SAMPLES, name))); }
{
  const r = P.parsePDFDoc(sample('sample-logo.pdf'));
  ok(near(r.artboard.w, 612) && near(r.artboard.h, 792), 'sample-logo: letter artboard');
  ok(r.shapes.length === 1, 'sample-logo: one compound fill shape', r.shapes.length);
  ok(r.shapes[0].cmds.filter(c => c[0] === 'M').length === 4, 'sample-logo: 4 subpaths (rects, triangle, circle)');
  ok(r.shapes[0].cmds.filter(c => c[0] === 'C').length === 4, 'sample-logo: circle kept as 4 cubics');
  ok(!r.hasLiveText, 'sample-logo: no live text');
  const b = C.tightBBox(r.shapes[0].cmds);
  ok(near(b.x, 0.4 * 72, 0.5) && near(b.w, 6 * 72, 1), 'sample-logo: geometry at expected inches', JSON.stringify(b));
}
{
  const r = P.parsePDFDoc(sample('sample-logo-xobject.pdf'));
  ok(r.shapes.length === 1, 'sample-logo-xobject: form XObject resolved', r.shapes.length);
  ok(r.shapes[0].cmds.filter(c => c[0] === 'M').length === 4, 'sample-logo-xobject: same 4 subpaths via Do');
}
{
  const r = P.parsePDFDoc(sample('sample-mixed.pdf'));
  ok(r.shapes.length === 1, 'sample-mixed: rect imported', r.shapes.length);
  ok(r.shapes[0].stroke && !r.shapes[0].fill, 'sample-mixed: stroked (S), not filled');
  ok(r.hasLiveText === true, 'sample-mixed: live text flagged');
}
{
  const r = P.parsePDFDoc(sample('sample-text-only.pdf'));
  ok(r.shapes.length === 0 && r.hasLiveText === true, 'sample-text-only: nothing to import, text flagged');
}

// ---- export: structure ----
{
  const doc = C.newDoc({ units: 'in', w: 4, h: 3 });
  C.addShape(doc, { type: 'path', fill: '#ff0000', stroke: null, opacity: 1, cmds: C.rectPath(36, 36, 72, 72) });
  const pdf = P.buildPDF(doc);
  ok(pdf.startsWith('%PDF-1.4'), 'export: PDF header');
  ok(pdf.indexOf('/MediaBox [0 0 288 216 ]') > 0, 'export: MediaBox at artboard size');
  ok(/xref/.test(pdf) && /startxref/.test(pdf) && pdf.trimEnd().endsWith('%%EOF'), 'export: xref + trailer present');
  ok(pdf.indexOf('1 0 0 rg') > 0, 'export: fill color written');
  // xref offsets actually point at "N 0 obj"
  const xrefPos = parseInt(pdf.match(/startxref\n(\d+)/)[1], 10);
  ok(pdf.slice(xrefPos, xrefPos + 4) === 'xref', 'export: startxref points at xref table');
  const off1 = parseInt(pdf.slice(pdf.indexOf('\n', xrefPos + 6) + 1).split('\n')[1].slice(0, 10), 10);
  ok(pdf.slice(off1).startsWith('1 0 obj'), 'export: first xref entry points at object 1', pdf.slice(off1, off1 + 8));
  const bytesOut = P.buildPDFBytes(doc);
  ok(bytesOut instanceof Uint8Array && bytesOut.length === pdf.length, 'export: bytes match string length');
}
{
  // hidden layers are dropped from the flat export
  const doc = C.newDoc();
  doc.layers.push({ id: 'L2', name: 'hidden', visible: false, locked: false });
  C.addShape(doc, { type: 'path', fill: '#00ff00', cmds: C.rectPath(0, 0, 10, 10) });
  const hiddenShape = C.addShape(doc, { type: 'path', fill: '#123456', cmds: C.rectPath(50, 50, 10, 10) });
  hiddenShape.layer = 'L2';
  const r = P.parsePDFDoc(P.buildPDFBytes(doc));
  ok(r.shapes.length === 1 && r.shapes[0].fill === '#00ff00', 'export: hidden layer dropped', r.shapes.length);
}

// ---- export -> import round trip: geometry, colors, opacity ----
{
  const doc = C.newDoc({ units: 'in', w: 8.5, h: 11 });
  C.addShape(doc, { type: 'path', name: 'box', fill: '#2f6fb3', stroke: { color: '#1d1d1b', w: 1.5 }, opacity: 1, cmds: C.rectPath(72, 72, 216, 144, 18) });
  C.addShape(doc, { type: 'path', name: 'dot', fill: '#6cb33f', stroke: null, opacity: 0.5, cmds: C.ellipsePath(396, 245, 86, 86) });
  C.addShape(doc, { type: 'path', name: 'line', fill: null, stroke: { color: '#e8862e', w: 3 }, opacity: 1, cmds: [['M', 100, 500], ['L', 400, 640]] });
  const r = P.parsePDFDoc(P.buildPDFBytes(doc));
  ok(near(r.artboard.w, 612) && near(r.artboard.h, 792), 'roundtrip: artboard preserved');
  ok(r.shapes.length === 3, 'roundtrip: all shapes back', r.shapes.length);
  for (let i = 0; i < 3; i++) {
    const a = C.tightBBox(doc.shapes[i].cmds), b = C.tightBBox(r.shapes[i].cmds);
    ok(near(a.x, b.x, 0.01) && near(a.y, b.y, 0.01) && near(a.w, b.w, 0.01) && near(a.h, b.h, 0.01),
      'roundtrip: shape ' + i + ' geometry identical', JSON.stringify([a, b]));
  }
  ok(r.shapes[0].fill === '#2f6fb3' && r.shapes[0].stroke.color === '#1d1d1b', 'roundtrip: fill+stroke colors survive');
  ok(near(r.shapes[0].stroke.w, 1.5, 1e-3), 'roundtrip: stroke width survives', r.shapes[0].stroke.w);
  ok(r.shapes[1].fill === '#6cb33f' && near(r.shapes[1].opacity, 0.5), 'roundtrip: opacity via ExtGState survives', r.shapes[1].opacity);
  ok(r.shapes[2].fill === null && r.shapes[2].stroke.color === '#e8862e', 'roundtrip: stroke-only shape survives');
  // curves come back as curves
  ok(r.shapes[1].cmds.filter(c => c[0] === 'C').length === 4, 'roundtrip: ellipse still 4 cubics');
  // z-order preserved
  ok(r.shapes.map(s => s.fill).join() === '#2f6fb3,#6cb33f,', 'roundtrip: z-order preserved');
}
{
  // demo doc round-trips (the exact content a first-time user would export)
  const doc = C.demoDoc();
  const r = P.parsePDFDoc(P.buildPDFBytes(doc));
  ok(r.shapes.length === 3, 'roundtrip: demo doc all shapes', r.shapes.length);
  const rebuilt = C.newDoc({ units: 'in', w: r.artboard.w / 72, h: r.artboard.h / 72 });
  for (const s of r.shapes) C.addShape(rebuilt, s);
  const r2 = P.parsePDFDoc(P.buildPDFBytes(rebuilt));
  ok(r2.shapes.length === 3, 'roundtrip: stable under a second pass');
  for (let i = 0; i < 3; i++) {
    const a = C.tightBBox(r.shapes[i].cmds), b = C.tightBBox(r2.shapes[i].cmds);
    ok(near(a.x, b.x, 0.01) && near(a.y, b.y, 0.01), 'roundtrip: pass-2 shape ' + i + ' geometry stable');
  }
}

console.log(`pdftest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
