/* Build the four Kingdom Restoration completion medallions.
 *
 *   in   <source>/25%_completion_icon.png … 100%_completion_icon.png   1254x1254 RGBA
 *   out  assets/kingdom-restoration/progress-icons/icon_completion_25.png … _100.png
 *
 * Why this exists. The four supplied badges are one artwork with a different
 * numeral in the middle, so the ONLY thing that may differ between the four
 * outputs is that numeral. Cropping each file to its own alpha bounding box
 * would scale each badge by a slightly different factor — the 100% disc would
 * render a hair larger than the 25% disc in the same 42px slot, which reads as
 * a wobble when the popup cycles through them. So:
 *
 *   1. every source's alpha bbox is measured,
 *   2. the UNION of the four boxes is squared off around its own centre,
 *   3. all four are cropped with that ONE box and resized to the same square.
 *
 * The badges therefore share an identical disc diameter and centre, and the
 * output is square so `object-fit: contain` in a square slot can never stretch
 * one axis against the other.
 *
 * Fringe. The supplied art is already alpha-cut, but a generated cut-out can
 * carry a bright halo in its partially-transparent rim — invisible over white,
 * a white outline over the popup's dark parchment (see the 2026-07 ricochet
 * sprite repair). The rim is audited here and, where the premultiplied colour
 * of a partial pixel is brighter than the opaque art it borders, that pixel's
 * RGB is pulled back to its nearest opaque neighbour. Alpha is never touched,
 * so the silhouette and its antialiasing survive untouched.
 *
 * Re-runnable: reads the sources, writes only the four outputs.
 * Run: node scripts/build-kr-completion-icons.js [sourceDir]
 */
const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '..', 'build', 'mobile', 'node_modules', 'sharp'));

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'kingdom-restoration', 'progress-icons');
const SRC_DIR = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
const PCTS = [25, 50, 75, 100];
const SIZE = 192;              // 42px slot × 3 DPR, with headroom — see .krNoticeIco
const ALPHA_EDGE = 8;          // below this a pixel is background, not rim

const srcPath = pct => path.join(SRC_DIR, pct + '%_completion_icon.png');
const outPath = pct => path.join(OUT_DIR, 'icon_completion_' + pct + '.png');

async function load(pct) {
  const { data, info } = await sharp(srcPath(pct)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, pct };
}
const at = (im, x, y) => (y * im.w + x) * 4;

/* alpha bounding box — anything at or below ALPHA_EDGE is background */
function bbox(im) {
  let x0 = im.w, y0 = im.h, x1 = -1, y1 = -1;
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < im.w; x++) {
      if (im.data[at(im, x, y) + 3] > ALPHA_EDGE) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/* ---- rim de-fringe ----
   For every partially transparent pixel, find the brightest/nearest OPAQUE
   neighbour in the 3×3 ring and clamp the rim pixel's RGB to it when the rim
   is brighter. A halo is by definition brighter than the art it surrounds;
   real soft edges (the badge's own gold bevel) already match their neighbour
   and are left alone. Alpha is never modified. */
function defringe(im) {
  const out = Buffer.from(im.data);
  let touched = 0;
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (let y = 0; y < im.h; y++) {
    for (let x = 0; x < im.w; x++) {
      const i = at(im, x, y);
      const a = im.data[i + 3];
      if (a <= ALPHA_EDGE || a >= 250) continue;
      let best = null, bestA = -1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= im.w || ny >= im.h) continue;
          const j = at(im, nx, ny);
          if (im.data[j + 3] > bestA) { bestA = im.data[j + 3]; best = j; }
        }
      }
      if (best === null || bestA < 250) continue;
      const rl = lum(im.data[i], im.data[i + 1], im.data[i + 2]);
      const nl = lum(im.data[best], im.data[best + 1], im.data[best + 2]);
      if (rl > nl + 12) {
        out[i] = im.data[best]; out[i + 1] = im.data[best + 1]; out[i + 2] = im.data[best + 2];
        touched++;
      }
    }
  }
  return { data: out, touched };
}

/* interior erasure holes: fully transparent pixels enclosed by opaque art.
   Reported only — a hole in supplied art is an art bug, not something to
   guess a fill colour for. */
function interiorHoles(im, box) {
  let holes = 0;
  for (let y = box.y0 + 1; y < box.y1; y++) {
    for (let x = box.x0 + 1; x < box.x1; x++) {
      if (im.data[at(im, x, y) + 3] > ALPHA_EDGE) continue;
      let solid = 0;
      for (let d = 1; d <= 40; d++) {
        if (x - d >= box.x0 && im.data[at(im, x - d, y) + 3] > 200) { solid++; break; }
      }
      for (let d = 1; d <= 40; d++) {
        if (x + d <= box.x1 && im.data[at(im, x + d, y) + 3] > 200) { solid++; break; }
      }
      for (let d = 1; d <= 40; d++) {
        if (y - d >= box.y0 && im.data[at(im, x, y - d) + 3] > 200) { solid++; break; }
      }
      for (let d = 1; d <= 40; d++) {
        if (y + d <= box.y1 && im.data[at(im, x, y + d) + 3] > 200) { solid++; break; }
      }
      if (solid === 4) holes++;
    }
  }
  return holes;
}

(async () => {
  for (const pct of PCTS) {
    if (!fs.existsSync(srcPath(pct))) {
      console.error('missing source: ' + srcPath(pct));
      process.exit(1);
    }
  }
  const imgs = [];
  for (const pct of PCTS) imgs.push(await load(pct));

  /* one shared crop box: union of the four alpha boxes, squared about its
     own centre and clamped to the canvas */
  const boxes = imgs.map(bbox);
  boxes.forEach((b, i) => console.log(`  ${PCTS[i]}%  bbox ${b.x0},${b.y0}..${b.x1},${b.y1}` +
    `  holes=${interiorHoles(imgs[i], b)}`));
  const u = boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
  }));
  const cx = (u.x0 + u.x1) / 2, cy = (u.y0 + u.y1) / 2;
  let half = Math.ceil(Math.max(u.x1 - u.x0, u.y1 - u.y0) / 2) + 1;
  const W = imgs[0].w, H = imgs[0].h;
  half = Math.min(half, Math.floor(Math.min(cx, cy, W - 1 - cx, H - 1 - cy)));
  const left = Math.round(cx - half), top = Math.round(cy - half), side = half * 2;
  console.log(`shared crop ${side}x${side} at ${left},${top}`);

  for (const im of imgs) {
    const fixed = defringe(im);
    if (fixed.touched) console.log(`  ${im.pct}%  de-fringed ${fixed.touched} rim px`);
    await sharp(fixed.data, { raw: { width: im.w, height: im.h, channels: 4 } })
      .extract({ left, top, width: side, height: side })
      .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })   // square -> square: no distortion
      .png({ compressionLevel: 9 })
      .toFile(outPath(im.pct));
    const st = fs.statSync(outPath(im.pct));
    console.log(`icon_completion_${im.pct}.png  ${SIZE}x${SIZE}  ${(st.size / 1024).toFixed(1)} KB`);
  }
})();
