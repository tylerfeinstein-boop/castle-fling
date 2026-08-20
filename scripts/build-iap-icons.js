'use strict';

/* Build the Google Play in-app product icons for the four crown packs.
 *
 *   in   assets/castle-fling/ui-polish/trimmed/howto_icon_crowns.png  (322x291 crown)
 *   out  assets/build-branding/store/iap/crown_pack_<n>.png           (512x512)
 *
 * Why generate rather than upscale an existing badge. The obvious base,
 * milestone_crown_collector.png, is a finished 256x256 medallion — taking it to
 * 512 is a 2x upscale of fine gold filigree and reads soft at the size Play
 * actually shows these. Instead the frame is drawn as vector at full 512 and the
 * crown is composited at 1.05x of its native width, so the only raster art in
 * the file is close to its original resolution.
 *
 * Tier is carried by the numeral, not by the art: at store thumbnail size a
 * "bigger pile of crowns" treatment is indistinguishable between 250 and 500,
 * whereas the number is legible and is what a buyer actually compares.
 *
 * Play product icons are square PNG with no alpha requirement; a full-bleed
 * background is used so the icon never depends on the surface behind it.
 *
 * Run: node scripts/build-iap-icons.js      (sharp lives in build/mobile)
 */

const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '..', 'build', 'mobile', 'node_modules', 'sharp'));

const ROOT = path.resolve(__dirname, '..');
const CROWN = path.join(ROOT, 'assets/castle-fling/ui-polish/trimmed/howto_icon_crowns.png');
const OUT_DIR = path.join(ROOT, 'assets/build-branding/store/iap');

const S = 512;

/* Castle Fling's panel palette: deep royal blue field, warm gold metal. */
const TIERS = [
  { id: 'crown_pack_100',  crowns: 100,   label: '100',   name: 'Small Coffer' },
  { id: 'crown_pack_250',  crowns: 250,   label: '250',   name: 'Royal Purse' },
  { id: 'crown_pack_500',  crowns: 500,   label: '500',   name: 'Treasury Chest' },
  { id: 'crown_pack_1000', crowns: 1000,  label: '1,000', name: "King's Hoard" },
];

function background() {
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="field" cx="50%" cy="42%" r="72%">
      <stop offset="0%"   stop-color="#2c4f8f"/>
      <stop offset="55%"  stop-color="#16294d"/>
      <stop offset="100%" stop-color="#0b1526"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f4dc8a"/>
      <stop offset="45%"  stop-color="#d4a63c"/>
      <stop offset="100%" stop-color="#8a6420"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="40%" r="50%">
      <stop offset="0%"   stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- Opaque square backing FIRST: store assets are safest with no alpha at
       all, so the rounded frame is drawn over a filled corner rather than
       cutting a transparent one. -->
  <rect width="${S}" height="${S}" fill="#0b1526"/>
  <rect width="${S}" height="${S}" rx="96" fill="url(#field)"/>
  <ellipse cx="256" cy="205" rx="205" ry="180" fill="url(#glow)"/>

  <!-- light rays behind the crown -->
  <g opacity="0.16" fill="#ffe9a8">
    ${Array.from({ length: 12 }, (_, i) => {
      const a = (i * 30) * Math.PI / 180;
      const x1 = 256 + Math.cos(a) * 40, y1 = 200 + Math.sin(a) * 40;
      const x2 = 256 + Math.cos(a - 0.045) * 250, y2 = 200 + Math.sin(a - 0.045) * 250;
      const x3 = 256 + Math.cos(a + 0.045) * 250, y3 = 200 + Math.sin(a + 0.045) * 250;
      return `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}"/>`;
    }).join('')}
  </g>

  <rect x="14" y="14" width="${S - 28}" height="${S - 28}" rx="84"
        fill="none" stroke="url(#gold)" stroke-width="15"/>
  <rect x="30" y="30" width="${S - 60}" height="${S - 60}" rx="72"
        fill="none" stroke="#5b3f14" stroke-width="3" opacity="0.55"/>
</svg>`);
}

function banner(label) {
  // Numeral plate across the lower third. Stroked text keeps the digits legible
  // against the gold plate at thumbnail size.
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f6e29b"/>
      <stop offset="50%"  stop-color="#d9ac42"/>
      <stop offset="100%" stop-color="#9a7126"/>
    </linearGradient>
  </defs>
  <g>
    <rect x="72" y="352" width="368" height="104" rx="26"
          fill="url(#plate)" stroke="#4a3210" stroke-width="5"/>
    <rect x="84" y="362" width="344" height="84" rx="19"
          fill="none" stroke="#fff3c4" stroke-width="2" opacity="0.65"/>
    <text x="256" y="418" text-anchor="middle"
          font-family="Georgia, 'Times New Roman', serif" font-size="62" font-weight="bold"
          fill="#3a2408" stroke="#fff6d0" stroke-width="1.2" paint-order="stroke">${label}</text>
    <text x="256" y="480" text-anchor="middle"
          font-family="Georgia, 'Times New Roman', serif" font-size="34" font-weight="bold"
          letter-spacing="7" fill="#f6e6b0" stroke="#26160480" stroke-width="3" paint-order="stroke">CROWNS</text>
  </g>
</svg>`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1.05x of native width — effectively no upscale, so the gold stays crisp.
  const crown = await sharp(CROWN).resize({ width: 338 }).toBuffer();

  for (const t of TIERS) {
    const out = path.join(OUT_DIR, t.id + '.png');
    await sharp(background())
      .composite([
        { input: crown, top: 52, left: Math.round((S - 338) / 2) },
        { input: banner(t.label), top: 0, left: 0 },
      ])
      /* flatten() composites onto the backing colour but sharp still emits an
         (opaque) alpha channel for PNG; removeAlpha() drops it so the file is
         a true 24-bit RGB PNG. */
      .flatten({ background: '#0b1526' })
      .removeAlpha()
      .png({ compressionLevel: 9 })
      .toFile(out);
    const m = await sharp(out).metadata();
    console.log(`${t.id.padEnd(16)} ${m.width}x${m.height}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  ${t.name}`);
  }
  console.log('\nOut: ' + path.relative(ROOT, OUT_DIR));
})();
