/*
 * pdfimport.js
 * --------------------
 * Vector-path importer for PDF and Illustrator (.ai with PDF compatibility)
 * files, with color capture. Re-implementation in the spirit of
 * cam-engine's pdfparse.js: scans raw PDF objects (no xref dependence),
 * inflates streams, walks the page tree, and interprets content streams
 * to extract filled/stroked paths in top-left-origin page coordinates.
 *
 * Works as a plain <script> in the browser (exposes window.VecPDF.parsePDF)
 * and as a CommonJS module in Node (module.exports.parsePDF).
 *
 * Usage:
 *   const doc = await VecPDF.parsePDF(arrayBufferOrUint8Array);
 *   doc = {
 *     pageCount, isAI, creator, producer,
 *     colors: [ {space, values, rgb, name?, uses} ],   // captured palette
 *     pages: [ {
 *       width, height,            // points, artboard size (MediaBox)
 *       shapes: [ {
 *         subpaths: [ {start:{x,y}, segments:[seg], closed} ],
 *           // seg = {type:'line', to:{x,y}}
 *           //     | {type:'cubic', c1:{x,y}, c2:{x,y}, to:{x,y}}
 *         fill:   color | null,   // color = {space, values, rgb:[r,g,b] 0..1, name?}
 *         stroke: color | null,
 *         strokeWidth,            // points, already CTM-scaled
 *         fillRule: 'nonzero' | 'evenodd'
 *       } ],
 *       colors: [...]             // palette used on this page
 *     } ]
 *   }
 *
 * Coordinates are in PDF points with the origin at the TOP-LEFT of the
 * page and y increasing downward (canvas convention), MediaBox offset
 * and /Rotate already applied.
 *
 * Supported: FlateDecode (+PNG predictors), ASCIIHexDecode, object
 * streams (ObjStm), Form XObjects, DeviceGray/RGB/CMYK, ICCBased,
 * CalRGB/CalGray/Lab (approximated), Separation & DeviceN spot colors
 * (tint transforms of FunctionType 0/2/3 evaluated; spot names captured).
 * Text, images, shadings and clipping are ignored — this importer is
 * about vector geometry.
 */
(function (global) {
'use strict';

/* ------------------------------------------------------------------ */
/* Bytes & strings                                                     */
/* ------------------------------------------------------------------ */

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('parsePDF: expected ArrayBuffer or Uint8Array');
}

// Latin-1 view of bytes so string indexing == byte indexing.
function latin1(bytes) {
  const CHUNK = 8192;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return out;
}

function strToBytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/* ------------------------------------------------------------------ */
/* Inflate (pako if present, else DecompressionStream)                 */
/* ------------------------------------------------------------------ */

async function inflate(bytes) {
  if (global.pako && global.pako.inflate) {
    return global.pako.inflate(bytes);
  }
  if (typeof DecompressionStream !== 'undefined') {
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) { /* try next format */ }
    }
    throw new Error('FlateDecode failed');
  }
  throw new Error('No inflate available: include pako or use a runtime with DecompressionStream');
}

/* ------------------------------------------------------------------ */
/* PDF object lexer                                                    */
/* Values: number | boolean | null | {str} | {name} | {ref,gen}        */
/*         | Array | plain object (dict, keys are name strings)        */
/* ------------------------------------------------------------------ */

const WS = { 0x00: 1, 0x09: 1, 0x0a: 1, 0x0c: 1, 0x0d: 1, 0x20: 1 };
function isWs(c) { return WS[c.charCodeAt(0)] === 1; }
function isDelim(c) { return '()<>[]{}/%'.indexOf(c) >= 0; }

function skipWs(S, i) {
  for (;;) {
    while (i < S.length && isWs(S[i])) i++;
    if (S[i] === '%') { while (i < S.length && S[i] !== '\n' && S[i] !== '\r') i++; }
    else return i;
  }
}

function parseName(S, i) { // S[i] === '/'
  i++;
  let out = '';
  while (i < S.length && !isWs(S[i]) && !isDelim(S[i])) {
    if (S[i] === '#' && /^[0-9a-fA-F]{2}/.test(S.substr(i + 1, 2))) {
      out += String.fromCharCode(parseInt(S.substr(i + 1, 2), 16));
      i += 3;
    } else {
      out += S[i++];
    }
  }
  return { v: { name: out }, i };
}

function parseLiteralString(S, i) { // S[i] === '('
  i++;
  let out = '', depth = 1;
  while (i < S.length && depth > 0) {
    const c = S[i];
    if (c === '\\') {
      const n = S[i + 1];
      if (n === 'n') { out += '\n'; i += 2; }
      else if (n === 'r') { out += '\r'; i += 2; }
      else if (n === 't') { out += '\t'; i += 2; }
      else if (n === 'b') { out += '\b'; i += 2; }
      else if (n === 'f') { out += '\f'; i += 2; }
      else if (n === '\r') { i += 2; if (S[i] === '\n') i++; } // line continuation
      else if (n === '\n') { i += 2; }
      else if (n >= '0' && n <= '7') {
        let oct = '';
        i++;
        while (oct.length < 3 && S[i] >= '0' && S[i] <= '7') oct += S[i++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else { out += n; i += 2; }
    } else if (c === '(') { depth++; out += c; i++; }
    else if (c === ')') { depth--; if (depth > 0) out += c; i++; }
    else { out += c; i++; }
  }
  return { v: { str: out }, i };
}

function parseHexString(S, i) { // S[i] === '<' (single)
  i++;
  let hex = '';
  while (i < S.length && S[i] !== '>') {
    if (/[0-9a-fA-F]/.test(S[i])) hex += S[i];
    i++;
  }
  i++;
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
  return { v: { str: out }, i };
}

const REF_RE = /^[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+R(?![A-Za-z0-9_])/;

// Parse one object at S[i]. Returns {v, i} with i past the object.
function parseObj(S, i) {
  i = skipWs(S, i);
  const c = S[i];
  if (c === undefined) return { v: null, i };

  if (c === '<' && S[i + 1] === '<') { // dict
    i += 2;
    const dict = {};
    for (;;) {
      i = skipWs(S, i);
      if (S[i] === '>' && S[i + 1] === '>') { i += 2; break; }
      if (S[i] !== '/') { i++; continue; } // tolerate junk
      const key = parseName(S, i);
      const val = parseObj(S, key.i);
      dict[key.v.name] = val.v;
      i = val.i;
    }
    return { v: dict, i };
  }
  if (c === '<') return parseHexString(S, i);
  if (c === '(') return parseLiteralString(S, i);
  if (c === '/') return parseName(S, i);
  if (c === '[') {
    i++;
    const arr = [];
    for (;;) {
      i = skipWs(S, i);
      if (S[i] === ']') { i++; break; }
      if (i >= S.length) break;
      const el = parseObj(S, i);
      arr.push(el.v);
      i = el.i;
    }
    return { v: arr, i };
  }
  if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
    let j = i + 1;
    while (j < S.length && /[0-9.eE+-]/.test(S[j])) j++;
    const numStr = S.slice(i, j);
    const num = parseFloat(numStr);
    // indirect reference lookahead: "<int> <int> R"
    if (/^\d+$/.test(numStr)) {
      const m = REF_RE.exec(S.substr(j, 24));
      if (m) return { v: { ref: num, gen: parseInt(m[1], 10) }, i: j + m[0].length };
    }
    return { v: num, i: j };
  }
  // keyword
  let j = i;
  while (j < S.length && !isWs(S[j]) && !isDelim(S[j])) j++;
  const word = S.slice(i, j);
  if (word === 'true') return { v: true, i: j };
  if (word === 'false') return { v: false, i: j };
  if (word === 'null') return { v: null, i: j };
  return { v: { op: word }, i: j === i ? i + 1 : j };
}

/* ------------------------------------------------------------------ */
/* Document: object scan, streams, filters                             */
/* ------------------------------------------------------------------ */

function isName(v, n) { return v && typeof v === 'object' && v.name === n; }

class PDFDoc {
  constructor(bytes) {
    this.bytes = bytes;
    this.S = latin1(bytes);
    this.objects = new Map(); // num -> {value, streamStart?, streamEnd?}
    this.trailer = {};
  }

  resolve(v) {
    let guard = 0;
    while (v && typeof v === 'object' && 'ref' in v && guard++ < 64) {
      const e = this.objects.get(v.ref);
      v = e ? e.value : null;
    }
    return v;
  }

  scan() {
    const S = this.S;
    const objRe = /(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj\b/g;
    let cursor = 0, m;
    while ((m = objRe.exec(S)) !== null) {
      if (m.index < cursor) continue; // inside a previous stream body
      const num = parseInt(m[1], 10);
      let parsed;
      try { parsed = parseObj(S, m.index + m[0].length); }
      catch (e) { continue; }
      const entry = { value: parsed.v };
      let i = skipWs(S, parsed.i);
      if (S.startsWith('stream', i)) {
        let k = i + 6;
        if (S[k] === '\r') k++;
        if (S[k] === '\n') k++;
        entry.streamStart = k;
        // Locate endstream: trust /Length when it points at one, else search.
        let end = -1;
        const lenV = this.resolveLenient(parsed.v && parsed.v.Length);
        if (typeof lenV === 'number' && lenV >= 0 && k + lenV <= S.length) {
          const probe = skipWs(S, k + lenV);
          if (S.startsWith('endstream', probe)) end = k + lenV;
        }
        if (end < 0) {
          let e = S.indexOf('endstream', k);
          if (e < 0) e = S.length;
          // strip the EOL that precedes endstream
          let t = e;
          if (S[t - 1] === '\n') t--;
          if (S[t - 1] === '\r') t--;
          end = t;
        }
        entry.streamEnd = end;
        const endobj = S.indexOf('endobj', end);
        cursor = endobj < 0 ? end : endobj + 6;
        objRe.lastIndex = cursor;
      }
      if (!this.objects.has(num) || entry.streamStart !== undefined ||
          this.objects.get(num).streamStart === undefined) {
        this.objects.set(num, entry);
      }
    }
    // trailers (classic xref tables)
    const trRe = /trailer\b/g;
    let t;
    while ((t = trRe.exec(S)) !== null) {
      try {
        const d = parseObj(S, t.index + 7).v;
        if (d && typeof d === 'object' && d.Root) Object.assign(this.trailer, d);
      } catch (e) { /* ignore */ }
    }
    // cross-reference streams also carry /Root
    if (!this.trailer.Root) {
      for (const [, e] of this.objects) {
        const v = e.value;
        if (v && typeof v === 'object' && isName(v.Type, 'XRef') && v.Root) {
          Object.assign(this.trailer, { Root: v.Root, Info: v.Info });
          break;
        }
      }
    }
  }

  // Resolve that works during scan (target may not be scanned yet).
  resolveLenient(v) {
    if (v && typeof v === 'object' && 'ref' in v) {
      const e = this.objects.get(v.ref);
      if (e) return e.value;
      // brute: find "<num> 0 obj <int>" in the raw file
      const re = new RegExp('(?:^|[^0-9])(' + String(v.ref) + ')[\\0\\t\\n\\f\\r ]+\\d+[\\0\\t\\n\\f\\r ]+obj\\b');
      const m = re.exec(this.S);
      if (m) {
        try { return parseObj(this.S, m.index + m[0].length).v; } catch (e2) { return null; }
      }
      return null;
    }
    return v;
  }

  rawStream(entry) {
    return this.bytes.subarray(entry.streamStart, entry.streamEnd);
  }

  async decodeStream(entry) {
    let data = this.rawStream(entry);
    const dict = entry.value || {};
    let filters = this.resolve(dict.Filter);
    let parms = this.resolve(dict.DecodeParms || dict.DP);
    if (!filters) return data;
    if (!Array.isArray(filters)) { filters = [filters]; parms = [parms]; }
    else if (!Array.isArray(parms)) { parms = [parms]; }
    for (let i = 0; i < filters.length; i++) {
      const f = this.resolve(filters[i]);
      const p = this.resolve(parms[i]) || null;
      if (isName(f, 'FlateDecode') || isName(f, 'Fl')) {
        data = await inflate(data);
        data = this.applyPredictor(data, p);
      } else if (isName(f, 'ASCIIHexDecode') || isName(f, 'AHx')) {
        const s = latin1(data).replace(/[^0-9a-fA-F>]/g, '');
        const hex = s.replace(/>.*$/, '');
        const out = new Uint8Array(Math.ceil(hex.length / 2));
        for (let k = 0; k < hex.length; k += 2) out[k >> 1] = parseInt(hex.substr(k, 2).padEnd(2, '0'), 16);
        data = out;
      } else if (f) {
        throw new Error('Unsupported stream filter: ' + (f.name || f));
      }
    }
    return data;
  }

  applyPredictor(data, parms) {
    if (!parms) return data;
    const pred = this.resolve(parms.Predictor) || 1;
    if (pred < 2) return data;
    const colors = this.resolve(parms.Colors) || 1;
    const bpc = this.resolve(parms.BitsPerComponent) || 8;
    const columns = this.resolve(parms.Columns) || 1;
    const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
    const rowLen = Math.ceil(colors * bpc * columns / 8);
    if (pred === 2) return data; // TIFF predictor on 8-bit rare; pass through
    // PNG predictors: each row prefixed with a filter-type byte
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowLen + 1)];
      const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
      const dst = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let x = 0; x < rowLen; x++) {
        const a = x >= bpp ? dst[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        let v = src[x];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        dst[x] = v & 0xff;
      }
      prev = dst;
    }
    return out;
  }

  async expandObjectStreams() {
    for (const [, entry] of Array.from(this.objects)) {
      const v = entry.value;
      if (!v || typeof v !== 'object' || !isName(v.Type, 'ObjStm')) continue;
      let data;
      try { data = await this.decodeStream(entry); } catch (e) { continue; }
      const S = latin1(data);
      const N = this.resolve(v.N) || 0;
      const first = this.resolve(v.First) || 0;
      let i = 0;
      const header = [];
      for (let k = 0; k < N; k++) {
        const a = parseObj(S, i); const b = parseObj(S, a.i);
        header.push([a.v, b.v]);
        i = b.i;
      }
      for (const [num, off] of header) {
        if (typeof num !== 'number' || typeof off !== 'number') continue;
        if (this.objects.has(num)) continue; // directly-scanned objects win
        try {
          const parsed = parseObj(S, first + off);
          this.objects.set(num, { value: parsed.v });
        } catch (e) { /* skip bad member */ }
      }
    }
  }

  findCatalog() {
    let root = this.resolve(this.trailer.Root);
    if (root && isName(root.Type, 'Catalog')) return root;
    for (const [, e] of this.objects) {
      const v = e.value;
      if (v && typeof v === 'object' && isName(v.Type, 'Catalog')) return v;
    }
    return null;
  }

  collectPages() {
    const cat = this.findCatalog();
    const pages = [];
    const walk = (node, inherited, depth) => {
      node = this.resolve(node);
      if (!node || typeof node !== 'object' || depth > 64) return;
      const inh = {
        MediaBox: node.MediaBox !== undefined ? node.MediaBox : inherited.MediaBox,
        Resources: node.Resources !== undefined ? node.Resources : inherited.Resources,
        Rotate: node.Rotate !== undefined ? node.Rotate : inherited.Rotate,
      };
      if (isName(node.Type, 'Pages') || (node.Kids && !isName(node.Type, 'Page'))) {
        const kids = this.resolve(node.Kids) || [];
        for (const k of kids) walk(k, inh, depth + 1);
      } else if (isName(node.Type, 'Page') || node.Contents !== undefined) {
        pages.push({ dict: node, inherited: inh });
      }
    };
    if (cat && cat.Pages) walk(cat.Pages, {}, 0);
    if (!pages.length) { // last resort: scan for page dicts
      for (const [, e] of this.objects) {
        const v = e.value;
        if (v && typeof v === 'object' && isName(v.Type, 'Page')) {
          pages.push({ dict: v, inherited: {} });
        }
      }
    }
    return pages;
  }

  async pageContent(pageDict) {
    let contents = this.resolve(pageDict.Contents);
    if (!contents) return new Uint8Array(0);
    if (!Array.isArray(contents)) contents = [pageDict.Contents];
    const parts = [];
    for (const c of contents) {
      const ref = c && typeof c === 'object' && 'ref' in c ? this.objects.get(c.ref) : null;
      const entry = ref || (typeof c === 'object' ? { value: this.resolve(c) } : null);
      if (!entry || entry.streamStart === undefined) continue;
      try { parts.push(await this.decodeStream(entry)); }
      catch (e) { /* skip undecodable part */ }
    }
    let total = 0;
    for (const p of parts) total += p.length + 1;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 0x0a; }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Matrices & colors                                                   */
/* ------------------------------------------------------------------ */

function matMul(m, n) { // apply m "after" n?  result = n · m (PDF: cm concatenates before CTM)
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
function matApply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}
function matScale(m) {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function cmyk2rgb(c, m, y, k) {
  return [clamp01((1 - c) * (1 - k)), clamp01((1 - m) * (1 - k)), clamp01((1 - y) * (1 - k))];
}
function colGray(g) { g = clamp01(g); return { space: 'gray', values: [g], rgb: [g, g, g] }; }
function colRGB(r, g, b) { return { space: 'rgb', values: [r, g, b].map(clamp01), rgb: [r, g, b].map(clamp01) }; }
function colCMYK(c, m, y, k) {
  const v = [c, m, y, k].map(clamp01);
  return { space: 'cmyk', values: v, rgb: cmyk2rgb(v[0], v[1], v[2], v[3]) };
}

function colorKey(col) {
  if (!col) return '';
  return col.space + ':' + (col.name || '') + ':' + col.values.map(v => v.toFixed(4)).join(',');
}

/* ------------------------------------------------------------------ */
/* PDF functions (for Separation tint transforms)                      */
/* ------------------------------------------------------------------ */

async function evalFunction(doc, fnRefOrDict, inputs) {
  const entry = fnRefOrDict && typeof fnRefOrDict === 'object' && 'ref' in fnRefOrDict
    ? doc.objects.get(fnRefOrDict.ref) : { value: doc.resolve(fnRefOrDict) };
  if (!entry || !entry.value || typeof entry.value !== 'object') return null;
  const fn = entry.value;
  const type = doc.resolve(fn.FunctionType);
  const domain = (doc.resolve(fn.Domain) || [0, 1]).map(Number);
  const x = Math.min(Math.max(inputs[0], domain[0]), domain[1]);

  if (type === 2) {
    const c0 = (doc.resolve(fn.C0) || [0]).map(Number);
    const c1 = (doc.resolve(fn.C1) || [1]).map(Number);
    const n = doc.resolve(fn.N) || 1;
    const t = Math.pow(x, n);
    const out = [];
    for (let i = 0; i < Math.max(c0.length, c1.length); i++) {
      out.push((c0[i] || 0) + t * ((c1[i] || 0) - (c0[i] || 0)));
    }
    return out;
  }
  if (type === 3) {
    const fns = doc.resolve(fn.Functions) || [];
    const bounds = (doc.resolve(fn.Bounds) || []).map(Number);
    const encode = (doc.resolve(fn.Encode) || []).map(Number);
    let k = 0;
    while (k < bounds.length && x >= bounds[k]) k++;
    const lo = k === 0 ? domain[0] : bounds[k - 1];
    const hi = k === bounds.length ? domain[1] : bounds[k];
    const e0 = encode.length > 2 * k ? encode[2 * k] : 0;
    const e1 = encode.length > 2 * k + 1 ? encode[2 * k + 1] : 1;
    const t = hi === lo ? e0 : e0 + (x - lo) / (hi - lo) * (e1 - e0);
    return evalFunction(doc, fns[k], [t]);
  }
  if (type === 0 && entry.streamStart !== undefined) {
    try {
      const data = await doc.decodeStream(entry);
      const size = (doc.resolve(fn.Size) || [2]).map(Number);
      const bps = doc.resolve(fn.BitsPerSample) || 8;
      const range = (doc.resolve(fn.Range) || []).map(Number);
      const nOut = range.length ? range.length / 2 : 1;
      if (bps !== 8 && bps !== 16) return null;
      const nSamples = size[0];
      const t = (x - domain[0]) / (domain[1] - domain[0] || 1);
      const idx = Math.min(nSamples - 1, Math.round(t * (nSamples - 1)));
      const out = [];
      for (let i = 0; i < nOut; i++) {
        let raw, max;
        if (bps === 8) { raw = data[idx * nOut + i]; max = 255; }
        else { const o = (idx * nOut + i) * 2; raw = (data[o] << 8) | data[o + 1]; max = 65535; }
        const r0 = range.length ? range[2 * i] : 0;
        const r1 = range.length ? range[2 * i + 1] : 1;
        out.push(r0 + (raw / max) * (r1 - r0));
      }
      return out;
    } catch (e) { return null; }
  }
  return null; // Type 4 (PostScript calculator) & exotic cases
}

/* ------------------------------------------------------------------ */
/* Color spaces                                                        */
/* ------------------------------------------------------------------ */

function csFamily(doc, cs) {
  // Returns {kind, n, name?, alt?, tint?} for a resolved colorspace value.
  cs = doc.resolve(cs);
  if (!cs) return { kind: 'gray', n: 1 };
  if (cs.name) {
    switch (cs.name) {
      case 'DeviceGray': case 'CalGray': case 'G': return { kind: 'gray', n: 1 };
      case 'DeviceRGB': case 'CalRGB': case 'RGB': return { kind: 'rgb', n: 3 };
      case 'DeviceCMYK': case 'CMYK': return { kind: 'cmyk', n: 4 };
      case 'Pattern': return { kind: 'pattern', n: 1 };
      default: return { kind: 'gray', n: 1 };
    }
  }
  if (Array.isArray(cs)) {
    const head = doc.resolve(cs[0]);
    const hname = head && head.name;
    if (hname === 'ICCBased') {
      const strm = doc.resolve(cs[1]);
      const n = (strm && doc.resolve(strm.N)) || 3;
      return n === 4 ? { kind: 'cmyk', n: 4 } : n === 1 ? { kind: 'gray', n: 1 } : { kind: 'rgb', n: 3 };
    }
    if (hname === 'CalRGB' || hname === 'Lab') return { kind: 'rgb', n: 3 };
    if (hname === 'CalGray') return { kind: 'gray', n: 1 };
    if (hname === 'Separation') {
      const nm = doc.resolve(cs[1]);
      return { kind: 'separation', n: 1, name: (nm && nm.name) || 'Spot', alt: cs[2], tint: cs[3] };
    }
    if (hname === 'DeviceN') {
      const names = (doc.resolve(cs[1]) || []).map(v => (doc.resolve(v) || {}).name || '?');
      return { kind: 'devicen', n: names.length, name: names.join('+'), alt: cs[2], tint: cs[3] };
    }
    if (hname === 'Indexed') return { kind: 'gray', n: 1 };
    if (hname === 'Pattern') return { kind: 'pattern', n: 1 };
  }
  return { kind: 'gray', n: 1 };
}

async function makeColorFromCS(doc, fam, comps) {
  switch (fam.kind) {
    case 'gray': return colGray(comps[0] !== undefined ? comps[0] : 0);
    case 'rgb': return colRGB(comps[0] || 0, comps[1] || 0, comps[2] || 0);
    case 'cmyk': return colCMYK(comps[0] || 0, comps[1] || 0, comps[2] || 0, comps[3] || 1);
    case 'pattern': return { space: 'pattern', values: [], rgb: [0.5, 0.5, 0.5] };
    case 'separation': case 'devicen': {
      const tint = comps.length ? comps[0] : 1;
      let rgb = null, values = comps.slice();
      const out = await evalFunction(doc, fam.tint, comps.length ? comps : [1]);
      if (out) {
        const altFam = csFamily(doc, fam.alt);
        if (altFam.kind === 'cmyk' && out.length >= 4) rgb = cmyk2rgb(out[0], out[1], out[2], out[3]);
        else if (altFam.kind === 'rgb' && out.length >= 3) rgb = out.slice(0, 3).map(clamp01);
        else if (out.length >= 1) rgb = [clamp01(out[0]), clamp01(out[0]), clamp01(out[0])];
      }
      if (!rgb) { const g = clamp01(1 - tint); rgb = [g, g, g]; } // fallback: tint as darkness
      return { space: 'separation', name: fam.name, values, rgb };
    }
    default: return colGray(0);
  }
}

/* ------------------------------------------------------------------ */
/* Content-stream interpreter                                          */
/* ------------------------------------------------------------------ */

const TEXT_OPS = new Set(['BT', 'ET', 'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts',
  'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"']);
const IGNORE_OPS = new Set(['ri', 'i', 'j', 'J', 'M', 'd', 'gs', 'sh', 'd0', 'd1',
  'MP', 'DP', 'BMC', 'BDC', 'EMC', 'BX', 'EX', 'CS_UNKNOWN']);

async function runContentStream(doc, contentBytes, resources, gsInit, shapes, depth) {
  if (depth > 12) return;
  const S = latin1(contentBytes);
  let gs = gsInit;
  const gsStack = [];
  const operands = [];

  // path construction state (user space)
  let subpaths = [];      // finished subpaths of current path
  let cur = null;         // {start, segments, closed}
  let cx = 0, cy = 0;     // current point, user space
  let sx = 0, sy = 0;     // subpath start, user space

  const tp = (x, y) => matApply(gs.ctm, x, y);

  function moveTo(x, y) {
    if (cur && cur.segments.length) subpaths.push(cur);
    const p = tp(x, y);
    cur = { start: { x: p.x, y: p.y }, segments: [], closed: false };
    cx = x; cy = y; sx = x; sy = y;
  }
  function lineTo(x, y) {
    if (!cur) moveTo(cx, cy);
    const p = tp(x, y);
    cur.segments.push({ type: 'line', to: { x: p.x, y: p.y } });
    cx = x; cy = y;
  }
  function curveTo(x1, y1, x2, y2, x3, y3) {
    if (!cur) moveTo(cx, cy);
    const c1 = tp(x1, y1), c2 = tp(x2, y2), to = tp(x3, y3);
    cur.segments.push({ type: 'cubic', c1: { x: c1.x, y: c1.y }, c2: { x: c2.x, y: c2.y }, to: { x: to.x, y: to.y } });
    cx = x3; cy = y3;
  }
  function closePath() {
    if (cur) { cur.closed = true; subpaths.push(cur); cur = null; cx = sx; cy = sy; }
  }
  function endPath() { subpaths = []; cur = null; }

  function emit(fill, stroke, fillRule) {
    if (cur && (cur.segments.length || fill)) subpaths.push(cur);
    cur = null;
    const sp = subpaths.filter(p => p.segments.length > 0);
    if (sp.length) {
      shapes.push({
        subpaths: sp,
        fill: fill || null,
        stroke: stroke || null,
        strokeWidth: stroke ? gs.lineWidth * matScale(gs.ctm) : 0,
        fillRule: fillRule || 'nonzero',
      });
    }
    subpaths = [];
  }

  function lookupCS(nameOrVal) {
    if (nameOrVal && nameOrVal.name) {
      const n = nameOrVal.name;
      if (n === 'DeviceGray' || n === 'DeviceRGB' || n === 'DeviceCMYK' || n === 'Pattern' ||
          n === 'G' || n === 'RGB' || n === 'CMYK') {
        return csFamily(doc, nameOrVal);
      }
      const csDict = doc.resolve(resources && resources.ColorSpace) || {};
      if (csDict[n] !== undefined) return csFamily(doc, csDict[n]);
    }
    return csFamily(doc, nameOrVal);
  }

  let i = 0;
  const len = S.length;
  while (i < len) {
    i = skipWs(S, i);
    if (i >= len) break;
    const c = S[i];
    if (c === '/' || c === '(' || c === '<' || c === '[' ||
        c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      const r = parseObj(S, i);
      operands.push(r.v);
      i = r.i;
      continue;
    }
    // operator token
    let j = i;
    while (j < len && !isWs(S[j]) && !isDelim(S[j])) j++;
    const op = S.slice(i, j === i ? i + 1 : j);
    i = j === i ? i + 1 : j;
    const nums = operands.map(v => (typeof v === 'number' ? v : 0));

    try {
      switch (op) {
        /* graphics state */
        case 'q': gsStack.push({ ...gs, fill: gs.fill, stroke: gs.stroke }); break;
        case 'Q': if (gsStack.length) gs = gsStack.pop(); break;
        case 'cm': gs = { ...gs, ctm: matMul(nums.slice(0, 6), gs.ctm) }; break;
        case 'w': gs = { ...gs, lineWidth: nums[0] }; break;

        /* path construction */
        case 'm': moveTo(nums[0], nums[1]); break;
        case 'l': lineTo(nums[0], nums[1]); break;
        case 'c': curveTo(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]); break;
        case 'v': curveTo(cx, cy, nums[0], nums[1], nums[2], nums[3]); break;
        case 'y': curveTo(nums[0], nums[1], nums[2], nums[3], nums[2], nums[3]); break;
        case 'h': closePath(); break;
        case 're': {
          const [x, y, w, h] = nums;
          moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); closePath();
          break;
        }

        /* path painting */
        case 'f': case 'F': emit(gs.fill, null, 'nonzero'); break;
        case 'f*': emit(gs.fill, null, 'evenodd'); break;
        case 'S': emit(null, gs.stroke); break;
        case 's': closePath(); emit(null, gs.stroke); break;
        case 'B': emit(gs.fill, gs.stroke, 'nonzero'); break;
        case 'B*': emit(gs.fill, gs.stroke, 'evenodd'); break;
        case 'b': closePath(); emit(gs.fill, gs.stroke, 'nonzero'); break;
        case 'b*': closePath(); emit(gs.fill, gs.stroke, 'evenodd'); break;
        case 'n': endPath(); break;
        case 'W': case 'W*': break; // clipping ignored (geometry importer)

        /* color */
        case 'g': gs = { ...gs, fill: colGray(nums[0]), fillCS: { kind: 'gray', n: 1 } }; break;
        case 'G': gs = { ...gs, stroke: colGray(nums[0]), strokeCS: { kind: 'gray', n: 1 } }; break;
        case 'rg': gs = { ...gs, fill: colRGB(nums[0], nums[1], nums[2]), fillCS: { kind: 'rgb', n: 3 } }; break;
        case 'RG': gs = { ...gs, stroke: colRGB(nums[0], nums[1], nums[2]), strokeCS: { kind: 'rgb', n: 3 } }; break;
        case 'k': gs = { ...gs, fill: colCMYK(nums[0], nums[1], nums[2], nums[3]), fillCS: { kind: 'cmyk', n: 4 } }; break;
        case 'K': gs = { ...gs, stroke: colCMYK(nums[0], nums[1], nums[2], nums[3]), strokeCS: { kind: 'cmyk', n: 4 } }; break;
        case 'cs': {
          const fam = lookupCS(operands[0]);
          gs = { ...gs, fillCS: fam, fill: await makeColorFromCS(doc, fam, fam.kind === 'cmyk' ? [0, 0, 0, 1] : [0]) };
          break;
        }
        case 'CS': {
          const fam = lookupCS(operands[0]);
          gs = { ...gs, strokeCS: fam, stroke: await makeColorFromCS(doc, fam, fam.kind === 'cmyk' ? [0, 0, 0, 1] : [0]) };
          break;
        }
        case 'sc': case 'scn': {
          const comps = operands.filter(v => typeof v === 'number');
          gs = { ...gs, fill: await makeColorFromCS(doc, gs.fillCS, comps) };
          break;
        }
        case 'SC': case 'SCN': {
          const comps = operands.filter(v => typeof v === 'number');
          gs = { ...gs, stroke: await makeColorFromCS(doc, gs.strokeCS, comps) };
          break;
        }

        /* XObjects */
        case 'Do': {
          const nm = operands[0] && operands[0].name;
          const xobjs = doc.resolve(resources && resources.XObject) || {};
          const ref = nm !== undefined ? xobjs[nm] : null;
          const entry = ref && typeof ref === 'object' && 'ref' in ref
            ? doc.objects.get(ref.ref) : null;
          const xv = entry && entry.value;
          if (xv && isName(xv.Subtype, 'Form') && entry.streamStart !== undefined) {
            let sub;
            try { sub = await doc.decodeStream(entry); } catch (e) { sub = null; }
            if (sub) {
              let ctm = gs.ctm;
              const mtx = doc.resolve(xv.Matrix);
              if (Array.isArray(mtx) && mtx.length === 6) ctm = matMul(mtx.map(Number), ctm);
              const subRes = doc.resolve(xv.Resources) || resources;
              await runContentStream(doc, sub, subRes, { ...gs, ctm }, shapes, depth + 1);
            }
          }
          break;
        }

        /* inline images: skip binary data through EI */
        case 'BI': {
          let e = i;
          for (;;) {
            e = S.indexOf('EI', e);
            if (e < 0) { e = len; break; }
            const before = e === 0 ? ' ' : S[e - 1];
            const after = e + 2 < len ? S[e + 2] : ' ';
            if (isWs(before) && (isWs(after) || isDelim(after) || e + 2 >= len)) { e += 2; break; }
            e += 2;
          }
          i = e;
          break;
        }

        default:
          // text ops & other no-ops: just consume operands
          break;
      }
    } catch (e) { /* keep interpreting; one bad op shouldn't kill the page */ }
    operands.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

async function parsePDF(input) {
  const bytes = toBytes(input);
  const head = latin1(bytes.subarray(0, Math.min(1024, bytes.length)));
  if (head.indexOf('%PDF-') < 0) {
    if (head.indexOf('%!PS-Adobe') === 0) {
      throw new Error('This .ai file has no PDF compatibility (legacy PostScript format). ' +
        'Re-save it from Illustrator with "Create PDF Compatible File" checked.');
    }
    throw new Error('Not a PDF file (missing %PDF header)');
  }

  const doc = new PDFDoc(bytes);
  doc.scan();
  await doc.expandObjectStreams();

  // document metadata / AI detection
  let creator = '', producer = '';
  const info = doc.resolve(doc.trailer.Info);
  if (info && typeof info === 'object') {
    const cv = doc.resolve(info.Creator), pv = doc.resolve(info.Producer);
    if (cv && cv.str) creator = cv.str;
    if (pv && pv.str) producer = pv.str;
  }
  const isAI = /Illustrator/i.test(creator + ' ' + producer) ||
    doc.S.indexOf('Adobe Illustrator') >= 0 || doc.S.indexOf('%%AI') >= 0;

  const pageEntries = doc.collectPages();
  if (!pageEntries.length) throw new Error('No pages found in PDF');

  const docPalette = new Map();
  const pages = [];

  for (const { dict, inherited } of pageEntries) {
    const mb = (doc.resolve(inherited.MediaBox) || [0, 0, 612, 792]).map(v => Number(doc.resolve(v)));
    const x0 = Math.min(mb[0], mb[2]), y0 = Math.min(mb[1], mb[3]);
    const x1 = Math.max(mb[0], mb[2]), y1 = Math.max(mb[1], mb[3]);
    let w = x1 - x0, h = y1 - y0;
    const rotate = ((Number(doc.resolve(inherited.Rotate)) || 0) % 360 + 360) % 360;

    // Base matrix: PDF user space (y-up, origin at MediaBox lower-left)
    // -> app space (y-down, origin top-left), with /Rotate applied.
    let base = [1, 0, 0, -1, -x0, y1]; // unrotated
    if (rotate === 90) { base = [0, 1, 1, 0, -y0, -x0]; const t = w; w = h; h = t; }
    else if (rotate === 180) { base = [-1, 0, 0, 1, x1, -y0]; }
    else if (rotate === 270) { base = [0, -1, -1, 0, y1, x1]; const t = w; w = h; h = t; }

    const shapes = [];
    const resources = doc.resolve(inherited.Resources) || {};
    const content = await doc.pageContent(dict);
    const gs0 = {
      ctm: base,
      fill: colGray(0), stroke: colGray(0),
      fillCS: { kind: 'gray', n: 1 }, strokeCS: { kind: 'gray', n: 1 },
      lineWidth: 1,
    };
    await runContentStream(doc, content, resources, gs0, shapes, 0);

    const pagePalette = new Map();
    for (const s of shapes) {
      for (const col of [s.fill, s.stroke]) {
        if (!col) continue;
        const key = colorKey(col);
        for (const map of [pagePalette, docPalette]) {
          const cur2 = map.get(key);
          if (cur2) cur2.uses++;
          else map.set(key, { space: col.space, values: col.values.slice(), rgb: col.rgb.slice(), name: col.name, uses: 1 });
        }
      }
    }

    pages.push({
      width: w, height: h,
      shapes,
      colors: Array.from(pagePalette.values()),
    });
  }

  return {
    pageCount: pages.length,
    isAI,
    creator, producer,
    colors: Array.from(docPalette.values()),
    pages,
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

const api = global.VecPDF || (global.VecPDF = {});
api.parsePDF = parsePDF;
api._internal = { latin1, strToBytes, parseObj, inflate, cmyk2rgb };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

})(typeof window !== 'undefined' ? window : globalThis);
