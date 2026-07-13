// VECPDF — vector-PDF import/export for Aquamentor Vector Studio.
// Import is a port of the CAM engine's pdfparse.js (aqsrc/cam-engine), extended
// for studio use: instead of flattening everything to polylines for cutting, it
// keeps cubic beziers as veccore ['C'] commands, works in PDF points (doc units),
// flips PDF's y-up user space into veccore's y-down space via the page MediaBox,
// and captures appearance — fill/stroke color (g/G rg/RG k/K sc/scn/SC/SCN),
// line width (w, scaled by the CTM), and constant alpha from /ExtGState (gs).
// Each painting operator (f F f* S s B B* b b*) emits ONE shape carrying every
// subpath built since the last paint, so holes survive as compound paths.
// Modern .ai files are PDF-compatible, so the same parser opens both.
// Known gaps (same as the CAM parser unless noted): clip regions as geometry,
// inline image data (skipped), non-Flate stream filters, shading/pattern fills
// (painted with the last set color), and the even-odd fill rule (treated as
// nonzero — veccore renders and hit-tests nonzero only).
// Export writes a flat, uncompressed vector PDF at artboard size: one page,
// classic xref, DeviceRGB colors, /ExtGState alpha — every viewer opens it and
// parsePDFDoc round-trips it. This is the base the later OCG/spot-plate writer
// builds on.
const VECPDF = (() => {
  'use strict';

  // ---- byte <-> latin1 string (offsets preserved 1:1) ----
  function u8ToStr(u8, s, e) {
    s = s || 0; e = (e == null ? u8.length : e);
    let out = ''; const CH = 0x8000;
    for (let i = s; i < e; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(e, i + CH)));
    return out;
  }
  function strToU8(str) {
    const u8 = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xff;
    return u8;
  }

  // ---- DEFLATE / zlib inflate (RFC 1950/1951), synchronous & pure ----
  function pdfInflate(input) {
    let ip = 0;
    if (input.length >= 2) {               // zlib header? CM=8 (deflate) and (CMF<<8|FLG)%31==0
      const cmf = input[0], flg = input[1];
      if ((cmf & 0x0f) === 8 && (((cmf << 8) | flg) % 31) === 0) { ip = 2; if (flg & 0x20) ip += 4; }
    }
    let pos = ip, bitBuf = 0, bitCnt = 0;
    const out = [];
    function getbit() { if (bitCnt === 0) { bitBuf = input[pos++]; bitCnt = 8; } const b = bitBuf & 1; bitBuf >>= 1; bitCnt--; return b; }
    function getbits(k) { let v = 0; for (let i = 0; i < k; i++) v |= getbit() << i; return v; }
    function buildHuff(lengths, num) {     // canonical-Huffman "puff" tables: count[len] + symbols[]
      const count = new Array(16).fill(0);
      for (let i = 0; i < num; i++) count[lengths[i]]++;
      count[0] = 0;
      const offs = new Array(16).fill(0);
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
      const symbols = new Array(num);
      for (let i = 0; i < num; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
      return { count: count, symbols: symbols };
    }
    function decode(h) {                    // O(15) canonical decode, MSB-first code assembly
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= 15; len++) {
        code |= getbit();
        const cnt = h.count[len];
        if (code - first < cnt) return h.symbols[index + (code - first)];
        index += cnt; first += cnt; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: bad code');
    }
    const LB = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const LE = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const DB = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const DE = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    const fixedLitLen = new Array(288); for (let i = 0; i < 288; i++) fixedLitLen[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
    const fixedDistLen = new Array(30).fill(5);
    const fixedLit = buildHuff(fixedLitLen, 288), fixedDist = buildHuff(fixedDistLen, 30);
    function block(litH, distH) {
      for (;;) {
        const sym = decode(litH);
        if (sym === 256) break;
        if (sym < 256) { out.push(sym); continue; }
        const s = sym - 257, length = LB[s] + getbits(LE[s]);
        const ds = decode(distH), dist = DB[ds] + getbits(DE[ds]);
        let start = out.length - dist;
        for (let i = 0; i < length; i++) out.push(out[start + i]);
      }
    }
    let last;
    do {
      last = getbit();
      const type = getbits(2);
      if (type === 0) {                    // stored
        bitCnt = 0;                        // byte-align
        const len = input[pos] | (input[pos + 1] << 8); pos += 4;   // len + ~len
        for (let i = 0; i < len; i++) out.push(input[pos++]);
      } else if (type === 1) {
        block(fixedLit, fixedDist);
      } else if (type === 2) {
        const hlit = getbits(5) + 257, hdist = getbits(5) + 1, hclen = getbits(4) + 4;
        const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
        const cll = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) cll[order[i]] = getbits(3);
        const clH = buildHuff(cll, 19);
        const lens = new Array(hlit + hdist).fill(0);
        let i = 0;
        while (i < hlit + hdist) {
          const sym = decode(clH);
          if (sym < 16) lens[i++] = sym;
          else if (sym === 16) { const r = getbits(2) + 3, p = lens[i - 1]; for (let j = 0; j < r; j++) lens[i++] = p; }
          else if (sym === 17) { const r = getbits(3) + 3; for (let j = 0; j < r; j++) lens[i++] = 0; }
          else { const r = getbits(7) + 11; for (let j = 0; j < r; j++) lens[i++] = 0; }
        }
        block(buildHuff(lens.slice(0, hlit), hlit), buildHuff(lens.slice(hlit), hdist));
      } else throw new Error('inflate: bad block type');
    } while (!last);
    return Uint8Array.from(out);
  }

  // ---- affine compose (PDF row-vector convention: x'=a*x+c*y+e, y'=b*x+d*y+f) ----
  // Returns matrix applying M first, then C (used for `cm` concatenation onto the CTM).
  function matMul(M, C) {
    return [
      M[0]*C[0] + M[1]*C[2],
      M[0]*C[1] + M[1]*C[3],
      M[2]*C[0] + M[3]*C[2],
      M[2]*C[1] + M[3]*C[3],
      M[4]*C[0] + M[5]*C[2] + C[4],
      M[4]*C[1] + M[5]*C[3] + C[5]
    ];
  }

  function isWS(c) { return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0'; }
  function isDelim(c) { return c === '(' || c === ')' || c === '<' || c === '>' || c === '[' || c === ']' || c === '{' || c === '}' || c === '/' || c === '%'; }

  // Does an inflated stream look like a page content stream (path construction + a paint op)?
  function looksLikeContent(s) {
    const path = /(?:^|\s)(?:m|l|c|re)(?:\s|$)/.test(s);
    const paint = /(?:^|\s)(?:f|f\*|S|s|B|b)(?:\s|$)/.test(s);
    return path && paint;
  }

  // ---- colors ----
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : (isFinite(v) ? v : 0); }
  function hex2(v) { return Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'); }
  function rgbHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }
  function grayHex(g) { return rgbHex(g, g, g); }
  function cmykHex(c, m, y, k) {
    return rgbHex((1 - clamp01(c)) * (1 - clamp01(k)), (1 - clamp01(m)) * (1 - clamp01(k)), (1 - clamp01(y)) * (1 - clamp01(k)));
  }
  // sc/scn/SC/SCN carry 1 (gray/tint), 3 (rgb) or 4 (cmyk) numbers; a trailing
  // /Name operand (patterns) leaves the color as-is. Separation tints darken from white.
  function componentsHex(nums, prev) {
    if (nums.length >= 4) return cmykHex(nums[nums.length-4], nums[nums.length-3], nums[nums.length-2], nums[nums.length-1]);
    if (nums.length === 3) return rgbHex(nums[0], nums[1], nums[2]);
    if (nums.length === 1) return grayHex(nums[0]);
    return prev;
  }

  // Interpret one content stream, appending studio shapes (points, y-down) to `out`.
  function interpretContent(s, out, ctx) {
    ctx = ctx || {};
    const n = s.length;
    let i = 0;
    // Full graphics state; q/Q save/restore all of it (colors travel with the CTM).
    let gs = ctx.baseGS ? Object.assign({}, ctx.baseGS) : {
      ctm: [1, 0, 0, 1, 0, 0], fill: '#000000', stroke: '#000000', lw: 1, ca: 1, CA: 1,
    };
    if (ctx.baseCTM) gs.ctm = ctx.baseCTM.slice();
    const xobjMap = ctx.xobjMap || {};
    const gsMap = ctx.gsMap || {};
    const stack = [], ops = [];
    let cmds = [], cur = null, start = null, hasDraw = false, lastName = null;

    function tf(x, y) { const m = gs.ctm; return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]; }
    function scaleF() { const m = gs.ctm; return Math.sqrt(Math.abs(m[0]*m[3] - m[1]*m[2])); }
    function moveTo(x, y) { const p = tf(x, y); cmds.push(['M', p[0], p[1]]); cur = [x, y]; start = [x, y]; }
    function lineTo(x, y) {
      if (!cur) { moveTo(x, y); return; }
      const p = tf(x, y); cmds.push(['L', p[0], p[1]]); cur = [x, y]; hasDraw = true;
    }
    function curveTo(x1, y1, x2, y2, x3, y3) {
      if (!cur) moveTo(x1, y1);
      const c1 = tf(x1, y1), c2 = tf(x2, y2), e = tf(x3, y3);
      cmds.push(['C', c1[0], c1[1], c2[0], c2[1], e[0], e[1]]);
      cur = [x3, y3]; hasDraw = true;
    }
    function rect(x, y, w, h) {
      moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h);
      cmds.push(['Z']); cur = [x, y]; start = [x, y];
    }
    function closepath() {
      if (cur && cmds.length && cmds[cmds.length - 1][0] !== 'Z') {
        cmds.push(['Z']);
        if (start) cur = [start[0], start[1]];
        hasDraw = true;
      }
    }
    function resetPath() { cmds = []; cur = null; start = null; hasDraw = false; }
    // One shape per paint op: every subpath since the last paint, with the
    // appearance in force right now. `n` (and pure clip installs) discards.
    function paint(doFill, doStroke, close) {
      if (close) closepath();
      if (hasDraw && cmds.length >= 2) {
        const shape = {
          type: 'path',
          cmds: cmds,
          fill: doFill ? gs.fill : null,
          stroke: doStroke ? { color: gs.stroke, w: Math.max(gs.lw * scaleF(), 0.1) } : null,
          opacity: doFill ? gs.ca : gs.CA,
        };
        out.shapes.push(shape);
      }
      resetPath();
    }
    function doExtGState(name) {            // `/Name gs` -> constant alpha from the ExtGState dict
      if (!name) return;
      let dict = null;
      const on = gsMap[name];
      if (on != null && ctx.objs && ctx.objs[on]) dict = ctx.objs[on].dictStr;
      else if (typeof on === 'string') dict = on;             // inline dict captured from resources
      if (!dict) return;
      const ca = dict.match(/\/ca\s+([0-9.]+)/);
      const CA = dict.match(/\/CA\s+([0-9.]+)/);
      if (ca) gs.ca = clamp01(parseFloat(ca[1]));
      if (CA) gs.CA = clamp01(parseFloat(CA[1]));
    }
    function doXObject(name) {              // resolve `/Name Do` -> Form XObject, apply /Matrix, recurse
      if (!name || !ctx.objs) return;
      const on = xobjMap[name];
      if (on == null || (ctx.seen && ctx.seen[on])) return;           // unknown or cycle
      const o = ctx.objs[on];
      if (!o || !/\/Subtype\s*\/Form\b/.test(o.dictStr)) return;       // Form XObjects only (skip images)
      const content = getStreamContent(o, ctx.u8);
      if (!content) return;
      let M = [1, 0, 0, 1, 0, 0];
      const mm = o.dictStr.match(/\/Matrix\s*\[\s*([-0-9.eE\s]+)\]/);
      if (mm) { const nums = mm[1].trim().split(/\s+/).map(parseFloat); if (nums.length === 6 && nums.every(x => !isNaN(x))) M = nums; }
      const childRes = dictAfter(o.dictStr, 'Resources', ctx.objs) || ctx.resourcesDict || null;
      const seen2 = {}; if (ctx.seen) for (const k in ctx.seen) seen2[k] = true; seen2[on] = true;
      const childGS = Object.assign({}, gs, { ctm: matMul(M, gs.ctm) });
      interpretContent(content, out, {
        objs: ctx.objs, u8: ctx.u8, baseGS: childGS,
        xobjMap: xobjectMap(childRes, ctx.objs), gsMap: extGStateMap(childRes, ctx.objs),
        resourcesDict: childRes, seen: seen2, stats: ctx.stats,
      });
    }

    function dispatch(op) {
      switch (op) {
        case 'q': stack.push(Object.assign({}, gs, { ctm: gs.ctm.slice() })); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': { const a = ops.slice(-6); if (a.length === 6) gs.ctm = matMul(a, gs.ctm); break; }
        case 'm': { const a = ops.slice(-2); moveTo(a[0], a[1]); break; }
        case 'l': { const a = ops.slice(-2); lineTo(a[0], a[1]); break; }
        case 'c': { const a = ops.slice(-6); curveTo(a[0], a[1], a[2], a[3], a[4], a[5]); break; }
        case 'v': { const a = ops.slice(-4); if (cur) curveTo(cur[0], cur[1], a[0], a[1], a[2], a[3]); break; }
        case 'y': { const a = ops.slice(-4); curveTo(a[0], a[1], a[2], a[3], a[2], a[3]); break; }
        case 're': { const a = ops.slice(-4); rect(a[0], a[1], a[2], a[3]); break; }
        case 'h': closepath(); break;
        case 'S': paint(false, true, false); break;
        case 's': paint(false, true, true); break;
        case 'f': case 'F': case 'f*': paint(true, false, true); break;
        case 'B': case 'B*': paint(true, true, true); break;
        case 'b': case 'b*': paint(true, true, true); break;
        case 'n': resetPath(); break;       // clip/no-op: discard, don't emit
        // color state
        case 'g': { const a = ops.slice(-1); gs.fill = grayHex(a[0]); break; }
        case 'G': { const a = ops.slice(-1); gs.stroke = grayHex(a[0]); break; }
        case 'rg': { const a = ops.slice(-3); if (a.length === 3) gs.fill = rgbHex(a[0], a[1], a[2]); break; }
        case 'RG': { const a = ops.slice(-3); if (a.length === 3) gs.stroke = rgbHex(a[0], a[1], a[2]); break; }
        case 'k': { const a = ops.slice(-4); if (a.length === 4) gs.fill = cmykHex(a[0], a[1], a[2], a[3]); break; }
        case 'K': { const a = ops.slice(-4); if (a.length === 4) gs.stroke = cmykHex(a[0], a[1], a[2], a[3]); break; }
        case 'sc': case 'scn': gs.fill = componentsHex(ops, gs.fill); break;
        case 'SC': case 'SCN': gs.stroke = componentsHex(ops, gs.stroke); break;
        case 'cs': gs.fill = '#000000'; break;      // colorspace select resets to the space's initial color (black)
        case 'CS': gs.stroke = '#000000'; break;
        case 'w': { const a = ops.slice(-1); if (isFinite(a[0]) && a[0] >= 0) gs.lw = a[0]; break; }
        case 'gs': doExtGState(lastName); break;
        case 'Do': doXObject(lastName); break;                              // Form XObject: recurse into its content
        case 'Tj': case 'TJ': case "'": case '"': if (ctx.stats) ctx.stats.text++; break;  // live text shown (not outlined) -> flag it
        case 'BI': i = skipInlineImage(s, i); break;
        default: break;
      }
      ops.length = 0; lastName = null;
    }

    while (i < n) {
      const ch = s[i];
      if (isWS(ch)) { i++; continue; }
      if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (ch === '(') { let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } ops.push(0); continue; }
      if (ch === '<') {
        if (s[i + 1] === '<') { let d = 1; i += 2; while (i < n && d > 0) { if (s[i] === '<' && s[i + 1] === '<') { d++; i += 2; } else if (s[i] === '>' && s[i + 1] === '>') { d--; i += 2; } else i++; } continue; }
        i++; while (i < n && s[i] !== '>') i++; i++; ops.push(0); continue;
      }
      if (ch === '[') { i++; while (i < n && s[i] !== ']') { if (s[i] === '(') { let d = 1; i++; while (i < n && d > 0) { const c = s[i++]; if (c === '\\') i++; else if (c === '(') d++; else if (c === ')') d--; } } else i++; } i++; continue; }
      if (ch === ']' || ch === '{' || ch === '}' || ch === ')') { i++; continue; }
      if (ch === '/') { const st = i + 1; i = st; while (i < n && !isDelim(s[i]) && !isWS(s[i])) i++; lastName = s.slice(st, i); continue; }
      if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) {
        let j = i + 1; while (j < n) { const c = s[j]; if ((c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+' || c === 'e' || c === 'E') j++; else break; }
        const num = parseFloat(s.slice(i, j)); ops.push(isNaN(num) ? 0 : num); i = j; continue;
      }
      let j = i; while (j < n && !isDelim(s[j]) && !isWS(s[j])) j++;
      const op = s.slice(i, j); i = j;
      dispatch(op);
    }
  }

  // Skip an inline image (BI ... ID <binary> EI). `i` points just past 'BI'. Returns index past 'EI'.
  function skipInlineImage(s, i) {
    const id = s.indexOf('ID', i);
    if (id < 0) return s.length;
    let k = id + 2;
    while (k < s.length - 1) {
      if (s[k] === 'E' && s[k + 1] === 'I' && (k + 2 >= s.length || isWS(s[k + 2])) && isWS(s[k - 1])) return k + 2;
      k++;
    }
    return s.length;
  }

  // ---- object map + resource resolution ----

  // Inflate/read a stream object's decoded content, or null (non-Flate filters skipped).
  function getStreamContent(o, u8) {
    if (!o || !o.hasStream) return null;
    const raw = u8.subarray(o.dataStart, o.dataEnd);
    if (/FlateDecode/.test(o.filter || '')) { try { const inf = pdfInflate(raw); return u8ToStr(inf, 0, inf.length); } catch (e) { return null; } }
    if (!o.filter) return u8ToStr(raw, 0, raw.length);
    return null;
  }

  // Brute-force scan every `N G obj … endobj` (works regardless of xref style). Returns { num: {dictStr,hasStream,dataStart,dataEnd,filter} }.
  function scanObjects(whole, u8) {
    const objs = {};
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(whole))) {
      const num = parseInt(m[1], 10);
      const objStart = m.index + m[0].length;
      const endobj = whole.indexOf('endobj', objStart);
      const boundary = endobj < 0 ? whole.length : endobj;
      const streamKw = whole.indexOf('stream', objStart);
      let hasStream = false, dataStart = -1, dataEnd = -1, filter = '', dictStr;
      if (streamKw >= 0 && streamKw < boundary) {
        dictStr = whole.slice(objStart, streamKw);
        hasStream = true;
        let ds = streamKw + 6; if (whole[ds] === '\r') ds++; if (whole[ds] === '\n') ds++;
        const es = whole.indexOf('endstream', ds);
        let de = es < 0 ? boundary : es;
        if (whole[de - 1] === '\n') de--; if (whole[de - 1] === '\r') de--;
        const lm = dictStr.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
        if (lm) { const L = parseInt(lm[1], 10); if (ds + L <= u8.length) de = ds + L; }
        dataStart = ds; dataEnd = de;
        const fm = dictStr.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/);
        filter = fm ? fm[1] : '';
        if (es >= 0) re.lastIndex = es + 9;                 // skip binary body so it can't spawn false objects
      } else dictStr = whole.slice(objStart, boundary);
      objs[num] = { num: num, dictStr: dictStr, hasStream: hasStream, dataStart: dataStart, dataEnd: dataEnd, filter: filter };
    }
    return objs;
  }

  // Value of /Key that is a dict: inline `<< … >>` (balanced) or an indirect `N 0 R` resolved via objs. Returns the dict string or null.
  function dictAfter(str, key, objs) {
    const m = new RegExp('\\/' + key + '\\s*').exec(str);
    if (!m) return null;
    let i = m.index + m[0].length;
    while (i < str.length && isWS(str[i])) i++;
    if (str[i] === '<' && str[i + 1] === '<') {
      let depth = 1, j = i + 2;
      while (j < str.length && depth > 0) { if (str[j] === '<' && str[j + 1] === '<') { depth++; j += 2; } else if (str[j] === '>' && str[j + 1] === '>') { depth--; j += 2; } else j++; }
      return str.slice(i, j);
    }
    const rm = /^(\d+)\s+\d+\s+R/.exec(str.slice(i));
    if (rm && objs) { const o = objs[parseInt(rm[1], 10)]; if (o) return o.dictStr; }
    return null;
  }

  // Map of XObject resource name -> object number, from a /Resources dict.
  function xobjectMap(resDict, objs) {
    const map = {};
    if (!resDict) return map;
    const xo = dictAfter(resDict, 'XObject', objs);
    if (!xo) return map;
    const re = /\/([A-Za-z0-9.\-_]+)\s+(\d+)\s+\d+\s+R/g; let m;
    while ((m = re.exec(xo))) map[m[1]] = parseInt(m[2], 10);
    return map;
  }

  // Map of ExtGState resource name -> object number OR inline dict string.
  function extGStateMap(resDict, objs) {
    const map = {};
    if (!resDict) return map;
    const eg = dictAfter(resDict, 'ExtGState', objs);
    if (!eg) return map;
    const refRe = /\/([A-Za-z0-9.\-_]+)\s+(\d+)\s+\d+\s+R/g; let m;
    while ((m = refRe.exec(eg))) map[m[1]] = parseInt(m[2], 10);
    const inlRe = /\/([A-Za-z0-9.\-_]+)\s*(<<[^>]*>>)/g;
    while ((m = inlRe.exec(eg))) if (map[m[1]] === undefined) map[m[1]] = m[2];
    return map;
  }

  // Decoded content string(s) a page's /Contents points to (single ref or array of refs).
  function pageContents(pg, objs, u8) {
    const out = [];
    let refs = [];
    const arrM = pg.dictStr.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arrM) { const rm = arrM[1].match(/(\d+)\s+\d+\s+R/g) || []; refs = rm.map(x => parseInt(x, 10)); }
    else { const r = pg.dictStr.match(/\/Contents\s+(\d+)\s+\d+\s+R/); if (r) refs = [parseInt(r[1], 10)]; }
    for (const rn of refs) { const c = getStreamContent(objs[rn], u8); if (c) out.push(c); }
    return out;
  }

  // /MediaBox from the page dict, inherited via /Parent if absent. [x0,y0,x1,y1].
  function pageMediaBox(pg, objs) {
    let dict = pg.dictStr, seen = new Set();
    for (let hops = 0; dict && hops < 32; hops++) {
      const m = dict.match(/\/MediaBox\s*\[\s*([-0-9.eE\s]+)\]/);
      if (m) {
        const nums = m[1].trim().split(/\s+/).map(parseFloat);
        if (nums.length === 4 && nums.every(v => isFinite(v))) {
          return [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]),
                  Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])];
        }
      }
      const pm = dict.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
      if (!pm || !objs) break;
      const pn = parseInt(pm[1], 10);
      if (seen.has(pn) || !objs[pn]) break;
      seen.add(pn);
      dict = objs[pn].dictStr;
    }
    return [0, 0, 612, 792];   // US letter default
  }

  // Fallback: filter-agnostic stream scan for PDFs whose page tree isn't reachable (e.g. pages in an ObjStm).
  function dictBefore(whole, si) { return whole.slice(Math.max(0, si - 4000), si); }
  function heuristicScan(whole, u8, out, baseCTM, stats) {
    let idx = 0;
    for (;;) {
      const si = whole.indexOf('stream', idx);
      if (si < 0) break;
      if (whole.substr(si - 3, 3) === 'end') { idx = si + 6; continue; }
      let ds = si + 6; if (whole[ds] === '\r') ds++; if (whole[ds] === '\n') ds++;
      const ei = whole.indexOf('endstream', ds);
      if (ei < 0) { idx = si + 6; continue; }
      const dict = dictBefore(whole, si);
      let dend = ei; if (whole[dend - 1] === '\n') dend--; if (whole[dend - 1] === '\r') dend--;
      const lenM = dict && dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/g);
      if (lenM) { const L = parseInt(lenM[lenM.length - 1].replace(/\/Length\s+/, ''), 10); if (ds + L <= u8.length) dend = ds + L; }
      const filM = dict && dict.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/g);
      const filter = filM ? filM[filM.length - 1] : '';
      let content = null; const raw = u8.subarray(ds, dend);
      if (/FlateDecode/.test(filter)) { try { const inf = pdfInflate(raw); content = u8ToStr(inf, 0, inf.length); } catch (e) { content = null; } }
      else if (!filter) content = u8ToStr(raw, 0, raw.length);
      if (content && looksLikeContent(content)) { try { interpretContent(content, out, { baseCTM: baseCTM, stats: stats }); } catch (e) {} }
      idx = ei + 9;
    }
  }

  // Main entry: Uint8Array of a PDF (or PDF-compatible .ai) -> studio import result:
  // { shapes, artboard:{w,h}, pageCount, hasLiveText, textShows }. Shapes are in
  // artboard coordinates (points, y-down); only the first page's content is imported.
  function parsePDFDoc(u8, opts) {
    const whole = u8ToStr(u8, 0, u8.length);
    if (whole.indexOf('%PDF') < 0) throw new Error('not a PDF (or PDF-compatible .ai) file');
    const objs = scanObjects(whole, u8);
    const stats = { text: 0 };
    const pages = [];
    for (const k in objs) { const o = objs[k]; if (/\/Type\s*\/Page\b/.test(o.dictStr) && !/\/Type\s*\/Pages\b/.test(o.dictStr)) pages.push(o); }
    pages.sort((a, b) => a.num - b.num);
    const out = { shapes: [], artboard: { w: 612, h: 792 }, pageCount: pages.length, hasLiveText: false, textShows: 0 };
    if (pages.length) {
      const pg = pages[0];
      const mb = pageMediaBox(pg, objs);
      out.artboard = { w: mb[2] - mb[0], h: mb[3] - mb[1] };
      // PDF user space is y-up with the origin at MediaBox bottom-left; the studio
      // is y-down with the origin at artboard top-left. One base matrix does both.
      const baseCTM = [1, 0, 0, -1, -mb[0], mb[3]];
      const resDict = dictAfter(pg.dictStr, 'Resources', objs);
      for (const cs of pageContents(pg, objs, u8)) {
        try {
          interpretContent(cs, out, {
            objs: objs, u8: u8, baseCTM: baseCTM, resourcesDict: resDict,
            xobjMap: xobjectMap(resDict, objs), gsMap: extGStateMap(resDict, objs),
            seen: {}, stats: stats,
          });
        } catch (e) {}
      }
    }
    if (out.shapes.length === 0 && stats.text === 0) {
      heuristicScan(whole, u8, out, [1, 0, 0, -1, 0, out.artboard.h], stats);   // page tree unreachable -> best-effort scan
    }
    out.hasLiveText = stats.text > 0;
    out.textShows = stats.text;
    return out;
  }

  // ---------- flat vector-PDF export ----------

  function fmtNum(v) {
    if (!isFinite(v)) v = 0;
    const s = (Math.round(v * 10000) / 10000).toString();
    return s.indexOf('e') >= 0 ? v.toFixed(4) : s;   // no exponent notation in PDF
  }
  function hexToRgb01(hex) {
    let h = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!h) return [0, 0, 0];
    h = h[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  function colorOp(hex, op) {
    const c = hexToRgb01(hex);
    return fmtNum(c[0]) + ' ' + fmtNum(c[1]) + ' ' + fmtNum(c[2]) + ' ' + op;
  }

  // Content-stream fragment for one shape, y flipped back to PDF's y-up space.
  function shapeContent(s, abH, gsName) {
    const parts = ['q'];
    if (gsName) parts.push('/' + gsName + ' gs');
    if (s.fill) parts.push(colorOp(s.fill, 'rg'));
    if (s.stroke) {
      parts.push(colorOp(s.stroke.color, 'RG'));
      parts.push(fmtNum(Math.max(s.stroke.w, 0)) + ' w');
    }
    for (const c of s.cmds) {
      if (c[0] === 'M') parts.push(fmtNum(c[1]) + ' ' + fmtNum(abH - c[2]) + ' m');
      else if (c[0] === 'L') parts.push(fmtNum(c[1]) + ' ' + fmtNum(abH - c[2]) + ' l');
      else if (c[0] === 'C') parts.push(
        fmtNum(c[1]) + ' ' + fmtNum(abH - c[2]) + ' ' + fmtNum(c[3]) + ' ' + fmtNum(abH - c[4]) + ' ' +
        fmtNum(c[5]) + ' ' + fmtNum(abH - c[6]) + ' c');
      else if (c[0] === 'Z') parts.push('h');
    }
    parts.push(s.fill && s.stroke ? 'B' : s.fill ? 'f' : 'S');
    parts.push('Q');
    return parts.join('\n');
  }

  // Build a complete single-page vector PDF of the document at artboard size.
  // Flat output: hidden layers are dropped, z-order is preserved, opacity < 1
  // becomes an /ExtGState. Returns a latin1 string (1 char = 1 byte);
  // use buildPDFBytes for a Uint8Array ready for a Blob.
  function buildPDF(doc) {
    const abW = doc.artboard.w, abH = doc.artboard.h;
    const hidden = new Set((doc.layers || []).filter(l => !l.visible).map(l => l.id));
    const shapes = (doc.shapes || []).filter(s => !hidden.has(s.layer) && (s.fill || s.stroke));

    // distinct sub-1 opacities -> /GS1..: value both as fill (ca) and stroke (CA) alpha
    const gsNames = new Map();   // rounded opacity -> name
    for (const s of shapes) {
      const o = Math.round(clamp01(s.opacity == null ? 1 : s.opacity) * 1000) / 1000;
      if (o < 1 && !gsNames.has(o)) gsNames.set(o, 'GS' + (gsNames.size + 1));
    }

    const frags = [];
    for (const s of shapes) {
      const o = Math.round(clamp01(s.opacity == null ? 1 : s.opacity) * 1000) / 1000;
      frags.push(shapeContent(s, abH, o < 1 ? gsNames.get(o) : null));
    }
    const content = frags.join('\n');

    let resources = '';
    if (gsNames.size) {
      const entries = [...gsNames.entries()].map(([o, name], idx) => '/' + name + ' ' + (5 + idx) + ' 0 R');
      resources = ' /Resources << /ExtGState << ' + entries.join(' ') + ' >> >>';
    }

    const objects = [];   // index 0 = object 1
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + fmtNum(abW) + ' ' + fmtNum(abH) + ' ] /Contents 4 0 R' + resources + ' >>');
    objects.push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    for (const [o] of gsNames) objects.push('<< /Type /ExtGState /ca ' + fmtNum(o) + ' /CA ' + fmtNum(o) + ' >>');

    let pdf = '%PDF-1.4\n%âãÏÓ\n';   // binary marker comment
    const offsets = [];
    for (let i = 0; i < objects.length; i++) {
      offsets.push(pdf.length);
      pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
    }
    const xrefPos = pdf.length;
    pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
    pdf += '0000000000 65535 f \n';
    for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
    pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
    return pdf;
  }

  function buildPDFBytes(doc) { return strToU8(buildPDF(doc)); }

  return { parsePDFDoc, buildPDF, buildPDFBytes, pdfInflate };
})();
if (typeof module !== 'undefined') module.exports = VECPDF;
if (typeof window !== 'undefined') window.VECPDF = VECPDF;
