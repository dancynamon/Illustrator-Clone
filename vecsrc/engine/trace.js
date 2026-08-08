// VECTRACE — Image Trace (raster -> vector) for Aquamentor Vector Studio.
// Pure pixel/geometry work, no DOM: a bitmap arrives as {w,h,data} with RGBA
// bytes (exactly what canvas getImageData hands over) and paths leave as
// veccore M/L/C/Z command lists in *image pixel* coordinates; the caller maps
// them into the document with placementMatrix().
//
// Six separable stages, each exported so tests can drive it on its own:
//   quantize -> denoise -> labelRegions -> contours -> simplify -> fitPath
const VECTRACE = (() => {
  'use strict';

  const C = typeof VECCORE !== 'undefined' ? VECCORE : require('./veccore.js');

  // ---------- options ----------
  // tolerance/minArea are in source pixels; cornerAngle is the turn angle (deg)
  // above which a vertex stays a hard corner instead of being smoothed.
  const DEFAULTS = {
    mode: 'color',       // 'color' | 'gray' | 'bw' | 'exact'
    colors: 6,           // palette size (color/gray/exact cap)
    threshold: 128,      // bw split on luminance 0..255
    tolerance: 1,        // RDP + curve-fit error
    cornerAngle: 60,
    minArea: 4,          // noise: regions smaller than this get merged away
    ignoreWhite: false,
    curves: true,        // false -> polygonal output (crisp pixel art)
    spread: 0.3,         // px of outward trap so neighbours overlap, not gap
    alphaCut: 128,       // pixels below this alpha are not traced
    maxPaths: 12000,    // runaway guard only — Noise is the real path-count knob
  };

  // Illustrator-familiar presets. The pixel-art pair keeps tolerance at 0 and
  // curves off so axis-aligned staircases survive as straight L segments.
  const PRESETS = {
    bw: { label: 'Black & White', mode: 'bw', threshold: 128, tolerance: 1, cornerAngle: 60, minArea: 6, ignoreWhite: true },
    gray: { label: 'Grayscale', mode: 'gray', colors: 8, tolerance: 1, cornerAngle: 60, minArea: 6 },
    color3: { label: '3 Colors', mode: 'color', colors: 3, tolerance: 1, cornerAngle: 60, minArea: 6 },
    color6: { label: '6 Colors', mode: 'color', colors: 6, tolerance: 1, cornerAngle: 60, minArea: 5 },
    color16: { label: '16 Colors', mode: 'color', colors: 16, tolerance: 1, cornerAngle: 60, minArea: 4 },
    photo: { label: 'Photo', mode: 'color', colors: 24, tolerance: 1.5, cornerAngle: 75, minArea: 8 },
    pixel: { label: 'Pixel Art', mode: 'exact', colors: 64, tolerance: 0, cornerAngle: 15, minArea: 1, curves: false, spread: 0 },
    pixelbw: { label: 'Pixel Art B&W', mode: 'bw', threshold: 128, tolerance: 0, cornerAngle: 15, minArea: 1, curves: false, ignoreWhite: true, spread: 0 },
  };
  const PRESET_ORDER = ['bw', 'gray', 'color3', 'color6', 'color16', 'photo', 'pixel', 'pixelbw'];

  function clampNum(v, lo, hi, dflt) {
    const n = +v;
    return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  }

  // Merge preset + caller overrides into a fully-clamped option set.
  function options(o) {
    o = o || {};
    const set = {};
    for (const k in o) if (o[k] !== undefined) set[k] = o[k];
    const p = PRESETS[set.preset] || null;
    const t = Object.assign({}, DEFAULTS, p ? Object.assign({}, p) : null, set);
    delete t.label;
    if (!/^(color|gray|bw|exact)$/.test(t.mode)) t.mode = 'color';
    t.colors = Math.round(clampNum(t.colors, 2, 256, 6));
    t.threshold = Math.round(clampNum(t.threshold, 0, 255, 128));
    t.tolerance = clampNum(t.tolerance, 0, 100, 1);
    t.cornerAngle = clampNum(t.cornerAngle, 0, 180, 60);
    t.minArea = Math.round(clampNum(t.minArea, 0, 1e6, 4));
    t.spread = clampNum(t.spread, 0, 8, 0.3);
    t.alphaCut = Math.round(clampNum(t.alphaCut, 0, 255, 128));
    t.maxPaths = Math.round(clampNum(t.maxPaths, 1, 1e6, 12000));
    t.ignoreWhite = !!t.ignoreWhite;
    t.curves = t.curves !== false;
    return t;
  }

  // ---------- colors ----------
  function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  function hexOf(rgb) {
    return '#' + rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
  }

  function isWhite(rgb, cut = 246) {
    return rgb[0] >= cut && rgb[1] >= cut && rgb[2] >= cut;
  }

  // ---------- stage 1: quantization ----------
  // Returns {w,h,idx,palette}: idx[p] is a palette index, or -1 where the
  // source is transparent (those pixels are simply not traced).

  // Median cut over a 5-bit-per-channel histogram. Boxes are ranges into a
  // key array that gets sorted in place on the split channel — no per-pixel
  // allocation anywhere.
  function medianCut(hist, sumR, sumG, sumB, maxColors) {
    const keys = [];
    for (let k = 0; k < hist.length; k++) if (hist[k]) keys.push(k);
    const key = Int32Array.from(keys);
    if (!key.length) return { palette: [[0, 0, 0]], lut: new Int32Array(hist.length) };

    const boxCount = k => { let c = 0; for (let i = k.lo; i < k.hi; i++) c += hist[key[i]]; return c; };
    const boxes = [{ lo: 0, hi: key.length, count: 0 }];
    boxes[0].count = boxCount(boxes[0]);

    while (boxes.length < maxColors) {
      let bi = -1, best = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].hi - boxes[i].lo > 1 && boxes[i].count > best) { best = boxes[i].count; bi = i; }
      }
      if (bi < 0) break;
      const b = boxes[bi];
      // widest channel of the box wins the split
      let r0 = 32, r1 = -1, g0 = 32, g1 = -1, b0 = 32, b1 = -1;
      for (let i = b.lo; i < b.hi; i++) {
        const k = key[i], r = k >> 10, g = (k >> 5) & 31, bb = k & 31;
        if (r < r0) r0 = r; if (r > r1) r1 = r;
        if (g < g0) g0 = g; if (g > g1) g1 = g;
        if (bb < b0) b0 = bb; if (bb > b1) b1 = bb;
      }
      const dr = r1 - r0, dg = g1 - g0, db = b1 - b0;
      const sh = dr >= dg && dr >= db ? 10 : dg >= db ? 5 : 0;
      key.subarray(b.lo, b.hi).sort((x, y) => ((x >> sh) & 31) - ((y >> sh) & 31));
      // split at the count median so both halves carry similar pixel mass
      let acc = 0, cut = b.lo + 1;
      for (let i = b.lo; i < b.hi - 1; i++) {
        acc += hist[key[i]];
        cut = i + 1;
        if (acc * 2 >= b.count) break;
      }
      const nb = { lo: cut, hi: b.hi, count: 0 };
      b.hi = cut;
      b.count = boxCount(b);
      nb.count = boxCount(nb);
      boxes.push(nb);
    }

    const palette = [], lut = new Int32Array(hist.length);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      let n = 0, r = 0, g = 0, bl = 0;
      for (let j = b.lo; j < b.hi; j++) {
        const k = key[j];
        lut[k] = i;
        n += hist[k]; r += sumR[k]; g += sumG[k]; bl += sumB[k];
      }
      palette.push(n ? [r / n, g / n, bl / n] : [0, 0, 0]);
    }
    return { palette, lut };
  }

  function quantize(bmp, opts) {
    const o = options(opts);
    const w = bmp.w, h = bmp.h, d = bmp.data, n = w * h;
    const idx = new Int32Array(n);
    const cut = o.alphaCut;

    if (o.mode === 'bw') {
      for (let p = 0; p < n; p++) {
        const q = p << 2;
        idx[p] = d[q + 3] < cut ? -1 : (luma(d[q], d[q + 1], d[q + 2]) < o.threshold ? 0 : 1);
      }
      return { w, h, idx, palette: [[0, 0, 0], [255, 255, 255]] };
    }

    if (o.mode === 'gray') {
      const lv = Math.min(256, o.colors);
      const cnt = new Float64Array(lv), sum = new Float64Array(lv);
      for (let p = 0; p < n; p++) {
        const q = p << 2;
        if (d[q + 3] < cut) { idx[p] = -1; continue; }
        const l = luma(d[q], d[q + 1], d[q + 2]);
        const b = Math.min(lv - 1, (l * lv / 256) | 0);
        idx[p] = b; cnt[b]++; sum[b] += l;
      }
      const palette = [];
      for (let i = 0; i < lv; i++) {
        const g = cnt[i] ? sum[i] / cnt[i] : (i + 0.5) * 255 / lv;
        palette.push([g, g, g]);
      }
      return { w, h, idx, palette };
    }

    if (o.mode === 'exact') {
      // Pixel art: keep the source palette verbatim when it is small enough.
      const map = new Map();
      let overflow = false;
      for (let p = 0; p < n; p++) {
        const q = p << 2;
        if (d[q + 3] < cut) continue;
        const k = (d[q] << 16) | (d[q + 1] << 8) | d[q + 2];
        if (!map.has(k)) {
          if (map.size >= o.colors) { overflow = true; break; }
          map.set(k, map.size);
        }
      }
      if (!overflow) {
        const palette = new Array(map.size);
        map.forEach((i, k) => { palette[i] = [(k >> 16) & 255, (k >> 8) & 255, k & 255]; });
        for (let p = 0; p < n; p++) {
          const q = p << 2;
          idx[p] = d[q + 3] < cut ? -1
            : map.get((d[q] << 16) | (d[q + 1] << 8) | d[q + 2]);
        }
        return { w, h, idx, palette, exact: true };
      }
    }

    // color (and exact overflow): 15-bit histogram + median cut
    const B = 1 << 15;
    const hist = new Uint32Array(B), sr = new Float64Array(B), sg = new Float64Array(B), sb = new Float64Array(B);
    for (let p = 0; p < n; p++) {
      const q = p << 2;
      if (d[q + 3] < cut) { idx[p] = -1; continue; }
      const r = d[q], g = d[q + 1], b = d[q + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
      idx[p] = k; // stash the bucket, remapped below
    }
    const { palette, lut } = medianCut(hist, sr, sg, sb, o.colors);
    for (let p = 0; p < n; p++) if (idx[p] >= 0) idx[p] = lut[idx[p]];
    return { w, h, idx, palette };
  }

  // ---------- stage 2: connected regions ----------
  // 4-connected flood fill over equal palette indices.
  function labelRegions(idx, w, h) {
    const n = w * h;
    const labels = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    const color = [], area = [];
    for (let s = 0; s < n; s++) {
      if (labels[s] !== -1 || idx[s] < 0) continue;
      const c = idx[s], id = color.length;
      let sp = 0, a = 0;
      labels[s] = id; stack[sp++] = s;
      while (sp) {
        const p = stack[--sp];
        a++;
        const x = p % w;
        if (x > 0 && labels[p - 1] === -1 && idx[p - 1] === c) { labels[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && labels[p + 1] === -1 && idx[p + 1] === c) { labels[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= w && labels[p - w] === -1 && idx[p - w] === c) { labels[p - w] = id; stack[sp++] = p - w; }
        if (p + w < n && labels[p + w] === -1 && idx[p + w] === c) { labels[p + w] = id; stack[sp++] = p + w; }
      }
      color.push(c); area.push(a);
    }
    return {
      labels, count: color.length,
      color: Int32Array.from(color), area: Int32Array.from(area),
    };
  }

  // Bucket every labelled pixel by region so later stages touch each pixel once.
  function regionPixels(reg) {
    const off = new Int32Array(reg.count + 1);
    for (let i = 0; i < reg.count; i++) off[i + 1] = off[i] + reg.area[i];
    const cur = off.slice(0, reg.count);
    const px = new Int32Array(off[reg.count]);
    for (let p = 0; p < reg.labels.length; p++) {
      const l = reg.labels[p];
      if (l >= 0) px[cur[l]++] = p;
    }
    return { off, px };
  }

  // ---------- stage 3: noise removal ----------
  // Regions under minArea adopt the colour of the neighbour they share the
  // most border with (preferring a neighbour that is itself big enough).
  // Mutates idx; returns how many regions were absorbed.
  function denoise(idx, w, h, minArea) {
    if (minArea <= 1) return 0;
    let merged = 0;
    for (let pass = 0; pass < 4; pass++) {
      const reg = labelRegions(idx, w, h);
      const { off, px } = regionPixels(reg);
      const newColor = Int32Array.from(reg.color);
      const order = [];
      for (let i = 0; i < reg.count; i++) if (reg.area[i] < minArea) order.push(i);
      if (!order.length) break;
      order.sort((a, b) => reg.area[a] - reg.area[b]);
      let did = 0;
      const tally = new Map(), n = w * h;
      for (const l of order) {
        tally.clear();
        for (let k = off[l]; k < off[l + 1]; k++) {
          const p = px[k], x = p % w;
          if (x > 0) bump(tally, reg.labels[p - 1], l);
          if (x < w - 1) bump(tally, reg.labels[p + 1], l);
          if (p >= w) bump(tally, reg.labels[p - w], l);
          if (p + w < n) bump(tally, reg.labels[p + w], l);
        }
        let best = -1, bestScore = -1;
        tally.forEach((shared, nb) => {
          // a big neighbour always beats a small one, ties break on shared border
          const score = (reg.area[nb] >= minArea ? 1e9 : 0) + shared;
          if (score > bestScore) { bestScore = score; best = nb; }
        });
        if (best < 0) continue;
        const c = newColor[best];
        newColor[l] = c;
        for (let k = off[l]; k < off[l + 1]; k++) idx[px[k]] = c;
        did++; merged++;
      }
      if (!did) break;
    }
    return merged;
  }

  function bump(map, nb, self) {
    if (nb < 0 || nb === self) return;
    map.set(nb, (map.get(nb) || 0) + 1);
  }

  // ---------- stage 4: contour extraction ----------
  // Crack following on the pixel grid: every boundary between an inside and an
  // outside pixel is a unit edge walked with the interior on the right, so the
  // loops come out axis-aligned (great for pixel art) and closed. Outer loops
  // have positive signed area, holes negative — which is exactly the winding
  // nonzero fill wants, so donuts stay hollow without an even-odd flag.
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

  function polyArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  // Junctions: grid vertices where three or more regions meet (the image border
  // counts as one). Neighbouring regions trace the same crack in opposite
  // directions, so pinning both of them to these vertices — and only these —
  // makes the shared run simplify and fit to identical geometry on both sides.
  // Without that, every boundary is approximated twice and the two answers
  // disagree by a fraction of a pixel: hairline gaps all over a photo trace.
  function junctionMap(labels, w, h) {
    const stride = w + 1;
    const j = new Uint8Array(stride * (h + 1));
    const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? -1 : labels[y * w + x];
    for (let y = 0; y <= h; y++) {
      for (let x = 0; x <= w; x++) {
        const tl = at(x - 1, y - 1), tr = at(x, y - 1), bl = at(x - 1, y), br = at(x, y);
        let n = 1;
        if (tr !== tl) n++;
        if (bl !== tl && bl !== tr) n++;
        if (br !== tl && br !== tr && br !== bl) n++;
        // a checkerboard vertex is a junction too, even with only two labels
        if (n >= 3 || (tl === br && tr === bl && tl !== tr)) j[x + y * stride] = 1;
      }
    }
    return j;
  }

  // Drop vertices whose incoming and outgoing directions are parallel, except
  // pinned ones (a T-junction can sit mid-run on a perfectly straight edge).
  function dropCollinear(pts, fix) {
    const n = pts.length;
    if (n < 3) return { pts, fix: fix || new Uint8Array(n) };
    const op = [], of = [];
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cr !== 0 || (fix && fix[i])) { op.push(b); of.push(fix ? fix[i] : 0); }
    }
    return op.length >= 3 ? { pts: op, fix: of } : { pts, fix: fix || new Uint8Array(n) };
  }

  // All closed loops bounding one labelled region, in pixel-grid coordinates.
  // `junction` is optional; when given, loops come back with a parallel `fix`
  // array marking the vertices that must survive simplification.
  function contours(labels, w, h, id, px, lo, hi, junction) {
    const stride = w + 1;
    const edges = new Map(); // vertex id -> bitmask of outgoing directions
    const add = (v, d) => edges.set(v, (edges.get(v) || 0) | (1 << d));
    for (let k = lo; k < hi; k++) {
      const p = px[k], x = p % w, y = (p / w) | 0, v = x + y * stride;
      if (y === 0 || labels[p - w] !== id) add(v, 0);                      // top    ->
      if (x === w - 1 || labels[p + 1] !== id) add(v + 1, 1);              // right  v
      if (y === h - 1 || labels[p + w] !== id) add(v + 1 + stride, 2);     // bottom <-
      if (x === 0 || labels[p - 1] !== id) add(v + stride, 3);             // left   ^
    }

    const loops = [];
    const starts = [...edges.keys()];
    for (const s0 of starts) {
      for (;;) {
        const m0 = edges.get(s0) || 0;
        if (!m0) break;
        let dir = m0 & 1 ? 0 : m0 & 2 ? 1 : m0 & 4 ? 2 : 3;
        let v = s0, last = -1;
        const pts = [], fix = [];
        for (;;) {
          const m = edges.get(v) & ~(1 << dir);
          if (m) edges.set(v, m); else edges.delete(v);
          const pin = junction ? junction[v] : 0;
          if (dir !== last || pin) { pts.push([v % stride, (v / stride) | 0]); fix.push(pin); }
          last = dir;
          v += DX[dir] + DY[dir] * stride;
          if (v === s0) break;
          const mv = edges.get(v) || 0;
          if (!mv) break; // malformed (cannot happen for a closed region)
          // hug the interior: tightest clockwise turn first, then straight
          const r = (dir + 1) & 3, st = dir, lf = (dir + 3) & 3;
          if ((mv >> r) & 1) dir = r;
          else if ((mv >> st) & 1) dir = st;
          else if ((mv >> lf) & 1) dir = lf;
          else break;
        }
        const poly = dropCollinear(pts, junction ? fix : null);
        if (poly.pts.length >= 3) {
          const a = polyArea(poly.pts);
          if (a !== 0) loops.push({ pts: poly.pts, fix: poly.fix, area: Math.abs(a), hole: a < 0 });
        }
      }
    }
    return loops;
  }

  // Push a loop outwards along its vertex bisectors (outers grow, holes
  // shrink). Simplification and curve fitting each move a boundary by a
  // fraction of a pixel, and where two of those errors happen to pull the same
  // way a hairline of artboard shows between neighbours. A sub-pixel spread
  // makes regions overlap instead — the classic print trap. Largest-area-first
  // z-order hides the overlap; the gap it replaces would not have been hidden.
  function spreadLoop(pts, d) {
    const n = pts.length;
    if (!d || n < 3) return pts;
    // Every loop is walked with its material on the right, so (dy,-dx) always
    // points away from the material — outer loops grow, holes shrink.
    const nx = new Array(n), ny = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      nx[i] = dy / L; ny[i] = -dx / L;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = (i + n - 1) % n;
      let bx = nx[p] + nx[i], by = ny[p] + ny[i];
      const L = Math.hypot(bx, by);
      if (L < 1e-9) { out[i] = [pts[i][0] + nx[i] * d, pts[i][1] + ny[i] * d]; continue; }
      bx /= L; by /= L;
      const m = d / Math.max(0.4, bx * nx[i] + by * ny[i]); // miter, capped at 2.5x
      out[i] = [pts[i][0] + bx * m, pts[i][1] + by * m];
    }
    return out;
  }

  function pointInPoly(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > y) !== (b[1] > y)
        && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  // Attach each hole loop to the smallest outer loop that contains it, so the
  // caller emits one subpath per outer boundary with its own holes.
  function nestLoops(loops) {
    const outers = loops.filter(l => !l.hole).map(l => ({ outer: l, holes: [] }));
    for (const hl of loops.filter(l => l.hole)) {
      const p = hl.pts[0];
      let best = null;
      for (const o of outers) {
        if (o.outer.area < hl.area) continue;
        if (!pointInPoly(o.outer.pts, p[0] + 0.5, p[1] + 0.5)
          && !pointInPoly(o.outer.pts, p[0] - 0.5, p[1] - 0.5)
          && !pointInPoly(o.outer.pts, p[0] + 0.5, p[1] - 0.5)
          && !pointInPoly(o.outer.pts, p[0] - 0.5, p[1] + 0.5)) continue;
        if (!best || o.outer.area < best.outer.area) best = o;
      }
      (best || outers[0] || { holes: [] }).holes.push(hl);
    }
    return outers;
  }

  // ---------- stage 5: simplification (Ramer-Douglas-Peucker) ----------
  function rdpOpen(pts, tol) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const t2 = tol * tol;
    const stack = [0, n - 1];
    while (stack.length) {
      const b = stack.pop(), a = stack.pop();
      if (b <= a + 1) continue;
      const ax = pts[a][0], ay = pts[a][1];
      const dx = pts[b][0] - ax, dy = pts[b][1] - ay, L2 = dx * dx + dy * dy;
      let best = -1, bd = -1;
      for (let i = a + 1; i < b; i++) {
        const ux = pts[i][0] - ax, uy = pts[i][1] - ay;
        let d2;
        if (L2 > 0) {
          const t = Math.max(0, Math.min(1, (ux * dx + uy * dy) / L2));
          const ex = ux - t * dx, ey = uy - t * dy;
          d2 = ex * ex + ey * ey;
        } else d2 = ux * ux + uy * uy;
        if (d2 > bd) { bd = d2; best = i; }
      }
      if (bd > t2) { keep[best] = 1; stack.push(a, best, best, b); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  // Anchors chosen from the point set alone (never from the walk's start
  // vertex), so a loop and its reversed twin land on the same two anchors.
  function lexLess(a, b) { return a[1] !== b[1] ? a[1] < b[1] : a[0] < b[0]; }

  function canonicalStart(pts) {
    let k = 0;
    for (let i = 1; i < pts.length; i++) if (lexLess(pts[i], pts[k])) k = i;
    return k;
  }

  function farthestFrom(pts, i0) {
    let best = i0 === 0 ? 1 % pts.length : 0, bd = -1;
    for (let i = 0; i < pts.length; i++) {
      if (i === i0) continue;
      const dx = pts[i][0] - pts[i0][0], dy = pts[i][1] - pts[i0][1];
      const d = dx * dx + dy * dy;
      if (d > bd || (d === bd && lexLess(pts[i], pts[best]))) { bd = d; best = i; }
    }
    return best;
  }

  // Closed loops are cut into spans at their anchors and each span goes through
  // RDP on its own, so the endpoints are never up for negotiation.
  function simplifyLoop(pts, fix, tol) {
    const n = pts.length;
    if (n < 4) return { pts: pts.slice(), fix: fix ? Array.from(fix) : new Array(n).fill(0) };
    const anchors = [], pinned = [];
    if (fix) for (let i = 0; i < n; i++) if (fix[i]) anchors.push(i);
    for (const a of anchors) pinned.push(1);
    if (anchors.length === 0) {
      const a0 = canonicalStart(pts);
      anchors.push(a0, farthestFrom(pts, a0));
      pinned.push(0, 0);
    } else if (anchors.length === 1) {
      anchors.push(farthestFrom(pts, anchors[0]));
      pinned.push(0);
    }
    const ord = anchors.map((v, i) => i).sort((i, j) => anchors[i] - anchors[j]);
    const outPts = [], outFix = [];
    for (let k = 0; k < ord.length; k++) {
      const a = anchors[ord[k]], b = anchors[ord[(k + 1) % ord.length]];
      const run = [];
      for (let i = a; ; i = (i + 1) % n) { run.push(pts[i]); if (i === b) break; }
      const r = rdpOpen(run, tol);
      for (let i = 0; i < r.length - 1; i++) {
        outPts.push(r[i]);
        outFix.push(i === 0 ? pinned[ord[k]] : 0);
      }
    }
    if (outPts.length < 3) return { pts: pts.slice(), fix: fix ? Array.from(fix) : new Array(n).fill(0) };
    return { pts: outPts, fix: outFix };
  }

  function simplifyClosed(pts, tol) { return simplifyLoop(pts, null, tol).pts; }

  // ---------- stage 6: curve fitting ----------
  function norm(x, y) {
    const l = Math.hypot(x, y);
    return l > 1e-12 ? [x / l, y / l] : [0, 0];
  }

  // Vertices whose turn angle exceeds the threshold stay hard corners.
  function detectCorners(pts, angleDeg) {
    const n = pts.length, out = [];
    if (n < 3) return out;
    const lim = Math.cos(angleDeg * Math.PI / 180);
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      const u = norm(b[0] - a[0], b[1] - a[1]), v = norm(c[0] - b[0], c[1] - b[1]);
      if (!u[0] && !u[1]) continue;
      if (!v[0] && !v[1]) continue;
      if (u[0] * v[0] + u[1] * v[1] < lim) out.push(i);
    }
    return out;
  }

  function bezierAt(bz, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [
      a * bz[0][0] + b * bz[1][0] + c * bz[2][0] + d * bz[3][0],
      a * bz[0][1] + b * bz[1][1] + c * bz[2][1] + d * bz[3][1],
    ];
  }

  function chordParams(pts) {
    const u = [0];
    for (let i = 1; i < pts.length; i++) {
      u.push(u[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const tot = u[u.length - 1] || 1;
    for (let i = 0; i < u.length; i++) u[i] /= tot;
    return u;
  }

  // Least-squares cubic through the run with the given end tangents (Schneider).
  function generateBezier(pts, u, t1, t2) {
    const p0 = pts[0], p3 = pts[pts.length - 1];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < pts.length; i++) {
      const t = u[i], mt = 1 - t;
      const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      const a0x = t1[0] * b1, a0y = t1[1] * b1, a1x = t2[0] * b2, a1y = t2[1] * b2;
      c00 += a0x * a0x + a0y * a0y;
      c01 += a0x * a1x + a0y * a1y;
      c11 += a1x * a1x + a1y * a1y;
      const tx = pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3));
      const ty = pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3));
      x0 += a0x * tx + a0y * ty;
      x1 += a1x * tx + a1y * ty;
    }
    const det = c00 * c11 - c01 * c01;
    let al = det !== 0 ? (c11 * x0 - c01 * x1) / det : 0;
    let ar = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
    const seg = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    if (!(al > 1e-6 * seg) || !(ar > 1e-6 * seg)) al = ar = seg / 3;
    return [p0, [p0[0] + t1[0] * al, p0[1] + t1[1] * al], [p3[0] + t2[0] * ar, p3[1] + t2[1] * ar], p3];
  }

  function maxError(pts, u, bz) {
    let max = 0, at = (pts.length / 2) | 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const q = bezierAt(bz, u[i]);
      const d = (q[0] - pts[i][0]) ** 2 + (q[1] - pts[i][1]) ** 2;
      if (d > max) { max = d; at = i; }
    }
    return [Math.sqrt(max), at];
  }

  // One Newton step per point toward the closest parameter on the curve.
  function reparam(pts, u, bz) {
    const out = u.slice();
    for (let i = 1; i < pts.length - 1; i++) {
      const t = u[i], mt = 1 - t;
      const q = bezierAt(bz, t);
      const d1x = 3 * mt * mt * (bz[1][0] - bz[0][0]) + 6 * mt * t * (bz[2][0] - bz[1][0]) + 3 * t * t * (bz[3][0] - bz[2][0]);
      const d1y = 3 * mt * mt * (bz[1][1] - bz[0][1]) + 6 * mt * t * (bz[2][1] - bz[1][1]) + 3 * t * t * (bz[3][1] - bz[2][1]);
      const d2x = 6 * mt * (bz[2][0] - 2 * bz[1][0] + bz[0][0]) + 6 * t * (bz[3][0] - 2 * bz[2][0] + bz[1][0]);
      const d2y = 6 * mt * (bz[2][1] - 2 * bz[1][1] + bz[0][1]) + 6 * t * (bz[3][1] - 2 * bz[2][1] + bz[1][1]);
      const ex = q[0] - pts[i][0], ey = q[1] - pts[i][1];
      const den = d1x * d1x + d1y * d1y + ex * d2x + ey * d2y;
      if (Math.abs(den) > 1e-12) out[i] = Math.min(1, Math.max(0, t - (ex * d1x + ey * d1y) / den));
    }
    return out;
  }

  function fitCubic(pts, t1, t2, err, out, depth) {
    if (pts.length === 2) {
      const d = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / 3;
      out.push([pts[0], [pts[0][0] + t1[0] * d, pts[0][1] + t1[1] * d],
        [pts[1][0] + t2[0] * d, pts[1][1] + t2[1] * d], pts[1]]);
      return;
    }
    let u = chordParams(pts);
    let bz = generateBezier(pts, u, t1, t2);
    let [e, at] = maxError(pts, u, bz);
    if (e <= err) { out.push(bz); return; }
    if (depth < 16 && e < err * 4) {
      for (let i = 0; i < 4; i++) {
        u = reparam(pts, u, bz);
        bz = generateBezier(pts, u, t1, t2);
        [e, at] = maxError(pts, u, bz);
        if (e <= err) { out.push(bz); return; }
      }
    }
    if (depth >= 16) { out.push(bz); return; }
    if (at <= 0 || at >= pts.length - 1) at = pts.length >> 1;
    const c = norm(pts[at - 1][0] - pts[at + 1][0], pts[at - 1][1] - pts[at + 1][1]);
    fitCubic(pts.slice(0, at + 1), t1, c, err, out, depth + 1);
    fitCubic(pts.slice(at), [-c[0], -c[1]], t2, err, out, depth + 1);
  }

  const STRAIGHT_EPS = 0.02;
  function isStraight(bz) {
    const dx = bz[3][0] - bz[0][0], dy = bz[3][1] - bz[0][1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return false;
    for (const p of [bz[1], bz[2]]) {
      const cr = Math.abs((p[0] - bz[0][0]) * dy - (p[1] - bz[0][1]) * dx) / L;
      const t = ((p[0] - bz[0][0]) * dx + (p[1] - bz[0][1]) * dy) / (L * L);
      if (cr > STRAIGHT_EPS || t < -0.05 || t > 1.05) return false;
    }
    return true;
  }

  // Closed polygon -> M/L/C/Z. curves=false keeps it polygonal; otherwise the
  // loop is cut at its corners and each smooth run is fitted with cubics.
  function fitPath(pts, opts, fix) {
    const o = options(opts);
    const n = pts.length;
    if (n < 3) return [];
    if (!o.curves || o.cornerAngle <= 0) {
      const cmds = [['M', pts[0][0], pts[0][1]]];
      for (let i = 1; i < n; i++) cmds.push(['L', pts[i][0], pts[i][1]]);
      cmds.push(['Z']);
      return cmds;
    }
    const err = Math.max(o.tolerance, 0.35);
    // Junctions are always corners: that is what keeps a shared run's fit
    // identical on both sides of the boundary.
    const cset = new Set(detectCorners(pts, o.cornerAngle));
    if (fix) for (let i = 0; i < n; i++) if (fix[i]) cset.add(i);
    const corners = [...cset].sort((a, b) => a - b);
    const runs = [];
    if (corners.length < 2) {
      // fully smooth loop: one run from a canonical anchor back to itself
      const s = corners.length ? corners[0] : canonicalStart(pts);
      const run = [];
      for (let i = 0; i <= n; i++) run.push(pts[(s + i) % n]);
      runs.push(run);
    } else {
      for (let k = 0; k < corners.length; k++) {
        const a = corners[k], b = corners[(k + 1) % corners.length];
        const run = [pts[a]];
        for (let i = (a + 1) % n; ; i = (i + 1) % n) {
          run.push(pts[i]);
          if (i === b) break;
        }
        runs.push(run);
      }
    }
    const segs = [];
    for (const run of runs) {
      const m = run.length;
      const closedRun = run[0] === run[m - 1];
      let t1 = norm(run[1][0] - run[0][0], run[1][1] - run[0][1]);
      let t2 = norm(run[m - 2][0] - run[m - 1][0], run[m - 2][1] - run[m - 1][1]);
      if (closedRun && m > 3) { // keep tangent continuity across the seam
        t1 = norm(run[1][0] - run[m - 2][0], run[1][1] - run[m - 2][1]);
        t2 = [-t1[0], -t1[1]];
      }
      fitCubic(run, t1, t2, err, segs, 0);
    }
    if (!segs.length) return [];
    const cmds = [['M', segs[0][0][0], segs[0][0][1]]];
    for (const bz of segs) {
      if (isStraight(bz)) cmds.push(['L', bz[3][0], bz[3][1]]);
      else cmds.push(['C', bz[1][0], bz[1][1], bz[2][0], bz[2][1], bz[3][0], bz[3][1]]);
    }
    cmds.push(['Z']);
    return cmds;
  }

  // ---------- pipeline ----------
  // trace(bitmap, opts) -> {paths, palette, stats}
  // paths are {cmds, fill, rgb, area, colorIndex} in image pixel coordinates,
  // largest area first so background regions paint behind their detail.
  function trace(bmp, opts) {
    const o = options(opts);
    const t0 = Date.now();
    const q = quantize(bmp, o);
    const w = q.w, h = q.h;
    const mergedRegions = denoise(q.idx, w, h, o.minArea);
    const reg = labelRegions(q.idx, w, h);
    const { off, px } = regionPixels(reg);
    const junction = junctionMap(reg.labels, w, h);

    const whiteIdx = new Uint8Array(q.palette.length);
    if (o.ignoreWhite) {
      for (let i = 0; i < q.palette.length; i++) whiteIdx[i] = isWhite(q.palette[i]) ? 1 : 0;
    }

    const paths = [];
    let points = 0, dropped = 0;
    // minArea is enforced by denoise (small regions get absorbed by a
    // neighbour). Anything it could not merge is still emitted — silently
    // skipping it here would punch an unfilled hole in the region around it.
    for (let l = 0; l < reg.count; l++) {
      const ci = reg.color[l];
      if (whiteIdx[ci]) { dropped++; continue; }
      const loops = contours(reg.labels, w, h, l, px, off[l], off[l + 1], junction);
      if (!loops.length) continue;
      // Holes keep the winding the crack walk gave them — opposite the outer
      // loop — so nonzero fill hollows them out with no even-odd flag needed.
      for (const lp of loops) {
        const s = simplifyLoop(lp.pts, lp.fix, o.tolerance);
        lp.pts = s.pts; lp.fix = s.fix;
      }
      // nest on the true geometry, then trap: spreading first would move hole
      // start points and could pick the wrong parent
      const nested = nestLoops(loops);
      for (const lp of loops) lp.pts = spreadLoop(lp.pts, o.spread);
      const cmds = [];
      for (const nest of nested) {
        const outer = fitPath(nest.outer.pts, o, nest.outer.fix);
        if (!outer.length) continue;
        cmds.push(...outer);
        for (const hl of nest.holes) {
          const hc = fitPath(hl.pts, o, hl.fix);
          if (hc.length) cmds.push(...hc);
        }
      }
      if (!cmds.length) continue;
      points += cmds.length;
      const rgb = q.palette[ci];
      paths.push({
        cmds, fill: hexOf(rgb), rgb: rgb.slice(), area: reg.area[l], colorIndex: ci,
      });
    }
    paths.sort((a, b) => b.area - a.area);
    let capped = 0;
    if (paths.length > o.maxPaths) {
      capped = paths.length - o.maxPaths;
      paths.length = o.maxPaths;
    }
    const colors = new Set(paths.map(p => p.colorIndex));
    return {
      paths, palette: q.palette,
      stats: {
        w, h, regions: reg.count, paths: paths.length, points,
        colors: colors.size, mergedRegions, whiteRegions: dropped,
        cappedPaths: capped, ms: Date.now() - t0, exact: !!q.exact,
      },
    };
  }

  // ---------- document integration ----------
  // The placement frame of an image shape is rectPath(x,y,w,h) run through the
  // same transforms as any other object, so its first, second and fourth points
  // give the affine that maps image pixels onto document points.
  function placementMatrix(cmds, iw, ih) {
    const pts = [];
    for (const c of cmds) {
      if (c[0] === 'M' || c[0] === 'L') pts.push([c[1], c[2]]);
      if (pts.length === 4) break;
    }
    if (pts.length < 4 || !(iw > 0) || !(ih > 0)) return [1, 0, 0, 1, 0, 0];
    const p0 = pts[0], p1 = pts[1], p3 = pts[3];
    return [
      (p1[0] - p0[0]) / iw, (p1[1] - p0[1]) / iw,
      (p3[0] - p0[0]) / ih, (p3[1] - p0[1]) / ih,
      p0[0], p0[1],
    ];
  }

  // Traced colors join the same doc.swatches palette pdfimport/pdfio populate:
  // {space,values,rgb,name,uses} with 0..1 components.
  function addSwatches(doc, paths) {
    if (!Array.isArray(doc.swatches)) doc.swatches = [];
    const byHex = new Map();
    for (const s of doc.swatches) {
      if (s.space === 'rgb' && Array.isArray(s.rgb)) byHex.set(hexOf(s.rgb.map(v => v * 255)), s);
    }
    for (const p of paths) {
      const hit = byHex.get(p.fill);
      if (hit) { hit.uses = (hit.uses || 0) + 1; continue; }
      const v = p.rgb.map(c => c / 255);
      const sw = { space: 'rgb', values: v.slice(), rgb: v.slice(), name: null, uses: 1 };
      doc.swatches.push(sw);
      byHex.set(p.fill, sw);
    }
    return doc.swatches;
  }

  // Add traced paths to a document as real editable shapes. Callers wrap this
  // in their history commit so Expand is a single undo step.
  const GROUP_LIMIT = 800; // grouping walks every bbox; skip it for huge traces

  function expandToShapes(doc, result, matrix, o) {
    o = o || {};
    const m = matrix || [1, 0, 0, 1, 0, 0];
    const layer = o.layer || null;
    const made = [];
    result.paths.forEach((p, i) => {
      const s = C.addShape(doc, {
        type: 'path',
        name: (o.name || 'Trace') + ' ' + (i + 1),
        fill: p.fill, stroke: null, opacity: 1,
        cmds: C.transformCmds(p.cmds, m),
      });
      if (layer) s.layer = layer;
      made.push(s);
    });
    addSwatches(doc, result.paths);
    if (made.length > 1 && made.length <= GROUP_LIMIT) {
      C.groupShapes(doc, made.map(s => s.id));
    }
    return made;
  }

  return {
    PRESETS, PRESET_ORDER, DEFAULTS, options,
    luma, hexOf, isWhite,
    quantize, medianCut,
    labelRegions, regionPixels, denoise,
    contours, junctionMap, polyArea, nestLoops, pointInPoly, dropCollinear, spreadLoop,
    rdpOpen, simplifyClosed, simplifyLoop, canonicalStart,
    detectCorners, fitPath, isStraight,
    trace, placementMatrix, addSwatches, expandToShapes,
  };
})();
if (typeof module !== 'undefined') module.exports = VECTRACE;
if (typeof window !== 'undefined') window.VECTRACE = VECTRACE;
