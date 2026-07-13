// pdfiotest — node tests for PDF/.ai import (VecPDF + PDFIO bridge) and
// flat vector-PDF export. Sample PDFs are built in-memory so the suite
// stays self-contained.
const zlib = require('zlib');
const C = require('./veccore.js');
const PDFIO = require('./pdfio.js');
const VecPDF = require('./pdfimport.js');
require('./pdfexport.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function near(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }

// ---- minimal PDF builders ----
function buf(s) { return Buffer.from(s, 'latin1'); }

function assemblePDF(objects, trailerExtra) {
  const chunks = [buf('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')];
  let pos = chunks[0].length;
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    const o = objects[i];
    const body = (o && typeof o === 'object' && o.stream !== undefined)
      ? Buffer.concat([buf(i + ' 0 obj\n' + o.dict + '\nstream\n'), o.stream, buf('\nendstream\nendobj\n')])
      : buf(i + ' 0 obj\n' + o + '\nendobj\n');
    offsets[i] = pos;
    chunks.push(body);
    pos += body.length;
  }
  let tail = 'xref\n0 ' + objects.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objects.length; i++) tail += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  tail += 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R' + (trailerExtra || '') +
    ' >>\nstartxref\n' + pos + '\n%%EOF\n';
  chunks.push(buf(tail));
  return new Uint8Array(Buffer.concat(chunks));
}

function contentObj(content, compress) {
  const raw = buf(content);
  if (compress) {
    const z = zlib.deflateSync(raw);
    return { dict: '<< /Length ' + z.length + ' /Filter /FlateDecode >>', stream: z };
  }
  return { dict: '<< /Length ' + raw.length + ' >>', stream: raw };
}

// red rect + blue stroked triangle + gray cubic under a cm translate
const BASIC_CONTENT = [
  '1 0 0 rg', '72 648 144 72 re', 'f',
  '0 0 1 RG', '3 w', '300 100 m', '400 300 l', '200 300 l', 'h', 'S',
  'q', '1 0 0 1 100 400 cm', '0.5 g', '0 0 m', '50 80 150 80 200 0 c', 'h', 'f', 'Q',
].join('\n');

function samplePDF(compress) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>';
  objs[4] = contentObj(BASIC_CONTENT, compress);
  return assemblePDF(objs);
}

function spotPDF() {
  const content = [
    '1 0 0 0 k', '50 500 100 100 re', 'f',       // pure cyan CMYK
    '/Spot1 cs', '1 scn', '50 300 100 100 re', 'f', // spot at 100%
  ].join('\n');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /ColorSpace << /Spot1 5 0 R >> >> >>';
  objs[4] = contentObj(content, false);
  objs[5] = '[/Separation /PANTONE#20185#20C /DeviceCMYK 6 0 R]';
  objs[6] = '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] /N 1 >>';
  return assemblePDF(objs);
}

function aiFile() { // Illustrator-style: PDF with an Illustrator /Creator
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 288 288] >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>';
  objs[4] = contentObj('1 0.2 0 0.1 k\n100 100 m\n200 100 l\n150 200 l\nh\nf', true);
  objs[5] = '<< /Creator (Adobe Illustrator 27.0) >>';
  return assemblePDF(objs, ' /Info 5 0 R');
}

function cmdBBox(cmds) { return C.tightBBox(cmds); }

(async () => {

  // ---- import: geometry, colors, veccore doc construction ----
  for (const compress of [false, true]) {
    const label = compress ? 'flate' : 'plain';
    const { doc, pageCount, isAI } = await PDFIO.docFromPDF(samplePDF(compress), 'sample.pdf');
    ok(pageCount === 1 && !isAI, label + ': one plain page');
    ok(near(doc.artboard.w, 612) && near(doc.artboard.h, 792), label + ': artboard from MediaBox');
    ok(doc.name === 'sample', label + ': doc named from file');
    ok(doc.shapes.length === 3, label + ': three shapes imported');

    const [rect, tri, blob] = doc.shapes;
    ok(rect.fill === '#ff0000' && rect.stroke === null, label + ': rect fill hex');
    const rb = cmdBBox(rect.cmds);
    ok(near(rb.x, 72) && near(rb.y, 72) && near(rb.w, 144) && near(rb.h, 72), label + ': rect geometry y-flipped');
    ok(tri.fill === null && tri.stroke && tri.stroke.color === '#0000ff' && near(tri.stroke.w, 3),
      label + ': stroked triangle');
    ok(blob.fillInfo && blob.fillInfo.space === 'gray' && near(blob.fillInfo.values[0], 0.5),
      label + ': gray fill keeps print info');
    ok(blob.cmds.some(c => c[0] === 'C'), label + ': cubic segment survives');
    ok(doc.swatches.length === 3, label + ': palette captured on doc');

    // imported doc round-trips through the .aqv project format
    const re = C.parseDoc(C.serializeDoc(doc));
    ok(re.shapes.length === 3 && re.shapes[2].fillInfo.space === 'gray',
      label + ': fillInfo survives .aqv serialize/parse');
  }

  // ---- import: CMYK + spot capture ----
  {
    const { doc } = await PDFIO.docFromPDF(spotPDF(), 'inks.pdf');
    ok(doc.shapes.length === 2, 'spot: two shapes');
    const [cyan, spot] = doc.shapes;
    ok(cyan.fillInfo && cyan.fillInfo.space === 'cmyk' &&
      JSON.stringify(cyan.fillInfo.values) === '[1,0,0,0]', 'spot: CMYK components kept');
    ok(cyan.fill === '#00ffff', 'spot: CMYK hex preview');
    ok(spot.fillInfo && spot.fillInfo.space === 'separation' &&
      spot.fillInfo.name === 'PANTONE 185 C', 'spot: separation name captured');
    ok(spot.name === 'PANTONE 185 C', 'spot: shape named after ink');
    ok(doc.swatches.some(s => s.name === 'PANTONE 185 C'), 'spot: ink in doc.swatches');
  }

  // ---- import: .ai flavored ----
  {
    const { doc, isAI } = await PDFIO.docFromPDF(aiFile(), 'logo.ai');
    ok(isAI, 'ai: detected Illustrator file');
    ok(doc.name === 'logo' && doc.shapes.length === 1, 'ai: imported');
    ok(doc.shapes[0].fillInfo.space === 'cmyk', 'ai: CMYK kept');
  }

  // ---- import: broken input fails with a message ----
  {
    let msg = '';
    try { await PDFIO.docFromPDF(new TextEncoder().encode('not a pdf'), 'x.pdf'); }
    catch (e) { msg = e.message; }
    ok(/Not a PDF/.test(msg), 'reject: non-PDF errors cleanly');
  }

  // ---- export: veccore doc -> flat PDF -> reparse ----
  {
    const doc = C.newDoc({ w: 5, h: 4, units: 'in' }); // 360 x 288 pt
    doc.name = 'exported';
    C.addShape(doc, {
      type: 'path', fill: '#3366cc', stroke: { color: '#000000', w: 2 },
      cmds: C.rectPath(36, 36, 144, 72),
    });
    C.addShape(doc, {
      type: 'path', fill: '#ff9900', stroke: null,
      cmds: C.ellipsePath(250, 150, 60, 40),
    });
    // hidden layer content must not export
    doc.layers.push({ id: 'L2', name: 'hidden', visible: false, locked: false });
    C.addShape(doc, { type: 'path', layer: 'L2', fill: '#00ff00', cmds: C.rectPath(0, 0, 10, 10) });
    // CMYK print info attached to a shape wins over its hex preview
    C.addShape(doc, {
      type: 'path', fill: '#00ffff', fillInfo: { space: 'cmyk', values: [1, 0, 0, 0] },
      cmds: C.rectPath(200, 200, 50, 50),
    });

    const bytes = PDFIO.exportDocPDF(doc);
    ok(bytes instanceof Uint8Array && String.fromCharCode(...bytes.slice(0, 8)) === '%PDF-1.4',
      'export: produces a PDF');

    const re = await VecPDF.parsePDF(bytes);
    ok(near(re.pages[0].width, 360) && near(re.pages[0].height, 288), 'export: artboard size');
    ok(re.pages[0].shapes.length === 3, 'export: hidden layer dropped');
    const [rect, ell, cyan] = re.pages[0].shapes;
    ok(rect.fill && near(rect.fill.rgb[0], 0x33 / 255) && rect.stroke && near(rect.strokeWidth, 2),
      'export: fill+stroke round-trip');
    ok(ell.subpaths[0].segments.every(s => s.type === 'cubic'), 'export: ellipse cubics kept');
    ok(cyan.fill.space === 'cmyk' && near(cyan.fill.values[0], 1), 'export: CMYK written natively');
  }

  // ---- full circle: PDF -> veccore doc -> PDF -> veccore doc ----
  {
    const a = await PDFIO.docFromPDF(spotPDF(), 'inks.pdf');
    const b = await PDFIO.docFromPDF(PDFIO.exportDocPDF(a.doc), 'inks2.pdf');
    ok(b.doc.shapes.length === a.doc.shapes.length, 'circle: shape count stable');
    const b0 = cmdBBox(a.doc.shapes[0].cmds), b1 = cmdBBox(b.doc.shapes[0].cmds);
    ok(near(b0.x, b1.x) && near(b0.y, b1.y) && near(b0.w, b1.w) && near(b0.h, b1.h),
      'circle: geometry stable');
    ok(b.doc.shapes[0].fillInfo.space === 'cmyk', 'circle: CMYK stable through app model');
  }

  console.log(`pdfiotest: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error('pdfiotest crashed:', e); process.exit(1); });
