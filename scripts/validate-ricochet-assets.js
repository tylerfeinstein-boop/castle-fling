'use strict';
/* ============================================================
   Castle Ricochet production asset validation (build gate).

   Run:  node scripts/validate-ricochet-assets.js
   Exits non-zero if any production sprite is broken, so a bad
   asset can never silently ship (§ asset build validation).

   Checks every PNG under assets/castle_ricochet/:
     - file decodes as a PNG (pure-Node decoder, no dependencies)
     - sprites carry a real alpha channel and are not empty
     - corner/border pixels are transparent (background stays opaque)
     - no white/gray checkerboard region survives
     - no banned source material (contact/preview/sheet/screenshot
       filenames) exists in the runtime tree
     - every sprite path referenced by ricochet.js exists on disk
   ============================================================ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ASSET_ROOT = path.join(ROOT, 'assets', 'castle_ricochet');

/* ---------------- minimal PNG decode (RGBA8) ---------------- */
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), bd: data[8], ct: data[9], il: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.il !== 0) throw new Error('interlaced PNG unsupported');
  const { w, h, bd, ct } = ihdr;
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * bd) >> 3);
  const stride = Math.ceil(channels * bd * w / 8);
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  const g16 = o => out.readUInt16BE(o) >> 8;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const di = (y * w + x) * 4;
    if (ct === 6) {
      if (bd === 8) { const o = y * stride + x * 4; rgba[di] = out[o]; rgba[di + 1] = out[o + 1]; rgba[di + 2] = out[o + 2]; rgba[di + 3] = out[o + 3]; }
      else { const o = y * stride + x * 8; rgba[di] = g16(o); rgba[di + 1] = g16(o + 2); rgba[di + 2] = g16(o + 4); rgba[di + 3] = g16(o + 6); }
    } else if (ct === 2) {
      let r, g, b;
      if (bd === 8) { const o = y * stride + x * 3; r = out[o]; g = out[o + 1]; b = out[o + 2]; }
      else { const o = y * stride + x * 6; r = g16(o); g = g16(o + 2); b = g16(o + 4); }
      rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = 255;
    } else if (ct === 3) {
      const idx = bd === 8 ? out[y * stride + x]
        : (out[y * stride + ((x * bd) >> 3)] >> (8 - bd - ((x * bd) & 7))) & ((1 << bd) - 1);
      rgba[di] = plte[idx * 3]; rgba[di + 1] = plte[idx * 3 + 1]; rgba[di + 2] = plte[idx * 3 + 2];
      rgba[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (ct === 0) {
      let g;
      if (bd === 8) g = out[y * stride + x];
      else if (bd === 16) g = g16(y * stride + x * 2);
      else { const v = (out[y * stride + ((x * bd) >> 3)] >> (8 - bd - ((x * bd) & 7))) & ((1 << bd) - 1); g = Math.round(v * 255 / ((1 << bd) - 1)); }
      rgba[di] = rgba[di + 1] = rgba[di + 2] = g; rgba[di + 3] = 255;
    } else if (ct === 4) {
      let g, a;
      if (bd === 8) { const o = y * stride + x * 2; g = out[o]; a = out[o + 1]; }
      else { const o = y * stride + x * 4; g = g16(o); a = g16(o + 2); }
      rgba[di] = rgba[di + 1] = rgba[di + 2] = g; rgba[di + 3] = a;
    }
  }
  return { w, h, ct, data: rgba };
}

/* ---------------- checks ---------------- */
const errors = [];
const fail = (rel, msg) => errors.push(rel + ': ' + msg);

/* "aim_contact_*" markers are production sprites — only contact SHEETS are source material */
const BANNED_NAME = /contact[-_]?sheet|preview|sheet|screenshot|composite|reference/i;
const MAX_DIM = 2048;                       // board background is 1672px wide

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function checkSprite(rel, img) {
  const { w, h, data: d } = img;
  const A = (x, y) => d[(y * w + x) * 4 + 3];
  if (img.ct !== 6 && img.ct !== 4) { fail(rel, 'no alpha channel (colorType ' + img.ct + ') — not a true RGBA sprite'); return; }
  let visible = 0, transparent = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 32) visible++; else if (d[i] < 8) transparent++; }
  if (visible === 0) fail(rel, 'image has no visible artwork (empty sprite)');
  if (transparent === 0) fail(rel, 'no transparent background at all — opaque rectangular canvas');
  /* corners must be transparent */
  for (const [cx, cy] of [[0, 0], [w - 4, 0], [0, h - 4], [w - 4, h - 4]]) {
    let m = 0;
    for (let y = cy; y < cy + 4; y++) for (let x = cx; x < cx + 4; x++) m = Math.max(m, A(x, y));
    if (m > 32) { fail(rel, 'opaque corner pixels — rectangular background or clipped neighbor'); break; }
  }
  /* checkerboard: periodic alternating neutral-light tiles */
  const neutral = (r, g, b) => Math.abs(r - g) <= 14 && Math.abs(g - b) <= 14 && Math.abs(r - b) <= 14;
  let hits = 0;
  for (const t of [8, 16, 24, 32]) {
    for (let y = 0; y + 2 * t < h; y += t) for (let x = 0; x + 2 * t < w; x += t) {
      const p = i => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
      const p0 = p(y * w + x), p1 = p(y * w + x + t), p3 = p(y * w + x + 2 * t);
      if (p0[3] < 200 || p1[3] < 200 || p3[3] < 200) continue;
      if (neutral(p0[0], p0[1], p0[2]) && neutral(p1[0], p1[1], p1[2]) &&
          p0[0] > 150 && p1[0] > 150 &&
          Math.abs(p0[0] - p3[0]) <= 8 && Math.abs(p0[0] - p1[0]) >= 24 && Math.abs(p0[0] - p1[0]) <= 90) hits++;
    }
  }
  if (hits > 24) fail(rel, 'checkerboard-like region detected (' + hits + ' periodic tile hits)');
}

/* ---------------- run ---------------- */
if (!fs.existsSync(ASSET_ROOT)) { console.error('assets/castle_ricochet missing'); process.exit(1); }
const files = walk(ASSET_ROOT, []);
let pngCount = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const base = path.basename(f);
  if (BANNED_NAME.test(base)) { fail(rel, 'banned source-material filename in runtime tree'); continue; }
  if (!/\.png$/i.test(base)) { if (!/\.(json|md)$/i.test(base)) fail(rel, 'unexpected non-PNG file'); continue; }
  pngCount++;
  let img;
  try { img = decodePNG(fs.readFileSync(f)); }
  catch (e) { fail(rel, 'failed to decode: ' + e.message); continue; }
  if (img.w < 8 || img.h < 8 || img.w > MAX_DIM || img.h > MAX_DIM) fail(rel, 'dimensions out of expected range: ' + img.w + 'x' + img.h);
  if (/\/backgrounds\//.test(rel)) continue;             // board art is intentionally opaque
  checkSprite(rel, img);
}

/* every sprite ricochet.js references must exist */
const src = fs.readFileSync(path.join(ROOT, 'ricochet.js'), 'utf8');
const referenced = new Set();
const push = rel => referenced.add(rel);
const reLit = /'((?:tokens|obstacles|ui|aim|backgrounds|props)\/[^']*?\.png)'/g;
let m;
while ((m = reLit.exec(src))) push(m[1]);
/* dynamic patterns assembled in code */
for (const f of ['token_player_royal_striker.png']) push('tokens/standardized_384/' + f);
const fileRe = /file:\s*'([^']+\.png)'/g;
while ((m = fileRe.exec(src))) {
  const f = m[1];
  push(f.indexOf('token_') === 0 ? 'tokens/standardized_384/' + f
    : f.indexOf('obstacle_') === 0 ? 'obstacles/' + f : 'ui/' + f);
}
for (const mode of ['primary_gold', 'enemy_output', 'striker_deflection', 'sink_safe', 'danger']) {
  for (const p of ['start_cap', 'shaft_tile', 'arrow_head']) push('aim/modular/' + mode + '/aim_' + mode + '_' + p + '.png');
}
for (const f of ['aim_contact_enemy', 'aim_contact_wall', 'aim_contact_pillar', 'aim_ricochet_joint', 'aim_sink_target', 'aim_danger_target']) push('aim/markers/' + f + '.png');
for (const mode of ['primary_gold', 'sink_safe', 'danger']) for (let l = 1; l <= 3; l++) push('aim/power/aim_' + mode + '_power_glow_' + l + '.png');
for (const rel of referenced) {
  if (!fs.existsSync(path.join(ASSET_ROOT, rel))) fail('ricochet.js', 'references missing asset ' + rel);
}
/* live-text guard: HUD/result values must never come from baked value sprites */
if (/ui_hud_value|ui_number_|baked_value/i.test(src)) fail('ricochet.js', 'static value sprite referenced where live text is required');

if (errors.length) {
  console.error('CASTLE RICOCHET ASSET VALIDATION FAILED (' + errors.length + ' problem' + (errors.length > 1 ? 's' : '') + '):');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('Castle Ricochet asset validation passed: ' + pngCount + ' PNGs verified, ' + referenced.size + ' runtime references resolved.');
