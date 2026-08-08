// separatetest — node tests for ink separation (separate.js), plate PDF
// writing (pdfexport.exportPlatePDF) and the plate bridge in pdfio. Every
// exported plate is re-parsed with this repo's own PDF parser, so "the ink
// survived" is proved by reading the file back, not by trusting the writer.
const C = require('./veccore.js');
const S = require('./separate.js');
const PDFIO = require('./pdfio.js');
const VecPDF = require('./pdfimport.js');
require('./pdfexport.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function near(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }
function latin1(bytes) { return Buffer.from(bytes).toString('latin1'); }

const CMYK = (c, m, y, k) => ({ space: 'cmyk', values: [c, m, y, k] });
const SPOT = (name, cmyk, tint = 1) => ({
  space: 'separation', name, values: [tint], alt: { space: 'cmyk', values: cmyk },
});

// 12x8 in piece: a spot-white panel, a spot-red mark, a CMYK build and an
// RGB stray — the shape of a real foam job that came in half-clean.
function jobDoc() {
  const doc = C.newDoc({ w: 12, h: 8, units: 'in' });
  doc.name = 'Foam Mat 12x8';
  C.addShape(doc, {
    type: 'path', name: 'White panel', fill: '#ffffff',
    fillInfo: SPOT('WHITE', [0, 0, 0, 0]), cmds: C.rectPath(72, 72, 288, 144),
  });
  C.addShape(doc, {
    type: 'path', name: 'Spot red', fill: '#e03c31',
    fillInfo: SPOT('PANTONE 185 C', [0, 0.91, 0.76, 0]), cmds: C.ellipsePath(540, 288, 72, 72),
  });
  C.addShape(doc, {
    type: 'path', name: 'Process build', fill: '#00a0b0', fillInfo: CMYK(1, 0.1, 0.3, 0),
    stroke: { color: '#000000', w: 2 }, strokeInfo: CMYK(0, 0, 0, 1),
    cmds: C.rectPath(432, 432, 216, 72),
  });
  C.addShape(doc, {
    type: 'path', name: 'RGB stray', fill: '#3366cc', cmds: C.rectPath(72, 432, 72, 72),
  });
  doc.swatches = [
    { space: 'separation', values: [1], rgb: [1, 1, 1], name: 'WHITE', alt: { space: 'cmyk', values: [0, 0, 0, 0] }, uses: 1 },
    { space: 'separation', values: [1], rgb: [0.88, 0.24, 0.19], name: 'PANTONE 185 C', alt: { space: 'cmyk', values: [0, 0.91, 0.76, 0] }, uses: 1 },
  ];
  return doc;
}

function processOnlyDoc() { // no spots anywhere
  const doc = C.newDoc({ w: 4, h: 3, units: 'in' });
  doc.name = 'Process only';
  C.addShape(doc, { type: 'path', fill: '#00ffff', fillInfo: CMYK(1, 0, 0, 0), cmds: C.rectPath(10, 10, 60, 40) });
  C.addShape(doc, { type: 'path', fill: '#ff00ff', fillInfo: CMYK(0, 1, 0, 0), cmds: C.rectPath(80, 10, 60, 40) });
  C.addShape(doc, { type: 'path', fill: '#333333', fillInfo: CMYK(0, 0, 0, 0.8), cmds: C.rectPath(10, 80, 60, 40) });
  return doc;
}

function inkOf(list, key) { return list.find(i => i.key === key) || null; }
function plateOf(plates, key) { return plates.find(p => p.ink.key === key) || null; }

(async () => {

  // ---- colors -> inks ----
  {
    ok(S.colorInks('#00ffff', CMYK(1, 0, 0, 0)).map(i => i.key).join() === 'CYAN',
      'inks: pure cyan is one plate');
    const rich = S.colorInks('#123456', CMYK(0.8, 0.4, 0, 0.2)).map(i => i.key);
    ok(rich.join() === 'CYAN,MAGENTA,BLACK', 'inks: a build lists every channel it uses');
    ok(S.colorInks('#808080', { space: 'gray', values: [0.5] })[0].key === 'BLACK',
      'inks: gray prints on black');
    const spot = S.colorInks('#ffffff', SPOT('WHITE', [0, 0, 0, 0], 0.5))[0];
    ok(spot.type === 'spot' && spot.key === 'WHITE' && near(spot.tint, 0.5),
      'inks: a spot is one ink at its tint');
    ok(S.colorInks('#3366cc', null).length === 3, 'inks: RGB falls back to a process build');
    ok(S.inkKey('pantone 185 c') === S.inkKey('PANTONE 185 C'), 'inks: names normalize to one key');
  }

  // ---- document inks + counts ----
  {
    const doc = jobDoc();
    const inks = S.documentInks(doc);
    ok(inks.length === 6, 'doc inks: 4 process-ish + 2 spots');
    ok(inks.slice(0, 4).map(i => i.key).join() === 'CYAN,MAGENTA,YELLOW,BLACK',
      'doc inks: process first, in plate order');
    ok(inkOf(inks, 'WHITE').type === 'spot' && inkOf(inks, 'WHITE').objects === 1,
      'doc inks: spot white used once');
    ok(inkOf(inks, 'BLACK').objects === 2, 'doc inks: black counts the stroke and the RGB stray');
    ok(inkOf(inks, 'PANTONE 185 C').cmyk[1] === 0.91, 'doc inks: spot keeps its alternate build');

    // an ink registered in swatches but used by nothing still shows up
    doc.swatches.push({ space: 'separation', values: [1], rgb: [0, 0, 0], name: 'VARNISH', alt: null, uses: 0 });
    const withOrphan = S.documentInks(doc);
    ok(inkOf(withOrphan, 'VARNISH') && inkOf(withOrphan, 'VARNISH').objects === 0,
      'doc inks: an unused registered ink is still listed');

    // hidden layers do not print, so they do not count
    doc.layers.push({ id: 'L2', name: 'notes', visible: false, locked: false });
    C.addShape(doc, { type: 'path', layer: 'L2', fill: '#ffffff', fillInfo: SPOT('WHITE', [0, 0, 0, 0]), cmds: C.rectPath(0, 0, 10, 10) });
    ok(inkOf(S.documentInks(doc), 'WHITE').objects === 1, 'doc inks: hidden layers are not counted');
  }

  // ---- separation preview ----
  {
    const visible = new Set(['CYAN', 'MAGENTA', 'YELLOW', 'BLACK']);
    ok(S.previewHex('#ffffff', SPOT('WHITE', [0, 0, 0, 0]), visible) === null,
      'preview: hiding an ink makes its objects vanish');
    ok(S.previewHex('#00a0b0', CMYK(1, 0.1, 0.3, 0), visible) === '#00a0b0',
      'preview: all inks visible leaves the color alone');
    const cyanOff = S.previewHex('#00a0b0', CMYK(1, 0.1, 0.3, 0), new Set(['MAGENTA', 'YELLOW', 'BLACK']));
    ok(cyanOff && cyanOff !== '#00a0b0' && S.hexToRgb(cyanOff)[0] > 0.8,
      'preview: dropping cyan repaints from the remaining inks');
    ok(S.previewHex('#00a0b0', CMYK(1, 0.1, 0.3, 0), null) === '#00a0b0', 'preview: no filter is a no-op');
  }

  // ---- plates: one per ink, only that ink's geometry ----
  {
    const doc = jobDoc();
    const plates = S.separatePlates(doc);
    ok(plates.length === 6, 'plates: 2 spots + CMYK separate into 6 plates');
    const white = plateOf(plates, 'WHITE');
    ok(white.objects === 1 && white.entries[0].shape.name === 'White panel',
      'plates: the white plate holds the white geometry');
    ok(white.entries.every(e => e.knockout || e.shape.name === 'White panel'),
      'plates: nothing else lands on the white plate');
    const black = plateOf(plates, 'BLACK');
    ok(black.objects === 2, 'plates: black carries the K stroke and the RGB stray');
    ok(near(plateOf(plates, 'CYAN').entries[0].fillTint, 1), 'plates: fill tint comes from the build');
    ok(plateOf(plates, 'MAGENTA').entries.some(e => near(e.fillTint, 0.1)),
      'plates: a 10% channel plates at 10%');
    ok(plateOf(plates, 'PANTONE 185 C').objects === 1, 'plates: the spot red plate is one object');
  }

  // ---- knockout vs overprint ----
  {
    const doc = C.newDoc({ w: 4, h: 4, units: 'in' });
    C.addShape(doc, { type: 'path', name: 'panel', fill: '#ffffff', fillInfo: SPOT('WHITE', [0, 0, 0, 0]), cmds: C.rectPath(0, 0, 288, 288) });
    C.addShape(doc, { type: 'path', name: 'logo', fill: '#000000', fillInfo: CMYK(0, 0, 0, 1), cmds: C.rectPath(72, 72, 72, 72) });
    C.addShape(doc, { type: 'path', name: 'far away', fill: '#000000', fillInfo: CMYK(0, 0, 0, 1), cmds: C.rectPath(600, 600, 10, 10) });

    const white = plateOf(S.separatePlates(doc), 'WHITE');
    ok(white.objects === 1 && white.knockouts === 1, 'knockout: an overlapping black logo holes the white plate');
    const hole = white.entries.find(e => e.knockout);
    ok(hole.shape.name === 'logo' && hole.fillTint === 0, 'knockout: the hole plates at zero tint');

    doc.shapes[1].overprint = true;
    ok(plateOf(S.separatePlates(doc), 'WHITE').knockouts === 0,
      'knockout: marking the logo overprint leaves the white plate solid');

    delete doc.shapes[1].overprint;
    ok(plateOf(S.separatePlates(doc, { knockouts: false }), 'WHITE').entries.length === 1,
      'knockout: {knockouts:false} exports ink geometry only');
    ok(S.setOverprint(doc, [doc.shapes[1].id], true) === 1 && doc.shapes[1].overprint === true,
      'knockout: setOverprint marks the object');
    ok(S.setOverprint(doc, [doc.shapes[1].id], null) === 1 && doc.shapes[1].overprint === undefined,
      'knockout: setOverprint(null) goes back to inheriting');
  }

  // ---- a document with zero spots still plates correctly ----
  {
    const doc = processOnlyDoc();
    const plates = S.separatePlates(doc);
    ok(plates.length === 3 && plates.map(p => p.ink.key).join() === 'CYAN,MAGENTA,BLACK',
      'process: only the channels actually used get plates');
    ok(plates.every(p => p.ink.type === 'process'), 'process: no phantom spots');
    const out = PDFIO.exportPlatePDFs(doc, { marks: false });
    ok(out.length === 3 && out.every(p => p.bytes instanceof Uint8Array), 'process: three plate PDFs');
    const re = await VecPDF.parsePDF(out[0].bytes);
    ok(re.pages[0].shapes.some(s => s.fill && s.fill.space === 'separation' && s.fill.name === 'Cyan'),
      'process: the cyan plate is a real /Separation named Cyan');
  }

  // ---- plate PDF structure: 2-layer OCG, house conventions ----
  {
    const doc = jobDoc();
    const out = PDFIO.exportPlatePDFs(doc);
    ok(out.length === 6, 'plate pdf: one file per ink');
    const white = out.find(p => p.ink.key === 'WHITE');
    ok(white.filename === 'Foam Mat 12x8_WHITE_spot+color.pdf', 'plate pdf: house filename');

    const src = latin1(white.bytes);
    ok(/\/OCProperties/.test(src), 'plate pdf: has /OCProperties');
    ok(/\/Type \/OCG \/Name \(Color\)/.test(src) && /\/Type \/OCG \/Name \(Spot\)/.test(src),
      'plate pdf: layers are named Color and Spot');
    ok(src.indexOf('/OC /oc_color BDC') > 0 && src.indexOf('/OC /oc_spot BDC') > 0,
      'plate pdf: marked content is /OC first, property name second');
    ok(src.indexOf('/oc_spot') > src.indexOf('/oc_color'), 'plate pdf: Spot layer draws last (on top)');
    ok((src.match(/BDC/g) || []).length === 2 && (src.match(/EMC/g) || []).length === 2,
      'plate pdf: exactly two marked-content blocks');
    ok(/\/OP true \/op true \/OPM 1/.test(src), 'plate pdf: overprint ExtGState present');

    const spotLayer = src.slice(src.indexOf('/OC /oc_spot BDC'), src.indexOf('EMC', src.indexOf('/OC /oc_spot BDC')));
    ok(!/ rg\b/.test(spotLayer) && !/ RG\b/.test(spotLayer), 'plate pdf: no RGB survives in the Spot layer');
    ok(!/ k\b/.test(spotLayer) && !/ K\b/.test(spotLayer), 'plate pdf: no process build in the Spot layer either');
    ok(/\/CS\d+ cs/.test(spotLayer), 'plate pdf: the Spot layer paints in a separation space');
    ok(/\/Separation \/WHITE \/DeviceCMYK/.test(src), 'plate pdf: ink written under its own name');
    ok(/\/Separation \/All \/DeviceCMYK/.test(src), 'plate pdf: marks image in registration');
    ok(/\/BaseFont \/Helvetica-Bold/.test(src) && /\(WHITE/.test(src), 'plate pdf: ink name label');
    ok(/\/TrimBox \[36 36 900 612\]/.test(src), 'plate pdf: trim box is the true piece size');
    ok(/\/MediaBox \[0 0 936 648\]/.test(src), 'plate pdf: media box adds the furniture margin');

    const bare = PDFIO.exportPlatePDFs(doc, { marks: false }).find(p => p.ink.key === 'WHITE');
    const bareSrc = latin1(bare.bytes);
    ok(/\/MediaBox \[0 0 864 576\]/.test(bareSrc), 'plate pdf: marks off means media box = piece size');
    ok(!/\/Separation \/All/.test(bareSrc), 'plate pdf: marks off drops the furniture');
  }

  // ---- round trip: plate -> parser -> the ink is still the ink ----
  {
    const doc = jobDoc();
    const plates = PDFIO.exportPlatePDFs(doc, { marks: false });

    const white = plates.find(p => p.ink.key === 'WHITE');
    const re = await PDFIO.docFromPDF(white.bytes, 'white.pdf');
    ok(near(re.doc.artboard.w, 864) && near(re.doc.artboard.h, 576),
      'round trip: plate reimports at true piece size');
    const sep = re.doc.shapes.filter(s => s.fillInfo && s.fillInfo.space === 'separation');
    ok(sep.length >= 1 && sep.every(s => s.fillInfo.name === 'WHITE'),
      'round trip: spot ink name survives export -> reimport');
    ok(near(sep[0].fillInfo.values[0], 1), 'round trip: tint survives');
    ok(re.doc.swatches.some(s => s.name === 'WHITE'), 'round trip: the ink lands in the palette');
    // both layers carry the same rectangle, in the same place
    const b = C.tightBBox(re.doc.shapes[0].cmds);
    ok(near(b.x, 72) && near(b.y, 72) && near(b.w, 288) && near(b.h, 144),
      'round trip: geometry lands at the same coordinates');
    ok(re.doc.shapes.length === 2, 'round trip: Color + Spot copies of the one object');

    const pms = plates.find(p => p.ink.key === 'PANTONE 185 C');
    const re2 = await PDFIO.docFromPDF(pms.bytes, 'pms.pdf');
    const s2 = re2.doc.shapes.find(s => s.fillInfo && s.fillInfo.space === 'separation');
    ok(s2.fillInfo.name === 'PANTONE 185 C', 'round trip: spaces in the ink name survive (#20 escaping)');
    ok(s2.fillInfo.alt && near(s2.fillInfo.alt.values[1], 0.91) && near(s2.fillInfo.alt.values[2], 0.76),
      'round trip: the ink alternate comes back identical, not via RGB');

    // a blank ink would render invisible, so the Spot layer's preview
    // alternate moves — the artwork's own color is left exactly as authored
    const reWhite = await VecPDF.parsePDF(white.bytes);
    const cols = reWhite.pages[0].shapes.map(s => s.fill).filter(f => f && f.space === 'separation');
    ok(cols.length === 2 && cols.every(f => f.name === 'WHITE'), 'round trip: both layers print WHITE');
    ok(cols[0].alt.values.every(v => v === 0), 'round trip: Color layer keeps the ink as authored');
    ok(cols[1].alt.values[3] > 0, 'round trip: blank white ink gets a visible preview alternate on the Spot layer');
  }

  // ---- overprint flags are preserved through the plate writer ----
  {
    const doc = jobDoc();
    doc.shapes[0].overprint = true;   // white panel overprints
    doc.shapes[1].overprint = false;  // spot red knocks out
    const plates = PDFIO.exportPlatePDFs(doc, { marks: false });
    const w = latin1(plates.find(p => p.ink.key === 'WHITE').bytes);
    ok(/\/OP true \/op true \/OPM 1/.test(w) && /\/GSop gs/.test(w), 'overprint: flag reaches the plate');
    const r = latin1(plates.find(p => p.ink.key === 'PANTONE 185 C').bytes);
    ok(/\/OP false \/op false \/OPM 0/.test(r) && /\/GSko gs/.test(r), 'overprint: knockout reaches the plate');
    // and it survives the project format, so undo/redo keeps it
    const round = C.parseDoc(C.serializeDoc(doc));
    ok(round.shapes[0].overprint === true && round.shapes[1].overprint === false,
      'overprint: flags survive .aqv serialize/parse');
  }

  // ---- flat export keeps spots as spots ----
  {
    const doc = jobDoc();
    const bytes = PDFIO.exportDocPDF(doc);
    const src = latin1(bytes);
    ok(/\/Separation \/WHITE \/DeviceCMYK/.test(src) && /\/Separation \/PANTONE#20185#20C/.test(src),
      'flat export: spot inks stay named separations');
    const re = await PDFIO.docFromPDF(bytes, 'flat.pdf');
    const names = re.doc.swatches.filter(s => s.space === 'separation').map(s => s.name).sort();
    ok(names.join('|') === 'PANTONE 185 C|WHITE', 'flat export: both inks reimport by name');
    ok(re.doc.shapes[2].fillInfo.space === 'cmyk', 'flat export: process build still CMYK');
  }

  // ---- ink management ----
  {
    const doc = jobDoc();
    ok(S.renameInk(doc, 'WHITE', 'PRINT WHITE') === 1, 'rename: one object repainted');
    ok(doc.shapes[0].fillInfo.name === 'PRINT WHITE' &&
      doc.swatches.some(s => s.name === 'PRINT WHITE'), 'rename: shape and swatch follow');
    ok(inkOf(S.documentInks(doc), 'PRINT WHITE').objects === 1, 'rename: the plate follows too');

    const d2 = jobDoc();
    ok(S.convertSpotToProcess(d2, 'PANTONE 185 C') === 1, 'spot->process: one object converted');
    ok(d2.shapes[1].fillInfo.space === 'cmyk' && near(d2.shapes[1].fillInfo.values[1], 0.91),
      'spot->process: the alternate build becomes the color');
    ok(!d2.swatches.some(s => s.name === 'PANTONE 185 C'), 'spot->process: ink leaves the registry');
    ok(!S.documentInks(d2).some(i => i.key === 'PANTONE 185 C'), 'spot->process: no plate left');

    const d3 = processOnlyDoc();
    ok(S.convertProcessToSpot(d3, 'BLACK', 'SAFETY BLACK') === 1, 'process->spot: solo-channel objects convert');
    ok(d3.shapes[2].fillInfo.space === 'separation' && d3.shapes[2].fillInfo.name === 'SAFETY BLACK' &&
      near(d3.shapes[2].fillInfo.values[0], 0.8), 'process->spot: tint preserved');
    ok(d3.swatches.some(s => s.name === 'SAFETY BLACK'), 'process->spot: ink registered');

    const d4 = jobDoc();
    ok(S.mergeInks(d4, 'WHITE', 'PANTONE 185 C') === 1, 'merge: objects move to the target ink');
    const merged = S.documentInks(d4);
    ok(!merged.some(i => i.key === 'WHITE'), 'merge: source ink is gone');
    ok(inkOf(merged, 'PANTONE 185 C').objects === 2, 'merge: target picks up the work');

    const d5 = jobDoc();
    d5.swatches.push({ space: 'separation', values: [1], rgb: [0, 0, 0], name: 'VARNISH', alt: null, uses: 0 });
    ok(S.deleteInk(d5, 'VARNISH') === true, 'delete: an unused ink can go');
    ok(S.deleteInk(d5, 'WHITE') === false, 'delete: an ink in use is refused');
    ok(S.deleteInk(d5, 'BLACK') === false, 'delete: process inks are not deletable');

    // every edit leaves a document the project format still accepts
    for (const d of [doc, d2, d3, d4, d5]) {
      let okDoc = true;
      try { C.parseDoc(C.serializeDoc(d)); } catch (e) { okDoc = false; }
      ok(okDoc, 'ink edits: document stays valid for history/undo');
    }
  }

  // ---- preflight ----
  {
    const doc = jobDoc();
    doc.swatches.push({ space: 'separation', values: [1], rgb: [0.88, 0.24, 0.19], name: 'Pantone 185C', alt: { space: 'cmyk', values: [0, 0.91, 0.76, 0] }, uses: 0 });
    doc.shapes[2].stroke.w = 0.1;
    const issues = S.preflight(doc);
    const codes = issues.map(i => i.code);
    ok(codes.includes('rgb'), 'preflight: flags leftover RGB');
    ok(issues.find(i => i.code === 'rgb').ids.length === 1, 'preflight: names the RGB object');
    ok(codes.includes('unused-ink'), 'preflight: flags an ink no object uses');
    ok(codes.includes('duplicate-spot'), 'preflight: flags near-duplicate spot definitions');
    ok(codes.includes('hairline'), 'preflight: flags hairline strokes');
    ok(S.preflight(doc, { minStroke: 0.05 }).every(i => i.code !== 'hairline'),
      'preflight: the hairline threshold is tunable');
    ok(S.preflight(processOnlyDoc()).length === 0, 'preflight: a clean process job passes');
    ok(S.preflight(C.newDoc()).some(i => i.code === 'empty'), 'preflight: an empty artboard is an error');
  }

  console.log(`separatetest: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error('separatetest crashed:', e); process.exit(1); });
