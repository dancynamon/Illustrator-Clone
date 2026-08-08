// vectest — node tests for veccore (document model, view math, paths).
const C = require('./veccore.js');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// ---- document ----
{
  const d = C.newDoc();
  ok(near(d.artboard.w, 612) && near(d.artboard.h, 792), 'newDoc default letter 612x792pt');
  ok(d.units === 'in' && d.layers.length === 1 && d.shapes.length === 0, 'newDoc defaults');
  const dmm = C.newDoc({ w: 254, h: 127, units: 'mm' });
  ok(near(dmm.artboard.w, 720) && near(dmm.artboard.h, 360), 'newDoc mm conversion');
  const s1 = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const s2 = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  ok(s1.id !== s2.id && d.shapes.length === 2, 'addShape unique ids');
  ok(s1.layer === 'L1', 'addShape default layer');
}

// ---- view math ----
{
  const v = { scale: 1.5, tx: 20, ty: 30 };
  const [sx, sy] = C.w2s(v, 100, 200);
  ok(near(sx, 170) && near(sy, 330), 'w2s');
  const [wx, wy] = C.s2w(v, sx, sy);
  ok(near(wx, 100) && near(wy, 200), 's2w roundtrip');
}
{
  // zoomAt keeps the anchor screen point on the same world point
  const v = { scale: 1.5, tx: 20, ty: 30 };
  const before = C.s2w(v, 100, 80);
  const v2 = C.zoomAt(v, 100, 80, 2);
  const after = C.s2w(v2, 100, 80);
  ok(near(v2.scale, 3), 'zoomAt scale');
  ok(near(before[0], after[0]) && near(before[1], after[1]), 'zoomAt anchor invariant');
  const vMin = C.zoomAt(v, 0, 0, 1e-9);
  const vMax = C.zoomAt(v, 0, 0, 1e9);
  ok(near(vMin.scale, 0.02) && near(vMax.scale, 96), 'zoomAt clamps');
}
{
  // fitRect centers the artboard
  const v = C.fitRect(1000, 800, 0, 0, 612, 792, 40);
  ok(near(v.scale, (800 - 80) / 792), 'fitRect scale limited by height');
  const [cx, cy] = C.w2s(v, 306, 396);
  ok(near(cx, 500) && near(cy, 400), 'fitRect centers');
}
{
  // tiny viewport must never produce a negative/zero scale
  const v = C.fitRect(8, 6, 0, 0, 612, 792, 40);
  ok(v.scale > 0, 'fitRect positive scale on tiny viewport');
  const v2 = C.fitRect(300, 300, 0, 0, 612, 792, 40);
  ok(v2.scale > 0 && near(v2.scale, (300 - 60) / 792), 'fitRect pad shrinks on small viewport');
}
{
  const v = C.panBy({ scale: 2, tx: 5, ty: 6 }, 10, -3);
  ok(v.tx === 15 && v.ty === 3 && v.scale === 2, 'panBy');
  ok(near(C.zoomPct({ scale: C.PX_PER_PT_100, tx: 0, ty: 0 }), 100), 'zoomPct 100 at 96dpi');
}

// ---- paths ----
{
  const b = C.pathBBox(C.rectPath(10, 20, 100, 50));
  ok(b && near(b.x, 10) && near(b.y, 20) && near(b.w, 100) && near(b.h, 50), 'rectPath bbox');
  const be = C.pathBBox(C.ellipsePath(50, 60, 30, 20));
  ok(be && near(be.x, 20) && near(be.y, 40) && near(be.w, 60) && near(be.h, 40), 'ellipsePath bbox exact');
  const rr = C.rectPath(0, 0, 100, 50, 10);
  ok(rr.filter(c => c[0] === 'C').length === 4, 'rounded rect has 4 corner curves');
  const st = C.starPath(0, 0, 100, 40, 5);
  ok(st.length === 11 && st[0][0] === 'M' && st[10][0] === 'Z', 'starPath command count');
  ok(near(st[1 - 1][2], -100), 'starPath first point at top');
  ok(C.pathBBox([['Z']]) === null, 'pathBBox empty');
}

// ---- demo doc ----
{
  const d = C.demoDoc();
  ok(d.shapes.length === 3, 'demoDoc 3 shapes');
  const ids = new Set(d.shapes.map(s => s.id));
  ok(ids.size === 3, 'demoDoc unique ids');
  ok(d.shapes.every(s => Array.isArray(s.cmds) && s.cmds.length > 1), 'demoDoc shapes have cmds');
}

// ---- color conversion ----
{
  ok(C.rgbToHex([1, 0, 0]) === '#ff0000', 'rgbToHex');
  ok(C.rgbToHex([0.5, 0.5, 0.5]) === '#808080', 'rgbToHex rounds');
  const rt = C.hexToRgb('#3366cc');
  ok(rt && near(rt[0], 0x33 / 255) && near(rt[2], 0xcc / 255), 'hexToRgb');
  ok(C.rgbToHex(C.hexToRgb('#0af')) === '#00aaff', 'hexToRgb expands 3-digit');
  ok(C.hexToRgb('nope') === null && C.hexToRgb('#12') === null, 'hexToRgb rejects garbage');
  ok(C.clamp01(2) === 1 && C.clamp01(-1) === 0 && C.clamp01(NaN) === 0, 'clamp01');
}
{
  ok(C.rgbToHex(C.cmykToRgb([1, 0, 0, 0])) === '#00ffff', 'cmyk cyan -> rgb');
  ok(C.rgbToHex(C.cmykToRgb([0, 0, 0, 1])) === '#000000', 'cmyk K -> black');
  ok(C.rgbToHex(C.cmykToRgb([0, 0, 0, 0])) === '#ffffff', 'cmyk empty -> white');
  const back = C.cmykToRgb(C.rgbToCmyk([0.2, 0.4, 0.8]));
  ok(near(back[0], 0.2) && near(back[1], 0.4) && near(back[2], 0.8), 'rgb -> cmyk -> rgb round trip');
  ok(JSON.stringify(C.rgbToCmyk([0, 0, 0])) === '[0,0,0,1]', 'black separates to K alone');
}
{
  const h = C.rgbToHsb([1, 0, 0]);
  ok(near(h[0], 0) && near(h[1], 1) && near(h[2], 1), 'rgbToHsb red');
  ok(near(C.rgbToHsb([0, 1, 0])[0], 120) && near(C.rgbToHsb([0, 0, 1])[0], 240), 'rgbToHsb hue wheel');
  ok(C.rgbToHsb([0.3, 0.3, 0.3])[1] === 0, 'gray has no saturation');
  for (const hex of ['#1188cc', '#ff8800', '#123456', '#ffffff', '#000000']) {
    ok(C.rgbToHex(C.hsbToRgb(C.rgbToHsb(C.hexToRgb(hex)))) === hex, 'hsb round trip ' + hex);
  }
  ok(C.rgbToHex(C.hsbToRgb([-60, 1, 1])) === C.rgbToHex(C.hsbToRgb([300, 1, 1])), 'hsbToRgb wraps negative hue');
}
{
  const cy = C.makeColor({ space: 'cmyk', values: [1, 0, 0, 0] });
  ok(C.colorHex(cy) === '#00ffff', 'makeColor cmyk appearance');
  ok(C.makeColor(null) === null && C.makeColor({ space: 'nope' }) === null, 'makeColor rejects non-colors');
  ok(C.makeColor({ space: 'cmyk' }).values.length === 4, 'makeColor pads missing components');
  const spot = C.makeColor({
    space: 'separation', name: 'PANTONE 185 C', values: [1],
    alt: { space: 'cmyk', values: [0, 0.91, 0.76, 0] },
  });
  ok(C.colorHex(spot) === C.rgbToHex(C.cmykToRgb([0, 0.91, 0.76, 0])), 'spot looks like its alternate build');
  const info = C.colorInfo(spot);
  ok(info.space === 'separation' && info.name === 'PANTONE 185 C' && info.alt.space === 'cmyk',
    'colorInfo keeps the ink name and its build');
  ok(C.colorInfo(C.makeColor({ space: 'rgb', values: [1, 0, 0] })) === null, 'rgb needs no print info');
  const back = C.paintColor(C.colorHex(spot), info);
  ok(C.colorEquals(back, spot) && back.name === spot.name, 'paintColor rebuilds a spot from hex + info');
  ok(!C.colorEquals(cy, C.makeColor({ space: 'cmyk', values: [1, 0, 0, 0.5] })), 'colorEquals separates builds');
  ok(C.paintColor(null, null) === null, 'paintColor of no paint is none');
  ok(near(C.makeColor({ space: 'separation', name: 'Mystery', values: [0.5] }).rgb[0], 0.5),
    'ink with no build falls back to tint as darkness');
}

// ---- fill / stroke / opacity ----
{
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const B = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  const ids = [A.id, B.id];
  C.setFill(d, ids, C.makeColor({ space: 'cmyk', values: [1, 0, 0, 0] }));
  ok(A.fill === '#00ffff' && B.fill === '#00ffff', 'setFill paints the whole list');
  ok(A.fillInfo.space === 'cmyk' && A.fillInfo !== B.fillInfo, 'setFill gives each shape its own info');
  C.setFill(d, ids, C.makeColor({ space: 'rgb', values: [1, 0, 0] }));
  ok(A.fill === '#ff0000' && A.fillInfo === undefined, 'an rgb fill drops stale print info');
  C.setFill(d, [A.id], null);
  ok(A.fill === null && B.fill === '#ff0000', 'fill none only where asked');
}
{
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  C.setStrokeProps(d, [A.id], { w: 4 });
  ok(A.stroke === null, 'stroke options skip shapes with no stroke');
  C.setStroke(d, [A.id], C.makeColor({ space: 'gray', values: [0] }));
  ok(A.stroke.color === '#000000' && A.stroke.w === 1 && A.strokeInfo.space === 'gray',
    'setStroke starts at 1pt and keeps gray');
  C.setStrokeProps(d, [A.id], { w: 4, cap: 'round', join: 'bevel', miter: 2, align: 'inside', dash: '6 3' });
  ok(A.stroke.w === 4 && A.stroke.cap === 'round' && A.stroke.join === 'bevel', 'weight/cap/join applied');
  ok(A.stroke.miter === 2 && A.stroke.align === 'inside', 'miter limit + alignment applied');
  ok(JSON.stringify(A.stroke.dash) === '[6,3]', 'dash parsed from typed text');
  C.setStrokeProps(d, [A.id], { cap: 'wobble', dash: '0 0' });
  ok(A.stroke.cap === 'round' && A.stroke.dash === undefined, 'unknown cap ignored, all-zero dash is solid');
  ok(C.strokeProp(null, 'cap') === 'butt' && C.strokeProp({ w: 1 }, 'align') === 'center', 'strokeProp defaults');
  C.setStroke(d, [A.id], null);
  ok(A.stroke === null && A.strokeInfo === undefined, 'stroke none clears the print info too');
}
{
  const d = C.newDoc();
  const A = C.addShape(d, {
    type: 'path', fill: '#ff0000', stroke: { color: '#0000ff', w: 2 }, cmds: C.rectPath(0, 0, 10, 10),
  });
  C.swapFillStroke(d, [A.id]);
  ok(A.fill === '#0000ff' && A.stroke.color === '#ff0000' && A.stroke.w === 2,
    'swapFillStroke trades colors and keeps the weight');
  C.setOpacity(d, [A.id], 2);
  ok(A.opacity === 1, 'setOpacity clamps');
  C.setOpacity(d, [A.id], 0.35);
  ok(near(A.opacity, 0.35), 'setOpacity applies');
}
{
  // a whole-selection recolor is one history entry
  const d = C.newDoc();
  const ids = [0, 1, 2].map(i => C.addShape(d, { type: 'path', cmds: C.rectPath(i * 20, 0, 10, 10) }).id);
  const h = C.newHistory(d);
  C.setFill(d, ids, C.makeColor({ space: 'cmyk', values: [0, 1, 1, 0] }));
  C.setOpacity(d, ids, 0.5);
  ok(C.commit(h, d) === true && h.stack.length === 2, 'multi-object paint commits once');
  const back = C.undo(h);
  ok(back.shapes.every(s => s.fill == null && s.opacity === 1), 'one undo reverts the whole selection');
}

// ---- swatches ----
{
  const d = C.newDoc();
  ok(d.swatches.length === 8 && d.swatches.every(s => !s.spot), 'newDoc seeds a process palette');
  const spot = C.addSwatch(d, {
    space: 'separation', name: 'PANTONE 185 C', values: [1],
    alt: { space: 'cmyk', values: [0, 0.91, 0.76, 0] },
  });
  ok(spot.spot === true && d.swatches.length === 9, 'addSwatch appends a spot ink');
  ok(C.addSwatch(d, spot) === spot && d.swatches.length === 9, 'addSwatch dedupes');
  ok(C.findSwatch(d, C.makeColor({ space: 'cmyk', values: [0, 0, 0, 1] })) === 1, 'findSwatch by color');
  ok(C.findSwatch(d, C.makeColor({ space: 'cmyk', values: [0.5, 0.5, 0.5, 0.5] })) === -1, 'findSwatch misses');
  ok(C.colorEquals(C.swatchColor(spot), C.makeColor(spot)), 'swatchColor gives back a paintable color');
  ok(C.renameSwatch(d, 8, '  Reflex  ') && d.swatches[8].name === 'Reflex', 'renameSwatch trims');
  ok(!C.renameSwatch(d, 8, '   '), 'renameSwatch rejects a blank name');
  ok(C.removeSwatch(d, 8) && d.swatches.length === 8, 'removeSwatch');
  ok(!C.removeSwatch(d, 99), 'removeSwatch out of range');
  ok(C.makeSwatch({ space: 'cmyk', values: [0.4, 0, 0.65, 0.3] }).name === 'C=40 M=0 Y=65 K=30',
    'an unnamed swatch is named after its build');
  ok(C.makeSwatch({ space: 'rgb', values: [1, 0, 0] }).name === 'R=255 G=0 B=0', 'rgb swatch name');
  ok(C.makeSwatch(null) === null, 'makeSwatch rejects nothing');
}
{
  // swatches and print info survive the project format
  const d = C.demoDoc();
  const d2 = C.parseDoc(C.serializeDoc(d));
  const sw = d2.swatches.find(s => s.spot);
  ok(sw && sw.name === 'Aquamentor Green' && sw.alt.space === 'cmyk', 'spot swatch round-trips');
  ok(d2.shapes[1].fillInfo.space === 'separation' && near(d2.shapes[1].fillInfo.alt.values[2], 0.65),
    'spot fill info round-trips with its build');
}
{
  const wrap = doc => JSON.stringify({ app: 'aq-vector-studio', version: 1, doc });
  const h = C.parseDoc(wrap({
    artboard: { w: 612, h: 792 }, layers: [{ id: 'L1' }],
    swatches: [{ space: 'cmyk', values: [0, 0, 0, 1], name: 'K' }, { space: 'bogus', values: [] }, null],
    shapes: [{
      layer: 'L1', cmds: [['M', 0, 0], ['L', 1, 1], ['Z']], fill: '#ff0000',
      fillInfo: { space: 'cmyk', values: [1, 2] },
      stroke: { color: '#000000', w: -3, cap: 'wobble', miter: 0, dash: ['x'] },
    }],
  }));
  ok(h.swatches.length === 1 && h.swatches[0].name === 'K', 'parseDoc drops unusable swatches');
  ok(h.shapes[0].fillInfo === undefined, 'parseDoc drops a short CMYK build');
  ok(h.shapes[0].stroke.w === 0 && h.shapes[0].stroke.cap === undefined &&
    h.shapes[0].stroke.miter === undefined && h.shapes[0].stroke.dash === undefined,
    'parseDoc heals stroke extras');
  const g = C.parseDoc(wrap({ artboard: { w: 10, h: 10 }, layers: [{ id: 'L1' }], shapes: [] }));
  ok(Array.isArray(g.swatches) && g.swatches.length === 0, 'parseDoc gives a doc with no palette an empty one');
}

function throws(fn, name) {
  try { fn(); fail++; console.error('FAIL (no throw):', name); }
  catch (e) { pass++; }
}

// ---- serialization ----
{
  const d = C.demoDoc();
  const s = C.serializeDoc(d);
  ok(typeof s === 'string' && s.includes('"app"'), 'serializeDoc returns tagged JSON');
  const d2 = C.parseDoc(s);
  ok(JSON.stringify(d2) === JSON.stringify(d), 'serialize/parse roundtrip identical');
  ok(d2 !== d && d2.shapes !== d.shapes, 'parseDoc returns fresh objects');
}
{
  throws(() => C.parseDoc('not json'), 'parseDoc rejects garbage');
  throws(() => C.parseDoc('{"app":"other","version":1,"doc":{}}'), 'parseDoc rejects foreign app tag');
  const wrap = doc => JSON.stringify({ app: 'aq-vector-studio', version: 1, doc });
  throws(() => C.parseDoc(wrap({ artboard: { w: -5, h: 11 } })), 'parseDoc rejects bad artboard');
  throws(() => C.parseDoc(wrap({
    artboard: { w: 612, h: 792 }, layers: [{ id: 'L1' }],
    shapes: [{ cmds: [['Q', 1, 2]] }],
  })), 'parseDoc rejects unknown path op');
  throws(() => C.parseDoc(wrap({
    artboard: { w: 612, h: 792 }, layers: [{ id: 'L1' }],
    shapes: [{ cmds: [['L', 'x', 3]] }],
  })), 'parseDoc rejects non-numeric coordinate');
  throws(() => C.parseDoc(JSON.stringify({ app: 'aq-vector-studio', version: 99, doc: {} })), 'parseDoc rejects future version');
}
{
  // healing: nextId, unknown layer, unknown units, missing name
  const wrap = doc => JSON.stringify({ app: 'aq-vector-studio', version: 1, doc });
  const d = C.parseDoc(wrap({
    units: 'furlongs',
    artboard: { w: 612, h: 792 },
    layers: [{ id: 'L1', name: 'Layer 1' }],
    shapes: [
      { id: 'S9', layer: 'NOPE', cmds: [['M', 0, 0], ['L', 10, 0], ['Z']] },
      { layer: 'L1', cmds: [['M', 0, 0], ['L', 5, 5], ['Z']] },
    ],
  }));
  ok(d.units === 'in', 'parseDoc heals unknown units');
  ok(d.name === 'Untitled', 'parseDoc heals missing name');
  ok(d.shapes[0].layer === 'L1', 'parseDoc reassigns unknown layer');
  ok(d.shapes[1].id === 'S10', 'parseDoc assigns missing id after max');
  ok(d.nextId >= 11, 'parseDoc heals nextId past max id');
  const added = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 1, 1) });
  ok(added.id !== 'S9' && added.id !== 'S10', 'addShape unique after load');
}

// ---- history ----
{
  const d = C.newDoc();
  const h = C.newHistory(d);
  ok(!C.canUndo(h) && !C.canRedo(h), 'history initial flags');
  ok(C.undo(h) === null && C.redo(h) === null, 'undo/redo null at bounds');
  C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  ok(C.commit(h, d) === true, 'commit true on change');
  ok(C.commit(h, d) === false, 'no-op commit skipped');
  ok(C.canUndo(h) && !C.canRedo(h), 'flags after commit');
  const back = C.undo(h);
  ok(back && back.shapes.length === 0, 'undo restores previous doc');
  ok(C.canRedo(h), 'canRedo after undo');
  const fwd = C.redo(h);
  ok(fwd && fwd.shapes.length === 1, 'redo restores change');
}
{
  // divergence: undo then a new commit clears the redo branch
  const d = C.newDoc();
  const h = C.newHistory(d);
  C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  C.commit(h, d);
  const d2 = C.undo(h);
  C.addShape(d2, { type: 'path', cmds: C.ellipsePath(0, 0, 5, 5) });
  C.commit(h, d2);
  ok(!C.canRedo(h), 'new commit clears redo branch');
  const u = C.undo(h);
  ok(u.shapes.length === 0, 'undo after divergence returns base');
}
{
  // cap trims oldest but keeps undo working
  const d = C.newDoc();
  const h = C.newHistory(d, 3);
  for (let i = 0; i < 5; i++) {
    C.addShape(d, { type: 'path', cmds: C.rectPath(i, 0, 1, 1) });
    C.commit(h, d);
  }
  ok(h.stack.length === 3, 'history capped');
  ok(C.canUndo(h), 'capped history still undoable');
  const u = C.undo(h);
  ok(u.shapes.length === 4, 'capped undo steps back one');
}

// ---- matrices & transforms ----
{
  const m = C.mMul(C.mTranslate(10, 0), C.mScale(2, 2));
  const [x, y] = C.mApply(m, 3, 4);
  ok(near(x, 16) && near(y, 8), 'mMul scale-then-translate');
  const r = C.mRotate(Math.PI / 2, 50, 50);
  const [rx, ry] = C.mApply(r, 100, 50);
  ok(near(rx, 50) && near(ry, 100), 'mRotate 90deg about center');
  const s = C.mScale(2, 3, 10, 20);
  const [sx, sy] = C.mApply(s, 10, 20);
  ok(near(sx, 10) && near(sy, 20), 'mScale fixes anchor');
  const t = C.transformCmds([['M', 0, 0], ['C', 1, 2, 3, 4, 5, 6], ['Z']], C.mTranslate(10, 20));
  ok(near(t[1][1], 11) && near(t[1][2], 22) && near(t[1][5], 15) && near(t[1][6], 26) && t[2][0] === 'Z',
    'transformCmds hits every coordinate pair');
}

// ---- flatten & tight bbox ----
{
  const subs = C.flattenPath(C.rectPath(0, 0, 10, 10));
  ok(subs.length === 1 && subs[0].closed && subs[0].pts.length === 4, 'flatten rect: 4 pts, closed');
  const arch = [['M', 0, 0], ['C', 0, -100, 100, -100, 100, 0]];
  const tb = C.tightBBox(arch);
  ok(tb && Math.abs(tb.y - (-75)) < 0.5, 'tightBBox finds cubic extremum (~-75)');
  ok(near(C.pathBBox(arch).y, -100), 'pathBBox stays conservative (-100)');
}

// ---- hit testing ----
{
  const rect = { fill: '#f00', stroke: null, cmds: C.rectPath(0, 0, 100, 50) };
  ok(C.hitTestShape(rect, 50, 25), 'hit inside filled rect');
  ok(!C.hitTestShape(rect, 150, 25), 'miss outside rect');
  const donut = {
    fill: '#f00', stroke: null,
    cmds: [...C.rectPath(0, 0, 100, 100),
      ['M', 25, 25], ['L', 25, 75], ['L', 75, 75], ['L', 75, 25], ['Z']], // reversed winding = hole
  };
  ok(!C.hitTestShape(donut, 50, 50), 'nonzero winding: hole is not hit');
  ok(C.hitTestShape(donut, 10, 50), 'donut ring is hit');
  const line = { fill: null, stroke: { color: '#000', w: 4 }, cmds: [['M', 0, 0], ['L', 100, 0]] };
  ok(C.hitTestShape(line, 50, 1.5), 'stroke hit within half width');
  ok(!C.hitTestShape(line, 50, 30), 'stroke miss far away');
}
{
  ok(C.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), 'rectsIntersect overlap');
  ok(!C.rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 5, h: 5 }), 'rectsIntersect apart');
}

// ---- groups ----
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', fill: '#111', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', fill: '#222', cmds: C.rectPath(20, 0, 10, 10) });
  const c = C.addShape(d, { type: 'path', fill: '#333', cmds: C.rectPath(40, 0, 10, 10) });
  const g1 = C.groupShapes(d, [a.id, b.id]);
  ok(a.group === g1 && b.group === g1 && !c.group, 'groupShapes assigns membership');
  ok(C.expandIds(d, [a.id]).sort().join() === [a.id, b.id].sort().join(), 'expandIds pulls in group');
  const g2 = C.groupShapes(d, [a.id, c.id]); // g1 as a unit + loose c
  ok(C.expandIds(d, [c.id]).length === 3, 'nested group expands to all members');
  ok(d.groups.find(g => g.id === g1).parent === g2, 'inner group parented');
  C.ungroupShapes(d, g2);
  ok(C.expandIds(d, [c.id]).length === 1, 'ungroup releases loose member');
  ok(C.expandIds(d, [a.id]).length === 2, 'inner group survives outer ungroup');
  ok(!d.groups.find(g => g.id === g2), 'ungrouped id removed');
}

// ---- duplicate ----
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', fill: '#111', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', fill: '#222', cmds: C.rectPath(20, 0, 10, 10) });
  const g1 = C.groupShapes(d, [a.id, b.id]);
  const dup = C.duplicateShapes(d, [a.id, b.id]);
  ok(dup.length === 2 && d.shapes.length === 4, 'duplicate clones shapes');
  const d0 = d.shapes.find(s => s.id === dup[0]);
  ok(d0.group && d0.group !== g1, 'duplicate gets its own group tree');
  ok(C.expandIds(d, [dup[0]]).sort().join() === dup.slice().sort().join(), 'duplicate group is self-contained');
  ok(JSON.stringify(d0.cmds) === JSON.stringify(a.cmds), 'duplicate copies geometry');
}

// ---- arrange ----
{
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 1, 1) });
  const B = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 1, 1) });
  const X = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 1, 1) });
  const order = () => d.shapes.map(s => s.id).join();
  C.bringForward(d, [A.id]);
  ok(order() === [B.id, A.id, X.id].join(), 'bringForward one step');
  C.bringForward(d, [A.id]);
  C.bringForward(d, [A.id]);
  ok(order() === [B.id, X.id, A.id].join(), 'bringForward stops at front');
  C.sendToBack(d, [A.id]);
  ok(order() === [A.id, B.id, X.id].join(), 'sendToBack');
  C.bringToFront(d, [A.id, B.id]);
  ok(order() === [X.id, A.id, B.id].join(), 'bringToFront keeps relative order');
  C.sendBackward(d, [B.id]);
  ok(order() === [X.id, B.id, A.id].join(), 'sendBackward one step');
}

// ---- align & distribute ----
{
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const B = C.addShape(d, { type: 'path', cmds: C.rectPath(18, 20, 10, 10) });
  const X = C.addShape(d, { type: 'path', cmds: C.rectPath(50, 40, 10, 30) });
  const ids = [A.id, B.id, X.id];
  C.alignUnits(d, ids, 'left');
  ok([A, B, X].every(s => near(C.tightBBox(s.cmds).x, 0)), 'align left');
  C.alignUnits(d, ids, 'bottom');
  const bots = [A, B, X].map(s => { const b = C.tightBBox(s.cmds); return b.y + b.h; });
  ok(bots.every(v => near(v, bots[0])), 'align bottom');
}
{
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });   // cx 5
  const B = C.addShape(d, { type: 'path', cmds: C.rectPath(18, 0, 10, 10) });  // cx 23
  const X = C.addShape(d, { type: 'path', cmds: C.rectPath(50, 0, 10, 10) });  // cx 55
  C.alignUnits(d, [A.id, B.id, X.id], 'hdist');
  const cxs = [A, B, X].map(s => { const b = C.tightBBox(s.cmds); return b.x + b.w / 2; });
  ok(near(cxs[0], 5) && near(cxs[1], 30) && near(cxs[2], 55), 'distribute horizontal centers');
}
{
  // grouped pair aligns as one rigid unit
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const B = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [A.id, B.id]);
  const X = C.addShape(d, { type: 'path', cmds: C.rectPath(100, 50, 10, 10) });
  C.alignUnits(d, [A.id, B.id, X.id], 'top');
  ok(near(C.tightBBox(A.cmds).y, 0) && near(C.tightBBox(B.cmds).y, 0), 'group unit did not move (already top)');
  ok(near(C.tightBBox(X.cmds).y, 0), 'loose shape aligned to top');
  const gapBefore = C.tightBBox(B.cmds).x - C.tightBBox(A.cmds).x;
  C.alignUnits(d, [A.id, B.id, X.id], 'left');
  ok(near(C.tightBBox(B.cmds).x - C.tightBBox(A.cmds).x, gapBefore), 'group stays rigid on align');
}

// ---- selection units ----
{
  const d = C.newDoc();
  const A = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const B = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [A.id, B.id]);
  const X = C.addShape(d, { type: 'path', cmds: C.rectPath(50, 0, 10, 10) });
  const units = C.selectionUnits(d, [A.id, B.id, X.id]);
  ok(units.length === 2, 'selectionUnits partitions by root');
  const gUnit = units.find(u => u.ids.length === 2);
  ok(gUnit && near(gUnit.bbox.w, 30), 'unit bbox spans group');
}

// ---- groups serialization ----
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', fill: '#111', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', fill: '#222', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [a.id, b.id]);
  const d2 = C.parseDoc(C.serializeDoc(d));
  ok(JSON.stringify(d2) === JSON.stringify(d), 'groups roundtrip');
  ok(C.expandIds(d2, [d2.shapes[0].id]).length === 2, 'groups functional after parse');
  // healing: unknown group ref, bad parent
  const wrap = doc => JSON.stringify({ app: 'aq-vector-studio', version: 1, doc });
  const h = C.parseDoc(wrap({
    artboard: { w: 612, h: 792 }, layers: [{ id: 'L1' }],
    groups: [{ id: 'G7', parent: 'G99' }],
    shapes: [{ layer: 'L1', group: 'GNOPE', cmds: [['M', 0, 0], ['L', 1, 1], ['Z']] }],
  }));
  ok(h.groups[0].parent === null, 'parseDoc heals dangling group parent');
  ok(h.shapes[0].group === null, 'parseDoc heals unknown shape group ref');
  ok(h.nextId >= 8, 'parseDoc nextId accounts for group ids');
}

// ---- units ----
{
  ok(near(C.toPt(1, 'in'), 72) && near(C.fromPt(144, 'in'), 2), 'toPt/fromPt inches');
  ok(near(C.toPt(25.4, 'mm'), 72) && near(C.fromPt(72, 'pt'), 72), 'toPt/fromPt mm and pt');
}

// ---- transform math ----
{
  const b = { x: 10, y: 20, w: 100, h: 50 };
  ok(C.refPoint(b, 'nw').join() === '10,20', 'refPoint nw');
  ok(C.refPoint(b, 'c').join() === '60,45', 'refPoint c');
  ok(C.refPoint(b, 'se').join() === '110,70', 'refPoint se');
  ok(C.refPoint(b, 'bogus').join() === '10,20', 'refPoint falls back to nw');
}
{
  // shear holds the anchor and leans the top to the right
  const m = C.mShear(45 * C.DEG, 0, 10);
  const at = C.mApply(m, 5, 10), above = C.mApply(m, 5, 0);
  ok(near(at[0], 5) && near(at[1], 10), 'mShear fixes the anchor');
  ok(near(above[0], 15) && near(above[1], 0, 1e-9), 'mShear leans the top right');
}
{
  ok(C.normAngle(370) === 10 && C.normAngle(-190) === 170, 'normAngle wraps');
  ok(C.normAngle(180) === 180 && C.normAngle(-180) === 180, 'normAngle keeps 180 positive');
}
{
  // W/H scale about the reference point, which never moves
  const b = { x: 0, y: 0, w: 100, h: 50 };
  const m = C.transformMatrix(b, { ref: 'nw', w: 200, h: 100 });
  ok(C.mApply(m, 0, 0).join() === '0,0', 'transformMatrix nw anchor is fixed');
  ok(C.mApply(m, 100, 50).join() === '200,100', 'transformMatrix scales to w/h');
  const mc = C.transformMatrix(b, { ref: 'c', w: 200 });
  ok(near(C.mApply(mc, 50, 25)[0], 50), 'transformMatrix center anchor is fixed');
  ok(near(C.mApply(mc, 0, 0)[0], -50), 'transformMatrix center scale grows both ways');
}
{
  // X/Y place the reference point itself
  const b = { x: 10, y: 10, w: 20, h: 20 };
  const m = C.transformMatrix(b, { ref: 'se', x: 100, y: 200 });
  ok(C.mApply(m, 30, 30).join() === '100,200', 'transformMatrix moves the ref point to x/y');
  const z = C.transformMatrix({ x: 5, y: 5, w: 0, h: 0 }, { ref: 'nw', w: 10, h: 10 });
  ok(z[0] === 1 && z[3] === 1, 'transformMatrix ignores w/h on a zero-size bbox');
}
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 20, 10) });
  // multi-object: the combined bbox is what scales
  C.transformSelection(d, [a.id, b.id], { ref: 'nw', w: 80 });
  const all = C.shapesBBox(d.shapes);
  ok(near(all.w, 80) && near(all.x, 0), 'transformSelection scales the combined bbox');
  ok(near(C.tightBBox(a.cmds).w, 20), 'transformSelection scales members proportionally');
  ok(near(C.tightBBox(b.cmds).x, 40), 'transformSelection keeps member spacing');
}
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 40, 20) });
  ok(a.angle === 0 && a.shear === 0, 'addShape seeds transform bookkeeping');
  C.transformSelection(d, [a.id], { ref: 'c', angle: 90 });
  const b = C.tightBBox(a.cmds);
  ok(near(b.w, 20) && near(b.h, 40), 'transformSelection rotate swaps w/h at 90°');
  ok(a.angle === 90, 'transformSelection records the angle');
  C.transformSelection(d, [a.id], { ref: 'c', angle: 90 }); // same absolute angle = no-op
  ok(near(C.tightBBox(a.cmds).w, 20), 'transformSelection angle is absolute, not cumulative');
  C.transformSelection(d, [a.id], { ref: 'c', angle: 0 });
  ok(near(C.tightBBox(a.cmds).w, 40) && a.angle === 0, 'transformSelection rotates back to 0');
}
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  ok(C.selectionAngles(d, [a.id, b.id]).angle === 0, 'selectionAngles shared value');
  C.transformSelection(d, [a.id], { ref: 'c', angle: 30 });
  ok(C.selectionAngles(d, [a.id, b.id]).angle === null, 'selectionAngles null when mixed');
  ok(C.selectionAngles(d, [a.id]).angle === 30, 'selectionAngles single object');
  C.transformSelection(d, [a.id], { ref: 'c', shear: 20 });
  ok(near(C.selectionAngles(d, [a.id]).shear, 20), 'selectionAngles tracks shear');
  ok(near(C.selectionAngles(d, [a.id]).angle, 30), 'shear does not disturb the angle');
}
{
  // a group moves as one unit under numeric transform
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(30, 0, 10, 10) });
  C.groupShapes(d, [a.id, b.id]);
  C.transformSelection(d, [a.id], { ref: 'nw', x: 100 }); // only one member given
  ok(near(C.tightBBox(a.cmds).x, 100) && near(C.tightBBox(b.cmds).x, 130),
    'transformSelection expands to the whole group');
  ok(C.transformSelection(d, [], { ref: 'nw', x: 0 }) === false, 'transformSelection empty is a no-op');
}
{
  // roundtrip keeps the transform bookkeeping
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', fill: '#111', cmds: C.rectPath(0, 0, 10, 10) });
  C.transformSelection(d, [a.id], { ref: 'c', angle: 45, shear: 10 });
  const d2 = C.parseDoc(C.serializeDoc(d));
  ok(near(d2.shapes[0].angle, 45) && near(d2.shapes[0].shear, 10), 'angle/shear survive serialization');
}

// ---- layers ----
{
  const d = C.newDoc();
  const l2 = C.addLayer(d);
  ok(d.layers.length === 2 && d.layers[0].id === l2.id, 'addLayer goes on top');
  ok(l2.id === 'L2' && l2.name === 'Layer 2', 'addLayer names and ids in sequence');
  ok(l2.visible === true && l2.locked === false, 'addLayer defaults');
  const l3 = C.addLayer(d, 'Art', 'L1');
  ok(d.layers.map(l => l.id).join() === 'L2,L3,L1', 'addLayer above a named layer');
  ok(l3.name === 'Art', 'addLayer custom name');
  ok(C.renameLayer(d, 'L3', ' Trace ') && C.layerOf(d, 'L3').name === 'Trace', 'renameLayer trims');
  ok(!C.renameLayer(d, 'L3', '   ') || C.layerOf(d, 'L3').name === 'Trace', 'renameLayer ignores blank');
  ok(C.renameLayer(d, 'nope', 'x') === false, 'renameLayer unknown layer');
}
{
  // layer order drives z: layers[0] is frontmost, so its shapes end up last
  const d = C.newDoc();
  const back = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const l2 = C.addLayer(d);
  const front = C.addShape(d, { type: 'path', layer: l2.id, cmds: C.rectPath(0, 0, 10, 10) });
  C.normalizeZ(d);
  ok(d.shapes.map(s => s.id).join() === [back.id, front.id].join(), 'normalizeZ stacks by layer order');
  ok(C.reorderLayers(d, 0, 1), 'reorderLayers moves a layer down');
  ok(d.layers.map(l => l.id).join() === 'L1,L2', 'reorderLayers new order');
  ok(d.shapes.map(s => s.id).join() === [front.id, back.id].join(), 'reorderLayers restacks shapes');
  ok(C.reorderLayers(d, 0, 0) === false && C.reorderLayers(d, 0, 9) === false, 'reorderLayers rejects no-ops');
}
{
  // within a layer, the existing z primitives still decide order
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const l2 = C.addLayer(d);
  const c = C.addShape(d, { type: 'path', layer: l2.id, cmds: C.rectPath(0, 0, 10, 10) });
  C.bringToFront(d, [a.id]);
  C.normalizeZ(d);
  ok(d.shapes.map(s => s.id).join() === [b.id, a.id, c.id].join(),
    'bringToFront is front-of-layer after normalizeZ');
}
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const l2 = C.addLayer(d);
  C.moveShapesToLayer(d, [a.id], l2.id);
  ok(a.layer === l2.id, 'moveShapesToLayer retags the shape');
  ok(d.shapes[d.shapes.length - 1].id === a.id, 'moved shape sits on the front layer');
  ok(C.moveShapesToLayer(d, [a.id], 'nope').length === 0, 'moveShapesToLayer unknown layer');
  ok(C.moveShapesToLayer(d, ['S404'], l2.id).length === 0, 'moveShapesToLayer unknown shape');
}
{
  // dropping onto a specific shape controls where in the stack it lands
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const c = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  C.moveShapesToLayer(d, [c.id], 'L1', a.id, 'back');
  ok(d.shapes.map(s => s.id).join() === [c.id, a.id, b.id].join(), 'drop behind an anchor');
  C.moveShapesToLayer(d, [c.id], 'L1', a.id, 'front');
  ok(d.shapes.map(s => s.id).join() === [a.id, c.id, b.id].join(), 'drop in front of an anchor');
}
{
  // whole groups move between layers together
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [a.id, b.id]);
  const l2 = C.addLayer(d);
  C.moveShapesToLayer(d, [a.id], l2.id);
  ok(a.layer === l2.id && b.layer === l2.id, 'moveShapesToLayer expands to the group');
}
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [a.id, b.id]);
  const l2 = C.addLayer(d);
  C.addShape(d, { type: 'path', layer: l2.id, cmds: C.rectPath(0, 0, 10, 10) });
  ok(C.deleteLayer(d, 'L1'), 'deleteLayer removes the layer');
  ok(d.shapes.length === 1 && d.shapes[0].layer === l2.id, 'deleteLayer takes its shapes with it');
  ok(d.groups.length === 0, 'deleteLayer prunes orphaned groups');
  ok(C.deleteLayer(d, l2.id) === false, 'deleteLayer keeps the last layer');
  ok(C.deleteLayer(d, 'nope') === false, 'deleteLayer unknown layer');
}
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [a.id, b.id]);
  C.layerOf(d, 'L1').locked = true;
  const dup = C.duplicateLayer(d, 'L1');
  ok(d.layers.map(l => l.id).join() === dup.id + ',L1', 'duplicateLayer sits above the source');
  ok(dup.name === 'Layer 1 copy' && dup.locked === true, 'duplicateLayer copies name and flags');
  const copies = d.shapes.filter(s => s.layer === dup.id);
  ok(copies.length === 2, 'duplicateLayer copies the shapes');
  ok(copies[0].group && copies[0].group === copies[1].group && copies[0].group !== a.group,
    'duplicateLayer clones the group tree');
  ok(C.duplicateLayer(d, 'nope') === null, 'duplicateLayer unknown layer');
}

// ---- object visibility / lock ----
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  ok(a.hidden === false && a.locked === false, 'addShape defaults visible and unlocked');
  ok(C.lockShapes(d, [a.id]) === 1 && a.locked === true && b.locked === false, 'lockShapes');
  ok(C.hideShapes(d, [b.id]) === 1 && b.hidden === true, 'hideShapes');
  C.unlockAll(d); C.showAll(d);
  ok(!a.locked && !b.hidden, 'unlockAll / showAll');
  // ids are literal — locking one group member leaves the rest alone
  C.groupShapes(d, [a.id, b.id]);
  C.lockShapes(d, [a.id]);
  ok(a.locked === true && b.locked === false, 'lockShapes does not expand groups');
  const d2 = C.parseDoc(C.serializeDoc(d));
  ok(d2.shapes[0].locked === true, 'flags survive serialization');
}

// ---- layer tree ----
{
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', name: 'A', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', name: 'B', cmds: C.rectPath(20, 0, 10, 10) });
  const c = C.addShape(d, { type: 'path', cmds: C.rectPath(40, 0, 10, 10) });
  const g = C.groupShapes(d, [a.id, b.id]);
  const t = C.layerTree(d);
  ok(t.length === 1 && t[0].id === 'L1' && t[0].name === 'Layer 1', 'layerTree one row per layer');
  ok(t[0].rows.length === 2, 'layerTree collapses a group into one row');
  ok(t[0].rows[0].kind === 'shape' && t[0].rows[0].id === c.id, 'layerTree lists front-most first');
  const grow = t[0].rows[1];
  ok(grow.kind === 'group' && grow.id === g && grow.ids.length === 2, 'layerTree group row');
  ok(grow.children.map(r => r.name).join() === 'B,A', 'layerTree group children in reverse z');
  ok(grow.children[0].kind === 'shape' && grow.layer === 'L1', 'layerTree children carry their layer');
  ok(t[0].rows[0].name === '<Path>', 'layerTree names unnamed paths');
}
{
  // nested groups nest one level per row
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  const c = C.addShape(d, { type: 'path', cmds: C.rectPath(40, 0, 10, 10) });
  const inner = C.groupShapes(d, [a.id, b.id]);
  const outer = C.groupShapes(d, [a.id, c.id]);
  const rows = C.layerTree(d)[0].rows;
  ok(rows.length === 1 && rows[0].id === outer, 'layerTree shows the root group only');
  ok(rows[0].children.length === 2, 'outer group has two children');
  ok(rows[0].children.some(r => r.id === inner && r.children.length === 2), 'inner group nests');
}
{
  // group rows derive their eye/lock from their members
  const d = C.newDoc();
  const a = C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const b = C.addShape(d, { type: 'path', cmds: C.rectPath(20, 0, 10, 10) });
  C.groupShapes(d, [a.id, b.id]);
  C.hideShapes(d, [a.id]);
  C.lockShapes(d, [a.id]);
  let row = C.layerTree(d)[0].rows[0];
  ok(row.visible === true && row.locked === false, 'group row: partly hidden still shows an open eye');
  C.hideShapes(d, [b.id]);
  C.lockShapes(d, [b.id]);
  row = C.layerTree(d)[0].rows[0];
  ok(row.visible === false && row.locked === true, 'group row: fully hidden/locked');
}
{
  // multi-layer tree order matches the panel: top layer first
  const d = C.newDoc();
  C.addShape(d, { type: 'path', cmds: C.rectPath(0, 0, 10, 10) });
  const l2 = C.addLayer(d, 'Top');
  const up = C.addShape(d, { type: 'path', layer: l2.id, cmds: C.rectPath(0, 0, 10, 10) });
  const t = C.layerTree(d);
  ok(t.map(l => l.name).join() === 'Top,Layer 1', 'layerTree top layer first');
  ok(t[0].rows.length === 1 && t[0].rows[0].id === up.id, 'layerTree rows filtered by layer');
  ok(t[1].rows.length === 1, 'lower layer keeps its own rows');
}

console.log(`vectest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
