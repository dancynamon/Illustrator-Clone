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
  fileInput.accept = '.aqv,.json,application/json';
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
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
  });
  function openFile() { fileInput.click(); }

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
      drawPath(s.cmds);
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.stroke) { ctx.strokeStyle = s.stroke.color; ctx.lineWidth = s.stroke.w; ctx.stroke(); }
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

  // ---------- menus ----------
  const MENUS = {
    file: [
      { label: 'New', run: newFile },
      { label: 'Open…', kbd: '⌘O', run: openFile },
      { label: 'Save', kbd: '⌘S', run: saveFile },
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
  renderLayers();
  resize();

  // debug handle
  window.VEC_STUDIO = {
    state, render, setTool, fitArtboard, VECCORE: C,
    mutate, doUndo, doRedo, newFile, openFile, saveFile, applyNewDoc,
    setSel, selectAll, doGroup, doUngroup, doArrange, doDelete, nudge,
  };
})();
