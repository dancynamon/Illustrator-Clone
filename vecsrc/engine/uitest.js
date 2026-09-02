// uitest — end-to-end tests for the built app (vector-studio.html), driven in
// a real browser. The other suites are pure-node and never load studio_app.js,
// so a panel that silently no-ops still passes them; this one clicks and drags
// the way a person does and asserts the document actually changed.
//
// Needs Playwright + Chromium, which are deliberately NOT dependencies of this
// repo (it has none). Where they are absent the suite skips rather than fails,
// so `npm test` stays runnable anywhere. Run it with `npm run uitest`.
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = 'file://' + path.join(ROOT, 'vector-studio.html');

// Playwright lives wherever the machine put it; try the usual spots.
function loadPlaywright() {
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright',
    path.join(ROOT, 'node_modules/playwright')];
  for (const t of tries) {
    try { return require(t); } catch (_) { /* keep looking */ }
  }
  return null;
}

const pw = loadPlaywright();
if (!pw) {
  console.log('uitest: skipped (playwright not found — install it to run browser tests)');
  process.exit(0);
}

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; console.error('FAIL:', name, detail == null ? '' : '— ' + detail); }
}

// Tests read the built bundle, so build first — otherwise a source edit would
// be quietly tested against a stale vector-studio.html.
execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'ignore' });

// Two colors planted in the trace bitmap, checked on the way back out.
const TRACE_RED = [208, 32, 32];
const TRACE_BLUE = [32, 64, 192];
function nearHex(hex, target, tol = 40) {
  if (!hex) return false;
  const n = parseInt(String(hex).slice(1), 16);
  return [16, 8, 0].every((sh, i) => Math.abs((n >> sh & 255) - target[i]) <= tol);
}

(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(APP);
  await page.waitForTimeout(900);

  const box = await page.locator('#stage').boundingBox();
  const drag = async (x0, y0, x1, y1) => {
    await page.mouse.move(box.x + x0, box.y + y0);
    await page.mouse.down();
    await page.mouse.move(box.x + x1, box.y + y1, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  const click = async (x, y) => {
    await page.mouse.move(box.x + x, box.y + y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  const shapeCount = () => page.evaluate(() => window.VEC_STUDIO.state.doc.shapes.length);
  const pickTool = async t => { await page.click(`[data-tool="${t}"]`); await page.waitForTimeout(80); };
  // setSel() only moves the selection; render() is what repaints the panels,
  // which is what a real canvas click ends up doing.
  const selectIndex = i => page.evaluate(n => {
    const S = window.VEC_STUDIO;
    S.setSel([S.state.doc.shapes[n].id]);
    S.render();
  }, i);

  // ---- drawing tools ----
  const n0 = await shapeCount();
  await pickTool('rect');
  await drag(300, 200, 460, 320);
  const nRect = await shapeCount();
  ok(nRect === n0 + 1, 'rect tool creates a shape', `${n0} -> ${nRect}`);

  await pickTool('ellipse');
  await drag(520, 200, 650, 330);
  const nEll = await shapeCount();
  ok(nEll === nRect + 1, 'ellipse tool creates a shape', `${nRect} -> ${nEll}`);

  await pickTool('pen');
  for (const [x, y] of [[300, 420], [420, 420], [360, 520]]) await click(x, y);
  await click(300, 420); // back on the first anchor closes the path
  await page.waitForTimeout(120);
  const nPen = await shapeCount();
  ok(nPen === nEll + 1, 'pen tool creates a path', `${nEll} -> ${nPen}`);
  ok(await page.evaluate(() => {
    const s = window.VEC_STUDIO.state.doc.shapes;
    return s[s.length - 1].cmds.some(c => c[0] === 'Z');
  }), 'pen path closes (emits Z)');

  // ---- history over drawn geometry ----
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  ok(await shapeCount() === nEll, 'undo removes the drawn path');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  ok(await shapeCount() === nPen, 'redo restores it');

  // ---- direct selection ----
  await pickTool('select');
  await page.evaluate(() => {
    const S = window.VEC_STUDIO, s = S.state.doc.shapes;
    S.setSel([s[s.length - 1].id]); S.render();
  });
  const cmdsOf = () => page.evaluate(() =>
    JSON.stringify(window.VEC_STUDIO.state.doc.shapes.slice(-1)[0].cmds));
  const beforeCmds = await cmdsOf();
  await pickTool('direct');
  await drag(300, 420, 340, 450);
  ok(await cmdsOf() !== beforeCmds, 'direct-select drag edits path geometry');

  // ---- fill ----
  await pickTool('select');
  await selectIndex(0);
  await page.fill('#col-hex', '#ff8800');
  await page.press('#col-hex', 'Enter');
  await page.waitForTimeout(200);
  const fillNow = await page.evaluate(() => window.VEC_STUDIO.state.doc.shapes[0].fill);
  ok(String(fillNow).toLowerCase() === '#ff8800', 'fill applies to the selection', 'fill=' + fillNow);

  // ---- stroke (needs a stroked target; the fields correctly disable without one) ----
  const stroked = await page.evaluate(() =>
    window.VEC_STUDIO.state.doc.shapes.findIndex(s => s.stroke));
  ok(stroked >= 0, 'document has a stroked shape to test against', 'index ' + stroked);
  await selectIndex(stroked);
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => document.querySelector('#st-w').disabled) === false,
    'stroke fields enable for a stroked selection');
  await page.fill('#st-w', '4');
  await page.press('#st-w', 'Enter');
  await page.waitForTimeout(200);
  ok(await page.evaluate(i => window.VEC_STUDIO.state.doc.shapes[i].stroke.w, stroked) === 4,
    'stroke weight applies');
  await page.fill('#st-dash', '6 3');
  await page.press('#st-dash', 'Enter');
  await page.waitForTimeout(200);
  const dash = await page.evaluate(i => window.VEC_STUDIO.state.doc.shapes[i].stroke.dash, stroked);
  ok(Array.isArray(dash) && dash.length === 2, 'stroke dash applies', JSON.stringify(dash));

  // ---- numeric transform ----
  await page.fill('#t-w', '2');
  await page.press('#t-w', 'Enter');
  await page.waitForTimeout(250);
  const wIn = await page.evaluate(() => {
    const S = window.VEC_STUDIO, C = S.VECCORE;
    const b = C.shapesBBox(S.state.doc.shapes.filter(s => S.state.sel.has(s.id)));
    return b ? b.w / 72 : null;
  });
  ok(Math.abs(wIn - 2) < 0.01, 'Transform W resizes the selection', 'W=' + wIn + 'in');

  // ---- layers ----
  const L0 = await page.evaluate(() => window.VEC_STUDIO.state.doc.layers.length);
  await page.evaluate(() => window.VEC_STUDIO.doAddLayer());
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => window.VEC_STUDIO.state.doc.layers.length) === L0 + 1,
    'Layers panel adds a layer');
  await page.evaluate(() => {
    const S = window.VEC_STUDIO;
    S.setSel([S.state.doc.shapes[0].id]); S.doLock(); S.render();
  });
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => window.VEC_STUDIO.state.doc.shapes[0].locked) === true,
    'lock selection sets the locked flag');

  // ---- separations ----
  const inks = await page.evaluate(() =>
    window.VEC_STUDIO.docInks(window.VEC_STUDIO.state.doc).map(i => i.name));
  ok(inks.length > 0, 'separations panel lists inks', inks.join(', '));
  ok(await page.evaluate(() =>
    window.VEC_STUDIO.docInks(window.VEC_STUDIO.state.doc).some(i => i.type === 'spot')),
  'a spot ink is detected');

  const plates = await page.evaluate(() =>
    window.PDFIO.exportPlatePDFs(window.VEC_STUDIO.state.doc, { marks: true })
      .map(p => ({
        name: p.ink.name, bytes: p.bytes.length,
        head: String.fromCharCode.apply(null, p.bytes.slice(0, 5)),
      })));
  ok(plates.length > 0, 'plate export emits a PDF per ink', plates.length + ' plates');
  ok(plates.every(p => p.head === '%PDF-' && p.bytes > 800), 'plates are well-formed PDFs',
    plates.map(p => `${p.name}:${p.bytes}B`).join(' '));

  // Color fidelity: the ink has to come back an ink, not a flattened RGB.
  const spots = await page.evaluate(async () => {
    const bytes = window.PDFIO.exportDocPDF(window.VEC_STUDIO.state.doc);
    const r = await window.PDFIO.docFromPDF(bytes);
    return (r.doc.swatches || []).filter(s => s.space === 'separation').map(s => s.name);
  });
  ok(spots.length > 0, 'spot ink survives export -> reimport', JSON.stringify(spots));

  // ---- image trace ----
  const traced = await page.evaluate(async ([red, blue]) => {
    const S = window.VEC_STUDIO;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgb(' + red.join(',') + ')'; g.fillRect(8, 8, 24, 24);
    g.fillStyle = 'rgb(' + blue.join(',') + ')';
    g.beginPath(); g.arc(44, 44, 14, 0, 7); g.fill();
    S.addPlacedImage('uitest', cv.toDataURL('image/png'), 64, 64);
    await new Promise(r => setTimeout(r, 500));
    const img = S.state.doc.shapes.find(s => s.type === 'image');
    if (!img) return { err: 'no image placed' };
    const before = S.state.doc.shapes.filter(s => s.type === 'path').length;
    S.setSel([img.id]); S.render();
    await new Promise(r => setTimeout(r, 400));
    await S.expandTrace();
    await new Promise(r => setTimeout(r, 800));
    const after = S.state.doc.shapes.filter(s => s.type === 'path');
    return {
      before, after: after.length,
      newFills: after.slice(before).map(s => s.fill),
      imageGone: !S.state.doc.shapes.some(s => s.id === img.id),
    };
  }, [TRACE_RED, TRACE_BLUE]);
  ok(!traced.err && traced.after > traced.before, 'image trace adds vector paths',
    JSON.stringify(traced));
  ok(!traced.err && traced.newFills.some(f => nearHex(f, TRACE_RED)) &&
    traced.newFills.some(f => nearHex(f, TRACE_BLUE)),
  'traced paths carry the source bitmap colors', JSON.stringify(traced.newFills));
  ok(!traced.err && traced.imageGone === true, 'Expand replaces the placed image');

  // A thrown handler anywhere above would not necessarily fail an assertion.
  ok(errs.length === 0, 'no JS errors during the session', errs.join(' | '));

  await browser.close();
  console.log(`uitest: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => {
  console.error('uitest: harness error —', e.message);
  process.exit(1);
});
