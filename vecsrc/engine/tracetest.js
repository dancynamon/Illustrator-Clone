// tracetest — node tests for trace.js (image trace pipeline), driven off
// synthetic in-memory bitmaps so every stage is checked without a canvas.
const T = require('./trace.js');
const C = require('./veccore.js');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

// ---- bitmap helpers ----
function bitmap(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  const f = fill || [255, 255, 255, 255];
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = f[0]; data[p * 4 + 1] = f[1]; data[p * 4 + 2] = f[2]; data[p * 4 + 3] = f[3];
  }
  return { w, h, data };
}
function put(bmp, x, y, rgba) {
  if (x < 0 || y < 0 || x >= bmp.w || y >= bmp.h) return;
  const q = (y * bmp.w + x) * 4;
  bmp.data[q] = rgba[0]; bmp.data[q + 1] = rgba[1]; bmp.data[q + 2] = rgba[2];
  bmp.data[q + 3] = rgba[3] == null ? 255 : rgba[3];
}
function fillRect(bmp, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(bmp, x, y, rgba);
}
function fillDisc(bmp, cx, cy, r, rgba) {
  for (let y = 0; y < bmp.h; y++) {
    for (let x = 0; x < bmp.w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) put(bmp, x, y, rgba);
    }
  }
}
const BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];
const RED = [220, 30, 30, 255], BLUE = [30, 60, 220, 255], GREEN = [30, 200, 60, 255];

// Rasterize a traced path set back to an index grid so output can be compared
// against the source pixels. Even-odd would be wrong here — nonzero matches
// how canvas/PDF fill, which is what the tracer targets.
function rasterize(paths, w, h) {
  const out = new Int32Array(w * h).fill(-1);
  paths.forEach((p, pi) => {
    const subs = C.flattenPath(p.cmds, 8);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let wn = 0;
        for (const s of subs) wn += windingAt(s.pts, x + 0.5, y + 0.5);
        if (wn !== 0) out[y * w + x] = pi;
      }
    }
  });
  return out;
}
function windingAt(pts, x, y) {
  let wn = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const cross = (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
    if (a[1] <= y) { if (b[1] > y && cross > 0) wn++; }
    else if (b[1] <= y && cross < 0) wn--;
  }
  return wn;
}

// ---- options / presets ----
{
  const o = T.options({ preset: 'pixel' });
  ok(o.mode === 'exact' && o.tolerance === 0 && o.curves === false, 'pixel preset is exact + polygonal');
  const o2 = T.options({ preset: 'pixel', tolerance: 3 });
  ok(o2.tolerance === 3 && o2.mode === 'exact', 'explicit control overrides its preset');
  const o3 = T.options({ colors: 999, threshold: -5, cornerAngle: 900 });
  ok(o3.colors === 256 && o3.threshold === 0 && o3.cornerAngle === 180, 'options clamp');
  ok(T.options({ preset: 'nope' }).mode === 'color', 'unknown preset falls back to defaults');
  ok(T.PRESET_ORDER.every(k => T.PRESETS[k] && T.PRESETS[k].label), 'every listed preset exists and is labelled');
}

// ---- stage 1: quantization ----
{
  // black/white split on luminance
  const b = bitmap(8, 4, WHITE);
  fillRect(b, 0, 0, 4, 4, BLACK);
  const q = T.quantize(b, { mode: 'bw', threshold: 128 });
  ok(q.palette.length === 2, 'bw palette is 2 entries');
  ok(q.idx[0] === 0 && q.idx[7] === 1, 'bw threshold splits dark from light');
  const qLo = T.quantize(b, { mode: 'bw', threshold: 0 });
  ok(qLo.idx[0] === 1, 'bw threshold at 0 makes everything light');
}
{
  // grayscale posterization uses the mean of each bin, so pure black stays black
  const b = bitmap(4, 1, WHITE);
  put(b, 0, 0, BLACK); put(b, 1, 0, [85, 85, 85, 255]); put(b, 2, 0, [170, 170, 170, 255]);
  const q = T.quantize(b, { mode: 'gray', colors: 4 });
  ok(q.palette.length === 4, 'gray palette level count');
  ok(near(q.palette[q.idx[0]][0], 0, 0.51), 'gray keeps black black');
  ok(near(q.palette[q.idx[3]][0], 255, 0.51), 'gray keeps white white');
  ok(q.idx[0] !== q.idx[1] && q.idx[1] !== q.idx[2], 'gray separates 4 tones');
}
{
  // exact mode keeps the source palette verbatim (pixel art)
  const b = bitmap(4, 4, WHITE);
  fillRect(b, 0, 0, 2, 2, RED);
  fillRect(b, 2, 2, 2, 2, BLUE);
  const q = T.quantize(b, { mode: 'exact', colors: 64 });
  ok(q.exact === true && q.palette.length === 3, 'exact mode finds exactly 3 colors');
  const hexes = q.palette.map(T.hexOf).sort();
  ok(hexes.join(',') === ['#ffffff', '#dc1e1e', '#1e3cdc'].sort().join(','), 'exact palette is bit-identical');
  const q2 = T.quantize(b, { mode: 'exact', colors: 2 });
  ok(!q2.exact && q2.palette.length <= 2, 'exact mode falls back to median cut past the cap');
}
{
  // median cut on a 4-colour source must recover 4 distinct colours
  const b = bitmap(20, 20, WHITE);
  fillRect(b, 0, 0, 10, 10, RED);
  fillRect(b, 10, 0, 10, 10, BLUE);
  fillRect(b, 0, 10, 10, 10, GREEN);
  const q = T.quantize(b, { mode: 'color', colors: 4 });
  ok(q.palette.length === 4, 'median cut yields the requested color count');
  const near255 = c => c.filter(v => v > 200).length;
  const found = q.palette.map(T.hexOf);
  ok(new Set(found).size === 4, 'median cut colors are distinct');
  ok(q.palette.some(p => near255(p) === 3), 'median cut recovers white');
  ok(q.idx[0] === q.idx[9] && q.idx[0] !== q.idx[10], 'median cut assigns per-quadrant indices');
}
{
  // transparent pixels are excluded from tracing entirely
  const b = bitmap(4, 4, [0, 0, 0, 0]);
  fillRect(b, 1, 1, 2, 2, RED);
  const q = T.quantize(b, { mode: 'exact', colors: 8 });
  ok(q.idx[0] === -1 && q.idx[5] >= 0, 'alpha below the cut marks pixels untraceable');
}

// ---- stage 2: region labelling ----
{
  const b = bitmap(9, 3, WHITE);
  fillRect(b, 0, 0, 3, 3, BLACK);
  fillRect(b, 6, 0, 3, 3, BLACK);
  const q = T.quantize(b, { mode: 'bw' });
  const reg = T.labelRegions(q.idx, 9, 3);
  ok(reg.count === 3, 'two black squares + one white gap = 3 regions');
  ok(Array.from(reg.area).sort((x, y) => x - y).join(',') === '9,9,9', 'region areas');
  const rp = T.regionPixels(reg);
  ok(rp.px.length === 27 && rp.off[reg.count] === 27, 'regionPixels buckets every pixel once');
}
{
  // 4-connectivity: diagonal touch is NOT one region
  const b = bitmap(2, 2, WHITE);
  put(b, 0, 0, BLACK); put(b, 1, 1, BLACK);
  const q = T.quantize(b, { mode: 'bw' });
  const reg = T.labelRegions(q.idx, 2, 2);
  ok(reg.count === 4, 'diagonal neighbours stay separate regions');
}

// ---- stage 3: noise removal ----
{
  // a solid red field peppered with single blue pixels
  const b = bitmap(20, 20, RED);
  put(b, 3, 3, BLUE); put(b, 11, 7, BLUE); put(b, 15, 16, BLUE);
  const q = T.quantize(b, { mode: 'exact', colors: 8 });
  const before = T.labelRegions(q.idx, 20, 20);
  ok(before.count === 4, 'noise: 3 specks + field before denoise');
  const merged = T.denoise(q.idx, 20, 20, 4);
  const after = T.labelRegions(q.idx, 20, 20);
  ok(merged === 3 && after.count === 1, 'noise: minArea 4 absorbs every speck');
  ok(after.area[0] === 400, 'noise: absorbed pixels take the neighbour color');
  // and the whole path stays clean end to end
  const r = T.trace(b, { mode: 'exact', colors: 8, minArea: 4, tolerance: 0, curves: false });
  ok(r.paths.length === 1, 'noise: trace emits a single path after denoise');
  const r2 = T.trace(b, { mode: 'exact', colors: 8, minArea: 1, tolerance: 0, curves: false });
  ok(r2.paths.length === 4, 'noise: minArea 1 keeps the specks');
}

// ---- stage 4: contour extraction ----
{
  // solid square: one loop, four corners, positive (outer) area
  const b = bitmap(10, 10, WHITE);
  fillRect(b, 2, 2, 5, 5, BLACK);
  const q = T.quantize(b, { mode: 'bw' });
  const reg = T.labelRegions(q.idx, 10, 10);
  const rp = T.regionPixels(reg);
  const dark = [...Array(reg.count).keys()].find(i => reg.color[i] === 0);
  const loops = T.contours(reg.labels, 10, 10, dark, rp.px, rp.off[dark], rp.off[dark + 1]);
  ok(loops.length === 1 && !loops[0].hole, 'square: one outer loop');
  ok(loops[0].pts.length === 4, 'square: contour collapses to 4 corners');
  ok(T.polyArea(loops[0].pts) === 25, 'square: contour area equals pixel area');
  const xs = loops[0].pts.map(p => p[0]).sort();
  ok(xs[0] === 2 && xs[3] === 7, 'square: contour sits on the pixel grid');
}
{
  // donut: outer loop plus a negatively-wound hole, and nesting finds the pair
  const b = bitmap(24, 24, WHITE);
  fillDisc(b, 12, 12, 9, BLACK);
  fillDisc(b, 12, 12, 4, WHITE);
  const q = T.quantize(b, { mode: 'bw' });
  const reg = T.labelRegions(q.idx, 24, 24);
  const rp = T.regionPixels(reg);
  let ring = -1;
  for (let i = 0; i < reg.count; i++) if (reg.color[i] === 0) ring = i;
  const loops = T.contours(reg.labels, 24, 24, ring, rp.px, rp.off[ring], rp.off[ring + 1]);
  ok(loops.length === 2, 'donut: two loops');
  ok(loops.filter(l => l.hole).length === 1, 'donut: exactly one is a hole');
  const outer = loops.find(l => !l.hole), hole = loops.find(l => l.hole);
  ok(T.polyArea(outer.pts) > 0 && T.polyArea(hole.pts) < 0, 'donut: hole is wound against the outer loop');
  const nested = T.nestLoops(loops);
  ok(nested.length === 1 && nested[0].holes.length === 1, 'donut: nesting attaches the hole to its outer');
  // and the hole must actually be empty after fill
  const r = T.trace(b, { mode: 'bw', minArea: 1, tolerance: 0, curves: false, ignoreWhite: true });
  ok(r.paths.length === 1, 'donut: ignoreWhite leaves just the ring');
  const grid = rasterize(r.paths, 24, 24);
  ok(grid[12 * 24 + 12] === -1, 'donut: center stays hollow under nonzero fill');
  ok(grid[12 * 24 + 5] === 0, 'donut: ring body is filled');
}
{
  // pinch point: two pixels touching only at a corner must not fuse into one loop
  const b = bitmap(4, 4, WHITE);
  put(b, 1, 1, BLACK); put(b, 2, 2, BLACK);
  const q = T.quantize(b, { mode: 'bw' });
  const reg = T.labelRegions(q.idx, 4, 4);
  const rp = T.regionPixels(reg);
  let n = 0;
  for (let i = 0; i < reg.count; i++) {
    if (reg.color[i] !== 0) continue;
    n += T.contours(reg.labels, 4, 4, i, rp.px, rp.off[i], rp.off[i + 1]).length;
  }
  ok(n === 2, 'pinch: diagonal pixels produce two separate square loops');
}

// ---- stage 5: simplification ----
{
  const line = [];
  for (let i = 0; i <= 20; i++) line.push([i, 0]);
  ok(T.rdpOpen(line, 0.1).length === 2, 'rdp collapses a straight run to its endpoints');
  const bump = line.slice();
  bump[10] = [10, 6];
  ok(T.rdpOpen(bump, 5).length === 3, 'rdp keeps a deviation above tolerance');
  ok(T.rdpOpen(bump, 8).length === 2, 'rdp drops a deviation below tolerance');
  ok(T.rdpOpen([[0, 0], [1, 1]], 1).length === 2, 'rdp passes 2-point runs through');
}
{
  // a staircase circle simplifies hard but keeps its extent
  const b = bitmap(64, 64, WHITE);
  fillDisc(b, 32, 32, 25, BLACK);
  const q = T.quantize(b, { mode: 'bw' });
  const reg = T.labelRegions(q.idx, 64, 64);
  const rp = T.regionPixels(reg);
  let disc = -1;
  for (let i = 0; i < reg.count; i++) if (reg.color[i] === 0) disc = i;
  const raw = T.contours(reg.labels, 64, 64, disc, rp.px, rp.off[disc], rp.off[disc + 1])[0].pts;
  const s = T.simplifyClosed(raw, 1);
  ok(s.length < raw.length / 2, `circle: rdp cuts ${raw.length} points to ${s.length}`);
  ok(s.length >= 8, 'circle: rdp keeps enough points to stay round');
  const ext = a => [Math.min(...a.map(p => p[0])), Math.max(...a.map(p => p[0]))];
  const e0 = ext(raw), e1 = ext(s);
  ok(Math.abs(e0[0] - e1[0]) <= 1 && Math.abs(e0[1] - e1[1]) <= 1, 'circle: rdp preserves the extent');
  ok(Math.abs(T.polyArea(s) - T.polyArea(raw)) / T.polyArea(raw) < 0.03, 'circle: rdp preserves area within 3%');
}

// ---- stage 6: curve fitting ----
{
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const poly = T.fitPath(square, { curves: false });
  ok(poly.length === 5 && poly[0][0] === 'M' && poly[4][0] === 'Z', 'fitPath polygonal command count');
  ok(poly.every(c => c[0] !== 'C'), 'fitPath polygonal emits no curves');
  const fitted = T.fitPath(square, { curves: true, cornerAngle: 60, tolerance: 1 });
  ok(fitted.filter(c => c[0] === 'C').length === 0, 'fitPath keeps 90-degree corners straight');
  ok(fitted.filter(c => c[0] === 'L').length === 4, 'fitPath emits 4 straight sides for a square');
}
{
  // a sampled circle must come back as curves, and few of them
  const pts = [];
  for (let i = 0; i < 48; i++) {
    const a = i / 48 * Math.PI * 2;
    pts.push([50 + 30 * Math.cos(a), 50 + 30 * Math.sin(a)]);
  }
  const cmds = T.fitPath(pts, { curves: true, cornerAngle: 60, tolerance: 0.4 });
  const cs = cmds.filter(c => c[0] === 'C').length;
  ok(cs > 0 && cs <= 8, `circle fit uses ${cs} cubics (<= 8)`);
  ok(cmds[cmds.length - 1][0] === 'Z', 'fitted path closes');
  // the fitted curve must stay on the circle
  let worst = 0;
  for (const s of C.flattenPath(cmds, 16)) {
    for (const p of s.pts) worst = Math.max(worst, Math.abs(Math.hypot(p[0] - 50, p[1] - 50) - 30));
  }
  ok(worst < 0.6, `circle fit max radial error ${worst.toFixed(3)} < 0.6`);
}
{
  const corners = T.detectCorners([[0, 0], [10, 0], [10, 10], [0, 10]], 60);
  ok(corners.length === 4, 'detectCorners finds all 4 corners of a square at 60deg');
  ok(T.detectCorners([[0, 0], [10, 0], [10, 10], [0, 10]], 120).length === 0,
    'detectCorners ignores 90deg turns above a 120deg threshold');
  ok(T.isStraight([[0, 0], [3, 0], [7, 0], [10, 0]]), 'isStraight detects a degenerate cubic');
  ok(!T.isStraight([[0, 0], [3, 5], [7, 5], [10, 0]]), 'isStraight rejects a real curve');
}

// ---- trapping (spread) ----
{
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const grown = T.spreadLoop(sq, 0.5);
  ok(T.polyArea(grown) > T.polyArea(sq), 'spreadLoop grows an outer loop');
  ok(Math.abs(grown[0][0] + 0.5) < 1e-9 && Math.abs(grown[2][0] - 10.5) < 1e-9,
    'spreadLoop offsets square corners by exactly the spread');
  const hole = sq.slice().reverse();
  const shrunk = T.spreadLoop(hole, 0.5);
  ok(Math.abs(T.polyArea(shrunk)) < Math.abs(T.polyArea(hole)), 'spreadLoop shrinks a hole (more material)');
  ok(T.spreadLoop(sq, 0) === sq, 'spreadLoop with no spread is a no-op');
  // and it must close the hairlines between neighbouring traced regions
  const b = bitmap(60, 60, WHITE);
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x < 60; x++) {
      const v = Math.sin(x / 7) * Math.cos(y / 5);
      put(b, x, y, v > 0.3 ? RED : v < -0.3 ? BLUE : GREEN);
    }
  }
  const uncovered = spread => {
    const r = T.trace(b, { mode: 'color', colors: 3, tolerance: 1, minArea: 3, spread });
    const g = rasterize(r.paths, 60, 60);
    let n = 0;
    for (let i = 0; i < 60 * 60; i++) if (g[i] < 0) n++;
    return n;
  };
  const gap0 = uncovered(0), gap1 = uncovered(0.3);
  ok(gap1 < gap0, `spread closes trace hairlines (${gap0} -> ${gap1} uncovered px)`);
}

// ---- shared boundaries (junction pinning) ----
{
  // two regions either side of a wiggly seam must simplify that seam to the
  // exact same geometry, or every colour boundary in a photo trace leaks white
  const b = bitmap(40, 40, RED);
  for (let x = 0; x < 40; x++) {
    const edge = Math.round(20 + 6 * Math.sin(x / 4));
    for (let y = edge; y < 40; y++) put(b, x, y, BLUE);
  }
  const r = T.trace(b, { mode: 'color', colors: 2, tolerance: 1.5, minArea: 2, spread: 0 });
  ok(r.paths.length === 2, 'seam: two regions');
  const g = rasterize(r.paths, 40, 40);
  let n = 0;
  for (let i = 0; i < 1600; i++) if (g[i] < 0) n++;
  ok(n === 0, `seam: shared boundary leaves no gap at all (${n} uncovered px)`);
  const j = (() => {
    const q = T.quantize(b, { mode: 'color', colors: 2 });
    const reg = T.labelRegions(q.idx, 40, 40);
    return T.junctionMap(reg.labels, 40, 40);
  })();
  ok(j.length === 41 * 41, 'junctionMap covers the whole vertex grid');
  ok(j[0] === 0, 'image corner with one region is not a junction');
}

// ---- full pipeline ----
{
  // two-colour checkerboard: every cell traced, nothing merged
  const b = bitmap(32, 32, WHITE);
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      if ((cx + cy) % 2 === 0) fillRect(b, cx * 8, cy * 8, 8, 8, BLACK);
    }
  }
  const r = T.trace(b, { preset: 'pixel' });
  ok(r.paths.length === 16, 'checkerboard: 16 cells traced');
  ok(r.stats.colors === 2, 'checkerboard: 2 colors');
  ok(r.paths.every(p => p.cmds.length === 5), 'checkerboard: every cell is a 4-point rect');
  const grid = rasterize(r.paths, 32, 32);
  let wrong = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const src = ((x / 8 | 0) + (y / 8 | 0)) % 2 === 0 ? '#000000' : '#ffffff';
      const got = grid[y * 32 + x] < 0 ? null : r.paths[grid[y * 32 + x]].fill;
      if (got !== src) wrong++;
    }
  }
  ok(wrong === 0, `checkerboard: pixel-exact round trip (${wrong} mismatches)`);
}
{
  // pixel art: a 3-colour sprite must round-trip pixel-exact with crisp edges
  const b = bitmap(16, 16, [0, 0, 0, 0]);
  const sprite = [
    '................',
    '.....RRRRRR.....',
    '....RRRRRRRR....',
    '....RRWWRRWW....',
    '....RRWWRRWW....',
    '....RRRRRRRR....',
    '....RRBBBBRR....',
    '.....RRBBRR.....',
    '......RRRR......',
    '.....BBBBBB.....',
    '....BBBBBBBB....',
    '....BB.BB.BB....',
    '....BB.BB.BB....',
    '.......BB.......',
    '......BBBB......',
    '................',
  ];
  const COL = { R: RED, W: WHITE, B: BLUE };
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = sprite[y][x];
      if (COL[ch]) put(b, x, y, COL[ch]);
    }
  }
  const r = T.trace(b, { preset: 'pixel' });
  ok(r.stats.exact === true, 'sprite: exact palette used');
  ok(r.paths.every(p => p.cmds.every(c => c[0] !== 'C')), 'sprite: no curves, edges stay axis-aligned');
  const allX = r.paths.flatMap(p => p.cmds.filter(c => c.length > 1).map(c => c[1]));
  ok(allX.every(v => v === Math.round(v)), 'sprite: every vertex lands on an integer pixel boundary');
  const grid = rasterize(r.paths, 16, 16);
  let wrong = 0;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const ch = sprite[y][x];
      const want = COL[ch] ? T.hexOf(COL[ch].slice(0, 3)) : null;
      const gi = grid[y * 16 + x];
      const got = gi < 0 ? null : r.paths[gi].fill;
      if (got !== want) wrong++;
    }
  }
  ok(wrong === 0, `sprite: 16x16 pixel-art round trip is exact (${wrong} mismatches)`);
  ok(r.paths.some(p => p.fill === '#ffffff'), 'sprite: white eyes survive (ignoreWhite off)');
}
{
  // ignoreWhite drops the paper, keeps the ink
  const b = bitmap(20, 20, WHITE);
  fillRect(b, 4, 4, 12, 12, BLACK);
  const on = T.trace(b, { mode: 'bw', ignoreWhite: true, minArea: 1, tolerance: 0, curves: false });
  const off = T.trace(b, { mode: 'bw', ignoreWhite: false, minArea: 1, tolerance: 0, curves: false });
  ok(on.paths.length === 1 && on.paths[0].fill === '#000000', 'ignoreWhite keeps only the dark region');
  ok(off.paths.length === 2, 'ignoreWhite off keeps the background too');
  ok(off.paths[0].area > off.paths[1].area, 'paths sort largest-first for sane z-order');
}
{
  // a traced disc should be smooth, closed, and land on the source geometry
  const b = bitmap(80, 80, WHITE);
  fillDisc(b, 40, 40, 30, RED);
  const r = T.trace(b, { mode: 'exact', colors: 8, tolerance: 1, cornerAngle: 60, minArea: 4, ignoreWhite: true });
  ok(r.paths.length === 1, 'disc: single traced path');
  ok(r.paths[0].cmds.filter(c => c[0] === 'C').length > 0, 'disc: fitted with curves');
  ok(r.paths[0].cmds.length < 24, `disc: compact path (${r.paths[0].cmds.length} commands)`);
  const bb = C.tightBBox(r.paths[0].cmds);
  ok(Math.abs(bb.x - 10) <= 1.5 && Math.abs(bb.w - 60) <= 2.5, `disc: bbox tracks the source (${bb.x.toFixed(1)},${bb.w.toFixed(1)})`);
  let worst = 0;
  for (const s of C.flattenPath(r.paths[0].cmds, 16)) {
    for (const p of s.pts) worst = Math.max(worst, Math.abs(Math.hypot(p[0] - 40, p[1] - 40) - 30));
  }
  ok(worst < 2, `disc: max radial deviation ${worst.toFixed(2)}px < 2`);
}
{
  // grayscale gradient: posterizes into bands, no exploding path count
  const b = bitmap(64, 64, WHITE);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const v = Math.round(x / 63 * 255);
      put(b, x, y, [v, v, v, 255]);
    }
  }
  const r = T.trace(b, { preset: 'gray', colors: 6, minArea: 8 });
  ok(r.paths.length === 6, 'gradient: 6 grey bands');
  ok(r.stats.colors === 6, 'gradient: 6 distinct colors');
  const dark = r.paths.find(p => p.rgb[0] < 40);
  ok(dark && C.tightBBox(dark.cmds).x < 2, 'gradient: darkest band is on the left');
}
{
  // empty / degenerate inputs must not throw
  ok(T.trace(bitmap(1, 1, [0, 0, 0, 0]), {}).paths.length === 0, 'fully transparent bitmap traces to nothing');
  ok(T.trace(bitmap(4, 4, WHITE), { ignoreWhite: true }).paths.length === 0, 'all-white with ignoreWhite traces to nothing');
  ok(T.fitPath([[0, 0], [1, 1]], {}).length === 0, 'fitPath rejects sub-triangle input');
  ok(T.trace(bitmap(3, 3, RED), { maxPaths: 1 }).stats.cappedPaths === 0, 'maxPaths reports what it dropped');
}

// ---- document integration ----
{
  const b = bitmap(16, 16, WHITE);
  fillRect(b, 2, 2, 6, 6, RED);
  fillRect(b, 9, 9, 5, 5, BLUE);
  const r = T.trace(b, { mode: 'exact', colors: 8, minArea: 1, tolerance: 0, curves: false, ignoreWhite: true, spread: 0 });
  const doc = C.newDoc({ w: 4, h: 4, units: 'in' });
  // a new doc now ships with the default process swatches, so count from there
  const swBefore = doc.swatches.length;
  // image placed at 0,0 sized 288x288pt -> 18pt per source pixel
  const frame = C.rectPath(0, 0, 288, 288);
  const m = T.placementMatrix(frame, 16, 16);
  ok(near(m[0], 18) && near(m[3], 18) && near(m[4], 0), 'placementMatrix scales pixels to points');
  const shapes = T.expandToShapes(doc, r, m, { name: 'Sprite' });
  ok(shapes.length === r.paths.length && doc.shapes.length === shapes.length, 'expandToShapes adds every path');
  ok(shapes.every(s => s.id && s.layer === 'L1' && s.type === 'path'), 'expanded shapes are real veccore shapes');
  const bb = C.tightBBox(shapes.find(s => s.fill === '#dc1e1e').cmds);
  ok(near(bb.x, 36) && near(bb.w, 108), 'expanded geometry lands in document points');
  ok(doc.swatches.length === swBefore + 2 && doc.swatches.slice(swBefore).every(s => s.space === 'rgb'), 'traced colors join doc.swatches');
  ok(doc.swatches.every(s => s.rgb.every(v => v >= 0 && v <= 1)), 'swatch components are 0..1 like pdfio writes');
  ok(shapes[0].group && shapes[0].group === shapes[1].group, 'expanded paths land in one group');
  // and it all survives a serialize/parse round trip (undo/redo path)
  const d2 = C.parseDoc(C.serializeDoc(doc));
  ok(d2.shapes.length === doc.shapes.length, 'expanded doc round-trips through history serialization');
}
{
  // a rotated/flipped placement frame still maps pixels correctly
  const frame = C.transformCmds(C.rectPath(0, 0, 100, 50), C.mRotate(Math.PI / 2, 0, 0));
  const m = T.placementMatrix(frame, 10, 5);
  const p = C.mApply(m, 10, 5); // image bottom-right corner
  const q = C.mApply(C.mRotate(Math.PI / 2, 0, 0), 100, 50);
  ok(near(p[0], q[0], 1e-9) && near(p[1], q[1], 1e-9), 'placementMatrix follows a rotated frame');
  ok(T.placementMatrix([['M', 0, 0]], 10, 10).join() === '1,0,0,1,0,0', 'placementMatrix falls back to identity');
}

// ---- image shapes in the document model ----
{
  const doc = C.newDoc();
  const img = C.addShape(doc, {
    type: 'image', name: 'photo.png', src: 'data:image/png;base64,AAAA', iw: 40, ih: 20,
    cmds: C.rectPath(10, 10, 200, 100),
  });
  const d2 = C.parseDoc(C.serializeDoc(doc));
  ok(d2.shapes[0].type === 'image', 'parseDoc preserves placed-image shapes');
  ok(d2.shapes[0].src === img.src && d2.shapes[0].iw === 40, 'parseDoc keeps the image payload');
  ok(C.hitTestShape(d2.shapes[0], 100, 50), 'placed images hit-test as solid');
  ok(!C.hitTestShape(d2.shapes[0], 5, 5), 'placed images do not hit outside their frame');
  const bad = JSON.stringify({
    app: 'aq-vector-studio', version: 1,
    doc: {
      artboard: { w: 100, h: 100 }, layers: [{ id: 'L1' }],
      shapes: [{ type: 'image', layer: 'L1', cmds: C.rectPath(0, 0, 10, 10) }],
    },
  });
  let threw = false;
  try { C.parseDoc(bad); } catch (e) { threw = true; }
  ok(threw, 'parseDoc rejects an image shape with no source');
}

// ---- performance ----
{
  // the stated budget: a 1000x1000 source traces in seconds, not minutes
  const N = 1000;
  const b = bitmap(N, N, WHITE);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = Math.sin(x / 60) * Math.cos(y / 45);
      put(b, x, y, v > 0.3 ? RED : v < -0.3 ? BLUE : [200, 200, 40, 255]);
    }
  }
  const t0 = Date.now();
  const r = T.trace(b, { preset: 'color6' });
  const ms = Date.now() - t0;
  ok(ms < 8000, `1000x1000 color6 trace in ${ms}ms (< 8000)`);
  ok(r.paths.length > 0 && r.stats.points > 0, '1000x1000 trace produced geometry');
}

console.log(`tracetest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
