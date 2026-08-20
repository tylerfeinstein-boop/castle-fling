/* Re-derive the two locked-button pieces from the CURRENT locked plaque.
 *
 *   in   assets/ui/theme/ui_button_disabled_locked.png   314x75
 *   out  assets/ui/theme/ui_button_disabled_body.png     272x75  (lock spliced out)
 *   out  assets/ui/theme/ui_lock_emblem.png              ~26x30  (lock alone)
 *
 * Why this exists twice. scripts/rebuild-ui-fix-sprites.js first performed this
 * split during the 2026-07-26 UI fix pass, reading the plaque out of
 * revert-backup/pre-ui-fix-pass/. The 2026-07-28 "quick sprite fix" pass then
 * installed a recut ui_button_disabled_locked.png with a genuinely clean alpha
 * trim (art bbox 3,2..310,69 instead of the old 1,1..312,73, i.e. the old
 * sprite's soft halo ran right off the canvas edge and straight through the
 * nine-slice corners) — but left the two DERIVED files pointing at the old art,
 * so the locked buttons in Castle Rooms, Milestones and the Crown Shop were the
 * one place in the theme still rendering the pre-fix sprite. This script redoes
 * the same split against the installed plaque, so the derived pair always
 * tracks whatever ui_button_disabled_locked.png currently is.
 *
 * The split itself is unchanged and is not cosmetic: nine-slicing the plaque
 * whole can only squash or slice the baked-in lock, so the plaque is spliced
 * shut and the lock rides on top as its own fixed-aspect element (see the
 * .roomBtn:disabled rules in style.css).
 *
 * Re-runnable: only the two outputs are written, never the input.
 * Run: node scripts/rebuild-locked-button-sprites.js
 */
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'build', 'mobile', 'node_modules', 'sharp'));

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'assets', 'ui', 'theme');
const SRC = path.join(DIR, 'ui_button_disabled_locked.png');

const blank = (w, h) => ({ data: Buffer.alloc(w * h * 4), w, h });
const put = (img, x, y, rgba) => {
  const i = (y * img.w + x) * 4;
  img.data[i] = rgba[0]; img.data[i + 1] = rgba[1]; img.data[i + 2] = rgba[2]; img.data[i + 3] = rgba[3];
};
const write = (img, name) =>
  sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toFile(path.join(DIR, name));

/* geometry of the plaque, re-measured on the current art:
     lock art          x 254..279, y 21..49
     plain body run    x 120..200  (the colour the lock is keyed against)
     right frame band  from x 288  */
const KEEP_L = 246, RIGHT_FROM = 288, FADE_FROM = 238;
const CUT = { x0: 248, x1: 286, y0: 12, y1: 58 };

(async () => {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };

  /* ---- body: keep x0..KEEP_L, then jump straight to the right frame ---- */
  const OFFSET = RIGHT_FROM - KEEP_L;
  const BW = KEEP_L + (W - RIGHT_FROM);
  const body = blank(BW, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < BW; x++) {
      let p;
      if (x < FADE_FROM) p = px(x, y);
      else if (x < KEEP_L) {
        const t = (x - FADE_FROM) / (KEEP_L - FADE_FROM);   // 8px crossfade hides the join
        const a = px(x, y), b = px(x + OFFSET, y);
        p = [0, 1, 2, 3].map(k => Math.round(a[k] * (1 - t) + b[k] * t));
      } else p = px(x + OFFSET, y);
      put(body, x, y, p);
    }
  }
  await write(body, 'ui_button_disabled_body.png');
  console.log(`ui_button_disabled_body.png ${BW}x${H}`);

  /* ---- emblem: keyed row by row against the plaque's own panel colour ----
     The plaque is a vertical gradient, so a single background colour would
     leave a dark band top and bottom; the median of a plain body run at the
     SAME row is the only key that cancels it. */
  const bg = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 120; x < 200; x++) row.push(px(x, y));
    row.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    bg.push(row[row.length >> 1]);
  }
  const lw = CUT.x1 - CUT.x0, lh = CUT.y1 - CUT.y0;
  const cut = blank(lw, lh);
  for (let y = CUT.y0; y < CUT.y1; y++) {
    for (let x = CUT.x0; x < CUT.x1; x++) {
      const p = px(x, y), b = bg[y];
      const diff = Math.max(Math.abs(p[0] - b[0]), Math.abs(p[1] - b[1]), Math.abs(p[2] - b[2]));
      const a = Math.max(0, Math.min(1, (diff - 10) / 16));   // 10: plaque grain never keys in
      put(cut, x - CUT.x0, y - CUT.y0, [p[0], p[1], p[2], Math.round(a * (p[3] / 255) * 255)]);
    }
  }
  /* drop specks the key picked up outside the lock, then trim to the alpha box
     so CSS can size the emblem by aspect ratio alone */
  const keep = Buffer.alloc(lw * lh);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px2 = x + dx, py2 = y + dy;
      if (px2 < 0 || py2 < 0 || px2 >= lw || py2 >= lh) continue;
      if (cut.data[(py2 * lw + px2) * 4 + 3] > 40) n++;
    }
    keep[y * lw + x] = n >= 4 ? 1 : 0;
  }
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    if (!keep[y * lw + x]) cut.data[(y * lw + x) * 4 + 3] = 0;
  }

  let mnx = lw, mxx = -1, mny = lh, mxy = -1;
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    if (cut.data[(y * lw + x) * 4 + 3] > 6) {
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
    }
  }
  const tw = mxx - mnx + 1, th = mxy - mny + 1;
  const emblem = blank(tw, th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = ((y + mny) * lw + (x + mnx)) * 4;
    put(emblem, x, y, [cut.data[i], cut.data[i + 1], cut.data[i + 2], cut.data[i + 3]]);
  }
  await write(emblem, 'ui_lock_emblem.png');
  console.log(`ui_lock_emblem.png          ${tw}x${th}  (source box ${CUT.x0 + mnx},${CUT.y0 + mny})`);
})().catch(e => { console.error(e); process.exit(1); });
