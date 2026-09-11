// bench — interactive-path benchmark for Aquamentor Vector Studio. Not a test:
// it never fails on a number, it reports them so a change can be compared
// against the run before it. Run with `npm run bench`.
//
// The node half (trace, path offsetting, history snapshot) always runs. The
// browser half drives the built vector-studio.html in Chromium and needs
// Playwright, which is deliberately not a dependency of this repo; without it
// that half is skipped and the node numbers still print.
const { execFileSync } = require('child_process');
const path = require('path');
const C = require('./veccore.js');
const T = require('./trace.js');

const ROOT = path.join(__dirname, '..');
const APP = 'file://' + path.join(ROOT, 'vector-studio.html');

function med(a) { a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; }
// A few untimed passes first, so the JIT has settled before anything counts.
function timeMs(fn, n = 30, warm = 5) {
  for (let i = 0; i < warm; i++) fn();
  const t = [];
  for (let i = 0; i < n; i++) { const t0 = process.hrtime.bigint(); fn(); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  return med(t);
}
const rows = [];
function row(name, value, unit) { rows.push([name, typeof value === 'number' ? +value.toFixed(2) : value, unit || '']); }
function print(title) {
  console.log('\n' + title);
  for (const [n, v, u] of rows) console.log('  ' + n.padEnd(46) + String(v).padStart(9) + ' ' + u);
  rows.length = 0;
}

// The same document the browser half uses: 300 shapes, every 7th with an
// inside-aligned dashed stroke, which is the expensive case on screen.
const STRESS_DOC = `(() => {
  const C = window.VEC_STUDIO.VECCORE, doc = C.newDoc();
  for (let i = 0; i < 300; i++) {
    const x = 60 + (i % 20) * 28, y = 60 + Math.floor(i / 20) * 45;
    const cmds = i % 3 === 0 ? C.starPath(x, y, 12, 5, 5)
      : i % 3 === 1 ? C.ellipsePath(x - 10, y - 10, 20, 20) : C.rectPath(x - 10, y - 10, 20, 20, 3);
    C.addShape(doc, { type: 'path', name: 's' + i, cmds, fill: ['#2f6fb3', '#e8862e', '#6bb33e'][i % 3],
      stroke: i % 7 === 0 ? { color: '#1d1d1b', w: 3, align: 'inside', dash: [4, 2] } : (i % 5 === 0 ? { color: '#000', w: 1 } : null),
      opacity: i % 15 === 0 ? 0.6 : 1 });
  }
  return doc;
})()`;

// ---- node half ----
{
  const w = 1000, h = 1000, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0, c = ((x >> 6) + (y >> 6)) & 1 ? [220, 40, 40] : [40, 60, 200];
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  for (const preset of ['color6', 'pixel', 'bw']) {
    let r;
    const ms = timeMs(() => { r = T.trace({ w, h, data: d }, { preset }); }, 3, 1);
    row(`trace 1000x1000 ${preset} (${r.paths.length} paths)`, ms, 'ms');
  }
  const blob = [['M', 0, 0]];
  for (let i = 1; i < 200; i++) blob.push(['C', i * 3, Math.sin(i) * 40, i * 3 + 1, Math.cos(i) * 40, i * 3 + 2, Math.sin(i * 1.3) * 40]);
  blob.push(['Z']);
  const st = { color: '#000', w: 8, align: 'inside' };
  for (const [name, p] of [['star', C.starPath(200, 200, 150, 60, 5)], ['ellipse', C.ellipsePath(0, 0, 300, 200)], ['200-anchor blob', blob]]) {
    let out;
    const ms = timeMs(() => { out = C.strokeOffsetPath(p, st); }, 50);
    row(`strokeOffsetPath ${name} (-> ${out ? out.length : 0} cmds)`, ms, 'ms');
  }
  const doc = C.newDoc();
  for (let i = 0; i < 300; i++) C.addShape(doc, { type: 'path', cmds: C.starPath(i, i, 12, 5, 5), fill: '#000' });
  row('serializeDoc 300 shapes (history snapshot)', timeMs(() => C.serializeDoc(doc), 20), 'ms');
  print('node');
}

// ---- browser half ----
function loadPlaywright() {
  for (const t of ['playwright', '/opt/node22/lib/node_modules/playwright', path.join(ROOT, 'node_modules/playwright')]) {
    try { return require(t); } catch (_) { /* keep looking */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log('\nbrowser: skipped (playwright not found)'); process.exit(0); }

// Bench the bundle as built from the current sources, never a stale one.
execFileSync(process.execPath, [path.join(__dirname, 'build.js')], { stdio: 'ignore' });

(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(APP);
  await page.waitForTimeout(800);

  const r = await page.evaluate(async (STRESS) => {
    const S = window.VEC_STUDIO, C = S.VECCORE;
    const med = a => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; };
    const time = (fn, n = 30, warm = 5) => { for (let i = 0; i < warm; i++) fn(); const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); } return med(t); };
    const out = {};
    S.applyNewDoc(eval(STRESS));
    out.render_idle = time(() => S.render());
    S.selectAll();
    out.render_all_selected = time(() => S.render());

    // A move-drag replaces every selected shape's cmds each pointer move; the
    // fresh-cmds number is what a frame costs mid-drag, the cache-hit one is
    // the floor once nothing has moved.
    const snap = new Map(S.state.doc.shapes.filter(s => S.state.sel.has(s.id)).map(s => [s.id, JSON.parse(JSON.stringify(s.cmds))]));
    S.state.drag = { kind: 'move', orig: snap, wx0: 0, wy0: 0, moved: true };
    let k = 0;
    out.drag_frame_fresh_cmds = time(() => { S.applyDragMatrix(C.mTranslate(++k, 0)); S.render(); });
    out.drag_frame_cache_hit = time(() => S.render());
    out.panel_sync_mid_drag = time(() => S.updateReadouts());
    S.state.drag = null;
    out.panel_sync_idle = time(() => S.updateReadouts());

    // Frame coalescing: a burst of pointer moves inside one task should draw
    // once, on the next animation frame, not once per event.
    window.__renders = 0;
    const fr = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) { if (w >= 1000 && x === 0 && y === 0) window.__renders++; return fr.call(this, x, y, w, h); };
    const cv = document.querySelector('#stage');
    S.state.pan = { sx: 100, sy: 100, view0: { ...S.state.view } };
    for (let i = 0; i < 20; i++) cv.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 + i, clientY: 100 + i, bubbles: true, pointerId: 1 }));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    out.renders_per_20_event_burst = window.__renders;
    S.state.pan = null; S.render();
    window.__renders = 0; window.__moves = 0;
    cv.addEventListener('pointermove', () => window.__moves++);
    const s = S.state.doc.shapes[3], bb = C.tightBBox(s.cmds);
    out.grab = C.w2s(S.state.view, bb.x + bb.w / 2, bb.y + bb.h / 2);
    return out;
  }, STRESS_DOC);

  // A real drag through the input pipeline: 150 pointer steps moving the whole
  // selection. Playwright awaits each step, so this measures per-frame cost
  // under real events rather than coalescing.
  const box = await page.locator('#stage').boundingBox();
  const t0 = Date.now();
  await page.mouse.move(box.x + r.grab[0], box.y + r.grab[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + r.grab[0] + 300, box.y + r.grab[1] + 200, { steps: 150 });
  await page.mouse.up();
  const wall = Date.now() - t0;
  const c = await page.evaluate(() => ({ moves: window.__moves, renders: window.__renders }));
  await browser.close();

  row('render, idle (300 shapes)', r.render_idle, 'ms');
  row('render, all 300 selected', r.render_all_selected, 'ms');
  row('drag frame, fresh cmds (aligned strokes)', r.drag_frame_fresh_cmds, 'ms');
  row('drag frame, cache hit', r.drag_frame_cache_hit, 'ms');
  row('panel sync per frame, idle', r.panel_sync_idle, 'ms');
  row('panel sync per frame, mid-drag', r.panel_sync_mid_drag, 'ms');
  row('renders from a 20-event pointer burst', r.renders_per_20_event_burst, '');
  row(`real 150-step drag (${c.moves} moves, ${c.renders} renders)`, wall, 'ms');
  print('browser');
  if (errs.length) { console.error('\npage errors:\n  ' + errs.join('\n  ')); process.exit(1); }
})().catch(e => { console.error('bench: harness error —', e.message); process.exit(1); });
