'use strict';
/* ============================================================
   Castle Ricochet obstacle collider audit (dev QA).

   Run:  node scripts/audit-obstacle-colliders.js [--sheets]

   Reads the obstacle catalog straight out of ricochet.js (never a
   copy) and measures every declared collider against the ACTUAL
   alpha silhouette of its sprite, at the exact scale and bottom
   anchor the game draws it with.

   The catalog describes where an obstacle MEETS THE FLOOR in this
   3/4 art, so the check is per collider band, not per sprite box:
   for each horizontal slice a collider covers, it reports how far
   the collider edge sits OUTSIDE the visible silhouette (slack —
   a token bounces off nothing) and how far INSIDE it sits (bite —
   a token visibly enters the art before bouncing).

   --sheets also writes a 3x overlay PNG per obstacle to
   docs/collider-audit/ (red = collider, green = silhouette edge)
   so a number that looks wrong can be eyeballed.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharp = require(path.join(ROOT, 'build', 'mobile', 'node_modules', 'sharp'));
const SRC = fs.readFileSync(path.join(ROOT, 'ricochet.js'), 'utf8');
const OBST_DIR = path.join(ROOT, 'assets', 'castle_ricochet', 'obstacles');
const SHEET_DIR = path.join(ROOT, 'docs', 'collider-audit');
const WRITE_SHEETS = process.argv.indexOf('--sheets') >= 0;
const ALPHA_EDGE = 24;

/* ---- pull OBSTACLES + footprintBottom out of ricochet.js ---- */
function extractCatalog() {
  const start = SRC.indexOf('const OBSTACLES = {');
  if (start < 0) throw new Error('OBSTACLES not found in ricochet.js');
  let i = SRC.indexOf('{', start), depth = 0, end = -1;
  for (let k = i; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function('return ' + SRC.slice(i, end))();
}
const OBSTACLES = extractCatalog();
function footprintBottom(def) {
  if (def.footY !== undefined) return def.footY;
  let fb = 0;
  for (const c of def.cols) {
    if (c.t === 'rect') fb = Math.max(fb, (c.oy || 0) + c.hh);
    else if (c.t === 'circle') fb = Math.max(fb, (c.oy || 0) + c.r * 0.7);
    else if (c.t === 'ellipse') fb = Math.max(fb, (c.oy || 0) + c.ry);
    else fb = Math.max(fb, Math.max(c.y1, c.y2) + c.th / 2);
  }
  return fb;
}

async function load(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

(async () => {
  if (WRITE_SHEETS) fs.mkdirSync(SHEET_DIR, { recursive: true });
  const rows = [];
  for (const kind of Object.keys(OBSTACLES)) {
    const def = OBSTACLES[kind];
    const img = await load(path.join(OBST_DIR, def.file));
    const scale = def.drawW / img.w;                 // source px -> board px
    const drawH = img.h * scale;
    const footY = footprintBottom(def);
    /* board offset (ox,oy) from the anchor -> source pixel */
    const toPx = (ox, oy) => ({ px: (ox + def.drawW / 2) / scale, py: (oy - footY + drawH) / scale });
    const alpha = (x, y) => {
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) return 0;
      return img.data[(iy * img.w + ix) * 4 + 3];
    };
    /* per-source-row silhouette extent */
    const rowMin = new Int32Array(img.h).fill(-1), rowMax = new Int32Array(img.h).fill(-1);
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) if (img.data[(y * img.w + x) * 4 + 3] > ALPHA_EDGE) { rowMin[y] = x; break; }
      for (let x = img.w - 1; x >= 0; x--) if (img.data[(y * img.w + x) * 4 + 3] > ALPHA_EDGE) { rowMax[y] = x; break; }
    }
    let lastVisible = 0;
    for (let y = img.h - 1; y >= 0; y--) if (rowMin[y] >= 0) { lastVisible = y; break; }

    const marks = [];   // overlay geometry, source px
    const out = { kind, file: def.file, drawW: def.drawW, footY: +footY.toFixed(1), cols: [] };
    for (let ci = 0; ci < def.cols.length; ci++) {
      const c = def.cols[ci];
      const info = { t: c.t, ci };
      if (c.t === 'rect') {
        const ox = c.ox || 0, oy = c.oy || 0;
        const tl = toPx(ox - c.hw, oy - c.hh), br = toPx(ox + c.hw, oy + c.hh);
        marks.push({ kind: 'rect', x0: tl.px, y0: tl.py, x1: br.px, y1: br.py });
        /* Compare the collider EXTENT to the art's extent across its own band.
           Deliberately not the worst single row: in 3/4 view a base is a
           parallelogram/diamond, so individual rows are narrower than the
           shape by design and a per-row worst case reports every correct
           collider as broken. */
        let aMin = 1e9, aMax = -1e9, empty = 0;
        const xLo = Math.max(0, Math.floor(tl.px) - 10), xHi = Math.min(img.w - 1, Math.ceil(br.px) + 10);
        for (let py = Math.max(0, Math.ceil(tl.py)); py <= Math.min(img.h - 1, Math.floor(br.py)); py++) {
          /* clip the scan to this collider's own span: on a multi-collider
             sprite (L-blocks, wall corners) the neighbouring part's art would
             otherwise be blamed on this one */
          let lo = -1, hi = -1;
          for (let x = xLo; x <= xHi; x++) if (alpha(x, py) > ALPHA_EDGE) { lo = x; break; }
          for (let x = xHi; x >= xLo; x--) if (alpha(x, py) > ALPHA_EDGE) { hi = x; break; }
          if (lo < 0) { empty++; continue; }
          aMin = Math.min(aMin, lo); aMax = Math.max(aMax, hi);
        }
        info.emptyRows = empty;
        info.artWidth = aMax > aMin ? +((aMax - aMin) * scale).toFixed(1) : null;
        info.width = +(2 * c.hw).toFixed(1);
        /* per side: >0 = collider sticks out past the art (phantom collision) */
        info.slack = aMax > aMin ? +Math.max((aMin - tl.px) * scale, (br.px - aMax) * scale, 0).toFixed(1) : 0;
        info.bite = aMax > aMin ? +Math.max((tl.px - aMin) * scale, (aMax - br.px) * scale, 0).toFixed(1) : 0;
        info.bottomGap = +((lastVisible - br.py) * scale).toFixed(1);   // >0: art continues below the collider
      } else if (c.t === 'ellipse' || c.t === 'circle') {
        const ox = c.ox || 0, oy = c.oy || 0;
        const rx = c.t === 'circle' ? c.r : c.rx, ry = c.t === 'circle' ? c.r : c.ry;
        marks.push({ kind: 'ellipse', c: toPx(ox, oy), rx: rx / scale, ry: ry / scale });
        /* extents only, for the same reason as rects: sampling the ellipse's
           own boundary against per-row silhouette edges compares points that
           are not on the same feature and reports nonsense */
        const top = Math.max(0, Math.ceil(toPx(ox, oy - ry).py)), bot = Math.min(img.h - 1, Math.floor(toPx(ox, oy + ry).py));
        const eL = toPx(ox - rx, oy).px, eR = toPx(ox + rx, oy).px;
        const xLo = Math.max(0, Math.floor(eL) - 10), xHi = Math.min(img.w - 1, Math.ceil(eR) + 10);
        let aMin = 1e9, aMax = -1e9;
        for (let py = top; py <= bot; py++) {       // clipped to this footprint's own span
          let lo = -1, hi = -1;
          for (let x = xLo; x <= xHi; x++) if (alpha(x, py) > ALPHA_EDGE) { lo = x; break; }
          for (let x = xHi; x >= xLo; x--) if (alpha(x, py) > ALPHA_EDGE) { hi = x; break; }
          if (lo < 0) continue;
          aMin = Math.min(aMin, lo); aMax = Math.max(aMax, hi);
        }
        info.slack = aMax > aMin ? +Math.max((aMin - eL) * scale, (eR - aMax) * scale, 0).toFixed(1) : 0;
        info.bite = aMax > aMin ? +Math.max((eL - aMin) * scale, (aMax - eR) * scale, 0).toFixed(1) : 0;
        info.bottomGap = +((lastVisible - toPx(ox, oy + ry).py) * scale).toFixed(1);
        info.width = +(2 * rx).toFixed(1);
      } else {
        const a = toPx(c.x1, c.y1), b = toPx(c.x2, c.y2);
        marks.push({ kind: 'seg', a, b, th: c.th / scale });
        info.width = +Math.hypot(c.x2 - c.x1, c.y2 - c.y1).toFixed(1);
        info.slack = null; info.bite = null;
      }
      out.cols.push(info);
    }
    rows.push(out);

    if (WRITE_SHEETS) {
      const buf = Buffer.from(img.data);
      const put = (x, y, rgb) => {
        const ix = Math.round(x), iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) return;
        const i = (iy * img.w + ix) * 4;
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255;
      };
      for (let y = 0; y < img.h; y++) {                       // silhouette edge, green
        if (rowMin[y] < 0) continue;
        put(rowMin[y], y, [40, 255, 80]); put(rowMax[y], y, [40, 255, 80]);
      }
      for (const m of marks) {                                // collider, red
        if (m.kind === 'rect') {
          for (let x = m.x0; x <= m.x1; x += 0.5) { put(x, m.y0, [255, 40, 40]); put(x, m.y1, [255, 40, 40]); }
          for (let y = m.y0; y <= m.y1; y += 0.5) { put(m.x0, y, [255, 40, 40]); put(m.x1, y, [255, 40, 40]); }
        } else if (m.kind === 'ellipse') {
          for (let a = 0; a < 1440; a++) {
            const th = a / 1440 * 2 * Math.PI;
            put(m.c.px + Math.cos(th) * m.rx, m.c.py + Math.sin(th) * m.ry, [255, 40, 40]);
          }
        } else {
          const len = Math.hypot(m.b.px - m.a.px, m.b.py - m.a.py);
          const ux = (m.b.px - m.a.px) / len, uy = (m.b.py - m.a.py) / len;
          for (let t = 0; t <= len; t += 0.5) for (const s of [-m.th / 2, 0, m.th / 2]) {
            put(m.a.px + ux * t - uy * s, m.a.py + uy * t + ux * s, [255, 40, 40]);
          }
        }
      }
      await sharp(buf, { raw: { width: img.w, height: img.h, channels: 4 } })
        .resize({ width: img.w * 3, kernel: 'nearest' })
        .png().toFile(path.join(SHEET_DIR, kind + '.png'));
    }
  }

  /* ---- report ---- */
  const pad = (s, n) => (s + '                        ').slice(0, n);
  console.log(pad('obstacle', 22) + pad('collider', 10) + pad('slack', 8) + pad('bite', 8) + pad('botGap', 9) + 'note');
  let flagged = 0;
  for (const r of rows) for (const c of r.cols) {
    const notes = [];
    if (c.slack !== null && c.slack >= 6) notes.push('LOOSE: ' + c.slack + 'px past the art');
    if (c.bite !== null && c.bite >= 10) notes.push('narrower than the art by ' + c.bite + 'px');
    if (c.emptyRows > 2) notes.push(c.emptyRows + ' rows of the band are empty');
    if (c.bottomGap !== undefined && c.bottomGap <= -6) notes.push('bottom sits ' + (-c.bottomGap) + 'px BELOW the art');
    if (c.bottomGap !== undefined && c.bottomGap >= 8) notes.push('art continues ' + c.bottomGap + 'px below');
    if (notes.length) flagged++;
    console.log(pad(r.kind, 22) + pad(c.t + '#' + c.ci, 10) +
      pad(c.slack === null ? '-' : String(c.slack), 8) +
      pad(c.bite === null ? '-' : String(c.bite), 8) +
      pad(c.bottomGap === undefined ? '-' : String(c.bottomGap), 9) + notes.join(', '));
  }
  console.log('\n' + flagged + ' collider(s) flagged.');
  if (WRITE_SHEETS) console.log('overlays: ' + path.relative(ROOT, SHEET_DIR).replace(/\\/g, '/'));
})();
