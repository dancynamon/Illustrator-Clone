// studio_app — UI wiring for Aquamentor Vector Studio.
// Thin layer over VECCORE: canvas rendering, pan/zoom, tool state, panels.
(() => {
  'use strict';
  const C = window.VECCORE;
  const TR = window.VECTRACE;
  const $ = s => document.querySelector(s);

  const stagewrap = $('#stagewrap');
  const canvas = $('#stage');
  const ctx = canvas.getContext('2d');

  const TOOLS = {
    select: 'Selection', direct: 'Direct Selection', pen: 'Pen',
    rect: 'Rectangle', ellipse: 'Ellipse', hand: 'Hand', zoom: 'Zoom',
  };
  const TOOL_KEYS = { v: 'select', a: 'direct', p: 'pen', m: 'rect', l: 'ellipse', h: 'hand', z: 'zoom' };

  const AUTOSAVE_KEY = 'aqvec_autosave';

  function loadAutosave() {
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      return s ? C.parseDoc(s) : null;
    } catch (e) { return null; }
  }

  const state = {
    doc: loadAutosave() || C.demoDoc(),
    history: null,       // set at boot
    view: C.newView(),
    tool: 'select',
    space: false,        // spacebar temporary hand
    pan: null,           // {sx,sy,view0} while dragging
    drag: null,          // select-tool drag state machine
    sel: new Set(),      // selected shape ids (always group-expanded)
    autoFit: true,       // keep fitting on resize until the user changes the view
    trace: {             // Image Trace panel controls + last preview result
      preset: 'color6', colors: 6, threshold: 128, tolerance: 1,
      corners: 70, noise: 5, ignoreWhite: false, preview: true,
      result: null,      // {shapeId, r, bw, bh} — paths in traced-bitmap pixels
      note: '', lastId: null, timer: 0,
    },
  };
  state.history = C.newHistory(state.doc);

  // ---------- selection helpers ----------
  function commitNow() {
    if (C.commit(state.history, state.doc)) scheduleAutosave();
  }
  function setSel(ids) {
    state.sel = new Set(C.expandIds(state.doc, ids));
  }
  function selShapes() {
    return state.doc.shapes.filter(s => state.sel.has(s.id));
  }
  function selectableLayers() {
    return new Set(state.doc.layers.filter(l => l.visible && !l.locked).map(l => l.id));
  }
  function worldPt(e) {
    const r = canvas.getBoundingClientRect();
    return C.s2w(state.view, e.clientX - r.left, e.clientY - r.top);
  }
  function screenPt(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function hitAt(wx, wy) {
    const ok = selectableLayers();
    const tol = 3 / state.view.scale;
    for (let i = state.doc.shapes.length - 1; i >= 0; i--) {
      const s = state.doc.shapes[i];
      if (!ok.has(s.layer)) continue;
      if (C.hitTestShape(s, wx, wy, tol)) return s;
    }
    return null;
  }

  // bbox handle geometry (screen space)
  const HANDLE_FRAC = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] };
  const HANDLE_CURSOR = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };
  function handlePoints(b) {
    const v = state.view;
    return Object.entries(HANDLE_FRAC).map(([c, f]) => {
      const p = C.w2s(v, b.x + f[0] * b.w, b.y + f[1] * b.h);
      return { c, x: p[0], y: p[1] };
    });
  }
  function hitHandle(sx, sy) {
    if (!state.sel.size) return null;
    const b = C.shapesBBox(selShapes());
    if (!b) return null;
    const pts = handlePoints(b);
    for (const h of pts) {
      if (Math.abs(sx - h.x) <= 5 && Math.abs(sy - h.y) <= 5) return { type: 'scale', c: h.c, bbox: b };
    }
    for (const h of pts) {
      if (h.c.length !== 2) continue; // corners only
      const d = Math.hypot(sx - h.x, sy - h.y);
      if (d > 5 && d <= 18) return { type: 'rotate', bbox: b };
    }
    return null;
  }

  function applyDragMatrix(m) {
    const byId = new Map(state.doc.shapes.map(s => [s.id, s]));
    for (const [id, cmds] of state.drag.orig) {
      const s = byId.get(id);
      if (s) s.cmds = C.transformCmds(cmds, m);
    }
  }
  function snapshotSel() {
    return new Map(selShapes().map(s => [s.id, JSON.parse(JSON.stringify(s.cmds))]));
  }

  // ---------- document lifecycle ----------
  let autosaveTimer = 0;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, C.serializeDoc(state.doc)); } catch (e) { /* quota */ }
    }, 400);
  }

  // Route every doc mutation through here: history + autosave + repaint.
  function mutate(fn) {
    fn(state.doc);
    if (C.commit(state.history, state.doc)) scheduleAutosave();
    renderLayers();
    render();
  }

  function refreshDoc() {
    // drop selection ids that no longer exist in the current doc
    const alive = new Set(state.doc.shapes.map(s => s.id));
    state.sel = new Set([...state.sel].filter(id => alive.has(id)));
    renderLayers();
    render();
  }

  function doUndo() {
    const d = C.undo(state.history);
    if (d) { state.doc = d; scheduleAutosave(); refreshDoc(); }
  }
  function doRedo() {
    const d = C.redo(state.history);
    if (d) { state.doc = d; scheduleAutosave(); refreshDoc(); }
  }

  // New/Open replace the doc and reset history.
  function applyNewDoc(doc) {
    state.doc = doc;
    state.history = C.newHistory(doc);
    state.sel.clear();
    state.autoFit = true;
    scheduleAutosave();
    fitArtboard();
    refreshDoc();
  }

  function newFile() {
    if (state.doc.shapes.length && !window.confirm('Replace the current document with a new one?')) return;
    applyNewDoc(C.newDoc());
  }

  function saveFile() {
    const blob = new Blob([C.serializeDoc(state.doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.doc.name || 'Untitled') + '.aqv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.aqv,.json,.pdf,.ai,.png,.jpg,.jpeg,.gif,.webp,application/json,application/pdf,image/*';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (f) openAnyFile(f);
  });
  function openFile() { fileInput.click(); }

  function openAqvFile(f) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const doc = C.parseDoc(rd.result);
        doc.name = f.name.replace(/\.(aqv|json)$/i, '');
        applyNewDoc(doc);
      } catch (err) {
        window.alert('Could not open "' + f.name + '": ' + err.message);
      }
    };
    rd.readAsText(f);
  }

  function importPdfFile(f) {
    f.arrayBuffer()
      .then(buf => PDFIO.docFromPDF(new Uint8Array(buf), f.name))
      .then(res => {
        applyNewDoc(res.doc);
        if (res.pageCount > 1) {
          window.alert(f.name + ' has ' + res.pageCount +
            ' pages; imported page 1 (one artboard per document).');
        }
      })
      .catch(err => window.alert('Could not import "' + f.name + '": ' + err.message));
  }

  function openAnyFile(f) {
    if (/\.(pdf|ai)$/i.test(f.name) || f.type === 'application/pdf') importPdfFile(f);
    else if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name) || /^image\//.test(f.type)) placeImageFile(f);
    else openAqvFile(f);
  }

  // drag & drop anywhere: .aqv/.json projects, .pdf/.ai vector imports, rasters
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /\.(aqv|json|pdf|ai|png|jpe?g|gif|webp|bmp)$/i.test(f.name)) openAnyFile(f);
  });

  function exportPdfFile() {
    try {
      const bytes = PDFIO.exportDocPDF(state.doc);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.doc.name || 'Untitled') + '.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      window.alert('Export failed: ' + err.message);
    }
  }

  // ---------- placed images ----------
  // A placed raster is an ordinary shape whose cmds are its placement frame,
  // so move/scale/rotate/z-order/undo all work on it with no special cases.
  // The pixels live on the shape as a data URL; decoded <img>s are cached here.
  const MAX_PLACED = 2000;  // stored longest edge — keeps history snapshots sane
  const imgCache = new Map();

  function imageFor(src) {
    let im = imgCache.get(src);
    if (!im) {
      im = new Image();
      im.addEventListener('load', () => { render(); scheduleTrace(); });
      im.src = src;
      imgCache.set(src, im);
    }
    return im;
  }

  const imgInput = document.createElement('input');
  imgInput.type = 'file';
  imgInput.accept = 'image/png,image/jpeg,image/gif,image/webp,image/*';
  imgInput.addEventListener('change', () => {
    const f = imgInput.files[0];
    imgInput.value = '';
    if (f) placeImageFile(f);
  });
  function placeImage() { imgInput.click(); }

  function placeImageFile(f) {
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        const iw = im.naturalWidth, ih = im.naturalHeight;
        const k = Math.min(1, MAX_PLACED / Math.max(iw, ih));
        const name = f.name.replace(/\.[a-z0-9]+$/i, '');
        if (k >= 1) { addPlacedImage(name, rd.result, iw, ih); return; }
        // oversized source: store a downscaled copy so undo snapshots stay light
        const w = Math.round(iw * k), h = Math.round(ih * k);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(im, 0, 0, w, h);
        const type = /jpe?g$/i.test(f.name) ? 'image/jpeg' : 'image/png';
        addPlacedImage(name, cv.toDataURL(type, 0.92), w, h);
      };
      im.onerror = () => window.alert('Could not read "' + f.name + '" as an image.');
      im.src = rd.result;
    };
    rd.readAsDataURL(f);
  }

  // Place at 1 source pixel = 1 pt, centered. Oversized art shrinks to fit the
  // artboard; sprite-sized art scales up so it is big enough to work on.
  function addPlacedImage(name, src, iw, ih) {
    const ab = state.doc.artboard;
    const fit = Math.min(ab.w * 0.9 / iw, ab.h * 0.9 / ih);
    const k = fit < 1 ? fit : Math.max(1, Math.min(ab.w * 0.6 / iw, ab.h * 0.6 / ih));
    const w = iw * k, h = ih * k;
    let shape = null;
    mutate(d => {
      shape = C.addShape(d, {
        type: 'image', name: name || 'Image', src, iw, ih,
        fill: null, stroke: null, opacity: 1,
        cmds: C.rectPath((ab.w - w) / 2, (ab.h - h) / 2, w, h),
      });
    });
    setTool('select');
    setSel([shape.id]);
    render();
  }

  function drawImageShape(s, worldScale) {
    const im = imageFor(s.src);
    if (!im.complete || !im.naturalWidth) return;
    const m = TR.placementMatrix(s.cmds, s.iw, s.ih);
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    // magnified rasters go nearest-neighbour so pixel art stays pixel art
    ctx.imageSmoothingEnabled = Math.hypot(m[0], m[1]) * worldScale < 2;
    ctx.drawImage(im, 0, 0, s.iw, s.ih);
    ctx.restore();
  }

  // ---------- rendering ----------
  let dpr = 1, vw = 0, vh = 0;

  function resize() {
    const r = stagewrap.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    vw = r.width; vh = r.height;
    if (vw < 10 || vh < 10) return; // pane not laid out yet — wait for a real size
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    if (state.autoFit) fitArtboard();
    render();
  }

  function fitArtboard() {
    const ab = state.doc.artboard;
    state.view = C.fitRect(vw, vh, 0, 0, ab.w, ab.h, 48);
  }

  function drawPath(cmds) {
    ctx.beginPath();
    for (const c of cmds) {
      if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
      else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
      else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else if (c[0] === 'Z') ctx.closePath();
    }
  }

  function render() {
    const v = state.view, ab = state.doc.artboard;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--canvas') || '#1b1b1b';
    ctx.fillRect(0, 0, vw, vh);

    // artboard (screen space, so the shadow stays crisp at any zoom)
    const [ax, ay] = C.w2s(v, 0, 0);
    const aw = ab.w * v.scale, ah = ab.h * v.scale;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ax, ay, aw, ah);
    ctx.restore();

    // shapes (world space; strokes are world-width so they scale with zoom)
    ctx.save();
    ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip(); // clip to artboard like Ai preview
    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
    const hidden = new Set(state.doc.layers.filter(l => !l.visible).map(l => l.id));
    for (const s of state.doc.shapes) {
      if (hidden.has(s.layer)) continue;
      ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
      if (s.type === 'image') { drawImageShape(s, v.scale); continue; }
      drawPath(s.cmds);
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke) { ctx.strokeStyle = s.stroke.color; ctx.lineWidth = s.stroke.w; ctx.stroke(); }
    }
    drawTracePreview();
    ctx.restore();

    // artboard outline on top
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(ax + .5, ay + .5, aw, ah);

    drawSelectionOverlay();
    updateReadouts();
  }

  function drawSelectionOverlay() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.sel.size) {
      const b = C.shapesBBox(selShapes());
      if (b) {
        const p0 = C.w2s(state.view, b.x, b.y);
        const p1 = C.w2s(state.view, b.x + b.w, b.y + b.h);
        const units = C.selectionUnits(state.doc, [...state.sel]);
        if (units.length > 1) {
          ctx.strokeStyle = 'rgba(58,142,230,.45)';
          ctx.lineWidth = 1;
          for (const u of units) {
            const q0 = C.w2s(state.view, u.bbox.x, u.bbox.y);
            const q1 = C.w2s(state.view, u.bbox.x + u.bbox.w, u.bbox.y + u.bbox.h);
            ctx.strokeRect(q0[0] + .5, q0[1] + .5, q1[0] - q0[0], q1[1] - q0[1]);
          }
        }
        ctx.strokeStyle = '#3a8ee6';
        ctx.lineWidth = 1;
        ctx.strokeRect(p0[0] + .5, p0[1] + .5, p1[0] - p0[0], p1[1] - p0[1]);
        ctx.fillStyle = '#fff';
        for (const h of handlePoints(b)) {
          ctx.fillRect(h.x - 3.5, h.y - 3.5, 7, 7);
          ctx.strokeRect(h.x - 3 + .5, h.y - 3 + .5, 6, 6);
        }
      }
    }
    const d = state.drag;
    if (d && d.kind === 'marquee' && d.moved) {
      ctx.strokeStyle = '#3a8ee6';
      ctx.fillStyle = 'rgba(58,142,230,.08)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      const x = Math.min(d.m0[0], d.m1[0]), y = Math.min(d.m0[1], d.m1[1]);
      const w = Math.abs(d.m1[0] - d.m0[0]), hh = Math.abs(d.m1[1] - d.m0[1]);
      ctx.fillRect(x, y, w, hh);
      ctx.strokeRect(x + .5, y + .5, w, hh);
      ctx.setLineDash([]);
    }
  }

  // ---------- panels / readouts ----------
  function updateReadouts() {
    const ab = state.doc.artboard, k = C.PT_PER[state.doc.units];
    $('#p-name').textContent = state.doc.name || 'Untitled';
    $('#p-artboard').textContent = `${+(ab.w / k).toFixed(2)} × ${+(ab.h / k).toFixed(2)} ${state.doc.units}`;
    const z = Math.round(C.zoomPct(state.view)) + '%';
    $('#p-zoom').textContent = z;
    $('#s-zoom').textContent = z;
    $('#p-tool').textContent = TOOLS[state.tool];
    $('#s-tool').textContent = TOOLS[state.tool];
    // selection readout + align button state
    const selEl = $('#p-sel');
    if (state.sel.size) {
      const b = C.shapesBBox(selShapes());
      selEl.textContent = b
        ? `${state.sel.size} obj · ${+(b.w / k).toFixed(2)} × ${+(b.h / k).toFixed(2)} ${state.doc.units}`
        : `${state.sel.size} obj`;
    } else {
      selEl.textContent = '—';
    }
    const units = selUnitCount();
    document.querySelectorAll('.alignrow button[data-align]').forEach(btn => {
      const dist = btn.dataset.align === 'hdist' || btn.dataset.align === 'vdist';
      btn.disabled = dist ? units < 3 : units < 2;
    });
    syncTracePanel();
  }

  function renderLayers() {
    const ul = $('#layerlist');
    ul.innerHTML = '';
    for (const l of state.doc.layers) {
      const li = document.createElement('li');
      const eye = document.createElement('span');
      eye.className = 'eye' + (l.visible ? ' on' : '');
      eye.textContent = l.visible ? '◉' : '○';
      eye.title = 'Toggle visibility';
      eye.addEventListener('click', () => mutate(d => {
        const dl = d.layers.find(x => x.id === l.id);
        if (dl) dl.visible = !dl.visible;
      }));
      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = l.name;
      li.append(eye, name);
      ul.appendChild(li);
    }
  }

  // ---------- image trace ----------
  // All the algorithms live in VECTRACE (pure, no DOM). This layer only turns
  // the selected placed image into an RGBA bitmap, maps the sliders onto trace
  // options, paints the preview, and routes Expand through mutate() so it is
  // one undo step.
  const PREVIEW_MAX = 420;   // trace this small while dragging sliders
  const EXPAND_MAX = 2000;
  const tr = state.trace;

  // Corners slider reads like Illustrator's: 100 = keep every hard corner.
  function cornerAngleOf(v) { return 165 - v * 1.5; }
  function cornerSliderOf(deg) { return Math.round((165 - deg) / 1.5); }

  function traceOpts() {
    return {
      preset: tr.preset, colors: tr.colors, threshold: tr.threshold,
      tolerance: tr.tolerance, cornerAngle: cornerAngleOf(tr.corners),
      minArea: tr.noise, ignoreWhite: tr.ignoreWhite,
    };
  }

  function selectedImage() {
    if (state.sel.size !== 1) return null;
    const s = state.doc.shapes.find(x => state.sel.has(x.id));
    return s && s.type === 'image' ? s : null;
  }

  // Decoded pixels for a placed image, capped to maxDim on the long edge.
  function bitmapOf(s, maxDim) {
    const im = imageFor(s.src);
    if (!im.complete || !im.naturalWidth) return null;
    const k = Math.min(1, maxDim / Math.max(s.iw, s.ih));
    const w = Math.max(1, Math.round(s.iw * k)), h = Math.max(1, Math.round(s.ih * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    c2.imageSmoothingEnabled = k < 1; // never resample at 1:1 — pixel art must stay sharp
    c2.drawImage(im, 0, 0, w, h);
    return { w, h, data: c2.getImageData(0, 0, w, h).data };
  }

  function scheduleTrace() {
    clearTimeout(tr.timer);
    tr.timer = setTimeout(runTracePreview, 160);
  }

  function runTracePreview() {
    const s = selectedImage();
    tr.result = null;
    if (!s || !tr.preview) { updateTraceStat(); render(); return; }
    const bmp = bitmapOf(s, PREVIEW_MAX);
    if (!bmp) return; // still decoding — the image load handler reschedules
    const r = TR.trace(bmp, traceOpts());
    tr.result = { shapeId: s.id, r, bw: bmp.w, bh: bmp.h };
    updateTraceStat();
    render();
  }

  // Preview paints the traced result over its image, in world space.
  function drawTracePreview() {
    const p = tr.result;
    if (!p) return;
    const s = state.doc.shapes.find(x => x.id === p.shapeId);
    if (!s || s.type !== 'image') return;
    const layer = state.doc.layers.find(l => l.id === s.layer);
    if (layer && !layer.visible) return;
    const m = TR.placementMatrix(s.cmds, p.bw, p.bh);
    ctx.save();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha = 1;
    for (const path of p.r.paths) {
      drawPath(path.cmds);
      ctx.fillStyle = path.fill;
      ctx.fill();
    }
    ctx.restore();
  }

  function expandTrace() {
    const s = selectedImage();
    if (!s) return;
    const bmp = bitmapOf(s, EXPAND_MAX);
    if (!bmp) return;
    const r = TR.trace(bmp, traceOpts());
    if (!r.paths.length) {
      window.alert('Trace produced no paths. Try more colors, a lower threshold, or turning off Ignore White.');
      updateTraceStat();
      return;
    }
    const m = TR.placementMatrix(s.cmds, bmp.w, bmp.h);
    let ids = [];
    mutate(d => {
      const img = d.shapes.find(x => x.id === s.id);
      const made = TR.expandToShapes(d, r, m, { name: s.name || 'Trace', layer: img ? img.layer : null });
      ids = made.map(x => x.id);
      d.shapes = d.shapes.filter(x => x.id !== s.id);
    });
    tr.result = null;
    tr.note = `Expanded ${r.paths.length} paths · ${r.stats.colors} colors · ${r.stats.ms}ms`;
    setSel(ids);
    render();
  }

  function setTraceStat(msg) { $('#tr-stat').textContent = msg; }

  function updateTraceStat() {
    const s = selectedImage();
    if (!s) {
      // the last Expand summary sticks until another image comes into play
      setTraceStat(tr.note
        || (state.sel.size ? 'Select a single placed image to trace.' : 'Place an image to trace it.'));
      return;
    }
    tr.note = '';
    if (!tr.preview) { setTraceStat(`${s.iw}×${s.ih}px · preview off`); return; }
    const p = tr.result;
    if (!p) { setTraceStat(`${s.iw}×${s.ih}px · tracing…`); return; }
    const st = p.r.stats;
    setTraceStat(`${st.paths} paths · ${st.colors} colors · ${st.points} pts · ${st.ms}ms`
      + (st.cappedPaths ? ` (${st.cappedPaths} smallest dropped)` : ''));
  }

  // Panel <-> state. Preset selection resets the sliders to that preset.
  function applyPreset(key) {
    const p = TR.PRESETS[key];
    if (!p) return;
    const o = TR.options({ preset: key });
    tr.preset = key;
    tr.colors = o.colors;
    tr.threshold = o.threshold;
    tr.tolerance = o.tolerance;
    tr.corners = cornerSliderOf(o.cornerAngle);
    tr.noise = Math.max(1, o.minArea);
    tr.ignoreWhite = o.ignoreWhite;
    writeTraceInputs();
  }

  function writeTraceInputs() {
    $('#tr-preset').value = tr.preset;
    $('#tr-colors').value = tr.colors;
    $('#tr-colors-v').textContent = tr.colors;
    $('#tr-threshold').value = tr.threshold;
    $('#tr-threshold-v').textContent = tr.threshold;
    $('#tr-tolerance').value = tr.tolerance;
    $('#tr-tolerance-v').textContent = tr.tolerance.toFixed(1);
    $('#tr-corners').value = tr.corners;
    $('#tr-corners-v').textContent = tr.corners;
    $('#tr-noise').value = tr.noise;
    $('#tr-noise-v').textContent = tr.noise;
    $('#tr-ignorewhite').checked = tr.ignoreWhite;
    $('#tr-preview').checked = tr.preview;
    const mode = TR.options({ preset: tr.preset }).mode;
    $('#tr-row-threshold').style.display = mode === 'bw' ? '' : 'none';
    $('#tr-row-colors').style.display = mode === 'bw' ? 'none' : '';
  }

  // Called from every repaint: keeps the panel in step with the selection and
  // kicks a fresh preview when the selected image changes.
  function syncTracePanel() {
    const s = selectedImage();
    const id = s ? s.id : null;
    $('#panel-trace').classList.toggle('off', !s);
    $('#tr-expand').disabled = !s;
    document.querySelectorAll('#panel-trace input, #panel-trace select').forEach(el => {
      if (el.id !== 'tr-preview') el.disabled = !s;
    });
    if (id !== tr.lastId) {
      tr.lastId = id;
      tr.result = null;
      updateTraceStat();
      scheduleTrace();
    }
  }

  function bindTrace() {
    const sel = $('#tr-preset');
    for (const key of TR.PRESET_ORDER) {
      const op = document.createElement('option');
      op.value = key;
      op.textContent = TR.PRESETS[key].label;
      sel.appendChild(op);
    }
    sel.addEventListener('change', () => { applyPreset(sel.value); scheduleTrace(); });
    const slider = (id, key, fmt) => $(id).addEventListener('input', e => {
      tr[key] = +e.target.value;
      $(id + '-v').textContent = fmt ? fmt(tr[key]) : tr[key];
      scheduleTrace();
    });
    slider('#tr-colors', 'colors');
    slider('#tr-threshold', 'threshold');
    slider('#tr-tolerance', 'tolerance', v => v.toFixed(1));
    slider('#tr-corners', 'corners');
    slider('#tr-noise', 'noise');
    $('#tr-ignorewhite').addEventListener('change', e => { tr.ignoreWhite = e.target.checked; scheduleTrace(); });
    $('#tr-preview').addEventListener('change', e => { tr.preview = e.target.checked; scheduleTrace(); });
    $('#tr-place').addEventListener('click', placeImage);
    $('#tr-expand').addEventListener('click', expandTrace);
    applyPreset(tr.preset);
  }

  // ---------- menus ----------
  const MENUS = {
    file: [
      { label: 'New', run: newFile },
      { label: 'Open…', kbd: '⌘O', run: openFile },
      { label: 'Place Image…', run: placeImage },
      { label: 'Save', kbd: '⌘S', run: saveFile },
      { label: 'Export PDF', kbd: '⌘E', run: exportPdfFile, enabled: () => state.doc.shapes.length > 0 },
    ],
    edit: [
      { label: 'Undo', kbd: '⌘Z', run: doUndo, enabled: () => C.canUndo(state.history) },
      { label: 'Redo', kbd: '⇧⌘Z', run: doRedo, enabled: () => C.canRedo(state.history) },
      { label: 'Select All', kbd: '⌘A', run: () => selectAll(), enabled: () => state.doc.shapes.length > 0 },
    ],
    object: [
      { label: 'Group', kbd: '⌘G', run: () => doGroup(), enabled: () => selUnitCount() >= 2 },
      { label: 'Ungroup', kbd: '⇧⌘G', run: () => doUngroup(), enabled: () => selHasGroup() },
      { label: 'Bring to Front', kbd: '⇧⌘]', run: () => doArrange('front'), enabled: () => state.sel.size > 0 },
      { label: 'Bring Forward', kbd: '⌘]', run: () => doArrange('forward'), enabled: () => state.sel.size > 0 },
      { label: 'Send Backward', kbd: '⌘[', run: () => doArrange('backward'), enabled: () => state.sel.size > 0 },
      { label: 'Send to Back', kbd: '⇧⌘[', run: () => doArrange('back'), enabled: () => state.sel.size > 0 },
    ],
  };

  // ---------- selection commands ----------
  function selUnitCount() {
    return state.sel.size ? C.selectionUnits(state.doc, [...state.sel]).length : 0;
  }
  function selHasGroup() {
    return selShapes().some(s => s.group);
  }
  function selectAll() {
    const ok = selectableLayers();
    setSel(state.doc.shapes.filter(s => ok.has(s.layer)).map(s => s.id));
    render();
  }
  function doGroup() {
    if (selUnitCount() < 2) return;
    mutate(d => C.groupShapes(d, [...state.sel]));
  }
  function doUngroup() {
    if (!selHasGroup()) return;
    mutate(d => {
      const roots = new Set(
        d.shapes.filter(s => state.sel.has(s.id)).map(s => C.rootGroupOf(d, s)).filter(Boolean));
      roots.forEach(gid => C.ungroupShapes(d, gid));
    });
  }
  function doArrange(how) {
    if (!state.sel.size) return;
    mutate(d => {
      const ids = [...state.sel];
      if (how === 'front') C.bringToFront(d, ids);
      else if (how === 'forward') C.bringForward(d, ids);
      else if (how === 'backward') C.sendBackward(d, ids);
      else C.sendToBack(d, ids);
    });
  }
  function doDelete() {
    if (!state.sel.size) return;
    mutate(d => { d.shapes = d.shapes.filter(s => !state.sel.has(s.id)); });
    state.sel.clear();
    render();
  }
  function nudge(dx, dy) {
    if (!state.sel.size) return;
    const m = C.mTranslate(dx, dy);
    mutate(d => {
      for (const s of d.shapes) if (state.sel.has(s.id)) s.cmds = C.transformCmds(s.cmds, m);
    });
  }

  document.querySelectorAll('.alignrow button[data-align]').forEach(b =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      mutate(d => C.alignUnits(d, [...state.sel], b.dataset.align));
    }));

  let openMenu = null; // {el, dd}
  function closeMenu() {
    if (!openMenu) return;
    openMenu.el.classList.remove('open');
    openMenu.dd.remove();
    openMenu = null;
  }
  function showMenu(el) {
    closeMenu();
    const items = MENUS[el.dataset.menu];
    if (!items) return;
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    for (const it of items) {
      const div = document.createElement('div');
      const on = !it.enabled || it.enabled();
      div.className = 'item' + (on ? '' : ' disabled');
      div.innerHTML = '<span></span><span class="kbd"></span>';
      div.firstChild.textContent = it.label;
      div.lastChild.textContent = it.kbd || '';
      if (on) div.addEventListener('click', () => { closeMenu(); it.run(); });
      dd.appendChild(div);
    }
    const r = el.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.top = r.bottom + 2 + 'px';
    document.body.appendChild(dd);
    el.classList.add('open');
    openMenu = { el, dd };
  }
  document.querySelectorAll('#menubar .menu[data-menu]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation();
      openMenu && openMenu.el === el ? closeMenu() : showMenu(el);
    }));
  window.addEventListener('pointerdown', e => {
    if (openMenu && !openMenu.dd.contains(e.target) && !openMenu.el.contains(e.target)) closeMenu();
  });

  // ---------- tools ----------
  function setTool(t) {
    if (!TOOLS[t]) return;
    state.tool = t;
    document.querySelectorAll('#toolbar button[data-tool]').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === t));
    stagewrap.className = 'tool-' + t;
    updateReadouts();
  }

  document.querySelectorAll('#toolbar button[data-tool]').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  // ---------- pointer: pan / zoom-click ----------
  function panActive(e) {
    return state.tool === 'hand' || state.space || e.button === 1;
  }

  canvas.addEventListener('pointerdown', e => {
    if (panActive(e)) {
      state.autoFit = false;
      state.pan = { sx: e.clientX, sy: e.clientY, view0: { ...state.view } };
      stagewrap.classList.add('panning');
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (state.tool === 'zoom') {
      state.autoFit = false;
      const r = canvas.getBoundingClientRect();
      const f = e.altKey ? 1 / 1.5 : 1.5;
      state.view = C.zoomAt(state.view, e.clientX - r.left, e.clientY - r.top, f);
      render();
      return;
    }
    if (state.tool !== 'select' || e.button !== 0) return;

    const [sx, sy] = screenPt(e);
    const [wx, wy] = worldPt(e);
    canvas.setPointerCapture(e.pointerId);

    // 1) bbox handles beat shape hits
    const h = hitHandle(sx, sy);
    if (h) {
      const b = h.bbox;
      if (h.type === 'scale') {
        const f = HANDLE_FRAC[h.c];
        let ax = b.x + (1 - f[0]) * b.w, ay = b.y + (1 - f[1]) * b.h; // opposite point
        if (e.altKey) { ax = b.x + b.w / 2; ay = b.y + b.h / 2; }
        state.drag = {
          kind: 'scale', c: h.c, ax, ay,
          hx: b.x + f[0] * b.w, hy: b.y + f[1] * b.h,
          axis: h.c === 'n' || h.c === 's' ? 'y' : h.c === 'e' || h.c === 'w' ? 'x' : 'xy',
          orig: snapshotSel(), moved: false,
        };
      } else {
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        state.drag = {
          kind: 'rotate', cx, cy,
          a0: Math.atan2(wy - cy, wx - cx),
          orig: snapshotSel(), moved: false,
        };
      }
      return;
    }

    // 2) shape hit → select / toggle, arm move drag
    const hit = hitAt(wx, wy);
    if (hit) {
      if (e.shiftKey) {
        const unit = C.expandIds(state.doc, [hit.id]);
        if (state.sel.has(hit.id)) {
          unit.forEach(id => state.sel.delete(id));
          render();
          return; // deselected — no drag
        }
        unit.forEach(id => state.sel.add(id));
      } else if (!state.sel.has(hit.id)) {
        setSel([hit.id]);
      }
      state.drag = {
        kind: 'move', wx0: wx, wy0: wy,
        alt: e.altKey, dupDone: false,
        orig: snapshotSel(), moved: false,
      };
      render();
      return;
    }

    // 3) empty space → marquee
    state.drag = { kind: 'marquee', m0: [sx, sy], m1: [sx, sy], shift: e.shiftKey, moved: false };
  });

  canvas.addEventListener('pointermove', e => {
    if (state.pan) {
      state.view = C.panBy(state.pan.view0, e.clientX - state.pan.sx, e.clientY - state.pan.sy);
      render();
    }
    const [sx, sy] = screenPt(e);
    const [wx, wy] = worldPt(e);
    const d = state.drag;
    if (d) {
      if (d.kind === 'move') {
        const dx = wx - d.wx0, dy = wy - d.wy0;
        if (!d.moved && Math.hypot(dx, dy) * state.view.scale < 3) { /* click slack */ }
        else {
          if (d.alt && !d.dupDone) { // alt-drag: copy moves, original stays
            const ids = C.duplicateShapes(state.doc, [...state.sel]);
            setSel(ids);
            d.orig = snapshotSel();
            d.dupDone = true;
          }
          d.moved = true;
          applyDragMatrix(C.mTranslate(dx, dy));
          render();
        }
      } else if (d.kind === 'scale') {
        let fx = 1, fy = 1;
        const dx0 = d.hx - d.ax, dy0 = d.hy - d.ay;
        if (d.axis !== 'y' && Math.abs(dx0) > 1e-9) fx = (wx - d.ax) / dx0;
        if (d.axis !== 'x' && Math.abs(dy0) > 1e-9) fy = (wy - d.ay) / dy0;
        if (e.shiftKey && d.axis === 'xy') fy = fx;
        if (isFinite(fx) && isFinite(fy)) {
          d.moved = true;
          applyDragMatrix(C.mScale(fx, fy, d.ax, d.ay));
          render();
        }
      } else if (d.kind === 'rotate') {
        let da = Math.atan2(wy - d.cy, wx - d.cx) - d.a0;
        if (e.shiftKey) da = Math.round(da / (Math.PI / 4)) * (Math.PI / 4);
        d.moved = true;
        applyDragMatrix(C.mRotate(da, d.cx, d.cy));
        render();
      } else if (d.kind === 'marquee') {
        d.m1 = [sx, sy];
        d.moved = true;
        render();
      }
    } else if (state.tool === 'select' && !state.pan) {
      const hh = hitHandle(sx, sy);
      canvas.style.cursor = hh ? (hh.type === 'rotate' ? 'crosshair' : HANDLE_CURSOR[hh.c]) : '';
    }
    const k = C.PT_PER[state.doc.units];
    $('#s-coords').textContent = `x: ${(wx / k).toFixed(2)} ${state.doc.units}   y: ${(wy / k).toFixed(2)} ${state.doc.units}`;
  });

  canvas.addEventListener('pointerup', e => {
    if (state.pan) {
      state.pan = null;
      stagewrap.classList.remove('panning');
      canvas.releasePointerCapture(e.pointerId);
      return;
    }
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.kind === 'marquee') {
      if (!d.moved) {
        if (!d.shift) { state.sel.clear(); render(); }
        return;
      }
      const v = state.view;
      const [ax, ay] = C.s2w(v, Math.min(d.m0[0], d.m1[0]), Math.min(d.m0[1], d.m1[1]));
      const [bx, by] = C.s2w(v, Math.max(d.m0[0], d.m1[0]), Math.max(d.m0[1], d.m1[1]));
      const rect = { x: ax, y: ay, w: bx - ax, h: by - ay };
      const ok = selectableLayers();
      const ids = state.doc.shapes
        .filter(s => ok.has(s.layer))
        .filter(s => { const b = C.tightBBox(s.cmds); return b && C.rectsIntersect(b, rect); })
        .map(s => s.id);
      setSel(d.shift ? [...state.sel, ...ids] : ids);
      render();
    } else if (d.moved) {
      commitNow();
      render();
    }
  });

  // wheel = zoom at cursor (trackpad pinch arrives as ctrl+wheel — same path)
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    state.autoFit = false;
    const r = canvas.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    state.view = C.zoomAt(state.view, e.clientX - r.left, e.clientY - r.top, f);
    render();
  }, { passive: false });

  // ---------- keyboard ----------
  window.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      closeMenu();
      if (state.sel.size) { state.sel.clear(); render(); }
      return;
    }
    if (mod && (k === 'y' || (e.shiftKey && k === 'z'))) { doRedo(); e.preventDefault(); return; }
    if (mod && k === 'z') { doUndo(); e.preventDefault(); return; }
    if (mod && k === 's') { saveFile(); e.preventDefault(); return; }
    if (mod && k === 'o') { openFile(); e.preventDefault(); return; }
    if (mod && k === 'e') { exportPdfFile(); e.preventDefault(); return; }
    if (mod && k === 'a') { selectAll(); e.preventDefault(); return; }
    if (mod && k === 'g') { e.shiftKey ? doUngroup() : doGroup(); e.preventDefault(); return; }
    if (mod && e.key === ']') { doArrange(e.shiftKey ? 'front' : 'forward'); e.preventDefault(); return; }
    if (mod && e.key === '[') { doArrange(e.shiftKey ? 'back' : 'backward'); e.preventDefault(); return; }
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) { doDelete(); e.preventDefault(); return; }
    if (!mod && e.key.startsWith('Arrow') && state.sel.size) {
      const step = e.shiftKey ? 10 : 1;
      nudge(
        e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' && !e.repeat) {
      state.space = true;
      stagewrap.classList.add('tool-hand');
      e.preventDefault();
      return;
    }
    if (mod && e.key === '0') { state.autoFit = true; fitArtboard(); render(); e.preventDefault(); return; }
    if (mod && e.key === '1') {
      state.autoFit = false;
      state.view = C.zoomAt(state.view, vw / 2, vh / 2, C.PX_PER_PT_100 / state.view.scale);
      render(); e.preventDefault(); return;
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      state.autoFit = false;
      state.view = C.zoomAt(state.view, vw / 2, vh / 2, 1.25); render(); e.preventDefault(); return;
    }
    if (mod && e.key === '-') {
      state.autoFit = false;
      state.view = C.zoomAt(state.view, vw / 2, vh / 2, 1 / 1.25); render(); e.preventDefault(); return;
    }
    if (!mod && TOOL_KEYS[e.key.toLowerCase()]) setTool(TOOL_KEYS[e.key.toLowerCase()]);
  });

  window.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      state.space = false;
      if (state.tool !== 'hand') stagewrap.className = 'tool-' + state.tool;
    }
  });

  $('#btn-fit').addEventListener('click', () => { state.autoFit = true; fitArtboard(); render(); });
  $('#btn-100').addEventListener('click', () => {
    state.autoFit = false;
    state.view = C.zoomAt(state.view, vw / 2, vh / 2, C.PX_PER_PT_100 / state.view.scale);
    render();
  });

  // ---------- boot ----------
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(stagewrap);
  setTool('select');
  bindTrace();
  renderLayers();
  resize();

  // debug handle
  window.VEC_STUDIO = {
    state, render, setTool, fitArtboard, VECCORE: C, VECTRACE: TR,
    mutate, doUndo, doRedo, newFile, openFile, saveFile, applyNewDoc,
    openAnyFile, exportPdfFile,
    setSel, selectAll, doGroup, doUngroup, doArrange, doDelete, nudge,
    placeImage, addPlacedImage, selectedImage, bitmapOf, traceOpts,
    runTracePreview, expandTrace, applyPreset,
  };
})();
