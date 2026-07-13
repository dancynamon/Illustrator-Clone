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

console.log(`vectest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
