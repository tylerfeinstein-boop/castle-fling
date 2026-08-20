'use strict';
/* ============================================================
   Build the Castle Ricochet metal hole-rim runtime sprite.

   Run:  node scripts/build-hole-rim-sprite.js

   Re-runnable and non-destructive: the ONLY input is the
   untouched 1254x1254 source in revert-backup/pre-hole-rims/,
   never anything under assets/, so running this twice produces
   the same bytes and the original art is never overwritten.

   What it does:
     1. alpha-trims the source to its artwork bounds (the source
        canvas has ~60px of empty margin, and an untrimmed sprite
        would make every ring placement drift)
     2. downscales to RIM_W px wide (the ring is never drawn
        larger than ~420 device px, so 512 is ample and keeps the
        decoded bitmap ~40x smaller than the source on mobile)
     3. measures the INNER OPENING of the trimmed sprite and
        prints the ratios ricochet.js needs to place rings by
        their opening rather than by their image box

   The printed RIM_GEO block is the single source of truth for
   ring placement AND for the pit sink trigger — paste it into
   ricochet.js whenever this sprite is rebuilt.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharp = require(path.join(ROOT, 'build', 'mobile', 'node_modules', 'sharp'));

const SRC = path.join(ROOT, 'revert-backup', 'pre-hole-rims', 'hole_perimeter_sprite_source.png');
const OUT_DIR = path.join(ROOT, 'assets', 'castle_ricochet', 'props');
const OUT = path.join(OUT_DIR, 'prop_hole_rim_metal.png');
const RIM_W = 512;                 // runtime width in px
const ALPHA_EDGE = 24;             // alpha above this counts as artwork

async function raw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/* artwork bounds of an RGBA buffer */
function alphaBounds(img) {
  const { data, w, h } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > ALPHA_EDGE) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* the transparent region enclosed by the ring = the visible opening */
function innerOpening(img) {
  const { data, w, h } = img;
  const seen = new Uint8Array(w * h);
  const cx = w >> 1, cy = h >> 1;
  if (data[(cy * w + cx) * 4 + 3] > ALPHA_EDGE) throw new Error('sprite centre is opaque — not a ring');
  const st = [[cx, cy]];
  seen[cy * w + cx] = 1;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  while (st.length) {
    const [x, y] = st.pop();
    n++;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) throw new Error('inner fill escaped the ring');
      const k = ny * w + nx;
      if (seen[k] || data[k * 4 + 3] > ALPHA_EDGE) continue;
      seen[k] = 1; st.push([nx, ny]);
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: n };
}

(async () => {
  if (!fs.existsSync(SRC)) { console.error('missing source: ' + SRC); process.exit(1); }
  const src = await raw(SRC);
  const b = alphaBounds(src);
  const outH = Math.round(RIM_W * b.h / b.w);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await sharp(SRC)
    .extract({ left: b.x0, top: b.y0, width: b.w, height: b.h })
    .resize({ width: RIM_W, height: outH, fit: 'fill', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  const out = await raw(OUT);
  const inner = innerOpening(out);
  const icx = (inner.x0 + inner.x1) / 2, icy = (inner.y0 + inner.y1) / 2;
  const geo = {
    innerCX: +(icx / out.w).toFixed(5),          // opening centre as a fraction of the image
    innerCY: +(icy / out.h).toFixed(5),
    innerRX: +(inner.w / 2 / out.w).toFixed(5),  // opening semi-axes as a fraction of the image
    innerRY: +(inner.h / 2 / out.h).toFixed(5),
  };
  console.log('source      ' + src.w + 'x' + src.h + '  artwork bounds ' + b.w + 'x' + b.h + ' at ' + b.x0 + ',' + b.y0);
  console.log('written     ' + path.relative(ROOT, OUT).replace(/\\/g, '/') + '  ' + out.w + 'x' + out.h +
    '  (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB, source ' + (fs.statSync(SRC).size / 1024).toFixed(0) + ' KB)');
  console.log('opening     ' + inner.w + 'x' + inner.h + ' px, ellipse fill ' +
    (inner.area / (Math.PI * inner.w * inner.h / 4)).toFixed(3) + ' (1.000 = a perfect ellipse)');
  console.log('\n  const RIM_GEO = ' + JSON.stringify(geo) + ';\n');
})();
