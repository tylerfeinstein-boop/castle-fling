/* Rebuild the four theme sprites that the 2026-07-26 UI fix pass depends on.
 *
 * Re-runnable: every input lives in revert-backup/pre-ui-fix-pass/, never in
 * assets/, so running this twice produces the same bytes.
 *
 *   ui_volume_slider_track.png   40x20  nine-sliceable pill (14px caps)
 *   ui_volume_slider_knob.png    42x42  round gold knob
 *   ui_button_disabled_body.png  272x75 locked plaque with the lock cut out
 *   ui_lock_emblem.png           ~26x36 the lock on its own
 *
 * Why the first two are rebuilt rather than tweaked: the shipped track was cut
 * out of the pack's ui_volume_slider.png with a stray cap fragment left at
 * x0-16 and no left cap on the bar, and the shipped knob was a disc clipped by
 * the crop box with a rectangular alpha mask flood-filled over the bottom half.
 * Both are re-cut here straight from the pack original.
 *
 * Run: node scripts/rebuild-ui-fix-sprites.js
 */
const path = require('path');
const sharp = require(path.join(__dirname, '..', 'build', 'mobile', 'node_modules', 'sharp'));

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'revert-backup', 'pre-ui-fix-pass');
const OUT = path.join(ROOT, 'assets', 'ui', 'theme');

const load = async file => {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
};
const blank = (w, h) => ({ data: Buffer.alloc(w * h * 4), w, h, c: 4 });
const put = (img, x, y, rgba) => {
  const i = (y * img.w + x) * 4;
  img.data[i] = rgba[0]; img.data[i + 1] = rgba[1]; img.data[i + 2] = rgba[2]; img.data[i + 3] = rgba[3];
};
const write = (img, name) =>
  sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toFile(path.join(OUT, name));

/* bilinear sample, clamped to the source edges */
function sample(img, fx, fy) {
  const x = Math.max(0, Math.min(img.w - 1.001, fx));
  const y = Math.max(0, Math.min(img.h - 1.001, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1);
  const at = (px, py) => { const i = (py * img.w + px) * img.c; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
  return [0, 1, 2].map(k =>
    Math.round((a[k] * (1 - tx) + b[k] * tx) * (1 - ty) + (c[k] * (1 - tx) + d[k] * tx) * ty));
}

/* ---------------------------------------------------------------- track ---
 * Pack geometry (ui_volume_slider.png, 390x85, opaque white background):
 * the unfilled dark pill runs y29..y48 and ends at x=373.5, so it is a 20px
 * capsule with a 10px radius. Only the right cap survives in the art (the left
 * end of the pack slider is the gold "filled" portion under the knob), so the
 * left cap is that same cap mirrored. 14px caps + a 12px stretchable middle.
 */
async function buildTrack() {
  const src = await load(path.join(SRC, 'ui_volume_slider_PACK_SOURCE.png'));
  const PILL_TOP = 29, PILL_RIGHT = 373;   // last art column of the right cap
  const CAP = 14, MID = 12, H = 20;
  const W = CAP * 2 + MID;
  const out = blank(W, H);

  /* out column -> source column (the middle re-uses a plain stretch of pill) */
  const srcX = x => {
    if (x < CAP) return (PILL_RIGHT - CAP + 1) + (CAP - 1 - x);   // mirrored right cap
    if (x < CAP + MID) return 250 + (x - CAP);                    // plain middle
    return (PILL_RIGHT - CAP + 1) + (x - CAP - MID);              // right cap
  };
  const mirrored = x => x < CAP;

  /* capsule coverage in output space */
  const R = 10, cy = H / 2;
  const dist = (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    const cx = Math.max(R, Math.min(W - R, px));
    return Math.hypot(px - cx, py - cy);
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = dist(x, y);
      const a = Math.max(0, Math.min(1, R + 0.5 - d));
      if (a <= 0) continue;
      /* edge pixels sample 1.5px further in so no white background bleeds in */
      let sx = srcX(x), sy = PILL_TOP + y;
      if (a < 0.99) {
        const px = x + 0.5, py = y + 0.5;
        const cx = Math.max(R, Math.min(W - R, px));
        const nx = (px - cx) / (d || 1), ny = (py - cy) / (d || 1);
        sx = srcX(x) - (mirrored(x) ? -nx : nx) * 1.5;
        sy = PILL_TOP + y - ny * 1.5;
      }
      const rgb = sample(src, sx, sy);
      put(out, x, y, [rgb[0], rgb[1], rgb[2], Math.round(a * 255)]);
    }
  }
  await write(out, 'ui_volume_slider_track.png');
  console.log(`ui_volume_slider_track.png  ${W}x${H}`);
}

/* ----------------------------------------------------------------- knob ---
 * The knob is a disc centred at (154.5, 39.6) with r≈20.2 in the pack art.
 * Masked to that circle it drops both the baked drop shadow and the track it
 * overlaps; CSS supplies the shadow, matching the rest of the theme pack.
 */
async function buildKnob() {
  const src = await load(path.join(SRC, 'ui_volume_slider_PACK_SOURCE.png'));
  const CX = 154.5, CY = 39.6, R = 20.2;
  const S = 42, oc = S / 2;
  const out = blank(S, S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - oc, dy = y + 0.5 - oc;
      const d = Math.hypot(dx, dy);
      const a = Math.max(0, Math.min(1, R + 0.5 - d));
      if (a <= 0) continue;
      const pull = a < 0.99 ? 1.5 : 0;
      const k = d ? (d - pull) / d : 0;
      const rgb = sample(src, CX + dx * k, CY + dy * k);
      put(out, x, y, [rgb[0], rgb[1], rgb[2], Math.round(a * 255)]);
    }
  }
  await write(out, 'ui_volume_slider_knob.png');
  console.log(`ui_volume_slider_knob.png   ${S}x${S}`);
}

/* -------------------------------------------------- locked button pieces ---
 * ui_button_disabled_locked.png is 314x75: a plaque whose right third carries
 * a baked lock emblem (x256..279, y20..49). Nine-slicing it can only ever
 * squash or slice that emblem, so the sprite is split into two assets:
 *   - the plaque with the lock band spliced out, symmetric enough to nine-slice
 *     with the same 26/10px numbers as every other button in the theme;
 *   - the lock on its own, drawn as a fixed-aspect element by the CSS.
 */
async function buildLockedPieces() {
  const src = await load(path.join(SRC, 'ui_button_disabled_locked.png'));
  const { w: W, h: H } = src;
  const px = (x, y) => { const i = (y * W + x) * 4; return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]]; };

  /* --- body: keep x0..245, then jump straight to the right frame at x288 --- */
  const KEEP_L = 246, RIGHT_FROM = 288, OFFSET = RIGHT_FROM - KEEP_L;
  const BW = KEEP_L + (W - RIGHT_FROM);
  const body = blank(BW, H);
  const FADE_FROM = 238;                       // 8px crossfade hides the join
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < BW; x++) {
      let p;
      if (x < FADE_FROM) p = px(x, y);
      else if (x < KEEP_L) {
        const t = (x - FADE_FROM) / (KEEP_L - FADE_FROM);
        const a = px(x, y), b = px(x + OFFSET, y);
        p = [0, 1, 2, 3].map(k => Math.round(a[k] * (1 - t) + b[k] * t));
      } else p = px(x + OFFSET, y);
      put(body, x, y, p);
    }
  }
  await write(body, 'ui_button_disabled_body.png');
  console.log(`ui_button_disabled_body.png ${BW}x${H}`);

  /* --- emblem: keyed against the plaque's own panel colour, row by row --- */
  const bg = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 120; x < 200; x++) row.push(px(x, y));
    row.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    bg.push(row[row.length >> 1]);
  }
  const X0 = 250, X1 = 285, Y0 = 14, Y1 = 55;
  const lw = X1 - X0, lh = Y1 - Y0;
  const cut = blank(lw, lh);
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const p = px(x, y), b = bg[y];
      const diff = Math.max(Math.abs(p[0] - b[0]), Math.abs(p[1] - b[1]), Math.abs(p[2] - b[2]));
      const a = Math.max(0, Math.min(1, (diff - 6) / 16));
      put(cut, x - X0, y - Y0, [p[0], p[1], p[2], Math.round(a * (p[3] / 255) * 255)]);
    }
  }
  /* trim to the emblem's own alpha box so CSS can size it by aspect */
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
  console.log(`ui_lock_emblem.png          ${tw}x${th}`);
}

(async () => {
  await buildTrack();
  await buildKnob();
  await buildLockedPieces();
})().catch(e => { console.error(e); process.exit(1); });
