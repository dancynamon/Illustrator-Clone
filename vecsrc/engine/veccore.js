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
      swatches: defaultSwatches(),
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

  // ---------- color ----------
  // Paints are stored the way the PDF bridge already stores them: a hex
  // string for the on-screen preview (shape.fill / shape.stroke.color) plus,
  // for print spaces only, the real ink data alongside it in shape.fillInfo /
  // shape.strokeInfo — {space, values, name?, alt?}. Every conversion between
  // spaces lives here so the panels, the swatches and the PDF exporter all
  // agree on what a color is. Components are 0..1 throughout; HSB hue is the
  // one exception and is in degrees.
  const COLOR_SPACES = { rgb: 3, cmyk: 4, gray: 1, separation: 1 };
  const PRINT_SPACES = { cmyk: 1, gray: 1, separation: 1 };

  function clamp01(v) { return !isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v; }

  // Returns null (not black) on anything unparseable so callers can reject
  // half-typed input instead of silently painting with it.
  function hexToRgb(hex) {
    let h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h.replace(/./g, c => c + c);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = parseInt(h, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
  }

  function cmykToRgb(v) {
    const k = clamp01(v[3]);
    return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])].map(c => (1 - c) * (1 - k));
  }

  // Naive separation (no profiles), matching the exporter's device CMYK:
  // pull the common ink out as K. Round-trips cmykToRgb for K-only builds.
  function rgbToCmyk(v) {
    const r = clamp01(v[0]), g = clamp01(v[1]), b = clamp01(v[2]);
    const k = 1 - Math.max(r, g, b);
    if (k >= 1) return [0, 0, 0, 1];
    return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
  }

  // HSB (= HSV): hue in degrees 0..360, saturation and brightness 0..1.
  function rgbToHsb(v) {
    const r = clamp01(v[0]), g = clamp01(v[1]), b = clamp01(v[2]);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, mx ? d / mx : 0, mx];
  }

  function hsbToRgb(v) {
    const h = ((v[0] % 360) + 360) % 360, s = clamp01(v[1]), b = clamp01(v[2]);
    const i = Math.floor(h / 60), f = h / 60 - i;
    const p = b * (1 - s), q = b * (1 - s * f), t = b * (1 - s * (1 - f));
    switch (i % 6) {
      case 0: return [b, t, p];
      case 1: return [q, b, p];
      case 2: return [p, b, t];
      case 3: return [p, q, b];
      case 4: return [t, p, b];
      default: return [b, p, q];
    }
  }

  function spaceToRgb(space, values) {
    if (space === 'cmyk') return cmykToRgb(values);
    if (space === 'gray') { const g = clamp01(values[0]); return [g, g, g]; }
    return [clamp01(values[0]), clamp01(values[1]), clamp01(values[2])];
  }

  // Normalize anything color-shaped (picker output, importer palette entry,
  // swatch) into {space, values, rgb, name?, alt?}. null means "none".
  function makeColor(o) {
    if (!o || !COLOR_SPACES[o.space]) return null;
    const space = o.space, n = COLOR_SPACES[space];
    const values = [];
    for (let i = 0; i < n; i++) values.push(clamp01(Array.isArray(o.values) ? o.values[i] : 0));
    if (space !== 'separation') return { space, values, rgb: spaceToRgb(space, values) };
    // A spot ink is one tint value; its look comes from the alternate build,
    // which is what keeps the plate identifiable all the way through export.
    const col = { space, values, rgb: null, name: String(o.name || 'Spot') };
    const a = o.alt;
    if (a && COLOR_SPACES[a.space] && a.space !== 'separation' && Array.isArray(a.values)) {
      const an = COLOR_SPACES[a.space];
      col.alt = { space: a.space, values: a.values.slice(0, an).map(clamp01) };
    }
    if (Array.isArray(o.rgb) && o.rgb.length === 3) col.rgb = o.rgb.map(clamp01);
    else if (col.alt) col.rgb = spaceToRgb(col.alt.space, col.alt.values);
    else { const g = 1 - values[0]; col.rgb = [g, g, g]; } // unknown ink: tint as darkness
    return col;
  }

  function colorHex(col) { return col ? rgbToHex(col.rgb) : null; }

  // The part of a color worth storing next to the hex preview. RGB is fully
  // described by the hex already; print spaces are not.
  function colorInfo(col) {
    if (!col || !PRINT_SPACES[col.space]) return null;
    const o = { space: col.space, values: col.values.slice() };
    if (col.name) o.name = col.name;
    if (col.alt) o.alt = { space: col.alt.space, values: col.alt.values.slice() };
    return o;
  }

  // Inverse: rebuild a full color from a shape's stored hex + print info.
  function paintColor(hex, info) {
    if (hex == null) return null;
    const rgb = hexToRgb(hex) || [0, 0, 0];
    if (info && COLOR_SPACES[info.space]) return makeColor({ ...info, rgb });
    return makeColor({ space: 'rgb', values: rgb });
  }

  function colorEquals(a, b) {
    if (!a || !b) return a === b;
    return a.space === b.space && (a.name || '') === (b.name || '') &&
      a.values.length === b.values.length && a.values.every((v, i) => Math.abs(v - b.values[i]) < 1e-6);
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

  // ---------- fill, stroke & opacity ----------
  // Each of these mutates the doc in place over a plain id list and leaves
  // committing to the caller, so painting a whole selection is one undo step.
  const STROKE_CAPS = { butt: 1, round: 1, square: 1 };
  const STROKE_JOINS = { miter: 1, round: 1, bevel: 1 };
  const STROKE_ALIGNS = { center: 1, inside: 1, outside: 1 };
  const STROKE_DEFAULTS = { w: 1, cap: 'butt', join: 'miter', miter: 10, align: 'center' };

  function eachShape(doc, ids, fn) {
    const set = new Set(ids);
    for (const s of doc.shapes) if (set.has(s.id)) fn(s);
  }

  // col === null paints "none".
  function setFill(doc, ids, col) {
    const hex = colorHex(col), info = colorInfo(col);
    eachShape(doc, ids, s => {
      s.fill = hex;
      if (info) s.fillInfo = { ...info }; else delete s.fillInfo;
    });
  }

  function setStroke(doc, ids, col) {
    const hex = colorHex(col), info = colorInfo(col);
    eachShape(doc, ids, s => {
      if (hex == null) { s.stroke = null; delete s.strokeInfo; return; }
      s.stroke = { ...(s.stroke || { w: STROKE_DEFAULTS.w }), color: hex };
      if (info) s.strokeInfo = { ...info }; else delete s.strokeInfo;
    });
  }

  // Weight/cap/join/miter/dash/align. Shapes with no stroke are skipped —
  // a weight alone should never conjure a black outline out of nothing.
  function setStrokeProps(doc, ids, props) {
    eachShape(doc, ids, s => {
      if (!s.stroke) return;
      const st = { ...s.stroke };
      if (props.w != null && isFinite(props.w)) st.w = Math.max(0, props.w);
      if (STROKE_CAPS[props.cap]) st.cap = props.cap;
      if (STROKE_JOINS[props.join]) st.join = props.join;
      if (props.miter != null && isFinite(props.miter)) st.miter = Math.max(1, props.miter);
      if (STROKE_ALIGNS[props.align]) st.align = props.align;
      if (props.dash !== undefined) {
        const d = parseDash(props.dash);
        if (d) st.dash = d; else delete st.dash;
      }
      s.stroke = st;
    });
  }

  function setOpacity(doc, ids, a) {
    const v = clamp01(a);
    eachShape(doc, ids, s => { s.opacity = v; });
  }

  // Everything about how a shape looks, in the form the setters take it back
  // in. This is what the eyedropper carries: the print info rides along, so
  // sampling a spot ink hands back the ink rather than a flattened preview.
  function strokeAttrs(stroke) {
    if (!stroke) return null;
    return {
      w: stroke.w,
      cap: strokeProp(stroke, 'cap'),
      join: strokeProp(stroke, 'join'),
      miter: strokeProp(stroke, 'miter'),
      align: strokeProp(stroke, 'align'),
      dash: stroke.dash ? stroke.dash.slice() : [], // empty clears a dash on the target
    };
  }

  function shapeAppearance(s) {
    return {
      fill: paintColor(s.fill, s.fillInfo),
      stroke: s.stroke ? paintColor(s.stroke.color, s.strokeInfo) : null,
      strokeAttrs: strokeAttrs(s.stroke),
      opacity: s.opacity == null ? 1 : s.opacity,
    };
  }

  // Paint an appearance onto a selection. Stroke color goes on before the
  // attributes, because a shape that had no stroke only grows one at the
  // colour step and setStrokeProps deliberately skips shapes without.
  function applyAppearance(doc, ids, ap, opts = {}) {
    setFill(doc, ids, ap.fill);
    setStroke(doc, ids, ap.stroke);
    if (ap.strokeAttrs) setStrokeProps(doc, ids, ap.strokeAttrs);
    if (opts.opacity !== false && ap.opacity != null) setOpacity(doc, ids, ap.opacity);
  }

  // Shift+X: every shape trades its own fill for its own stroke color, so a
  // mixed selection stays meaningful instead of collapsing to one pair.
  function swapFillStroke(doc, ids) {
    for (const s of doc.shapes.filter(s => ids.indexOf(s.id) >= 0)) {
      const fill = paintColor(s.fill, s.fillInfo);
      const stroke = s.stroke ? paintColor(s.stroke.color, s.strokeInfo) : null;
      setFill(doc, [s.id], stroke);
      setStroke(doc, [s.id], fill);
    }
  }

  // "6 3" / [6,3] -> [6,3]; anything all-zero or empty means solid (null).
  function parseDash(d) {
    const list = (Array.isArray(d) ? d : String(d == null ? '' : d).trim().split(/[\s,]+/))
      .map(Number).filter(v => isFinite(v) && v >= 0);
    return list.length && list.some(v => v > 0) ? list : null;
  }

  function strokeProp(stroke, key) {
    if (!stroke) return STROKE_DEFAULTS[key];
    const v = stroke[key];
    return v == null ? STROKE_DEFAULTS[key] : v;
  }

  // ---------- path offsetting ----------
  // An aligned stroke is a centered stroke drawn on the path pushed half its
  // weight to one side, so inside/outside alignment needs a genuine offset
  // path. Curves are flattened adaptively first: the offset of a cubic is not
  // a cubic, and the self-intersection pruning below only works on polylines.
  // OFFSET_TOL is in points, so the result is smooth well past print
  // resolution no matter how far the shape is zoomed.
  const OFFSET_TOL = 0.05;
  const INNER_TRIM_CAP = 20; // how far past |d| an inner corner may reach

  // Split a cubic until the control points sit within tol of the chord.
  function flatCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tol, depth) {
    const dx = x3 - x0, dy = y3 - y0;
    const len = Math.hypot(dx, dy);
    const flat = len > 1e-9
      ? (Math.abs((x1 - x0) * dy - (y1 - y0) * dx) + Math.abs((x2 - x0) * dy - (y2 - y0) * dx)) / len
      : Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x0, y2 - y0);
    if (flat <= tol || depth > 16) { out.push([x3, y3]); return; }
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
    const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
    const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
    const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
    const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
    flatCubic(out, x0, y0, x01, y01, xa, ya, xm, ym, tol, depth + 1);
    flatCubic(out, xm, ym, xb, yb, x23, y23, x3, y3, tol, depth + 1);
  }

  // Like flattenPath but accuracy-driven rather than fixed-step, and with
  // duplicate points removed so every segment has a well-defined normal.
  function flattenAdaptive(cmds, tol = OFFSET_TOL) {
    const subs = [];
    let cur = null, sx = 0, sy = 0, px = 0, py = 0;
    for (const c of cmds) {
      if (c[0] === 'M') {
        cur = { pts: [[c[1], c[2]]], closed: false };
        subs.push(cur);
        px = sx = c[1]; py = sy = c[2];
      } else if (!cur) continue;
      else if (c[0] === 'L') { cur.pts.push([c[1], c[2]]); px = c[1]; py = c[2]; }
      else if (c[0] === 'C') {
        flatCubic(cur.pts, px, py, c[1], c[2], c[3], c[4], c[5], c[6], tol, 0);
        px = c[5]; py = c[6];
      } else if (c[0] === 'Z') { cur.closed = true; px = sx; py = sy; }
    }
    for (const s of subs) {
      const p = [];
      for (const q of s.pts) {
        const last = p[p.length - 1];
        if (!last || Math.abs(last[0] - q[0]) > 1e-9 || Math.abs(last[1] - q[1]) > 1e-9) p.push(q);
      }
      if (s.closed && p.length > 1) {
        const a = p[0], b = p[p.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) p.pop();
      }
      s.pts = p;
    }
    return subs.filter(s => s.pts.length > 1);
  }

  // Shoelace in y-down document space: positive area means the interior lies
  // along the (-dy, dx) normal, which is the direction offsetPath calls "in".
  function subpathArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  // Where two rays cross, or null when they are parallel.
  function rayCross(px, py, ux, uy, qx, qy, vx, vy) {
    const den = ux * vy - uy * vx;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((qx - px) * vy - (qy - py) * vx) / den;
    return [px + ux * t, py + uy * t];
  }

  // Squared, because pruning calls this hundreds of thousands of times on
  // heavy artwork and only ever compares it against a fixed limit.
  function ptSegDist2(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - x, ey = ay + t * dy - y;
    return ex * ex + ey * ey;
  }

  // Raw offset of one polyline: every segment slides along its normal, and the
  // gaps that opens at corners are filled with the stroke's own join, so the
  // corners of an aligned stroke look like the corners of a centered one.
  function offsetSubpath(pts, closed, d, join, miterLimit, tol) {
    const n = pts.length;
    const segs = [];
    for (let i = 0, last = closed ? n : n - 1; i < last; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy);
      if (L < 1e-9) continue;
      segs.push({ a, b, ux: dx / L, uy: dy / L, nx: -dy / L, ny: dx / L });
    }
    if (!segs.length) return null;

    const out = [];
    const put = (x, y) => {
      const p = out[out.length - 1];
      if (!p || Math.abs(p[0] - x) > 1e-9 || Math.abs(p[1] - y) > 1e-9) out.push([x, y]);
    };
    const r = Math.abs(d);
    const arcStep = r > tol ? Math.max(0.05, 2 * Math.acos(Math.max(-1, 1 - tol / r))) : Math.PI / 2;

    function joinAt(p, prev, cur) {
      const p0x = p[0] + prev.nx * d, p0y = p[1] + prev.ny * d;
      const p1x = p[0] + cur.nx * d, p1y = p[1] + cur.ny * d;
      const cross = prev.ux * cur.uy - prev.uy * cur.ux;
      const dot = prev.ux * cur.ux + prev.uy * cur.uy;
      // A turn only needs corner geometry once it opens a gap wider than tol.
      // Below that one point covers it, which keeps a flattened curve from
      // paying for a join at every single vertex.
      if (dot > 0 && r * Math.abs(cross) <= tol) { put(p0x, p0y); return; }
      // cross * d < 0 means the two offset ends pull apart and the gap is a
      // real join; otherwise they cross and the corner trims to that crossing.
      const gap = cross * d < 0;
      const halfSin = Math.sqrt(Math.max(0, (1 + dot) / 2)); // sin(interior/2)
      const withinMiter = halfSin > 1e-9 && 1 / halfSin <= miterLimit;
      if (!gap || (join === 'miter' && withinMiter)) {
        const ip = rayCross(p0x, p0y, prev.ux, prev.uy, p1x, p1y, cur.ux, cur.uy);
        if (ip && Math.hypot(ip[0] - p[0], ip[1] - p[1]) <= r * INNER_TRIM_CAP) {
          put(ip[0], ip[1]);
          return;
        }
      } else if (join === 'round') {
        const a0 = Math.atan2(p0y - p[1], p0x - p[0]);
        let da = Math.atan2(p1y - p[1], p1x - p[0]) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(da) / arcStep));
        for (let k = 0; k <= steps; k++) {
          const a = a0 + da * (k / steps);
          put(p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r);
        }
        return;
      }
      put(p0x, p0y); put(p1x, p1y); // bevel, over-limit miter, runaway corner
    }

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const prev = i > 0 ? segs[i - 1] : (closed ? segs[segs.length - 1] : null);
      if (prev) joinAt(s.a, prev, s);
      else put(s.a[0] + s.nx * d, s.a[1] + s.ny * d);
      put(s.b[0] + s.nx * d, s.b[1] + s.ny * d);
    }
    if (closed && out.length > 1) {
      const a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
    }
    return out.length > 1 ? out : null;
  }

  // Uniform grid over the source segments, so pruning does not have to measure
  // every offset point against every source segment. Cells are 2·|d| across
  // and each segment is sampled every half cell, which puts any source within
  // |d| of a query point in the 3×3 block around that point's own cell.
  // Segment endpoints live in one flat array and cells key on a packed integer
  // — pruning runs per offset point, so allocation is what costs here.
  const GRID_BIAS = 1 << 20;

  function segGrid(subs, cell) {
    const map = new Map();
    const xs = [];
    const put = (key, seg) => {
      let bucket = map.get(key);
      if (!bucket) map.set(key, bucket = []);
      if (bucket[bucket.length - 1] !== seg) bucket.push(seg);
    };
    for (const s of subs) {
      const n = s.pts.length;
      for (let i = 0, last = s.closed ? n : n - 1; i < last; i++) {
        const a = s.pts[i], b = s.pts[(i + 1) % n];
        const seg = xs.length;
        xs.push(a[0], a[1], b[0], b[1]);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (cell / 2)));
        let prev = -1;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const key = (Math.floor((a[0] + dx * t) / cell) + GRID_BIAS) * 2 * GRID_BIAS +
            Math.floor((a[1] + dy * t) / cell) + GRID_BIAS;
          if (key === prev) continue;
          prev = key;
          put(key, seg);
        }
      }
    }
    return { cell, map, xs };
  }

  function nearSource(grid, x, y, lim2) {
    const cell = grid.cell, xs = grid.xs;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let i = -1; i <= 1; i++) {
      const row = (cx + i + GRID_BIAS) * 2 * GRID_BIAS;
      for (let j = -1; j <= 1; j++) {
        const bucket = grid.map.get(row + cy + j + GRID_BIAS);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const o = bucket[k];
          if (ptSegDist2(x, y, xs[o], xs[o + 1], xs[o + 2], xs[o + 3]) < lim2) return true;
        }
      }
    }
    return false;
  }

  // Every point of a true offset sits exactly |d| from the source. Anything
  // the raw offset put closer than that is inside the swept band — the loops a
  // corner throws when the offset outruns the local feature size — so drop it
  // and let the surviving runs bridge straight across the hole they leave.
  function pruneOffset(raw, closed, grid, lim) {
    const lim2 = lim * lim;
    const keep = raw.map(p => !nearSource(grid, p[0], p[1], lim2));
    if (keep.every(Boolean)) return raw;
    const start = closed ? Math.max(0, keep.indexOf(false)) : 0;
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const j = (start + i) % raw.length;
      if (keep[j]) out.push(raw[j]);
    }
    return out.length > 1 ? out : null;
  }

  // Offset a path by d, positive meaning toward the filled side. Returns M/L/Z
  // commands, or null when the offset eats the shape entirely (an inside
  // stroke wider than the shape is thick).
  function offsetPath(cmds, d, opts = {}) {
    const tol = opts.tol > 0 ? opts.tol : OFFSET_TOL;
    const join = STROKE_JOINS[opts.join] ? opts.join : STROKE_DEFAULTS.join;
    const miterLimit = opts.miterLimit > 1 ? opts.miterLimit : STROKE_DEFAULTS.miter;
    const subs = flattenAdaptive(cmds, tol);
    if (!subs.length) return null;
    if (Math.abs(d) < 1e-9) return cmds.slice();
    // Winding picks the side; a reversed outer contour flips the whole shape,
    // while holes wind the other way already and take care of themselves.
    let area = 0;
    for (const s of subs) if (s.closed) area += subpathArea(s.pts);
    const dd = area < 0 ? -d : d;
    const lim = Math.abs(dd) - Math.max(tol * 2, Math.abs(dd) * 1e-3);
    const grid = lim > 0 ? segGrid(subs, Math.max(2 * Math.abs(dd), 1e-6)) : null;
    const out = [];
    for (const s of subs) {
      let pts = offsetSubpath(s.pts, s.closed, dd, join, miterLimit, tol);
      if (pts && grid) pts = pruneOffset(pts, s.closed, grid, lim);
      if (!pts || pts.length < 2) continue;
      out.push(['M', pts[0][0], pts[0][1]]);
      for (let i = 1; i < pts.length; i++) out.push(['L', pts[i][0], pts[i][1]]);
      if (s.closed) out.push(['Z']);
    }
    return out.length ? out : null;
  }

  // The offset path an aligned stroke actually rides on, or null for a
  // centered stroke (and for a stroke whose offset collapsed).
  function strokeOffsetPath(cmds, stroke) {
    const align = strokeProp(stroke, 'align');
    if (!stroke || align === 'center' || !(stroke.w > 0)) return null;
    return offsetPath(cmds, (align === 'inside' ? 1 : -1) * stroke.w / 2, {
      join: strokeProp(stroke, 'join'), miterLimit: strokeProp(stroke, 'miter'),
    });
  }

  // ---------- swatches ----------
  // doc.swatches is the document palette. The PDF/.ai importer fills it from
  // the inks it finds in the file; the Swatches panel edits it. A swatch is a
  // color record plus a name, and spot inks (space 'separation') carry the ink
  // name and its alternate build so plates survive a round trip.
  function defaultSwatchName(col) {
    if (col.space === 'separation') return col.name || 'Spot';
    if (col.space === 'cmyk') {
      return col.values.map((v, i) => 'CMYK'[i] + '=' + Math.round(v * 100)).join(' ');
    }
    if (col.space === 'gray') return 'Gray ' + Math.round(col.values[0] * 100);
    return col.values.map((v, i) => 'RGB'[i] + '=' + Math.round(v * 255)).join(' ');
  }

  function makeSwatch(o) {
    const col = makeColor(o);
    if (!col) return null;
    const sw = {
      name: String((o && o.name) || defaultSwatchName(col)),
      space: col.space, values: col.values, rgb: col.rgb,
    };
    if (col.alt) sw.alt = col.alt;
    sw.spot = col.space === 'separation';
    return sw;
  }

  // Identity for dedupe: same space and components, and for spots the same
  // ink name — two different inks may well share an alternate build.
  function swatchKey(sw) {
    return sw.space + '|' + (sw.spot ? sw.name : '') + '|' + sw.values.map(v => v.toFixed(4)).join(',');
  }

  function findSwatch(doc, col) {
    const sw = makeSwatch(col);
    if (!sw) return -1;
    const key = swatchKey(sw);
    return (doc.swatches || []).findIndex(s => swatchKey(s) === key);
  }

  function addSwatch(doc, col, name) {
    if (!Array.isArray(doc.swatches)) doc.swatches = [];
    const sw = makeSwatch(name ? { ...col, name } : col);
    if (!sw) return null;
    const i = findSwatch(doc, sw);
    if (i >= 0) return doc.swatches[i];
    doc.swatches.push(sw);
    return sw;
  }

  function removeSwatch(doc, i) {
    if (!Array.isArray(doc.swatches) || i < 0 || i >= doc.swatches.length) return false;
    doc.swatches.splice(i, 1);
    return true;
  }

  function renameSwatch(doc, i, name) {
    const sw = Array.isArray(doc.swatches) ? doc.swatches[i] : null;
    if (!sw || !String(name || '').trim()) return false;
    sw.name = String(name).trim();
    return true;
  }

  function swatchColor(sw) { return makeColor(sw); }

  // The palette a brand-new document starts with: Illustrator's process
  // basics, as CMYK builds because this app exists for print work.
  function defaultSwatches() {
    return [
      { name: 'White', space: 'cmyk', values: [0, 0, 0, 0] },
      { name: 'Black', space: 'cmyk', values: [0, 0, 0, 1] },
      { name: 'Cyan', space: 'cmyk', values: [1, 0, 0, 0] },
      { name: 'Magenta', space: 'cmyk', values: [0, 1, 0, 0] },
      { name: 'Yellow', space: 'cmyk', values: [0, 0, 1, 0] },
      { name: 'Red', space: 'cmyk', values: [0, 1, 1, 0] },
      { name: 'Green', space: 'cmyk', values: [0.75, 0, 1, 0] },
      { name: 'Blue', space: 'cmyk', values: [1, 0.9, 0.1, 0] },
    ].map(makeSwatch);
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
      if (s.stroke) healStroke(s.stroke);
      for (const key of ['fillInfo', 'strokeInfo']) {
        if (s[key] === undefined) continue;
        const info = healColorInfo(s[key]);
        if (info) s[key] = info; else delete s[key];
      }
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
    // palette: drop anything that isn't a usable color, normalize the rest
    d.swatches = Array.isArray(d.swatches) ? d.swatches.map(makeSwatch).filter(Boolean) : [];
    let next = Math.max(isFinite(d.nextId) ? d.nextId : 1, maxId + 1);
    for (const s of d.shapes) if (!s.id) s.id = 'S' + next++;
    d.nextId = Math.max(next, maxId + 1);
    return d;
  }

  // Keep stroke extras only when they name something real; the renderer and
  // the exporter fill in STROKE_DEFAULTS for whatever is absent.
  function healStroke(st) {
    st.w = Math.max(0, st.w);
    if (!STROKE_CAPS[st.cap]) delete st.cap;
    if (!STROKE_JOINS[st.join]) delete st.join;
    if (!STROKE_ALIGNS[st.align]) delete st.align;
    if (st.miter !== undefined && (!isFinite(st.miter) || st.miter < 1)) delete st.miter;
    if (st.dash !== undefined) {
      const d = parseDash(st.dash);
      if (d) st.dash = d; else delete st.dash;
    }
  }

  // Print-color data on a shape: keep it only if it is structurally sound,
  // otherwise drop it and let the hex preview stand on its own.
  function healColorInfo(info) {
    if (!info || typeof info !== 'object' || !PRINT_SPACES[info.space]) return null;
    const n = COLOR_SPACES[info.space];
    if (!Array.isArray(info.values) || info.values.length < n) return null;
    if (!info.values.slice(0, n).every(v => typeof v === 'number' && isFinite(v))) return null;
    const o = { space: info.space, values: info.values.slice(0, n).map(clamp01) };
    if (info.space === 'separation') o.name = String(info.name || 'Spot');
    const a = info.alt;
    if (a && COLOR_SPACES[a.space] && a.space !== 'separation' && Array.isArray(a.values)) {
      const an = COLOR_SPACES[a.space];
      if (a.values.length >= an && a.values.slice(0, an).every(v => typeof v === 'number' && isFinite(v))) {
        o.alt = { space: a.space, values: a.values.slice(0, an).map(clamp01) };
      }
    }
    return o;
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
    // one spot ink in the palette so the Swatches panel shows a real plate
    const spot = addSwatch(doc, {
      space: 'separation', name: 'Aquamentor Green', values: [1],
      alt: { space: 'cmyk', values: [0.4, 0, 0.65, 0.3] },
    });
    const spotCol = swatchColor(spot);
    addShape(doc, {
      type: 'path', name: 'Rounded rect',
      fill: '#2f6fb3', stroke: null, opacity: 1,
      cmds: rectPath(1 * 72, 1 * 72, 3 * 72, 2 * 72, 18),
    });
    addShape(doc, {
      type: 'path', name: 'Spot green circle',
      fill: colorHex(spotCol), fillInfo: colorInfo(spotCol),
      stroke: { color: '#1d1d1b', w: 1.5 }, opacity: 1,
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
    COLOR_SPACES, PRINT_SPACES, STROKE_CAPS, STROKE_JOINS, STROKE_ALIGNS, STROKE_DEFAULTS,
    newDoc, addShape,
    clamp01, hexToRgb, rgbToHex, cmykToRgb, rgbToCmyk, rgbToHsb, hsbToRgb, spaceToRgb,
    makeColor, colorHex, colorInfo, paintColor, colorEquals,
    setFill, setStroke, setStrokeProps, setOpacity, swapFillStroke, parseDash, strokeProp,
    strokeAttrs, shapeAppearance, applyAppearance,
    OFFSET_TOL, flattenAdaptive, subpathArea, offsetPath, strokeOffsetPath,
    makeSwatch, swatchKey, swatchColor, findSwatch, addSwatch, removeSwatch, renameSwatch,
    defaultSwatches, defaultSwatchName,
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
