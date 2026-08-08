// studio_app — UI wiring for Aquamentor Vector Studio.
// Thin layer over VECCORE: canvas rendering, pan/zoom, tool state, panels.
(() => {
  'use strict';
  const C = window.VECCORE;
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
    drag: null,          // select-tool drag state machine
    sel: new Set(),      // selected shape ids (always group-expanded)
    autoFit: true,       // keep fitting on resize until the user changes the view
    inkVisible: null,    // null = composite; Set of ink keys = separation preview
    inkSel: null,        // ink key the Separations panel acts on
    issues: null,        // last preflight result (null until run)
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
    renderSeparations();
    render();
  }

  function refreshDoc() {
    // drop selection ids that no longer exist in the current doc
    const alive = new Set(state.doc.shapes.map(s => s.id));
    state.sel = new Set([...state.sel].filter(id => alive.has(id)));
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
    state.sel.clear();
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
    const inks = state.inkVisible; // separation preview: repaint per visible ink
    for (const s of state.doc.shapes) {
      if (hidden.has(s.layer)) continue;
      const fill = s.fill && (inks ? SEP.previewHex(s.fill, s.fillInfo, inks) : s.fill);
      const stroke = s.stroke && (inks ? SEP.previewHex(s.stroke.color, s.strokeInfo, inks) : s.stroke.color);
      if (inks && !fill && !stroke) continue; // lays down no visible ink
      ctx.globalAlpha = s.opacity != null ? s.opacity : 1;
      drawPath(s.cmds);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = s.stroke.w; ctx.stroke(); }
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
    syncOverprintButtons();
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
    if (mod && k === 'e') { e.shiftKey ? exportPlates() : exportPdfFile(); e.preventDefault(); return; }
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
  renderSeparations();
  resize();

  // debug handle
  window.VEC_STUDIO = {
    state, render, setTool, fitArtboard, VECCORE: C,
    mutate, doUndo, doRedo, newFile, openFile, saveFile, applyNewDoc,
    openAnyFile, exportPdfFile,
    setSel, selectAll, doGroup, doUngroup, doArrange, doDelete, nudge,
    SEPARATE: SEP, PDFIO, docInks, setInkVisible, toggleInk, renderSeparations,
    doPreflight, exportPlates, setSelOverprint,
    doRenameInk, doConvertInk, doMergeInk, doDeleteInk,
  };
})();
