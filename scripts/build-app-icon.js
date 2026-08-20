'use strict';

/* Build every Castle Fling application-icon slot from one master artwork.
 *
 *   in   assets/build-branding/icons/castlefling_app_icon.png   (1254x1254 master)
 *   out  assets/build-branding/icons/app_icon_*.png + app_icon.ico   (store / web / Windows)
 *        build/mobile/android/.../mipmap-<dpi>/ic_launcher*.png       (shipping Capacitor app)
 *        android/.../mipmap-<dpi>/ic_launcher*.png                   (legacy tree)
 *        build/desktop/app_icon.ico                                  (Electron packager copy)
 *
 * Why this exists. The master art is a full-bleed borderless scene, not a framed
 * badge: the enemy's outstretched hand runs to the right edge, the horns to the
 * top, the castle to the left, the crown shield to the bottom. Every launcher
 * slot therefore needs its own geometry decision, and those decisions have to be
 * reproducible — hand-cropping 26 PNGs is how a 3px drift between densities gets
 * shipped. Run this instead.
 *
 * Adaptive-icon geometry. Android composites two 108dp layers, shows only the
 * centre 72dp, and masks that with a launcher-chosen shape; only the centre 66dp
 * CIRCLE is guaranteed unclipped. Measured against the master, the outermost
 * subject (the fingertips) sits at 0.97 of the half-width. Dropping the
 * foreground to 68dp (inset 18.5%) puts those fingertips at 0.92 of the 72dp
 * radius — inside the 66dp safe circle — so no mask can take a hand, a horn, a
 * banner or the crown. Only sky, treetops and distant mountains fall in the
 * clipped corners. The background layer is deliberately NOT inset: it fills all
 * 108dp with a blurred cover of the same scene, so the ~2dp ring a squircle mask
 * exposes outside the foreground reads as the scene continuing, never as an
 * empty border and never as an added frame.
 *
 * Legacy (pre-26) launchers apply no mask, so ic_launcher.png carries its own
 * rounded-square silhouette and ic_launcher_round.png its own circle. minSdk is
 * 24, so API 24-25 really do render these. They are NOT full-bleed art: an
 * inscribed circle drawn over the full frame cuts the fingertips clean off. They
 * are instead the exact composite API 26+ shows — blurred background, artwork at
 * 68/72 of the visible window — so the icon looks the same on every supported
 * Android version rather than shedding a hand on the older ones.
 *
 * Nothing here is destructive — the master is only ever read.
 * Run: node scripts/build-app-icon.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sharp = require(path.join(ROOT, 'build', 'mobile', 'node_modules', 'sharp'));

const MASTER = path.join(ROOT, 'assets', 'build-branding', 'icons', 'castlefling_app_icon.png');
const BRANDING = path.join(ROOT, 'assets', 'build-branding', 'icons');
const MOBILE_RES = path.join(ROOT, 'build', 'mobile', 'android', 'app', 'src', 'main', 'res');
const LEGACY_RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

/* Launcher-icon sizes per density. `legacy` is the 48dp icon, `adaptive` the
 * 108dp adaptive layer canvas. */
const DENSITIES = {
  ldpi:    { legacy: 36,  adaptive: 81 },
  mdpi:    { legacy: 48,  adaptive: 108 },
  hdpi:    { legacy: 72,  adaptive: 162 },
  xhdpi:   { legacy: 96,  adaptive: 216 },
  xxhdpi:  { legacy: 144, adaptive: 324 },
  xxxhdpi: { legacy: 192, adaptive: 432 },
};

/* Store / web / Windows raster sizes, unchanged from the previous icon set. */
const BRANDING_SIZES = [32, 48, 64, 96, 180, 192, 512, 1024];
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
/* A web-manifest `maskable` icon is zoomed until its 80%-diameter safe circle
 * fills the mask, so full-bleed art declared maskable loses the fingertips the
 * adaptive icon was tuned to keep. These carry the same 68/108 inset instead. */
const MASKABLE_SIZES = [192, 512];

/* The legacy tree's adaptive-icon XML applies no inset, so its foreground has to
 * carry the 68/108 safe-zone scale itself. */
const LEGACY_FG_SCALE = 68 / 108;
/* Corner radius of the pre-26 square icon, as a fraction of its width. */
const LEGACY_CORNER = 0.22;

const written = [];

function record(file) {
  written.push(path.relative(ROOT, file).replace(/\\/g, '/'));
}

/* Square, full-quality resample of the master. Lanczos3 + no crop: the master is
 * already square, so this can never letterbox or stretch an axis. */
function scaled(size) {
  return sharp(MASTER).resize(size, size, { fit: 'fill', kernel: 'lanczos3' });
}

async function png(size) {
  return scaled(size).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

/* Cut `svgShape` out of `base`. dest-in keeps what is inside the shape and makes
 * everything outside transparent — no stroke, no fill, so nothing resembling a
 * frame is ever added. sharp resizes before it composites, so `base` must
 * already be `size` square. */
async function masked(base, size, svgShape) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${svgShape}</svg>`
  );
  return sharp(base)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function roundedSquare(size) {
  const r = Math.round(size * LEGACY_CORNER);
  return `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>`;
}

function circle(size) {
  const r = size / 2;
  return `<circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/>`;
}

/* Adaptive background: the same scene zoomed past the canvas and blurred, so the
 * sliver a squircle mask exposes outside the 68dp foreground continues the
 * artwork instead of showing a hole. Opaque by construction — an adaptive
 * background must never carry alpha. */
async function adaptiveBackground(size) {
  return sharp(MASTER)
    .resize(Math.round(size * 1.18), Math.round(size * 1.18), { fit: 'fill', kernel: 'lanczos3' })
    .blur(Math.max(1, size * 0.035))
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* Foreground for a tree whose XML does the inset itself: full-bleed art. */
async function adaptiveForeground(size) {
  return png(size);
}

/* Foreground for a tree whose XML has no inset: bake the 68/108 safe-zone scale,
 * transparent margin, art centred. */
async function adaptiveForegroundInset(size) {
  const art = Math.round(size * LEGACY_FG_SCALE);
  const pad = Math.round((size - art) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: await png(art), top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* Flattened stand-in for what Android composites across the whole 108dp canvas:
 * blurred scene filling it, sharp artwork inset to the safe zone on top. Used
 * for the web manifest's maskable slot. */
async function maskableIcon(size) {
  const art = Math.round(size * LEGACY_FG_SCALE);
  const pad = Math.round((size - art) / 2);
  return sharp(await adaptiveBackground(size))
    .composite([{ input: await png(art), top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* The same composite cropped to the 72dp window a launcher actually shows, at
 * `size` px. This is what the pre-26 PNGs are cut from, so an API 24 phone and
 * an API 34 phone show the same picture. */
async function visibleComposite(size) {
  const canvas = Math.round((size * 108) / 72);
  const crop = Math.round((canvas - size) / 2);
  const bg = await sharp(await adaptiveBackground(canvas))
    .extract({ left: crop, top: crop, width: size, height: size })
    .png()
    .toBuffer();
  const art = Math.round((size * 68) / 72);
  const pad = Math.round((size - art) / 2);
  return sharp(bg)
    .composite([{ input: await png(art), top: pad, left: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* Multi-image .ico. Every entry is PNG-compressed, matching the format of the
 * icon this replaces; Windows Vista+ and Electron both read that. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;      // 0 means 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;                            // palette
    dir[o + 3] = 0;                            // reserved
    dir.writeUInt16LE(1, o + 4);               // colour planes
    dir.writeUInt16LE(32, o + 6);              // bits per pixel
    dir.writeUInt32LE(e.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

async function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  record(file);
}

async function main() {
  const meta = await sharp(MASTER).metadata();
  if (meta.width !== meta.height) {
    throw new Error(`master is not square: ${meta.width}x${meta.height}`);
  }
  console.log(`master ${meta.width}x${meta.height} (${meta.channels}ch)`);

  /* ---- store / web / apple-touch rasters ---- */
  for (const size of BRANDING_SIZES) {
    await write(path.join(BRANDING, `app_icon_${size}.png`), await png(size));
  }

  for (const size of MASKABLE_SIZES) {
    await write(path.join(BRANDING, `app_icon_maskable_${size}.png`), await maskableIcon(size));
  }

  /* ---- capacitor-assets' icon source of record. logo.png is deliberately left
   *      alone: with no icon.png beside it, capacitor-assets treats logo.png as
   *      BOTH icon and splash source, so overwriting it would regenerate the
   *      splash screen too. Writing icon.png instead means a future
   *      `capacitor-assets generate` picks up this artwork for launcher icons
   *      and still builds the splash from the untouched logo.png. (It would also
   *      flatten the safe-zone geometry below — this script, not that tool, is
   *      the supported way to refresh these icons.) ---- */
  await write(path.join(ROOT, 'build', 'mobile', 'assets', 'icon.png'), await png(1024));

  /* ---- Play listing icon; the launcher art and the store art have to match ---- */
  const play = path.join(ROOT, 'dist', 'store-assets', 'play_icon_512.png');
  if (fs.existsSync(play)) await write(play, await png(512));

  /* ---- documentation preview of the current icon ---- */
  const preview = path.join(ROOT, 'assets', 'build-branding', 'previews', 'app_icon_preview.png');
  if (fs.existsSync(preview)) await write(preview, await png(1024));

  /* ---- Windows .ico, shared by electron-builder, electron/main.js and the
   *      browser favicon; build/desktop keeps its own copy next to its main.js ---- */
  const ico = buildIco(
    await Promise.all(ICO_SIZES.map(async (size) => ({ size, buf: await png(size) })))
  );
  await write(path.join(BRANDING, 'app_icon.ico'), ico);
  await write(path.join(ROOT, 'build', 'desktop', 'app_icon.ico'), ico);

  /* ---- shipping Capacitor app: all four slots at every density ---- */
  for (const [density, { legacy, adaptive }] of Object.entries(DENSITIES)) {
    const dir = path.join(MOBILE_RES, `mipmap-${density}`);
    const flat = await visibleComposite(legacy);
    await write(path.join(dir, 'ic_launcher.png'), await masked(flat, legacy, roundedSquare(legacy)));
    await write(path.join(dir, 'ic_launcher_round.png'), await masked(flat, legacy, circle(legacy)));
    await write(path.join(dir, 'ic_launcher_foreground.png'), await adaptiveForeground(adaptive));
    await write(path.join(dir, 'ic_launcher_background.png'), await adaptiveBackground(adaptive));
  }

  /* ---- legacy tree: only refresh slots it already has ---- */
  for (const [density, { legacy, adaptive }] of Object.entries(DENSITIES)) {
    const dir = path.join(LEGACY_RES, `mipmap-${density}`);
    if (!fs.existsSync(dir)) continue;
    const square = path.join(dir, 'ic_launcher.png');
    if (fs.existsSync(square)) {
      await write(square, await masked(await visibleComposite(legacy), legacy, roundedSquare(legacy)));
    }
    const fg = path.join(dir, 'ic_launcher_foreground.png');
    if (fs.existsSync(fg)) await write(fg, await adaptiveForegroundInset(adaptive));
  }

  console.log(`\nwrote ${written.length} files:`);
  for (const f of written) console.log('  ' + f);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
