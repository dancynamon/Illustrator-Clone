// studio_app — UI wiring for Aquamentor Vector Studio.
// Thin layer over VECCORE: canvas rendering, pan/zoom, tool state, panels.
(() => {
  'use strict';
  const C = window.VECCORE;
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
    target: 'fill',      // which paint the color picker and swatches drive
    paint: null,         // {fill, stroke} current paints — null means "none"
    pick: null,          // {fill, stroke} last real color per target, for the picker
    colorModel: 'rgb',   // picker entry mode: rgb | cmyk | hsb
    swatchSel: -1,       // selected swatch index in doc.swatches
  };
  state.history = C.newHistory(state.doc);
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
  fileInput.accept = '.aqv,.json,.pdf,.ai,application/json,application/pdf';
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
    else openAqvFile(f);
  }

  // drag & drop anywhere: .aqv/.json projects and .pdf/.ai vector imports
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /\.(aqv|json|pdf|ai)$/i.test(f.name)) openAnyFile(f);
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

  // Offsetting is the costly part of an aligned stroke, so hold the last
  // result per shape and redo it only when the geometry — or the stroke that
  // shaped it — changes. Drags replace s.cmds outright, so identity is enough.
  const offsetCache = new WeakMap();
  function alignedPath(s) {
    const st = s.stroke;
    const key = C.strokeProp(st, 'align') + '|' + st.w + '|' +
      C.strokeProp(st, 'join') + '|' + C.strokeProp(st, 'miter');
    const hit = offsetCache.get(s);
    if (hit && hit.key === key && hit.cmds === s.cmds) return hit.path;
    const path = C.strokeOffsetPath(s.cmds, st);
    offsetCache.set(s, { key, cmds: s.cmds, path });
    return path;
  }

  // Canvas only centers strokes. An inside or outside stroke is a centered one
  // riding the path offset half a weight to that side, which is what keeps
  // caps, joins and dashes at their true size. The clip stays as a backstop:
  // it is what stops the stroke leaking across the edge where the shape is
  // thinner than the stroke, and it covers the case where the offset collapses
  // altogether. The current path on entry is the shape's, left by the fill pass.
  function strokeShape(s) {
    const st = s.stroke;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.w;
    ctx.lineCap = C.strokeProp(st, 'cap');
    ctx.lineJoin = C.strokeProp(st, 'join');
    ctx.miterLimit = C.strokeProp(st, 'miter');
    ctx.setLineDash(st.dash || []);
    const align = C.strokeProp(st, 'align');
    if (align !== 'center') {
      ctx.save();
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
      const off = alignedPath(s);
      if (off) drawPath(off);
      else { ctx.lineWidth = st.w * 2; drawPath(s.cmds); } // offset ate the shape
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
    for (const s of state.doc.shapes) {
      if (hidden.has(s.layer)) continue;
      ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
      drawPath(s.cmds);
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke) strokeShape(s);
    }
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
    syncPaintPanel();
    syncStrokePanel();
    renderSwatches();
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

  // ---------- menus ----------
  const MENUS = {
    file: [
      { label: 'New', run: newFile },
      { label: 'Open…', kbd: '⌘O', run: openFile },
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
    // Panel fields own their keystrokes; only the app-level modifiers get through.
    const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target && e.target.tagName);
    if (inField && e.key === 'Escape') { e.target.blur(); return; }
    if (inField && !mod) return;
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
  renderLayers();
  resize();

  // debug handle
  window.VEC_STUDIO = {
    state, render, setTool, fitArtboard, VECCORE: C,
    mutate, doUndo, doRedo, newFile, openFile, saveFile, applyNewDoc,
    openAnyFile, exportPdfFile,
    setSel, selectAll, doGroup, doUngroup, doArrange, doDelete, nudge,
    setTarget, pushColor, pushOpacity, swapPaints, defaultPaints,
    applyStroke, applySwatch, addCurrentSwatch, renameSwatchAt,
  };
})();
