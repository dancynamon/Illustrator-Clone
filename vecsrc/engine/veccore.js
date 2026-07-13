// VECCORE — pure document/geometry core for Aquamentor Vector Studio.
// No DOM. Document coordinates are PDF points (1/72 in), y-down like SVG;
// the PDF exporter flips y. Loaded in-browser via build concat and in node
// tests via require.
const VECCORE = (() => {
  'use strict';

  const PT_PER = { in: 72, mm: 72 / 25.4, pt: 1 };
  // 100% zoom = 96 CSS px per inch (screen convention), i.e. 96/72 px per pt.
  const PX_PER_PT_100 = 96 / 72;

  // ---------- document ----------
  function newDoc(o = {}) {
    const units = o.units || 'in';
    const k = PT_PER[units];
    return {
      name: o.name || 'Untitled',
      units,
      artboard: { w: (o.w != null ? o.w : 8.5) * k, h: (o.h != null ? o.h : 11) * k },
      layers: [{ id: 'L1', name: 'Layer 1', visible: true, locked: false }],
      shapes: [],
      groups: [],
      nextId: 1,
    };
  }

  function addShape(doc, shape) {
    shape.id = 'S' + doc.nextId++;
    if (!shape.layer) shape.layer = doc.layers[0].id;
    if (shape.fill === undefined) shape.fill = null;
    if (shape.stroke === undefined) shape.stroke = null;
    if (shape.opacity == null) shape.opacity = 1;
    if (shape.group === undefined) shape.group = null;
    doc.shapes.push(shape);
    return shape;
  }

  // ---------- view (world pt <-> screen px) ----------
  // screen = world*scale + t
  function newView() { return { scale: PX_PER_PT_100, tx: 0, ty: 0 }; }
  function w2s(v, x, y) { return [x * v.scale + v.tx, y * v.scale + v.ty]; }
  function s2w(v, x, y) { return [(x - v.tx) / v.scale, (y - v.ty) / v.scale]; }

  // Zoom by factor f keeping screen point (sx,sy) fixed on the same world point.
  function zoomAt(v, sx, sy, f, min = 0.02, max = 96) {
    const ns = Math.min(max, Math.max(min, v.scale * f));
    const wx = (sx - v.tx) / v.scale, wy = (sy - v.ty) / v.scale;
    return { scale: ns, tx: sx - wx * ns, ty: sy - wy * ns };
  }

  function panBy(v, dx, dy) { return { scale: v.scale, tx: v.tx + dx, ty: v.ty + dy }; }

  // View that fits world rect (x,y,w,h) centered in a vw×vh viewport.
  // Padding shrinks on small viewports; scale is always positive.
  function fitRect(vw, vh, x, y, w, h, pad = 40) {
    pad = Math.max(0, Math.min(pad, vw * 0.1, vh * 0.1));
    const s = Math.max(1e-6, Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h));
    return { scale: s, tx: (vw - w * s) / 2 - x * s, ty: (vh - h * s) / 2 - y * s };
  }

  function zoomPct(v) { return v.scale / PX_PER_PT_100 * 100; }

  // ---------- paths ----------
  // A path is an array of commands: ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Z'].
  // Maps 1:1 onto canvas, SVG, and PDF operators.

  const KAPPA = 0.5522847498307936; // cubic circle approximation constant

  function rectPath(x, y, w, h, r = 0) {
    if (r <= 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
    r = Math.min(r, w / 2, h / 2);
    const k = KAPPA * r;
    return [
      ['M', x + r, y],
      ['L', x + w - r, y], ['C', x + w - r + k, y, x + w, y + r - k, x + w, y + r],
      ['L', x + w, y + h - r], ['C', x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h],
      ['L', x + r, y + h], ['C', x + r - k, y + h, x, y + h - r + k, x, y + h - r],
      ['L', x, y + r], ['C', x, y + r - k, x + r - k, y, x + r, y],
      ['Z'],
    ];
  }

  function ellipsePath(cx, cy, rx, ry) {
    const kx = KAPPA * rx, ky = KAPPA * ry;
    return [
      ['M', cx + rx, cy],
      ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
      ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
      ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
      ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
      ['Z'],
    ];
  }

  function starPath(cx, cy, rOut, rIn, points = 5) {
    const cmds = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? rOut : rIn;
      const a = -Math.PI / 2 + i * Math.PI / points;
      cmds.push([i === 0 ? 'M' : 'L', cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    cmds.push(['Z']);
    return cmds;
  }

  // Bounding box over all coordinates in the command list (control points
  // included — conservative for curves, exact for the shapes above).
  function pathBBox(cmds) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cmds) {
      for (let i = 1; i + 1 <= c.length; i += 2) {
        const x = c[i], y = c[i + 1];
        if (typeof x !== 'number' || typeof y !== 'number') continue;
        if (x < x0) x0 = x; if (y < y0) y0 = y;
        if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
    }
    if (x0 === Infinity) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---------- affine matrices ----------
  // m = [a,b,c,d,e,f]: x' = a·x + c·y + e ; y' = b·x + d·y + f
  function mMul(m2, m1) { // m1 applied first, then m2
    return [
      m2[0] * m1[0] + m2[2] * m1[1], m2[1] * m1[0] + m2[3] * m1[1],
      m2[0] * m1[2] + m2[2] * m1[3], m2[1] * m1[2] + m2[3] * m1[3],
      m2[0] * m1[4] + m2[2] * m1[5] + m2[4], m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
    ];
  }
  function mTranslate(dx, dy) { return [1, 0, 0, 1, dx, dy]; }
  function mScale(sx, sy, cx = 0, cy = 0) { return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]; }
  function mRotate(rad, cx = 0, cy = 0) {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
  }
  function mApply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  function transformCmds(cmds, m) {
    return cmds.map(c => {
      if (c[0] === 'Z') return ['Z'];
      const o = [c[0]];
      for (let i = 1; i + 1 <= c.length; i += 2) {
        const p = mApply(m, c[i], c[i + 1]);
        o.push(p[0], p[1]);
      }
      return o;
    });
  }

  // ---------- flattening, tight bounds, hit testing ----------
  // Flatten to polyline subpaths: [{pts:[[x,y]...], closed}]. Fixed cubic
  // subdivision is plenty for hit tests and bounds at document scale.
  function flattenPath(cmds, seg = 16) {
    const subs = [];
    let cur = null, sx = 0, sy = 0, px = 0, py = 0;
    for (const c of cmds) {
      if (c[0] === 'M') {
        cur = { pts: [[c[1], c[2]]], closed: false };
        subs.push(cur);
        px = sx = c[1]; py = sy = c[2];
      } else if (c[0] === 'L') {
        if (!cur) continue;
        cur.pts.push([c[1], c[2]]);
        px = c[1]; py = c[2];
      } else if (c[0] === 'C') {
        if (!cur) continue;
        for (let i = 1; i <= seg; i++) {
          const t = i / seg, u = 1 - t;
          cur.pts.push([
            u * u * u * px + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
            u * u * u * py + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
          ]);
        }
        px = c[5]; py = c[6];
      } else if (c[0] === 'Z') {
        if (cur) cur.closed = true;
        px = sx; py = sy;
      }
    }
    return subs;
  }

  function tightBBox(cmds) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of flattenPath(cmds)) {
      for (const p of s.pts) {
        if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1];
        if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1];
      }
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function shapesBBox(shapes) {
    let out = null;
    for (const s of shapes) {
      const b = tightBBox(s.cmds);
      if (!b) continue;
      if (!out) out = { ...b };
      else {
        const x1 = Math.max(out.x + out.w, b.x + b.w), y1 = Math.max(out.y + out.h, b.y + b.h);
        out.x = Math.min(out.x, b.x); out.y = Math.min(out.y, b.y);
        out.w = x1 - out.x; out.h = y1 - out.y;
      }
    }
    return out;
  }

  function windingNumber(pts, x, y) {
    let wn = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
      if (a[1] <= y) { if (b[1] > y && cross > 0) wn++; }
      else if (b[1] <= y && cross < 0) wn--;
    }
    return wn;
  }

  function distToSubpath(sub, x, y) {
    const pts = sub.pts, n = pts.length;
    const last = sub.closed ? n : n - 1;
    let d = Infinity;
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      let t = L2 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      d = Math.min(d, Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y));
    }
    return d;
  }

  // Fill hit uses nonzero winding summed across subpaths (canvas default, so
  // holes behave like they render). Stroke hit uses distance to the outline.
  function hitTestShape(shape, x, y, tol = 2) {
    const subs = flattenPath(shape.cmds);
    if (shape.fill != null) {
      let wn = 0;
      for (const s of subs) wn += windingNumber(s.pts, x, y);
      if (wn !== 0) return true;
    }
    const strokeTol = Math.max(tol, shape.stroke ? shape.stroke.w / 2 + tol / 2 : 0);
    if (shape.stroke || shape.fill == null) {
      for (const s of subs) if (distToSubpath(s, x, y) <= strokeTol) return true;
    }
    return false;
  }

  function rectsIntersect(a, b) {
    return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
  }

  // ---------- groups ----------
  // Flat shape list stays the z-order truth; groups are a registry
  // doc.groups = [{id:'G7', parent:'G9'|null}], shapes carry .group = innermost id.
  function groupEntry(doc, gid) { return (doc.groups || []).find(g => g.id === gid) || null; }

  function rootGroupOf(doc, shape) {
    let gid = shape.group || null, seen = new Set();
    while (gid && !seen.has(gid)) {
      seen.add(gid);
      const g = groupEntry(doc, gid);
      if (!g || !g.parent) break;
      gid = g.parent;
    }
    return gid;
  }

  function rootKeyOf(doc, shape) { return rootGroupOf(doc, shape) || shape.id; }

  // Expand shape ids to full group membership (by shared root).
  function expandIds(doc, ids) {
    const set = new Set(ids);
    const roots = new Set();
    for (const s of doc.shapes) if (set.has(s.id)) roots.add(rootKeyOf(doc, s));
    return doc.shapes.filter(s => roots.has(rootKeyOf(doc, s))).map(s => s.id);
  }

  // Partition an (expanded) selection into rigid units: one per root group,
  // one per loose shape. Each unit: {key, ids, bbox}.
  function selectionUnits(doc, ids) {
    const set = new Set(expandIds(doc, ids));
    const byKey = new Map();
    for (const s of doc.shapes) {
      if (!set.has(s.id)) continue;
      const key = rootKeyOf(doc, s);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(s);
    }
    return [...byKey.entries()].map(([key, shapes]) => ({
      key, ids: shapes.map(s => s.id), bbox: shapesBBox(shapes),
    }));
  }

  function groupShapes(doc, ids) {
    const units = selectionUnits(doc, ids);
    if (units.length < 2) return null;
    if (!doc.groups) doc.groups = [];
    const gid = 'G' + doc.nextId++;
    doc.groups.push({ id: gid, parent: null });
    for (const u of units) {
      if (u.key[0] === 'G') groupEntry(doc, u.key).parent = gid;
      else {
        const s = doc.shapes.find(s => s.id === u.key);
        if (s) s.group = gid;
      }
    }
    return gid;
  }

  // Dissolve one (root) group: direct children become free units.
  function ungroupShapes(doc, gid) {
    for (const g of doc.groups) if (g.parent === gid) g.parent = null;
    for (const s of doc.shapes) if (s.group === gid) s.group = null;
    doc.groups = doc.groups.filter(g => g.id !== gid);
  }

  // Clone shapes (expanded to full groups) with a parallel cloned group tree.
  // Clones append on top in original relative order; returns new shape ids.
  function duplicateShapes(doc, ids) {
    const set = new Set(expandIds(doc, ids));
    const gidMap = new Map(); // old gid -> new gid
    function cloneGroupChain(gid) {
      if (!gid) return null;
      if (gidMap.has(gid)) return gidMap.get(gid);
      const g = groupEntry(doc, gid);
      const ng = 'G' + doc.nextId++;
      gidMap.set(gid, ng);
      doc.groups.push({ id: ng, parent: g ? cloneGroupChain(g.parent) : null });
      return ng;
    }
    const out = [];
    for (const s of doc.shapes.slice()) {
      if (!set.has(s.id)) continue;
      const copy = JSON.parse(JSON.stringify(s));
      copy.id = 'S' + doc.nextId++;
      copy.group = cloneGroupChain(s.group);
      doc.shapes.push(copy);
      out.push(copy.id);
    }
    return out;
  }

  // ---------- z-order (array order = z, last is frontmost) ----------
  function bringToFront(doc, ids) {
    const set = new Set(ids);
    const sel = doc.shapes.filter(s => set.has(s.id));
    doc.shapes = doc.shapes.filter(s => !set.has(s.id)).concat(sel);
  }
  function sendToBack(doc, ids) {
    const set = new Set(ids);
    const sel = doc.shapes.filter(s => set.has(s.id));
    doc.shapes = sel.concat(doc.shapes.filter(s => !set.has(s.id)));
  }
  function bringForward(doc, ids) {
    const set = new Set(ids), a = doc.shapes;
    for (let i = a.length - 2; i >= 0; i--) {
      if (set.has(a[i].id) && !set.has(a[i + 1].id)) {
        const t = a[i]; a[i] = a[i + 1]; a[i + 1] = t;
      }
    }
  }
  function sendBackward(doc, ids) {
    const set = new Set(ids), a = doc.shapes;
    for (let i = 1; i < a.length; i++) {
      if (set.has(a[i].id) && !set.has(a[i - 1].id)) {
        const t = a[i]; a[i] = a[i - 1]; a[i - 1] = t;
      }
    }
  }

  // ---------- align & distribute ----------
  // Units move rigidly. Align modes reference the selection bbox; distribute
  // spaces unit centers evenly between the two extremes.
  function alignUnits(doc, ids, mode) {
    const units = selectionUnits(doc, ids);
    if (!units.length) return;
    const shapesById = new Map(doc.shapes.map(s => [s.id, s]));
    function moveUnit(u, dx, dy) {
      if (!dx && !dy) return;
      const m = mTranslate(dx, dy);
      for (const id of u.ids) {
        const s = shapesById.get(id);
        s.cmds = transformCmds(s.cmds, m);
      }
    }
    if (mode === 'hdist' || mode === 'vdist') {
      if (units.length < 3) return;
      const horiz = mode === 'hdist';
      const c = u => horiz ? u.bbox.x + u.bbox.w / 2 : u.bbox.y + u.bbox.h / 2;
      const sorted = units.slice().sort((a, b) => c(a) - c(b));
      const lo = c(sorted[0]), hi = c(sorted[sorted.length - 1]);
      const step = (hi - lo) / (sorted.length - 1);
      sorted.forEach((u, i) => {
        const d = lo + i * step - c(u);
        moveUnit(u, horiz ? d : 0, horiz ? 0 : d);
      });
      return;
    }
    const all = { x: Math.min(...units.map(u => u.bbox.x)), y: Math.min(...units.map(u => u.bbox.y)) };
    all.w = Math.max(...units.map(u => u.bbox.x + u.bbox.w)) - all.x;
    all.h = Math.max(...units.map(u => u.bbox.y + u.bbox.h)) - all.y;
    for (const u of units) {
      const b = u.bbox;
      let dx = 0, dy = 0;
      if (mode === 'left') dx = all.x - b.x;
      else if (mode === 'hcenter') dx = all.x + all.w / 2 - (b.x + b.w / 2);
      else if (mode === 'right') dx = all.x + all.w - (b.x + b.w);
      else if (mode === 'top') dy = all.y - b.y;
      else if (mode === 'vcenter') dy = all.y + all.h / 2 - (b.y + b.h / 2);
      else if (mode === 'bottom') dy = all.y + all.h - (b.y + b.h);
      moveUnit(u, dx, dy);
    }
  }

  // ---------- serialization (.aqv project format) ----------
  const APP_ID = 'aq-vector-studio';
  const FORMAT_VERSION = 1;
  const CMD_ARITY = { M: 3, L: 3, C: 7, Z: 1 };

  function serializeDoc(doc) {
    return JSON.stringify({ app: APP_ID, version: FORMAT_VERSION, doc });
  }

  // Parse + validate a serialized project. Throws with a human message on
  // anything structurally wrong; heals what can be healed (ids, layers,
  // units, name) so old/hand-edited files still open.
  function parseDoc(str) {
    let o;
    try { o = JSON.parse(str); } catch (e) { throw new Error('not valid JSON'); }
    if (!o || o.app !== APP_ID) throw new Error('not an Aquamentor Vector Studio file');
    if (typeof o.version !== 'number' || o.version > FORMAT_VERSION) throw new Error('unsupported file version');
    const d = o.doc;
    if (!d || typeof d !== 'object') throw new Error('missing document');
    if (!d.artboard || !isFinite(d.artboard.w) || !isFinite(d.artboard.h)
      || d.artboard.w <= 0 || d.artboard.h <= 0) throw new Error('bad artboard');
    if (!PT_PER[d.units]) d.units = 'in';
    if (typeof d.name !== 'string' || !d.name) d.name = 'Untitled';
    if (!Array.isArray(d.layers) || !d.layers.length) {
      d.layers = [{ id: 'L1', name: 'Layer 1', visible: true, locked: false }];
    }
    for (const l of d.layers) {
      if (typeof l.id !== 'string' || !l.id) throw new Error('bad layer');
      l.name = String(l.name || l.id);
      l.visible = l.visible !== false;
      l.locked = !!l.locked;
    }
    if (!Array.isArray(d.shapes)) d.shapes = [];
    const layerIds = new Set(d.layers.map(l => l.id));
    let maxId = 0;
    for (const s of d.shapes) {
      if (!s || !Array.isArray(s.cmds) || !s.cmds.length) throw new Error('bad shape');
      for (const c of s.cmds) {
        if (!Array.isArray(c) || CMD_ARITY[c[0]] == null || c.length !== CMD_ARITY[c[0]]) {
          throw new Error('bad path command');
        }
        for (let i = 1; i < c.length; i++) {
          if (typeof c[i] !== 'number' || !isFinite(c[i])) throw new Error('bad path coordinate');
        }
      }
      s.type = 'path';
      if (!layerIds.has(s.layer)) s.layer = d.layers[0].id;
      if (s.opacity == null || !isFinite(s.opacity)) s.opacity = 1;
      if (s.fill != null && typeof s.fill !== 'string') s.fill = null;
      if (s.stroke != null && (typeof s.stroke !== 'object' || typeof s.stroke.color !== 'string'
        || !isFinite(s.stroke.w))) s.stroke = null;
      const m = typeof s.id === 'string' && /^S(\d+)$/.exec(s.id);
      if (m) maxId = Math.max(maxId, +m[1]); else s.id = null;
    }
    // groups: validate registry, heal dangling refs/parents and cycles
    if (!Array.isArray(d.groups)) d.groups = [];
    const gids = new Set();
    for (const g of d.groups) {
      const gm = g && typeof g.id === 'string' && /^G(\d+)$/.exec(g.id);
      if (!gm) throw new Error('bad group');
      gids.add(g.id);
      maxId = Math.max(maxId, +gm[1]);
    }
    for (const g of d.groups) {
      if (g.parent != null && !gids.has(g.parent)) g.parent = null;
    }
    for (const g of d.groups) { // break parent cycles
      let cur = g, seen = new Set();
      while (cur && cur.parent) {
        if (seen.has(cur.id)) { g.parent = null; break; }
        seen.add(cur.id);
        cur = d.groups.find(x => x.id === cur.parent);
      }
    }
    for (const s of d.shapes) {
      if (s.group != null && !gids.has(s.group)) s.group = null;
    }
    let next = Math.max(isFinite(d.nextId) ? d.nextId : 1, maxId + 1);
    for (const s of d.shapes) if (!s.id) s.id = 'S' + next++;
    d.nextId = Math.max(next, maxId + 1);
    return d;
  }

  // ---------- history (undo/redo) ----------
  // Snapshot-based: the stack holds serialized docs, so entries are immutable
  // and no-op commits are a cheap string compare. idx points at the current state.
  function newHistory(doc, cap = 100) {
    return { stack: [serializeDoc(doc)], idx: 0, cap };
  }
  function commit(h, doc) {
    const s = serializeDoc(doc);
    if (s === h.stack[h.idx]) return false;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(s);
    while (h.stack.length > h.cap) h.stack.shift();
    h.idx = h.stack.length - 1;
    return true;
  }
  function canUndo(h) { return h.idx > 0; }
  function canRedo(h) { return h.idx < h.stack.length - 1; }
  function undo(h) { return canUndo(h) ? parseDoc(h.stack[--h.idx]) : null; }
  function redo(h) { return canRedo(h) ? parseDoc(h.stack[++h.idx]) : null; }

  // ---------- demo content (placeholder until real docs/import land) ----------
  function demoDoc() {
    const doc = newDoc({ w: 8.5, h: 11, units: 'in' });
    addShape(doc, {
      type: 'path', name: 'Rounded rect',
      fill: '#2f6fb3', stroke: null, opacity: 1,
      cmds: rectPath(1 * 72, 1 * 72, 3 * 72, 2 * 72, 18),
    });
    addShape(doc, {
      type: 'path', name: 'Spot green circle',
      fill: '#6cb33f', stroke: { color: '#1d1d1b', w: 1.5 }, opacity: 1,
      cmds: ellipsePath(5.5 * 72, 3.4 * 72, 1.2 * 72, 1.2 * 72),
    });
    addShape(doc, {
      type: 'path', name: 'Star',
      fill: '#e8862e', stroke: null, opacity: 1,
      cmds: starPath(3.4 * 72, 6.6 * 72, 1.5 * 72, 0.62 * 72, 5),
    });
    return doc;
  }

  return {
    PT_PER, PX_PER_PT_100, KAPPA,
    newDoc, addShape,
    newView, w2s, s2w, zoomAt, panBy, fitRect, zoomPct,
    rectPath, ellipsePath, starPath, pathBBox,
    mMul, mTranslate, mScale, mRotate, mApply, transformCmds,
    flattenPath, tightBBox, shapesBBox, hitTestShape, rectsIntersect,
    rootGroupOf, expandIds, selectionUnits, groupShapes, ungroupShapes, duplicateShapes,
    bringToFront, sendToBack, bringForward, sendBackward, alignUnits,
    serializeDoc, parseDoc,
    newHistory, commit, canUndo, canRedo, undo, redo,
    demoDoc,
  };
})();
if (typeof module !== 'undefined') module.exports = VECCORE;
if (typeof window !== 'undefined') window.VECCORE = VECCORE;
