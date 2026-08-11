// studio_app — UI wiring for Aquamentor Vector Studio.
// Thin layer over VECCORE: canvas rendering, pan/zoom, tool state, panels.
(() => {
  'use strict';
  const C = window.VECCORE;
  const TR = window.VECTRACE;
  const SEP = window.SEPARATE;
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
    drag: null,          // select/direct-tool drag state machine
    draw: null,          // rect/ellipse rubber band {wx0,wy0,wx1,wy1,square,center}
    pen: null,           // pen path under construction {anchors,closed,drag,hover,hoverClose}
    sel: new Set(),      // selected shape ids (always group-expanded)
    asel: new Map(),     // direct tool: shape id -> Set of anchor keys
    autoFit: true,       // keep fitting on resize until the user changes the view
    layer: null,         // active layer id (Layers panel target)
    collapsed: new Set(),// layer ids twisted shut (layers open by default)
    expanded: new Set(), // group ids twisted open (groups shut by default)
    ref: 'nw',           // Transform panel reference point
    constrain: false,    // Transform panel W/H proportion lock
    target: 'fill',      // which paint the color picker and swatches drive
    paint: null,         // {fill, stroke} current paints — null means "none"
    pick: null,          // {fill, stroke} last real color per target, for the picker
    colorModel: 'rgb',   // picker entry mode: rgb | cmyk | hsb
    swatchSel: -1,       // selected swatch index in doc.swatches
    trace: {             // Image Trace panel controls + last preview result
      preset: 'color6', colors: 6, threshold: 128, tolerance: 1,
      corners: 70, noise: 5, ignoreWhite: false, preview: true,
      result: null,      // {shapeId, r, bw, bh} — paths in traced-bitmap pixels
      note: '', lastId: null, timer: 0,
    },
    inkVisible: null,    // null = composite; Set of ink keys = separation preview
    inkSel: null,        // ink key the Separations panel acts on
    issues: null,        // last preflight result (null until run)
  };
  state.history = C.newHistory(state.doc);
  state.layer = state.doc.layers[0].id;
  {
    // Illustrator's startup paints: white fill over a black stroke.
    const white = C.makeColor({ space: 'cmyk', values: [0, 0, 0, 0] });
    const black = C.makeColor({ space: 'cmyk', values: [0, 0, 0, 1] });
    state.paint = { fill: white, stroke: black };
    state.pick = { fill: white, stroke: black };
  }

  // ---------- selection helpers ----------
  function commitNow() {
    if (C.commit(state.history, state.doc)) scheduleAutosave();
  }
  // A panel field fires its change event on blur, so anything about to move
  // the selection has to let it commit first — otherwise a weight or opacity
  // typed for one object lands on the next one.
  function blurPanelField() {
    const el = document.activeElement;
    if (el && el.closest && el.closest('#panels')) el.blur();
  }
  function setSel(ids) {
    blurPanelField();
    state.sel = new Set(C.expandIds(state.doc, ids));
    state.asel.clear(); // anchor picks belong to whatever was selected before
  }
  function selShapes() {
    return state.doc.shapes.filter(s => state.sel.has(s.id));
  }
  function selectableLayers() {
    return new Set(state.doc.layers.filter(l => l.visible && !l.locked).map(l => l.id));
  }
  // Hidden/locked objects are out of reach even on a live layer.
  function selectableShapes() {
    const ok = selectableLayers();
    return state.doc.shapes.filter(s => ok.has(s.layer) && !s.hidden && !s.locked);
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
    const live = selectableShapes();
    const tol = 3 / state.view.scale;
    for (let i = live.length - 1; i >= 0; i--) {
      if (C.hitTestShape(live[i], wx, wy, tol)) return live[i];
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
  // normalizeZ keeps the shape list grouped by layer, so z-order edits stay
  // inside their layer the way Illustrator does it.
  function mutate(fn) {
    fn(state.doc);
    C.normalizeZ(state.doc);
    if (C.commit(state.history, state.doc)) scheduleAutosave();
    refreshDoc();
  }

  function refreshDoc() {
    // drop selection ids that no longer exist in the current doc
    const alive = new Set(state.doc.shapes.map(s => s.id));
    state.sel = new Set([...state.sel].filter(id => alive.has(id)));
    if (!C.layerOf(state.doc, state.layer)) state.layer = state.doc.layers[0].id;
    state.asel.clear(); // anchor indices do not survive a document swap
    renderLayers();
    renderSeparations();
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
    state.pen = state.draw = state.drag = null; // nothing in flight belongs to the new doc
    state.sel.clear();
    state.layer = doc.layers[0].id;
    state.collapsed.clear();
    state.expanded.clear();
    state.autoFit = true;
    state.inkVisible = null;
    state.inkSel = null;
    state.issues = null;
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

  function appendPath(cmds) {
    for (const c of cmds) {
      if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
      else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
      else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else if (c[0] === 'Z') ctx.closePath();
    }
  }

  function drawPath(cmds) {
    ctx.beginPath();
    appendPath(cmds);
  }

  // Canvas only centers strokes, so inside/outside draw at double weight and
  // clip to (or away from) the shape — the same construction the PDF exporter
  // writes, so preview and print agree. Caps and joins render at that doubled
  // size, which only shows on open or dashed paths; closed shapes, where
  // alignment actually matters, are exact. The current path on entry is the
  // shape's, left there by the fill pass.
  // colorOverride carries the separation-preview ink color when one is active.
  function strokeShape(s, colorOverride) {
    const st = s.stroke;
    ctx.strokeStyle = colorOverride || st.color;
    ctx.lineWidth = st.w;
    ctx.lineCap = C.strokeProp(st, 'cap');
    ctx.lineJoin = C.strokeProp(st, 'join');
    ctx.miterLimit = C.strokeProp(st, 'miter');
    ctx.setLineDash(st.dash || []);
    const align = C.strokeProp(st, 'align');
    if (align !== 'center') {
      ctx.save();
      ctx.lineWidth = st.w * 2;
      if (align === 'inside') {
        ctx.clip();
      } else {
        const b = C.tightBBox(s.cmds) || { x: 0, y: 0, w: 0, h: 0 };
        const pad = st.w * 2 + 10;
        ctx.beginPath();
        ctx.rect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
        appendPath(s.cmds); // even-odd against the enclosing rect = outside only
        ctx.clip('evenodd');
      }
      drawPath(s.cmds);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.stroke();
    }
    ctx.setLineDash([]);
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
    const inks = state.inkVisible; // separation preview: repaint per visible ink
    for (const s of state.doc.shapes) {
      if (hidden.has(s.layer) || s.hidden) continue;
      const fill = s.fill && (inks ? SEP.previewHex(s.fill, s.fillInfo, inks) : s.fill);
      const stroke = s.stroke && (inks ? SEP.previewHex(s.stroke.color, s.strokeInfo, inks) : s.stroke.color);
      if (inks && !fill && !stroke) continue; // lays down no visible ink
      ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
      if (s.type === 'image') { drawImageShape(s, v.scale); continue; }
      drawPath(s.cmds);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) strokeShape(s, stroke);
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

  // Screen-space path for overlay art (previews, the pen path in flight).
  function drawWorldPath(cmds) {
    const v = state.view;
    drawPath(C.transformCmds(cmds, [v.scale, 0, 0, v.scale, v.tx, v.ty]));
  }

  function drawAnchor(p, on) {
    ctx.fillStyle = on ? '#3a8ee6' : '#fff';
    ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
    ctx.strokeStyle = '#3a8ee6';
    ctx.lineWidth = 1;
    ctx.strokeRect(p[0] - 2.5, p[1] - 2.5, 5, 5);
  }
  function drawHandle(p, h) {
    ctx.strokeStyle = '#3a8ee6';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(h[0], h[1]); ctx.stroke();
    ctx.fillStyle = '#3a8ee6';
    ctx.beginPath(); ctx.arc(h[0], h[1], 3, 0, Math.PI * 2); ctx.fill();
  }

  // Anchors of the selected objects, Ai-style: hollow squares until picked,
  // handles only on the segments that touch a picked anchor.
  function drawAnchorOverlay() {
    const v = state.view;
    for (const s of selShapes()) {
      const subs = C.pathToAnchors(s.cmds);
      const sel = state.asel.get(s.id) || new Set();
      const live = liveHandleKeys(subs, sel);
      subs.forEach((sub, si) => sub.anchors.forEach((a, ai) => {
        const p = C.w2s(v, a.x, a.y);
        for (const which of ['in', 'out']) {
          if (a[which] && live.has(C.handleKey(si, ai, which))) {
            drawHandle(p, C.w2s(v, a[which][0], a[which][1]));
          }
        }
      }));
      subs.forEach((sub, si) => sub.anchors.forEach((a, ai) => {
        drawAnchor(C.w2s(v, a.x, a.y), sel.has(C.anchorKey(si, ai)));
      }));
    }
  }

  function drawPenOverlay() {
    const p = state.pen, v = state.view;
    if (!p || !p.anchors.length) return;
    ctx.strokeStyle = '#3a8ee6';
    ctx.lineWidth = 1;
    if (p.anchors.length > 1) {
      drawWorldPath(C.anchorsToPath([{ anchors: p.anchors, closed: p.closed }]));
      ctx.stroke();
    }
    // rubber band from the live anchor to the cursor
    const last = p.anchors[p.anchors.length - 1];
    if (p.hover && !p.drag) {
      const a = C.w2s(v, last.x, last.y);
      const c1 = last.out ? C.w2s(v, last.out[0], last.out[1]) : a;
      const b = C.w2s(v, p.hover[0], p.hover[1]);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.bezierCurveTo(c1[0], c1[1], b[0], b[1], b[0], b[1]);
      ctx.stroke();
      ctx.restore();
    }
    for (const a of p.anchors) {
      const q = C.w2s(v, a.x, a.y);
      for (const which of ['in', 'out']) {
        if (a === last && a[which]) drawHandle(q, C.w2s(v, a[which][0], a[which][1]));
      }
      drawAnchor(q, a === last);
    }
    // close affordance: a ring on the first anchor when the click would close
    if (p.hoverClose && !p.drag) {
      const q = C.w2s(v, p.anchors[0].x, p.anchors[0].y);
      ctx.strokeStyle = '#3a8ee6';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(q[0], q[1], 7, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawShapePreview() {
    if (!state.draw) return;
    ctx.save();
    ctx.strokeStyle = '#3a8ee6';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    drawWorldPath(drawnCmds(state.draw));
    ctx.stroke();
    ctx.restore();
  }

  function drawSelectionOverlay() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.sel.size && state.tool !== 'direct') {
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
    if (state.tool === 'direct') drawAnchorOverlay();
    drawPenOverlay();
    drawShapePreview();
    const d = state.drag;
    if (d && (d.kind === 'marquee' || d.kind === 'amarquee') && d.moved) {
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
    const anchors = anchorSelSize();
    if (state.tool === 'direct' && anchors) {
      selEl.textContent = `${anchors} anchor${anchors > 1 ? 's' : ''}`;
    } else if (state.sel.size) {
      const b = C.shapesBBox(selShapes());
      selEl.textContent = b
        ? `${state.sel.size} obj · ${+(b.w / k).toFixed(2)} × ${+(b.h / k).toFixed(2)} ${state.doc.units}`
        : `${state.sel.size} obj`;
    } else {
      selEl.textContent = '—';
    }
    syncOverprintButtons();
    const units = selUnitCount();
    document.querySelectorAll('.alignrow button[data-align]').forEach(btn => {
      const dist = btn.dataset.align === 'hdist' || btn.dataset.align === 'vdist';
      btn.disabled = dist ? units < 3 : units < 2;
    });
    updateTransform();
    markLayerRows();
    syncPaintPanel();
    syncStrokePanel();
    renderSwatches();
    syncTracePanel();
  }

  // ---------- transform panel ----------
  const TF_INPUTS = ['x', 'y', 'w', 'h', 'rot', 'shear'];

  function fmtNum(v, dp) {
    return String(+v.toFixed(dp));
  }
  // force=true also refreshes the field the user is typing in (after applying).
  function setField(id, v, dp, force) {
    const el = $(id);
    if (!force && document.activeElement === el) return;
    el.disabled = v === undefined;
    el.value = v == null ? '' : fmtNum(v, dp);
  }

  function updateTransform(force) {
    const u = state.doc.units, k = C.PT_PER[u];
    $('#t-units').textContent = u;
    const b = state.sel.size ? C.shapesBBox(selShapes()) : null;
    const dp = u === 'pt' ? 2 : 4;
    if (!b) {
      // undefined = no selection (greyed out); null = mixed (blank but live)
      for (const f of TF_INPUTS) setField('#t-' + f, undefined, dp, true);
      return;
    }
    const p = C.refPoint(b, state.ref);
    setField('#t-x', p[0] / k, dp, force);
    setField('#t-y', p[1] / k, dp, force);
    setField('#t-w', b.w / k, dp, force);
    setField('#t-h', b.h / k, dp, force);
    const a = C.selectionAngles(state.doc, [...state.sel]);
    setField('#t-rot', a.angle, 2, force);
    setField('#t-shear', a.shear, 2, force);
  }

  // One field committed: everything else on the selection stays put.
  function applyTransformField(which) {
    if (!state.sel.size) return;
    const raw = $('#t-' + which).value.trim();
    const n = parseFloat(raw);
    if (!raw || !isFinite(n)) { updateTransform(true); return; }
    const k = C.PT_PER[state.doc.units];
    const b = C.shapesBBox(selShapes());
    const spec = { ref: state.ref };
    if (which === 'x') spec.x = n * k;
    else if (which === 'y') spec.y = n * k;
    else if (which === 'w') {
      spec.w = Math.max(1e-4, n * k);
      if (state.constrain && b.w > 1e-9) spec.h = b.h * (spec.w / b.w);
    } else if (which === 'h') {
      spec.h = Math.max(1e-4, n * k);
      if (state.constrain && b.h > 1e-9) spec.w = b.w * (spec.h / b.h);
    } else if (which === 'rot') spec.angle = C.normAngle(n);
    else spec.shear = Math.max(-89, Math.min(89, n));
    mutate(d => C.transformSelection(d, [...state.sel], spec));
    updateTransform(true);
  }

  for (const f of TF_INPUTS) {
    const el = $('#t-' + f);
    el.addEventListener('change', () => applyTransformField(f));
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { updateTransform(true); el.blur(); } });
  }

  function setRef(ref) {
    state.ref = ref;
    document.querySelectorAll('#refgrid button').forEach(b =>
      b.classList.toggle('on', b.dataset.ref === ref));
    updateTransform(true);
  }
  document.querySelectorAll('#refgrid button[data-ref]').forEach(b =>
    b.addEventListener('click', () => setRef(b.dataset.ref)));
  $('#t-chain').addEventListener('click', () => {
    state.constrain = !state.constrain;
    $('#t-chain').classList.toggle('on', state.constrain);
  });

  // ---------- layers panel ----------
  const ICON = {
    eyeOn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.5 8S4 4.2 8 4.2 14.5 8 14.5 8 12 11.8 8 11.8 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>',
    eyeOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 6.2S4.4 9.4 8 9.4s6-3.2 6-3.2"/><path d="M4.2 8.6 3.1 10.6M8 9.6v2.2M11.8 8.6l1.1 2"/></svg>',
    lockOn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.6" y="7.2" width="8.8" height="5.6" rx="1"/><path d="M5.7 7.2V5.4a2.3 2.3 0 0 1 4.6 0v1.8"/></svg>',
    lockOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3.6" y="7.2" width="8.8" height="5.6" rx="1"/><path d="M5.7 7.2V5.4a2.3 2.3 0 0 1 4.6 0"/></svg>',
  };

  function iconSpan(cls, on, icons, title) {
    const el = document.createElement('span');
    el.className = cls + (on ? '' : ' off');
    el.innerHTML = on ? icons[0] : icons[1];
    el.title = title;
    return el;
  }

  function twistySpan(id, open, expandable) {
    const el = document.createElement('span');
    el.className = 'tw' + (expandable ? '' : ' leaf');
    el.textContent = open ? '▼' : '▶';
    if (expandable) el.addEventListener('click', e => {
      e.stopPropagation();
      const set = id[0] === 'L' ? state.collapsed : state.expanded;
      set.has(id) ? set.delete(id) : set.add(id);
      renderLayers();
    });
    return el;
  }

  function nameSpan(text, onRename) {
    const el = document.createElement('span');
    el.className = 'lname';
    el.textContent = text;
    if (onRename) el.addEventListener('dblclick', e => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.value = text;
      el.textContent = '';
      el.appendChild(inp);
      inp.focus();
      inp.select();
      let done = false;
      const finish = keep => {
        if (done) return;
        done = true;
        if (keep) onRename(inp.value); else renderLayers();
      };
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        else if (ev.key === 'Escape') finish(false);
      });
    });
    return el;
  }

  function layerRowEl(l) {
    const row = document.createElement('div');
    row.className = 'lrow layerrow';
    row.dataset.kind = 'layer';
    row.dataset.layer = l.id;
    row.dataset.drag = '1';
    const open = !state.collapsed.has(l.id);
    row.appendChild(twistySpan(l.id, open, l.rows.length > 0));
    const eye = iconSpan('eye', l.visible, [ICON.eyeOn, ICON.eyeOff], 'Toggle layer visibility');
    eye.addEventListener('click', e => {
      e.stopPropagation();
      mutate(d => { const t = C.layerOf(d, l.id); if (t) t.visible = !t.visible; });
    });
    const lk = iconSpan('lk', l.locked, [ICON.lockOn, ICON.lockOff], 'Toggle layer lock');
    lk.addEventListener('click', e => {
      e.stopPropagation();
      mutate(d => { const t = C.layerOf(d, l.id); if (t) t.locked = !t.locked; });
    });
    row.append(eye, lk, nameSpan(l.name, v => mutate(d => C.renameLayer(d, l.id, v))));
    return row;
  }

  function objRowEl(r, depth) {
    const row = document.createElement('div');
    row.className = 'lrow objrow';
    row.dataset.kind = 'obj';
    row.dataset.layer = r.layer;
    row.dataset.ids = r.ids.join(',');
    row.dataset.front = r.ids[0];
    row.dataset.back = r.ids[r.ids.length - 1];
    row.dataset.drag = depth === 1 ? '1' : '0'; // only whole units leave a layer
    row.style.paddingLeft = 6 + depth * 12 + 'px';
    row.appendChild(twistySpan(r.id, state.expanded.has(r.id), r.children.length > 0));
    const eye = iconSpan('eye', r.visible, [ICON.eyeOn, ICON.eyeOff], 'Toggle visibility');
    eye.addEventListener('click', e => {
      e.stopPropagation();
      mutate(d => C.hideShapes(d, r.ids, r.visible));
    });
    const lk = iconSpan('lk', r.locked, [ICON.lockOn, ICON.lockOff], 'Toggle lock');
    lk.addEventListener('click', e => {
      e.stopPropagation();
      mutate(d => C.lockShapes(d, r.ids, !r.locked));
    });
    row.append(eye, lk);
    if (r.kind === 'shape') {
      const sh = state.doc.shapes.find(s => s.id === r.id);
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = (sh && (sh.fill || (sh.stroke && sh.stroke.color))) || 'transparent';
      row.appendChild(sw);
    }
    row.appendChild(nameSpan(r.name));
    return row;
  }

  function renderLayers() {
    const list = $('#layerlist');
    const top = list.scrollTop;
    list.querySelectorAll('.lrow').forEach(el => el.remove());
    const frag = document.createDocumentFragment();
    const addRows = (rows, depth) => {
      for (const r of rows) {
        frag.appendChild(objRowEl(r, depth));
        if (r.children.length && state.expanded.has(r.id)) addRows(r.children, depth + 1);
      }
    };
    for (const l of C.layerTree(state.doc)) {
      frag.appendChild(layerRowEl(l));
      if (!state.collapsed.has(l.id)) addRows(l.rows, 1);
    }
    list.appendChild(frag);
    list.scrollTop = top;
    $('#lb-del').disabled = state.doc.layers.length < 2;
    markLayerRows();
  }

  // Cheap two-way sync: canvas selection just repaints the row highlights.
  function markLayerRows() {
    document.querySelectorAll('#layerlist .lrow').forEach(el => {
      if (el.dataset.kind === 'layer') {
        el.classList.toggle('sel', el.dataset.layer === state.layer);
      } else {
        const ids = el.dataset.ids.split(',');
        el.classList.toggle('sel', ids.every(id => state.sel.has(id)));
      }
    });
  }

  function doAddLayer() {
    mutate(d => {
      const l = C.addLayer(d, null, state.layer);
      state.layer = l.id;
    });
  }
  function doDuplicateLayer() {
    mutate(d => {
      const l = C.duplicateLayer(d, state.layer);
      if (l) state.layer = l.id;
    });
  }
  function doDeleteLayer() {
    if (state.doc.layers.length < 2) return;
    mutate(d => C.deleteLayer(d, state.layer));
  }
  $('#lb-new').addEventListener('click', doAddLayer);
  $('#lb-dup').addEventListener('click', doDuplicateLayer);
  $('#lb-del').addEventListener('click', doDeleteLayer);

  // ---------- layers panel drag & drop ----------
  // Pointer-driven (not HTML5 DnD) so it behaves the same as the canvas drags.
  let ldrag = null;

  function dropTargetAt(clientY) {
    const rows = [...document.querySelectorAll('#layerlist .lrow')];
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY < r.bottom) return { row, before: clientY < r.top + r.height / 2 };
    }
    const last = rows[rows.length - 1];
    return last ? { row: last, before: false } : null;
  }

  function showDropLine(t) {
    const dl = $('#dropline'), list = $('#layerlist');
    if (!t) { dl.style.display = 'none'; return; }
    const lr = list.getBoundingClientRect(), r = t.row.getBoundingClientRect();
    dl.style.display = 'block';
    dl.style.top = (t.before ? r.top : r.bottom) - lr.top + list.scrollTop - 1 + 'px';
  }

  function dropLayer(src, t) {
    const from = C.layerIndex(state.doc, src.dataset.layer);
    // Every layer row that starts above the drop line stays above the dragged
    // one, so the count of them is the insertion index.
    const r = t.row.getBoundingClientRect();
    const y = t.before ? r.top : r.bottom;
    let ins = 0;
    document.querySelectorAll('#layerlist .lrow[data-kind="layer"]').forEach(el => {
      if (el.getBoundingClientRect().top < y) ins++;
    });
    const to = ins > from ? ins - 1 : ins;
    if (from < 0 || to === from) return;
    mutate(d => C.reorderLayers(d, from, to));
  }

  function dropObject(src, t) {
    const ids = src.dataset.ids.split(',');
    if (t.row === src || (t.row.dataset.ids || '').split(',').some(id => ids.includes(id))) return;
    if (t.row.dataset.kind === 'layer') {
      mutate(d => C.moveShapesToLayer(d, ids, t.row.dataset.layer));
      state.layer = t.row.dataset.layer;
    } else {
      const anchor = t.before ? t.row.dataset.front : t.row.dataset.back;
      mutate(d => C.moveShapesToLayer(d, ids, t.row.dataset.layer, anchor, t.before ? 'front' : 'back'));
      state.layer = t.row.dataset.layer;
    }
    markLayerRows();
  }

  // Row activation happens on pointerup so a drag never doubles as a click.
  function activateRow(row) {
    if (row.dataset.kind === 'layer') {
      state.layer = row.dataset.layer;
      markLayerRows();
      return;
    }
    const ids = row.dataset.ids.split(',');
    const locked = ids.every(id => {
      const s = state.doc.shapes.find(x => x.id === id);
      return !s || s.locked || s.hidden;
    });
    const l = C.layerOf(state.doc, row.dataset.layer);
    if (locked || !l || l.locked || !l.visible) return;
    setSel(ids);
    state.layer = row.dataset.layer;
    markLayerRows();
    render();
  }

  $('#layerlist').addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const row = e.target.closest('.lrow');
    if (!row || e.target.closest('.eye, .lk, .tw') || e.target.tagName === 'INPUT') return;
    ldrag = { row, y0: e.clientY, moved: false };
  });
  window.addEventListener('pointermove', e => {
    if (!ldrag) return;
    if (!ldrag.moved) {
      if (Math.abs(e.clientY - ldrag.y0) < 4) return;
      if (ldrag.row.dataset.drag !== '1') { ldrag = null; return; }
      ldrag.moved = true;
      ldrag.row.classList.add('dragging');
    }
    showDropLine(dropTargetAt(e.clientY));
  });
  window.addEventListener('pointerup', e => {
    if (!ldrag) return;
    const d = ldrag;
    ldrag = null;
    d.row.classList.remove('dragging');
    showDropLine(null);
    if (!d.moved) { activateRow(d.row); return; }
    const t = dropTargetAt(e.clientY);
    if (!t) return;
    if (d.row.dataset.kind === 'layer') dropLayer(d.row, t);
    else dropObject(d.row, t);
  });

  // ---------- fill, stroke & color ----------
  // The picker speaks the units people type: RGB 0-255, CMYK/HSB percentages,
  // hue in degrees. Everything below the panel boundary is 0..1 (see veccore).
  const COLOR_MODELS = {
    rgb: [{ k: 'R', max: 255 }, { k: 'G', max: 255 }, { k: 'B', max: 255 }],
    cmyk: [{ k: 'C', max: 100 }, { k: 'M', max: 100 }, { k: 'Y', max: 100 }, { k: 'K', max: 100 }],
    hsb: [{ k: 'H', max: 360 }, { k: 'S', max: 100 }, { k: 'B', max: 100 }],
  };

  function colorToModel(col, model) {
    const rgb = col ? col.rgb : [0, 0, 0];
    if (model === 'cmyk') {
      // a spot ink shows the build it actually prints as
      const v = col && col.space === 'cmyk' ? col.values
        : col && col.alt && col.alt.space === 'cmyk' ? col.alt.values
          : C.rgbToCmyk(rgb);
      return v.map(x => x * 100);
    }
    if (model === 'hsb') {
      const h = C.rgbToHsb(rgb);
      return [h[0], h[1] * 100, h[2] * 100];
    }
    return rgb.map(x => x * 255);
  }

  function modelToColor(vals, model) {
    if (model === 'cmyk') return C.makeColor({ space: 'cmyk', values: vals.map(v => v / 100) });
    const rgb = model === 'hsb'
      ? C.hsbToRgb([vals[0], vals[1] / 100, vals[2] / 100])
      : vals.map(v => v / 255);
    return C.makeColor({ space: 'rgb', values: rgb });
  }

  // Effective paint of a target: the frontmost selected object's, or the app's
  // current paint when nothing is selected.
  function effectivePaint(kind) {
    const shapes = selShapes();
    if (!shapes.length) return state.paint[kind];
    const s = shapes[shapes.length - 1];
    if (kind === 'fill') return C.paintColor(s.fill, s.fillInfo);
    return s.stroke ? C.paintColor(s.stroke.color, s.strokeInfo) : null;
  }

  // Paint the whole selection in one shot. live=true skips the history entry
  // so dragging a slider ends up as a single undo step on release.
  function pushColor(col, live) {
    state.paint[state.target] = col;
    if (col) state.pick[state.target] = col;
    if (state.sel.size) {
      const ids = [...state.sel];
      if (state.target === 'fill') C.setFill(state.doc, ids, col);
      else C.setStroke(state.doc, ids, col);
      if (!live && C.commit(state.history, state.doc)) scheduleAutosave();
    }
    render();
  }

  function setTarget(t) {
    state.target = t;
    $('#well-fill').classList.toggle('active', t === 'fill');
    $('#well-stroke').classList.toggle('active', t === 'stroke');
    render();
  }

  function swapPaints() {
    if (state.sel.size) mutate(d => C.swapFillStroke(d, [...state.sel]));
    else {
      const f = state.paint.fill;
      state.paint.fill = state.paint.stroke;
      state.paint.stroke = f;
      render();
    }
  }

  function defaultPaints() {
    const white = C.makeColor({ space: 'cmyk', values: [0, 0, 0, 0] });
    const black = C.makeColor({ space: 'cmyk', values: [0, 0, 0, 1] });
    state.paint = { fill: white, stroke: black };
    state.pick = { fill: white, stroke: black };
    if (state.sel.size) {
      mutate(d => {
        const ids = [...state.sel];
        C.setFill(d, ids, white);
        C.setStroke(d, ids, black);
        C.setStrokeProps(d, ids, { w: 1 });
      });
    } else render();
  }

  // Only write inputs the user is not currently in — otherwise a repaint mid
  // drag or mid keystroke fights them for the caret.
  function setVal(el, v) { if (el !== document.activeElement) el.value = v; }

  const colSliders = $('#col-sliders');
  let sliderModel = null;

  function buildSliders() {
    if (sliderModel === state.colorModel) return;
    sliderModel = state.colorModel;
    colSliders.innerHTML = '';
    COLOR_MODELS[sliderModel].forEach((comp, i) => {
      const row = document.createElement('div');
      row.className = 'crow';
      row.innerHTML = '<label></label><input type="range" min="0" step="1">' +
        '<input class="num" type="number" min="0" step="1">';
      const [label, range, num] = row.children;
      label.textContent = comp.k;
      range.max = comp.max;
      num.max = comp.max;
      const push = (v, live) => {
        const vals = COLOR_MODELS[sliderModel].map((c, j) => +colSliders.children[j].children[1].value);
        vals[i] = v;
        pushColor(modelToColor(vals, sliderModel), live);
      };
      range.addEventListener('input', () => push(+range.value, true));
      range.addEventListener('change', () => { if (C.commit(state.history, state.doc)) scheduleAutosave(); });
      num.addEventListener('change', () => push(+num.value, false));
      colSliders.appendChild(row);
    });
  }

  function paintLabel(col) {
    if (!col) return 'None';
    return C.defaultSwatchName(col) + (col.space === 'separation' ? ' · spot' : '');
  }

  function syncPaintPanel() {
    buildSliders();
    for (const kind of ['fill', 'stroke']) {
      const col = effectivePaint(kind);
      state.paint[kind] = col;
      if (col) state.pick[kind] = col;
      const well = $('#well-' + kind);
      well.classList.toggle('none', !col);
      well.firstChild.style[kind === 'fill' ? 'background' : 'borderColor'] =
        col ? C.colorHex(col) : (kind === 'fill' ? '#ffffff' : '#ffffff');
    }
    const col = state.pick[state.target];
    setVal($('#col-hex'), C.colorHex(col));
    setVal($('#col-model'), state.colorModel);
    colorToModel(col, state.colorModel).forEach((v, i) => {
      const row = colSliders.children[i];
      if (!row) return;
      setVal(row.children[1], Math.round(v));
      setVal(row.children[2], Math.round(v));
    });
    $('#fs-ink').textContent =
      (state.target === 'fill' ? 'Fill: ' : 'Stroke: ') + paintLabel(state.paint[state.target]);

    const shapes = selShapes();
    const alpha = shapes.length ? shapes[shapes.length - 1].opacity : 1;
    const pct = Math.round((alpha == null ? 1 : alpha) * 100);
    setVal($('#op-range'), pct);
    setVal($('#op-num'), pct);
    $('#op-range').disabled = $('#op-num').disabled = !shapes.length;
  }

  document.querySelectorAll('.fswells .well[data-paint]').forEach(b =>
    b.addEventListener('click', () => setTarget(b.dataset.paint)));
  $('#fs-swap').addEventListener('click', swapPaints);
  $('#fs-default').addEventListener('click', defaultPaints);
  $('#fs-none').addEventListener('click', () => pushColor(null, false));
  $('#col-model').addEventListener('change', e => { state.colorModel = e.target.value; render(); });
  $('#col-hex').addEventListener('change', e => {
    const rgb = C.hexToRgb(e.target.value);
    if (rgb) pushColor(C.makeColor({ space: 'rgb', values: rgb }), false);
    else render(); // unparseable — put the real value back
  });

  // Opacity: preview while dragging, one history entry on release.
  function pushOpacity(pct, live) {
    if (!state.sel.size) return;
    C.setOpacity(state.doc, [...state.sel], pct / 100);
    if (!live && C.commit(state.history, state.doc)) scheduleAutosave();
    render();
  }
  $('#op-range').addEventListener('input', e => pushOpacity(+e.target.value, true));
  $('#op-range').addEventListener('change', () => {
    if (C.commit(state.history, state.doc)) scheduleAutosave();
  });
  $('#op-num').addEventListener('change', e => pushOpacity(+e.target.value, false));

  // ---------- stroke options ----------
  function selStroke() {
    const withStroke = selShapes().filter(s => s.stroke);
    return withStroke.length ? withStroke[withStroke.length - 1].stroke : null;
  }

  function applyStroke(props) {
    if (!state.sel.size) return;
    mutate(d => C.setStrokeProps(d, [...state.sel], props));
  }

  const STROKE_SEGS = [
    { sel: '#st-cap', attr: 'cap', prop: 'cap' },
    { sel: '#st-join', attr: 'join', prop: 'join' },
    { sel: '#st-align', attr: 'align2', prop: 'align' },
  ];
  for (const seg of STROKE_SEGS) {
    document.querySelectorAll(seg.sel + ' button').forEach(b =>
      b.addEventListener('click', () => applyStroke({ [seg.prop]: b.dataset[seg.attr] })));
  }
  $('#st-w').addEventListener('change', e => applyStroke({ w: +e.target.value }));
  $('#st-miter').addEventListener('change', e => applyStroke({ miter: +e.target.value }));
  $('#st-dash').addEventListener('change', e => applyStroke({ dash: e.target.value }));

  function syncStrokePanel() {
    const st = selStroke();
    const on = !!st;
    setVal($('#st-w'), C.strokeProp(st, 'w'));
    setVal($('#st-miter'), C.strokeProp(st, 'miter'));
    setVal($('#st-dash'), st && st.dash ? st.dash.join(' ') : '');
    for (const el of [$('#st-w'), $('#st-miter'), $('#st-dash')]) el.disabled = !on;
    for (const seg of STROKE_SEGS) {
      const cur = C.strokeProp(st, seg.prop);
      document.querySelectorAll(seg.sel + ' button').forEach(b => {
        b.classList.toggle('on', on && b.dataset[seg.attr] === cur);
        b.disabled = !on;
      });
    }
  }

  // ---------- swatches ----------
  let swatchSig = null;

  function applySwatch(i) {
    const sw = (state.doc.swatches || [])[i];
    if (!sw) return;
    state.swatchSel = i;
    pushColor(C.swatchColor(sw), false);
  }

  function renameSwatchAt(i) {
    const sw = (state.doc.swatches || [])[i];
    if (!sw) return;
    const name = window.prompt('Swatch name', sw.name);
    if (name != null && name.trim()) mutate(d => C.renameSwatch(d, i, name));
  }

  function renderSwatches() {
    const list = state.doc.swatches || [];
    if (state.swatchSel >= list.length) state.swatchSel = -1;
    const sig = list.map(s => s.name + '|' + C.swatchKey(s)).join('\n') + '#' + state.swatchSel;
    if (sig === swatchSig) return;
    swatchSig = sig;
    const grid = $('#swatchgrid');
    grid.innerHTML = '';
    const none = document.createElement('div');
    none.className = 'swatch noneswatch';
    none.title = 'None';
    none.addEventListener('click', () => pushColor(null, false));
    grid.appendChild(none);
    list.forEach((sw, i) => {
      const el = document.createElement('div');
      el.className = 'swatch' + (sw.spot ? ' spot' : '') + (state.swatchSel === i ? ' sel' : '');
      el.style.background = C.rgbToHex(sw.rgb);
      el.title = sw.name + (sw.spot ? ' — spot ink' : '');
      el.dataset.swatch = String(i);
      el.addEventListener('click', () => applySwatch(i));
      el.addEventListener('dblclick', () => renameSwatchAt(i));
      grid.appendChild(el);
    });
    const sel = list[state.swatchSel];
    $('#swatchname').textContent = sel ? sel.name + (sel.spot ? ' — spot ink' : '') : '—';
    $('#sw-rename').disabled = $('#sw-delete').disabled = !sel;
  }

  $('#sw-new').addEventListener('click', addCurrentSwatch);
  $('#fs-tosw').addEventListener('click', addCurrentSwatch);
  function addCurrentSwatch() {
    const col = state.pick[state.target];
    if (!col) return;
    mutate(d => C.addSwatch(d, col));
    state.swatchSel = C.findSwatch(state.doc, col);
    render();
  }
  $('#sw-rename').addEventListener('click', () => renameSwatchAt(state.swatchSel));
  $('#sw-delete').addEventListener('click', () => {
    const i = state.swatchSel;
    if (i < 0) return;
    mutate(d => C.removeSwatch(d, i));
    state.swatchSel = -1;
    render();
  });

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

  // ---------- separations ----------
  function docInks() { return SEP.documentInks(state.doc); }

  function selectedInk() {
    return state.inkSel ? docInks().find(i => i.key === state.inkSel) || null : null;
  }

  function setInkVisible(keys) { // null = composite preview
    state.inkVisible = keys;
    renderSeparations();
    render();
  }

  function toggleInk(key) {
    const all = docInks().map(i => i.key);
    const vis = new Set(state.inkVisible || all);
    if (vis.has(key)) vis.delete(key); else vis.add(key);
    setInkVisible(vis.size === all.length ? null : vis);
  }

  function renderSeparations() {
    const ul = $('#inklist');
    if (!ul) return;
    const inks = docInks();
    if (state.inkSel && !inks.some(i => i.key === state.inkSel)) state.inkSel = null;
    ul.innerHTML = '';
    for (const ink of inks) {
      const on = !state.inkVisible || state.inkVisible.has(ink.key);
      const li = document.createElement('li');
      li.className = (ink.key === state.inkSel ? 'sel ' : '') + (ink.objects ? '' : 'unused');
      const eye = document.createElement('span');
      eye.className = 'eye' + (on ? ' on' : '');
      eye.textContent = on ? '◉' : '○';
      eye.title = 'Separation preview: show only the inks you leave on';
      eye.addEventListener('click', () => toggleInk(ink.key));
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = SEP.cmykToHex(ink.cmyk);
      const name = document.createElement('span');
      name.className = 'iname';
      name.textContent = ink.name;
      name.title = ink.name + ' — ' + ink.objects + ' object' + (ink.objects === 1 ? '' : 's');
      name.addEventListener('click', () => {
        state.inkSel = state.inkSel === ink.key ? null : ink.key;
        renderSeparations();
      });
      const badge = document.createElement('span');
      badge.className = 'ibadge';
      badge.textContent = ink.type === 'spot' ? 'SPOT' : 'PROC';
      const count = document.createElement('span');
      count.className = 'icount';
      count.textContent = ink.objects;
      li.append(eye, chip, name, badge, count);
      ul.appendChild(li);
    }
    if (!inks.length) {
      const li = document.createElement('li');
      li.textContent = 'No printable artwork';
      li.style.color = 'var(--text-dim)';
      ul.appendChild(li);
    }

    const ink = selectedInk();
    $('#ink-all').classList.toggle('on', !state.inkVisible);
    $('#ink-rename').disabled = !ink || ink.type !== 'spot';
    $('#ink-merge').disabled = !ink || inks.length < 2;
    $('#ink-delete').disabled = !ink || ink.type !== 'spot' || ink.objects > 0;
    const conv = $('#ink-convert');
    conv.textContent = ink && ink.type === 'spot' ? '→ Process' : '→ Spot';
    conv.disabled = !ink || ink.objects === 0;
    $('#ink-plates').disabled = !inks.some(i => i.objects > 0);
    syncOverprintButtons();
    renderPreflight();
  }

  // The overprint segment acts on the selection, so it follows selection
  // changes (render) as well as document changes (renderSeparations).
  function syncOverprintButtons() {
    const shapes = selShapes();
    const on = shapes.length && shapes.every(s => s.overprint === true);
    const off = shapes.length && shapes.every(s => s.overprint === false);
    document.querySelectorAll('.subrow button[data-op]').forEach(b => {
      b.disabled = !state.sel.size;
      b.classList.toggle('on', shapes.length > 0 &&
        (b.dataset.op === 'on' ? on : b.dataset.op === 'off' ? off : !on && !off));
    });
  }

  function renderPreflight() {
    const box = $('#preflight');
    if (!box) return;
    box.innerHTML = '';
    if (!state.issues) return;
    if (!state.issues.length) {
      box.appendChild(issueRow('ok', 'No preflight problems found.'));
      return;
    }
    for (const it of state.issues) box.appendChild(issueRow(it.level, it.message, it.ids));
  }

  function issueRow(level, message, ids) {
    const div = document.createElement('div');
    div.className = 'issue' + (level === 'error' ? ' error' : level === 'ok' ? ' ok' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = level === 'ok' ? '✓' : '▲';
    const txt = document.createElement('span');
    txt.textContent = message;
    if (ids && ids.length) { // click an issue to select what it is about
      txt.style.cursor = 'pointer';
      txt.title = 'Select the affected objects';
      txt.addEventListener('click', () => { setSel(ids); render(); });
    }
    div.append(dot, txt);
    return div;
  }

  function doPreflight() {
    state.issues = SEP.preflight(state.doc);
    renderPreflight();
    return state.issues;
  }

  function setSelOverprint(mode) {
    if (!state.sel.size) return;
    mutate(d => SEP.setOverprint(d, [...state.sel], mode === 'auto' ? null : mode === 'on'));
  }

  function doRenameInk() {
    const ink = selectedInk();
    if (!ink || ink.type !== 'spot') return;
    const nm = window.prompt('Rename ink "' + ink.name + '" to:', ink.name);
    if (!nm || !nm.trim() || nm.trim() === ink.name) return;
    mutate(d => SEP.renameInk(d, ink.key, nm.trim()));
    state.inkSel = SEP.inkKey(nm);
    renderSeparations();
  }

  function doConvertInk() {
    const ink = selectedInk();
    if (!ink || !ink.objects) return;
    if (ink.type === 'spot') {
      if (!window.confirm('Convert "' + ink.name + '" to a process build? ' +
        ink.objects + ' object(s) will print on CMYK plates instead of their own.')) return;
      mutate(d => SEP.convertSpotToProcess(d, ink.key));
      state.inkSel = null;
    } else {
      const nm = window.prompt('New spot ink name for objects printing only in ' + ink.name + ':',
        ink.name.toUpperCase());
      if (!nm || !nm.trim()) return;
      const n = SEP.convertProcessToSpot(C.parseDoc(C.serializeDoc(state.doc)), ink.key, nm.trim());
      if (!n) {
        window.alert('No object prints in ' + ink.name + ' alone, so there is nothing to move ' +
          'onto a spot plate. (Objects that mix it with other process inks stay put.)');
        return;
      }
      mutate(d => SEP.convertProcessToSpot(d, ink.key, nm.trim()));
      state.inkSel = SEP.inkKey(nm);
    }
    renderSeparations();
  }

  function doMergeInk() {
    const ink = selectedInk();
    if (!ink) return;
    const others = docInks().filter(i => i.key !== ink.key);
    if (!others.length) return;
    const nm = window.prompt('Merge "' + ink.name + '" into which ink?\n\n' +
      others.map(i => '· ' + i.name).join('\n'), others[0].name);
    if (!nm || !nm.trim()) return;
    const target = others.find(i => i.key === SEP.inkKey(nm));
    if (!target) { window.alert('No ink named "' + nm + '" in this document.'); return; }
    mutate(d => SEP.mergeInks(d, ink.key, target.key));
    state.inkSel = target.key;
    renderSeparations();
  }

  function doDeleteInk() {
    const ink = selectedInk();
    if (!ink) return;
    if (!SEP.deleteInk(C.parseDoc(C.serializeDoc(state.doc)), ink.key)) {
      window.alert('"' + ink.name + '" is still used by ' + ink.objects +
        ' object(s), so it cannot be deleted. Merge or convert it first.');
      return;
    }
    mutate(d => SEP.deleteInk(d, ink.key));
    state.inkSel = null;
    renderSeparations();
  }

  // One PDF per ink, downloaded back to back. Preflight warnings are shown
  // first so nobody plates a job with RGB or hairlines still in it.
  function exportPlates() {
    const issues = doPreflight();
    const blocking = issues.filter(i => i.level === 'error');
    if (blocking.length) { window.alert('Cannot plate:\n\n' + blocking.map(i => '· ' + i.message).join('\n')); return; }
    if (issues.length && !window.confirm('Preflight found:\n\n' +
      issues.map(i => '· ' + i.message).join('\n') + '\n\nExport plates anyway?')) return;
    let plates;
    try {
      plates = PDFIO.exportPlatePDFs(state.doc);
    } catch (err) {
      window.alert('Plate export failed: ' + err.message);
      return;
    }
    plates.forEach((p, i) => {
      setTimeout(() => VecPDF.downloadBytes(p.bytes, p.filename), i * 150);
    });
    return plates;
  }

  $('#ink-all').addEventListener('click', () => setInkVisible(null));
  $('#ink-rename').addEventListener('click', doRenameInk);
  $('#ink-convert').addEventListener('click', doConvertInk);
  $('#ink-merge').addEventListener('click', doMergeInk);
  $('#ink-delete').addEventListener('click', doDeleteInk);
  $('#ink-preflight').addEventListener('click', doPreflight);
  $('#ink-plates').addEventListener('click', exportPlates);
  document.querySelectorAll('.subrow button[data-op]').forEach(b =>
    b.addEventListener('click', () => setSelOverprint(b.dataset.op)));

  // ---------- menus ----------
  const MENUS = {
    file: [
      { label: 'New', run: newFile },
      { label: 'Open…', kbd: '⌘O', run: openFile },
      { label: 'Place Image…', run: placeImage },
      { label: 'Save', kbd: '⌘S', run: saveFile },
      { label: 'Export PDF', kbd: '⌘E', run: exportPdfFile, enabled: () => state.doc.shapes.length > 0 },
      { label: 'Export Separation Plates…', kbd: '⇧⌘E', run: exportPlates, enabled: () => state.doc.shapes.length > 0 },
      { label: 'Preflight', run: doPreflight, enabled: () => state.doc.shapes.length > 0 },
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
      { label: 'Lock Selection', kbd: '⌘2', run: () => doLock(), enabled: () => state.sel.size > 0 },
      { label: 'Unlock All', kbd: '⌥⌘2', run: () => doUnlockAll(), enabled: () => state.doc.shapes.some(s => s.locked) },
      { label: 'Hide Selection', kbd: '⌘3', run: () => doHide(), enabled: () => state.sel.size > 0 },
      { label: 'Show All', kbd: '⌥⌘3', run: () => doShowAll(), enabled: () => state.doc.shapes.some(s => s.hidden) },
      { label: 'Overprint', run: () => setSelOverprint('on'), enabled: () => state.sel.size > 0 },
      { label: 'Knock Out', run: () => setSelOverprint('off'), enabled: () => state.sel.size > 0 },
      { label: 'Overprint: Auto', run: () => setSelOverprint('auto'), enabled: () => state.sel.size > 0 },
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
    setSel(selectableShapes().map(s => s.id));
    render();
  }
  // Illustrator drops the selection once it goes out of reach.
  function doLock() {
    if (!state.sel.size) return;
    mutate(d => C.lockShapes(d, [...state.sel], true));
    state.sel.clear();
    render();
  }
  function doHide() {
    if (!state.sel.size) return;
    mutate(d => C.hideShapes(d, [...state.sel], true));
    state.sel.clear();
    render();
  }
  function doUnlockAll() { mutate(d => C.unlockAll(d)); }
  function doShowAll() { mutate(d => C.showAll(d)); }
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
    if (state.tool === 'pen' && t !== 'pen') penFinish(false);
    state.drag = state.draw = null;
    state.tool = t;
    document.querySelectorAll('#toolbar button[data-tool]').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === t));
    stagewrap.className = 'tool-' + t;
    updateReadouts();
  }

  document.querySelectorAll('#toolbar button[data-tool]').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  // ---------- drawing tools (rect / ellipse / pen) ----------
  // Ai's default appearance for freshly drawn art — every tool draws with it,
  // open pen paths included.
  function newStyle() { return { fill: '#ffffff', stroke: { color: '#1d1d1b', w: 1 } }; }

  // Screen-pixel pick radius expressed in world units, so tolerances feel the
  // same at every zoom level.
  function pickTol(px) { return px / state.view.scale; }

  function addDrawnShape(name, cmds, style) {
    let id = null;
    mutate(d => { id = C.addShape(d, { type: 'path', name, ...style, cmds }).id; });
    setSel([id]);
    return id;
  }

  function drawnRect(d) {
    return C.dragRect(d.wx0, d.wy0, d.wx1, d.wy1, d.square, d.center);
  }
  function drawnCmds(d) {
    const r = drawnRect(d);
    return d.tool === 'rect'
      ? C.rectPath(r.x, r.y, r.w, r.h)
      : C.ellipsePath(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2);
  }

  function onShapeToolDown(e) {
    const [wx, wy] = worldPt(e);
    state.draw = {
      tool: state.tool, wx0: wx, wy0: wy, wx1: wx, wy1: wy,
      square: e.shiftKey, center: e.altKey,
    };
    canvas.setPointerCapture(e.pointerId);
  }
  function onShapeToolMove(e, wx, wy) {
    const d = state.draw;
    d.wx1 = wx; d.wy1 = wy;
    d.square = e.shiftKey; d.center = e.altKey;
    render();
  }
  function onShapeToolUp() {
    const d = state.draw;
    state.draw = null;
    const r = drawnRect(d);
    // a click (or a hairline drag) draws nothing, like Ai
    if (r.w * state.view.scale >= 1 && r.h * state.view.scale >= 1) {
      addDrawnShape(d.tool === 'rect' ? 'Rectangle' : 'Ellipse', drawnCmds(d), newStyle());
    }
    render();
  }

  // The pen path lives outside the document until it is finished, so one drawn
  // path is one undo step.
  function penSub() { return { anchors: state.pen.anchors, closed: state.pen.closed }; }

  function penFinish(close) {
    const p = state.pen;
    state.pen = null;
    stagewrap.classList.remove('pen-close');
    if (!p) return;
    if (close) p.closed = true;
    if (p.anchors.length >= 2) {
      addDrawnShape('Path', C.anchorsToPath([{ anchors: p.anchors, closed: p.closed }]), newStyle());
    }
    render();
  }

  function penCancelPoint() {
    const p = state.pen;
    if (!p || !p.drag) return false;
    if (p.drag.isNew) p.anchors.pop();
    p.drag = null;
    if (!p.anchors.length) state.pen = null;
    render();
    return true;
  }

  function penCloseTarget(wx, wy) {
    const p = state.pen;
    if (!p || p.anchors.length < 2) return false;
    const a0 = p.anchors[0];
    return Math.hypot(a0.x - wx, a0.y - wy) <= pickTol(6);
  }

  function onPenDown(e) {
    const [wx, wy] = worldPt(e);
    canvas.setPointerCapture(e.pointerId);
    const p = state.pen;
    if (p && penCloseTarget(wx, wy)) {
      // drag while closing shapes the joining curve through the first anchor
      p.drag = { idx: 0, isNew: false, closing: true, broke: false };
      render();
      return;
    }
    if (p && p.anchors.length) {
      const last = p.anchors[p.anchors.length - 1];
      if (Math.hypot(last.x - wx, last.y - wy) <= pickTol(6)) {
        last.out = null; // click the live anchor to make the next segment leave straight
        render();
        return;
      }
    }
    if (!p) state.pen = { anchors: [], closed: false, drag: null, hover: null, hoverClose: false };
    state.pen.anchors.push({ x: wx, y: wy, in: null, out: null });
    state.pen.drag = { idx: state.pen.anchors.length - 1, isNew: true, closing: false, broke: false };
    render();
  }

  function onPenMove(e, wx, wy) {
    const p = state.pen;
    if (!p) return;
    p.hover = [wx, wy];
    if (p.drag) {
      // Alt at any point during the drag breaks the pair for good, so the two
      // handles stay independent even after the key comes back up.
      p.drag.broke = p.drag.broke || e.altKey;
      C.moveHandle(penSub(), p.drag.idx, 'out', wx, wy, p.drag.broke ? 'none' : 'full');
    } else {
      p.hoverClose = penCloseTarget(wx, wy);
      stagewrap.classList.toggle('pen-close', p.hoverClose);
    }
    render();
  }

  function onPenUp() {
    const p = state.pen;
    if (!p || !p.drag) return;
    const closing = p.drag.closing;
    p.drag = null;
    if (closing) penFinish(true);
    else render();
  }

  // ---------- direct selection ----------
  function anchorSel(id) {
    let s = state.asel.get(id);
    if (!s) { s = new Set(); state.asel.set(id, s); }
    return s;
  }
  function anchorSelSize() {
    let n = 0;
    for (const s of state.asel.values()) n += s.size;
    return n;
  }
  // Ai shows the handles of every selected anchor plus the neighbouring handle
  // on each segment that touches one.
  function liveHandleKeys(subs, sel) {
    const live = new Set();
    subs.forEach((sub, si) => {
      const n = sub.anchors.length;
      sub.anchors.forEach((a, ai) => {
        if (!sel.has(C.anchorKey(si, ai))) return;
        live.add(C.handleKey(si, ai, 'in'));
        live.add(C.handleKey(si, ai, 'out'));
        const prev = ai > 0 ? ai - 1 : (sub.closed ? n - 1 : -1);
        const next = ai < n - 1 ? ai + 1 : (sub.closed ? 0 : -1);
        if (prev >= 0) live.add(C.handleKey(si, prev, 'out'));
        if (next >= 0) live.add(C.handleKey(si, next, 'in'));
      });
    });
    return live;
  }

  function onDirectDown(e) {
    const [sx, sy] = screenPt(e);
    const [wx, wy] = worldPt(e);
    const tol = pickTol(5);
    canvas.setPointerCapture(e.pointerId);

    // 1) a live handle beats everything — it is drawn on top
    for (const s of selShapes()) {
      const subs = C.pathToAnchors(s.cmds);
      const hh = C.hitAnchorHandle(subs, wx, wy, tol, liveHandleKeys(subs, anchorSel(s.id)));
      if (!hh) continue;
      state.drag = { kind: 'handle', id: s.id, subs, ...hh, broke: false, moved: false };
      return;
    }

    // 2) an anchor: pick it (shift toggles), then drag every selected anchor
    for (const s of selShapes()) {
      const ha = C.hitAnchor(C.pathToAnchors(s.cmds), wx, wy, tol);
      if (!ha) continue;
      const key = C.anchorKey(ha.si, ha.ai);
      const sel = anchorSel(s.id);
      if (e.shiftKey) {
        if (sel.has(key)) { sel.delete(key); render(); return; }
        sel.add(key);
      } else if (!sel.has(key)) {
        state.asel.clear();
        anchorSel(s.id).add(key);
      }
      state.drag = { kind: 'anchors', wx0: wx, wy0: wy, snap: snapshotAnchors(), moved: false };
      render();
      return;
    }

    // 3) the path body: select the object and show its anchors, drag moves it
    const hit = hitAt(wx, wy);
    if (hit) {
      if (!state.sel.has(hit.id)) setSel([hit.id]);
      state.drag = { // no alt-duplicate here — Alt means "break the handle" for this tool
        kind: 'move', wx0: wx, wy0: wy,
        alt: false, dupDone: true, orig: snapshotSel(), moved: false,
      };
      render();
      return;
    }

    // 4) empty space: marquee across every anchor in range
    state.drag = { kind: 'amarquee', m0: [sx, sy], m1: [sx, sy], shift: e.shiftKey, moved: false };
  }

  function snapshotAnchors() {
    const snap = new Map();
    for (const s of selShapes()) {
      if (state.asel.has(s.id)) snap.set(s.id, C.pathToAnchors(s.cmds));
    }
    return snap;
  }

  function onAnchorDragMove(d, wx, wy) {
    const dx = wx - d.wx0, dy = wy - d.wy0;
    if (!d.moved && Math.hypot(dx, dy) * state.view.scale < 3) return; // click slack
    d.moved = true;
    const byId = new Map(state.doc.shapes.map(s => [s.id, s]));
    for (const [id, subs0] of d.snap) {
      const s = byId.get(id);
      if (!s) continue;
      const subs = JSON.parse(JSON.stringify(subs0)); // always offset from the original
      for (const key of state.asel.get(id) || []) {
        const [si, ai] = key.split(':').map(Number);
        if (subs[si]) C.moveAnchor(subs[si], ai, dx, dy);
      }
      s.cmds = C.anchorsToPath(subs);
    }
    render();
  }

  function onHandleDragMove(d, e, wx, wy) {
    const s = state.doc.shapes.find(x => x.id === d.id);
    if (!s) return;
    d.broke = d.broke || e.altKey;
    d.moved = true;
    C.moveHandle(d.subs[d.si], d.ai, d.which, wx, wy, d.broke ? 'none' : undefined);
    s.cmds = C.anchorsToPath(d.subs);
    render();
  }

  function finishAnchorMarquee(d) {
    const v = state.view;
    const [ax, ay] = C.s2w(v, Math.min(d.m0[0], d.m1[0]), Math.min(d.m0[1], d.m1[1]));
    const [bx, by] = C.s2w(v, Math.max(d.m0[0], d.m1[0]), Math.max(d.m0[1], d.m1[1]));
    const rect = { x: ax, y: ay, w: bx - ax, h: by - ay };
    const ok = selectableLayers();
    const picked = new Map();
    for (const s of state.doc.shapes) {
      if (!ok.has(s.layer)) continue;
      const keys = C.anchorsInRect(C.pathToAnchors(s.cmds), rect);
      if (keys.length) picked.set(s.id, new Set(keys));
    }
    if (d.shift) {
      for (const [id, keys] of picked) keys.forEach(k => anchorSel(id).add(k));
      state.sel = new Set([...state.sel, ...picked.keys()]);
    } else {
      state.sel = new Set(picked.keys());
      state.asel = picked;
    }
    render();
  }

  function doDeleteAnchors() {
    const drop = [];
    mutate(d => {
      for (const [id, keys] of state.asel) {
        const s = d.shapes.find(x => x.id === id);
        if (!s || !keys.size) continue;
        const subs = C.deleteAnchors(C.pathToAnchors(s.cmds), keys);
        if (subs.length) s.cmds = C.anchorsToPath(subs);
        else drop.push(id);
      }
      if (drop.length) d.shapes = d.shapes.filter(s => !drop.includes(s.id));
    });
    drop.forEach(id => state.sel.delete(id));
    state.asel.clear();
    render();
  }

  // ---------- pointer: pan / zoom-click ----------
  function panActive(e) {
    return state.tool === 'hand' || state.space || e.button === 1;
  }

  canvas.addEventListener('pointerdown', e => {
    blurPanelField();
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
    if (e.button !== 0) return;
    if (state.tool === 'rect' || state.tool === 'ellipse') { onShapeToolDown(e); return; }
    if (state.tool === 'pen') { onPenDown(e); return; }
    if (state.tool === 'direct') { onDirectDown(e); return; }
    if (state.tool !== 'select') return;

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
    if (state.draw) onShapeToolMove(e, wx, wy);
    if (state.tool === 'pen') onPenMove(e, wx, wy);
    const d = state.drag;
    if (d) {
      if (d.kind === 'handle') {
        onHandleDragMove(d, e, wx, wy);
      } else if (d.kind === 'anchors') {
        onAnchorDragMove(d, wx, wy);
      } else if (d.kind === 'move') {
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
        d.da = da;
        applyDragMatrix(C.mRotate(da, d.cx, d.cy));
        render();
      } else if (d.kind === 'marquee' || d.kind === 'amarquee') {
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
    if (state.draw) { onShapeToolUp(); return; }
    if (state.tool === 'pen') { onPenUp(); return; }
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.kind === 'amarquee') {
      if (!d.moved) {
        if (!d.shift) { state.sel.clear(); state.asel.clear(); render(); }
        return;
      }
      finishAnchorMarquee(d);
    } else if (d.kind === 'marquee') {
      if (!d.moved) {
        if (!d.shift) { state.sel.clear(); render(); }
        return;
      }
      const v = state.view;
      const [ax, ay] = C.s2w(v, Math.min(d.m0[0], d.m1[0]), Math.min(d.m0[1], d.m1[1]));
      const [bx, by] = C.s2w(v, Math.max(d.m0[0], d.m1[0]), Math.max(d.m0[1], d.m1[1]));
      const rect = { x: ax, y: ay, w: bx - ax, h: by - ay };
      const ids = selectableShapes()
        .filter(s => { const b = C.tightBBox(s.cmds); return b && C.rectsIntersect(b, rect); })
        .map(s => s.id);
      setSel(d.shift ? [...state.sel, ...ids] : ids);
      render();
    } else if (d.moved) {
      // keep the Transform panel's rotate readout in step with handle drags
      if (d.kind === 'rotate' && d.da) {
        const deg = d.da / C.DEG;
        for (const s of state.doc.shapes) {
          if (state.sel.has(s.id)) s.angle = C.normAngle((s.angle || 0) + deg);
        }
      }
      commitNow();
      refreshDoc();
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
    // Panel fields own their keystrokes; only the app-level modifiers get through.
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target && e.target.tagName);
    if (inField && e.key === 'Escape') { e.target.blur(); return; }
    if (inField && !mod) return;
    if (e.key === 'Escape') {
      closeMenu();
      if (state.draw) { state.draw = null; render(); return; }
      if (state.pen) {
        // mid-drag Escape throws away the point being placed; otherwise it
        // ends the path and keeps what is drawn so far
        if (!penCancelPoint()) penFinish(false);
        return;
      }
      if (state.sel.size || state.asel.size) { state.sel.clear(); state.asel.clear(); render(); }
      return;
    }
    if (e.key === 'Enter' && state.pen) { penFinish(false); e.preventDefault(); return; }
    if (mod && (k === 'y' || (e.shiftKey && k === 'z'))) { doRedo(); e.preventDefault(); return; }
    if (mod && k === 'z') { doUndo(); e.preventDefault(); return; }
    if (mod && k === 's') { saveFile(); e.preventDefault(); return; }
    if (mod && k === 'o') { openFile(); e.preventDefault(); return; }
    if (mod && k === 'e') { e.shiftKey ? exportPlates() : exportPdfFile(); e.preventDefault(); return; }
    if (mod && k === 'a') { selectAll(); e.preventDefault(); return; }
    if (mod && k === 'g') { e.shiftKey ? doUngroup() : doGroup(); e.preventDefault(); return; }
    // e.code, because Alt+digit rewrites e.key on some keyboard layouts
    if (mod && e.code === 'Digit2') { e.altKey ? doUnlockAll() : doLock(); e.preventDefault(); return; }
    if (mod && e.code === 'Digit3') { e.altKey ? doShowAll() : doHide(); e.preventDefault(); return; }
    if (mod && e.key === ']') { doArrange(e.shiftKey ? 'front' : 'forward'); e.preventDefault(); return; }
    if (mod && e.key === '[') { doArrange(e.shiftKey ? 'back' : 'backward'); e.preventDefault(); return; }
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      anchorSelSize() ? doDeleteAnchors() : doDelete();
      e.preventDefault();
      return;
    }
    if (!mod && e.key.startsWith('Arrow') && state.sel.size) {
      const step = e.shiftKey ? 10 : 1;
      nudge(
        e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      e.preventDefault();
      return;
    }
    if (!mod && k === 'x') {
      if (e.shiftKey) swapPaints(); else setTarget(state.target === 'fill' ? 'stroke' : 'fill');
      e.preventDefault();
      return;
    }
    if (!mod && k === 'd' && !e.shiftKey) { defaultPaints(); e.preventDefault(); return; }
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
  setRef(state.ref);
  bindTrace();
  renderLayers();
  renderSeparations();
  resize();

  // debug handle
  window.VEC_STUDIO = {
    state, render, setTool, fitArtboard, VECCORE: C, VECTRACE: TR,
    mutate, doUndo, doRedo, newFile, openFile, saveFile, applyNewDoc,
    openAnyFile, exportPdfFile,
    setSel, selectAll, doGroup, doUngroup, doArrange, doDelete, nudge,
    renderLayers, markLayerRows, updateTransform, applyTransformField, setRef,
    doAddLayer, doDuplicateLayer, doDeleteLayer, doLock, doHide, doUnlockAll, doShowAll,
    setTarget, pushColor, pushOpacity, swapPaints, defaultPaints,
    applyStroke, applySwatch, addCurrentSwatch, renameSwatchAt,
    penFinish, doDeleteAnchors,
    placeImage, addPlacedImage, selectedImage, bitmapOf, traceOpts,
    runTracePreview, expandTrace, applyPreset,
    SEPARATE: SEP, PDFIO, docInks, setInkVisible, toggleInk, renderSeparations,
    doPreflight, exportPlates, setSelOverprint,
    doRenameInk, doConvertInk, doMergeInk, doDeleteInk,
  };
})();
