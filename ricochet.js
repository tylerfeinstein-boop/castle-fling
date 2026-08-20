'use strict';
/* ============================================================
   CASTLE RICOCHET — hourly physics-puzzle mini-game
   "Bank your Royal Striker off castle obstacles and knock
    enemy tokens into the pits."  Five shots. Three enemies.
   Loaded AFTER game.js: reuses Castle Fling's canvas, save
   (META), coins (addGold), crowns, Music, Sfx, gameConfirm,
   showScreen and CrashDiagnostics. No second save/currency
   system exists — everything flows through the platform layer.
   Compat: no ?. / ?? anywhere (Android 7 WebView parse rules).
   ============================================================ */
const CastleRicochet = (() => {

  /* ---------------- constants ---------------- */
  const BW = 1664, BH = 936;                    // logical board (16:9, matches art)
  const ASSET_ROOT = 'assets/castle_ricochet/';
  const REPLAY_COST_CROWNS = 20;
  const FREE_COOLDOWN_MS = 60 * 60 * 1000;
  const RICO_REWARDS = { 0: 0, 1: 500, 2: 1000, 3: 1500 };

  const TOKEN_RADIUS = 34;
  const TOKEN_RESTITUTION = 0.86;
  const WALL_RESTITUTION = 0.88;
  const LINEAR_DRAG = 1.35;
  const STOP_SPEED = 16;
  const MAX_TOKEN_SPEED = 1600;
  const MAX_SHOT_POWER = 1450;
  const MAX_PULL = 260;                          // pull px mapping to full power
  const MIN_PULL = 30;                           // below this: cancelled, no shot spent
  const PHYSICS_STEP = 1 / 60;
  const MAX_SUBSTEPS = 4;
  const SETTLE_MS = 250;                         // all below STOP_SPEED this long = settled
  const MAX_SHOT_RESOLUTION_MS = 9000;

  const CRATE_BREAK_SPEED = 480;
  const CRATE_KEEP_VELOCITY = 0.72;
  const BOMB_TRIGGER_SPEED = 400;
  const BOMB_RADIUS = 145;
  const BOMB_IMPULSE = 620;

  const TOKEN_TOKEN_CLEARANCE = TOKEN_RADIUS * 2.4;
  const TOKEN_OBSTACLE_CLEARANCE = TOKEN_RADIUS * 1.35;
  const PIT_SPAWN_CLEARANCE = TOKEN_RADIUS * 3.0;
  const OBSTACLE_PIT_CLEARANCE = TOKEN_RADIUS * 2.0;
  const MAX_LAYOUT_GENERATION_ATTEMPTS = 80;
  const GENERATION_TIME_BUDGET_MS = 3500;

  const debugOn = () => !!window.RICO_DEBUG && !(window.BUILD_CONFIG && BUILD_CONFIG.isProduction);

  /* ---------------- map (mirror of assets/castle_ricochet/maps/castle_ricochet_board_01.json;
     embedded because Android WebView cannot reliably fetch() file:// JSON) ---------------- */
  const MAP = {
    id: 'castle_ricochet_board_01',
    bounds: { x0: 216, y0: 159, x1: 1448, y1: 824 },
    /* Pit openings. cx/cy/rx/ry describe the VISIBLE opening of the hole —
       the very ellipse the metal rim's inner edge is drawn on (see RIM_GEO),
       so "where the art shows a hole" and "where a token can sink" are one
       number that cannot drift apart.
       2026-08-04 rim pass: every centre moved 8-12 board px UP onto the
       painted opening (measured off the board art by dark-region fitting —
       all four pits were low by the same amount) and ry snapped to the rim
       sprite's own opening aspect (1.3305) so the artwork scales all but
       uniformly.
       Second pass, same day: the two TOP pits are painted considerably
       smaller than the bottom two (they are further up the courtyard), so at
       the shipped rx: 70 their rim openings overhung the painted hole and
       showed a crescent of lit stone lip inside the metal — the bottom pair
       did not, because their shipped rx already sat on the largest ellipse
       that fits inside the painted hole. rx: 53/55 puts the top pair on that
       same standard. Measured lit-lip pixels showing inside the opening:
       top-left 1916 -> 236, top-right 1713 -> 25, against 15 and 21 for the
       bottom pair. NOTE this also shrinks the sink target at the two top
       holes, which is the point — the trigger is the opening. */
    pits: [
      { id: 'pit_top_left', cx: 432, cy: 293, rx: 53, ry: 39.83 },
      { id: 'pit_top_right', cx: 1256, cy: 290, rx: 55, ry: 41.34 },
      { id: 'pit_bottom_left', cx: 368, cy: 689, rx: 78, ry: 58.63 },
      { id: 'pit_bottom_right', cx: 1321, cy: 683, rx: 74, ry: 55.62 },
    ],
    playerZone: { x0: 620, y0: 640, x1: 1040, y1: 780 },
    enemyZones: [
      { x0: 540, y0: 340, x1: 720, y1: 560 },
      { x0: 700, y0: 260, x1: 980, y1: 520 },
      { x0: 960, y0: 340, x1: 1150, y1: 560 },
    ],
    obstacleZone: { x0: 360, y0: 290, x1: 1300, y1: 660 },
  };

  /* ---------------- metal hole rim (ONE shared sprite = the "prefab") ----------------
     All four pits draw the same props/prop_hole_rim_metal.png, scaled by their
     own opening — there are no four one-off rim objects to drift apart.
     RIM_GEO is printed by scripts/build-hole-rim-sprite.js and records where
     the sprite's INNER OPENING sits inside the image (fractions of the image
     box), so a rim is positioned by its OPENING and never by its image rect.
     That is what keeps art and physics welded together: the rim opening, the
     debug ellipse and the sink trigger below are all derived from the same
     MAP.pits ellipse, so resizing a pit moves all three at once (§ Part 2.6).
     NOT A COLLIDER, deliberately: the rim is a flange lying flush with the
     courtyard floor, so tokens roll across it exactly as they rolled across
     the bare stone before. Making the metal solid would seal every pit and no
     token could ever be sunk again. What the rim does change is that the
     scoring area is now the opening it frames — a token grazing or resting on
     the metal is outside the trigger and does not score. */
  const RIM_SPRITE = 'props/prop_hole_rim_metal.png';
  const RIM_GEO = { innerCX: 0.49902, innerCY: 0.48426, innerRX: 0.30273, innerRY: 0.28208 };
  /* a token sinks once its CENTRE is this far inside the opening: it must have
     genuinely entered the hole, not merely touched the inner lip. Unchanged
     from the pre-rim calibration, so sink difficulty is what it always was. */
  const SINK_INSET = TOKEN_RADIUS * 0.25;
  for (const p of MAP.pits) {                    // one-time derivation, never per frame
    p.rimW = p.rx / RIM_GEO.innerRX;             // rim draw rect, board space
    p.rimH = p.ry / RIM_GEO.innerRY;
    p.rimX = p.cx - RIM_GEO.innerCX * p.rimW;
    p.rimY = p.cy - RIM_GEO.innerCY * p.rimH;
    p.sinkRX = p.rx - SINK_INSET;                // sink trigger, same ellipse inset
    p.sinkRY = p.ry - SINK_INSET;
  }

  /* ---------------- enemy roster (mass classes per design) ---------------- */
  const ENEMY_TOKENS = [
    { id: 'runner', file: 'token_enemy_runner.png', mass: 0.90 },
    { id: 'wall_climber', file: 'token_enemy_wall_climber.png', mass: 0.90 },
    { id: 'soldier', file: 'token_enemy_soldier.png', mass: 1.00 },
    { id: 'bomb_carrier', file: 'token_enemy_bomb_carrier.png', mass: 1.00 },
    { id: 'healer', file: 'token_enemy_healer.png', mass: 1.00 },
    { id: 'banner_carrier', file: 'token_enemy_banner_carrier.png', mass: 1.00 },
    { id: 'shield_bearer', file: 'token_enemy_shield_bearer.png', mass: 1.12 },
    { id: 'hammer_brute', file: 'token_enemy_hammer_brute.png', mass: 1.12 },
    { id: 'heavy_knight', file: 'token_enemy_heavy_knight.png', mass: 1.12 },
    { id: 'siege_captain', file: 'token_enemy_siege_captain.png', mass: 1.12 },
    { id: 'bomb_cart', file: 'token_enemy_bomb_cart.png', mass: 1.12 },
  ];

  /* ---------------- obstacle catalog ----------------
     Perspective art must not rotate: colliders are axis-aligned rects,
     ground-footprint ellipses, or fixed diagonal segments (angled wood
     bumpers). All positions are the FOOTPRINT center; sprites bottom-
     anchor to it.
     Hand-calibrated collider metadata (single source of truth for live
     physics, the aim preview, the generator, the solver and the debug
     overlay): every collider describes WHERE THE OBSTACLE MEETS THE
     FLOOR in this 3/4 top-down art — never the full sprite rect, never
     decorative height (banners, battlements, fuses, spike tips), never
     the soft shadow. Round obstacles (pillars, barrels) use 'ellipse'
     because a circular base drawn in 3/4 view is vertically fore-
     shortened; rx/ry/oy were measured against the solid-alpha
     silhouette of each PNG at drawW scale.
     footY = visual ground-contact offset: board px below the anchor at
     which the sprite's IMAGE BOTTOM is anchored.

     2026-08-04 collider-tightening pass (scripts/audit-obstacle-colliders.js
     re-measures all of this against the PNGs and writes overlay sheets to
     docs/collider-audit/). Two systematic errors were measured and removed:
       1. every rect's bottom edge sat 8-15 board px BELOW the artwork,
          because footY defaulted to the collider bottom and so anchored the
          sprite's IMAGE bottom — transparent padding included — instead of
          its visible bottom. That is the "invisible wall" in front of every
          obstacle, on the side tokens most often arrive from.
       2. several rects were far wider than their base: wall_low was 39 px
          per side wider than the art, wall_long 20, corner_right 22.
     footY is now EXPLICIT on every entry, pinned to what footprintBottom()
     returned before the pass, so every sprite draws and depth-sorts exactly
     where it did — only the collision geometry moved.
     Shape TYPES are deliberately unchanged (rect stays rect, ellipse stays
     ellipse, seg stays seg): restitution, normals and the aim preview are all
     tuned around them. What remains is the perspective limit of an
     axis-aligned box around a base that is a parallelogram/diamond in 3/4
     view — the corners of a long wall still carry some air. Fixing that needs
     a rotated hull, which would change how every wall bounces, so it stays. */
  const OBSTACLES = {
    wall_long: { file: 'obstacle_stone_wall_long_banner.png', drawW: 300, footY: 38, cols: [{ t: 'rect', hw: 128, hh: 33, ox: -10, oy: -5 }] },
    wall_medium: { file: 'obstacle_stone_wall_medium_banner.png', drawW: 220, footY: 36, cols: [{ t: 'rect', hw: 99, hh: 31, oy: -5 }] },
    wall_short: { file: 'obstacle_stone_wall_short_banner.png', drawW: 150, footY: 34, cols: [{ t: 'rect', hw: 62, hh: 28, ox: 2, oy: -6 }] },
    wall_low: { file: 'obstacle_stone_wall_low_long.png', drawW: 300, footY: 32, cols: [{ t: 'rect', hw: 109, hh: 25, ox: -26, oy: -7 }] },
    corner_left: { file: 'obstacle_stone_wall_corner_left.png', drawW: 210, footY: 62, cols: [{ t: 'rect', hw: 90, hh: 30, ox: 6, oy: 20 }, { t: 'rect', hw: 33, hh: 40, ox: -57, oy: -22 }] },
    corner_right: { file: 'obstacle_stone_wall_corner_right.png', drawW: 210, footY: 62, cols: [{ t: 'rect', hw: 78, hh: 30, ox: -14, oy: 20 }, { t: 'rect', hw: 35, hh: 39, ox: 59, oy: -23 }] },
    pillar_large: { file: 'obstacle_pillar_large.png', drawW: 120, footY: 36.4, cols: [{ t: 'ellipse', rx: 51, ry: 27, ox: 3, oy: 1 }] },
    pillar_small: { file: 'obstacle_pillar_small.png', drawW: 90, footY: 26.6, cols: [{ t: 'ellipse', rx: 38, ry: 21, ox: 2, oy: -2 }] },
    block_square: { file: 'obstacle_stone_block_square.png', drawW: 130, footY: 42, cols: [{ t: 'rect', hw: 53, hh: 36, ox: 1, oy: -6 }] },
    block_l_low: { file: 'obstacle_stone_block_l_low.png', drawW: 170, footY: 48, cols: [{ t: 'rect', hw: 60, hh: 25, ox: 13, oy: 9 }, { t: 'rect', hw: 30, hh: 41, ox: -35, oy: -27 }] },
    block_l_tall: { file: 'obstacle_stone_block_l_tall.png', drawW: 160, footY: 48, cols: [{ t: 'rect', hw: 65, hh: 25, ox: 4, oy: 9 }, { t: 'rect', hw: 35, hh: 53, ox: 34, oy: -19 }] },
    block_l_small: { file: 'obstacle_stone_block_l_small.png', drawW: 140, footY: 44, cols: [{ t: 'rect', hw: 57, hh: 24, ox: 4, oy: 8 }, { t: 'rect', hw: 29, hh: 43, ox: -26, oy: -15 }] },
    wood_wall: { file: 'obstacle_wood_wall_straight.png', drawW: 260, footY: 30, cols: [{ t: 'rect', hw: 116, hh: 24, ox: 5, oy: -6 }] },
    /* Angled bumpers. The capsule AXIS is a deliberate design choice — these
       are the game's diagonal deflectors and every bank shot is tuned around
       that angle — so the line and thickness are untouched. It does not lie
       along the painted stone plinth (the art's base runs at about +0.3, the
       capsule at -0.575, and the plinth sits ~105px thick across the capsule
       axis): art and intent disagree here, which is a design call, not a
       calibration slip. What IS fixed is pure overshoot: the capsule used to
       reach 25-37 board px past the end of the sprite on each side and
       collide in open air. Ends are now clipped to the artwork; nothing else
       about them moved. */
    wood_bumper_left: { file: 'obstacle_wood_bumper_left.png', drawW: 190, footY: 59, cols: [{ t: 'seg', x1: -48, y1: 28, x2: 59, y2: -34, th: 26 }] },
    wood_bumper_right: { file: 'obstacle_wood_bumper_right.png', drawW: 190, footY: 59, cols: [{ t: 'seg', x1: -77, y1: -44, x2: 60, y2: 34, th: 26 }] },
    bumper_reinforced: { file: 'obstacle_reinforced_stone_bumper.png', drawW: 240, rest: 0.95, footY: 40, cols: [{ t: 'rect', hw: 108, hh: 35, ox: 4, oy: -5 }] },
    crate: { file: 'obstacle_crate_single.png', drawW: 100, breakable: true, footY: 38, cols: [{ t: 'rect', hw: 42, hh: 34, ox: 2, oy: -4 }] },
    crates_pyramid: { file: 'obstacle_crates_stack_pyramid.png', drawW: 180, breakable: true, footY: 46, cols: [{ t: 'rect', hw: 79, hh: 41, ox: 3, oy: -5 }] },
    crates_offset: { file: 'obstacle_crates_stack_offset.png', drawW: 180, breakable: true, footY: 44, cols: [{ t: 'rect', hw: 80, hh: 39, ox: 2, oy: -5 }] },
    bomb_barrel: { file: 'obstacle_bomb_barrel_single.png', drawW: 95, bomb: true, footY: 28, cols: [{ t: 'ellipse', rx: 39, ry: 21, ox: 2, oy: -4 }] },
    /* barrel groups: one ground ellipse per floor barrel (front-left barrel
       sits lower in the art than the rear-right one). Each ellipse keeps its
       authored foreshortening and is re-seated on its own barrel's base. */
    bomb_pair: { file: 'obstacle_bomb_barrels_pair.png', drawW: 140, bomb: true, footY: 38.5, cols: [{ t: 'ellipse', rx: 29, ry: 16, ox: -30, oy: 13 }, { t: 'ellipse', rx: 32, ry: 18, ox: 31, oy: 5 }] },
    bomb_stack: { file: 'obstacle_bomb_barrels_stack.png', drawW: 150, bomb: true, footY: 42, cols: [{ t: 'ellipse', rx: 29, ry: 15, ox: -30, oy: 16 }, { t: 'ellipse', rx: 32, ry: 16, ox: 32, oy: 4 }] },
    spikes_small: { file: 'obstacle_spike_barricade_small.png', drawW: 170, spike: true, footY: 30, cols: [{ t: 'rect', hw: 74, hh: 26, ox: 3, oy: -4 }] },
    spikes_large: { file: 'obstacle_spike_barricade_large.png', drawW: 250, spike: true, footY: 34, cols: [{ t: 'rect', hw: 111, hh: 28, ox: 4, oy: -6 }] },
  };

  /* difficulty pools: bombs never before attempt 4; spikes never in attempt 1 */
  const POOL_BEGINNER = ['wall_long', 'wall_medium', 'wall_short', 'wall_low', 'pillar_large', 'pillar_small', 'block_square', 'wood_wall', 'wood_bumper_left', 'wood_bumper_right', 'crate', 'crates_pyramid'];
  const POOL_STANDARD = POOL_BEGINNER.concat(['corner_left', 'corner_right', 'block_l_low', 'block_l_tall', 'block_l_small', 'bumper_reinforced', 'crates_offset', 'spikes_small', 'spikes_large']);
  const POOL_ADVANCED = POOL_STANDARD.concat(['bomb_barrel', 'bomb_pair', 'bomb_stack']);

  /* ---------------- authored fallback templates (all solver-verified in dev QA;
     coordinates live in the logical board space, clear of every pit ring) ---------------- */
  const TEMPLATES = [
    { id: 't01_center_pillar', player: [832, 730], enemies: [[620, 400], [832, 310], [1050, 400]], obstacles: [['pillar_large', 832, 510], ['wood_bumper_left', 540, 470], ['wood_bumper_right', 1130, 470], ['crate', 832, 630]] },
    { id: 't02_split_wall', player: [840, 740], enemies: [[580, 360], [840, 290], [1100, 360]], obstacles: [['wall_medium', 690, 490], ['wall_medium', 990, 490], ['pillar_small', 840, 620], ['crate', 470, 560]] },
    { id: 't03_left_corridor', player: [900, 730], enemies: [[600, 350], [640, 520], [780, 300]], obstacles: [['wall_long', 1000, 440], ['wood_bumper_right', 1210, 570], ['crate', 700, 630], ['pillar_small', 480, 470]] },
    { id: 't04_right_corridor', player: [760, 730], enemies: [[1070, 350], [1030, 520], [890, 300]], obstacles: [['wall_long', 670, 440], ['wood_bumper_left', 450, 570], ['crate', 970, 630], ['pillar_small', 1180, 470]] },
    { id: 't05_twin_bumpers', player: [832, 740], enemies: [[832, 320], [590, 400], [1080, 400]], obstacles: [['wood_bumper_left', 600, 540], ['wood_bumper_right', 1070, 540], ['crate', 832, 560], ['wall_short', 832, 430]] },
    { id: 't06_crate_gate', player: [850, 745], enemies: [[640, 350], [860, 300], [1070, 350]], obstacles: [['crates_pyramid', 760, 560], ['crates_offset', 950, 560], ['crate', 580, 500], ['crate', 1130, 500]] },
    { id: 't07_reinforced_wall', player: [840, 740], enemies: [[600, 430], [840, 290], [1090, 430]], obstacles: [['bumper_reinforced', 840, 520], ['wall_short', 570, 560], ['wall_short', 1110, 560], ['crate', 840, 350]] },
    { id: 't08_double_pillar', player: [840, 745], enemies: [[840, 320], [580, 420], [1100, 420]], obstacles: [['pillar_large', 690, 480], ['pillar_large', 990, 480], ['crate', 840, 620], ['wall_short', 840, 400]] },
    { id: 't09_shallow_bank', player: [640, 760], enemies: [[620, 330], [860, 370], [1060, 330]], obstacles: [['wall_low', 840, 600], ['pillar_small', 1140, 650], ['crate', 520, 560], ['wall_short', 990, 470]] },
    { id: 't10_bomb_gate', minAttempts: 3, player: [880, 740], enemies: [[600, 360], [790, 300], [1000, 390]], obstacles: [['bomb_barrel', 700, 440], ['wall_short', 1060, 500], ['crate', 610, 610], ['pillar_small', 1200, 420]] },
  ];

  /* ---------------- images (lazy; only production sprites, never sheets) ----------------
     RICO_ASSET_VERSION busts stale browser/WebView caches whenever sprites
     are re-exported (§ cache invalidation): bump it with any PNG change. */
  const RICO_ASSET_VERSION = 7;   // 7: metal hole rim added (props/prop_hole_rim_metal.png)
  const RIMG = {};
  function rimg(rel) {
    if (!RIMG[rel]) {
      const img = new Image();
      img.onerror = () => { img.ricoFailed = true; CrashDiagnostics.record('asset-load-failed', { id: 'rico', src: ASSET_ROOT + rel }); };
      if (!(window.BUILD_CONFIG && BUILD_CONFIG.isProduction)) {
        img.onload = () => validateSpriteAlpha(img, rel);
      }
      img.src = ASSET_ROOT + rel + '?rv=' + RICO_ASSET_VERSION;
      RIMG[rel] = img;
    }
    return RIMG[rel];
  }
  const ready = img => img && img.complete && img.naturalWidth > 0 && !img.ricoAlphaBad;
  /* ---- dev/QA asset validation (§ transparency gate) ----
     Every token/obstacle sprite must be true RGBA with fully transparent
     corners — a baked white/gray/checkerboard canvas fails here with the
     exact path logged, and the sprite falls back to the clean vector shape
     instead of silently shipping a checker tile. Runs once per image at
     load in development builds only, never per frame and never in
     production. getImageData can throw on file:// (tainted canvas): that is
     an environment limit, not an asset failure — validation is skipped. */
  function validateSpriteAlpha(img, rel) {
    if (!(rel.indexOf('tokens/') === 0 || rel.indexOf('obstacles/') === 0 || rel.indexOf('ui/') === 0 ||
      rel.indexOf('props/') === 0)) return;
    try {
      const S = 24;                                   // tiny probe canvas is plenty
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, S, S);
      g.drawImage(img, 0, 0, S, S);
      const d = g.getImageData(0, 0, S, S).data;
      const alphaAt = (x, y) => d[(y * S + x) * 4 + 3];
      const corners = [alphaAt(0, 0), alphaAt(S - 1, 0), alphaAt(0, S - 1), alphaAt(S - 1, S - 1)];
      let transparent = 0, opaque = 0;
      for (let i = 0; i < S * S; i++) { if (d[i * 4 + 3] < 8) transparent++; else if (d[i * 4 + 3] > 246) opaque++; }
      const bad = corners.some(a => a > 24) || transparent === 0;
      if (bad) {
        img.ricoAlphaBad = true;                      // draw paths treat this as not-drawable
        CrashDiagnostics.record('rico-sprite-alpha-fail', { src: ASSET_ROOT + rel, corners, transparent, opaque });
        console.error('[Castle Ricochet Assets] SPRITE FAILED TRANSPARENCY VALIDATION — opaque canvas or baked checkerboard', ASSET_ROOT + rel, { corners, transparent });
      } else if (img.naturalWidth * img.naturalHeight === 0 || opaque === 0) {
        CrashDiagnostics.record('rico-sprite-empty', { src: ASSET_ROOT + rel });
        console.error('[Castle Ricochet Assets] SPRITE HAS NO OPAQUE ARTWORK', ASSET_ROOT + rel);
      }
    } catch (e) { /* tainted canvas (file://): cannot probe pixels here */ }
  }
  /* visible-artwork alpha bounds, measured once per image — debug overlay
     only (production never reads pixels back) */
  function artBounds(img) {
    if (img.ricoArtBounds !== undefined) return img.ricoArtBounds;
    let out = null;
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] >= 24) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 >= 0) out = { x0, y0, x1, y1 };
    } catch (e) { out = null; }
    img.ricoArtBounds = out;
    return out;
  }
  /* ---- mandatory aiming assets (§ Professional Aim Arrow Pack) ----
     Every arrow piece, contact marker and power glow the guide can draw.
     An attempt never starts until all of these are decoded: the renderer
     may then assume they are drawable and never skip a segment.
     NOTE (§ no outcome reveal): the pack's sink_safe/danger arrow modes and
     the aim_sink_target/aim_danger_target pit markers are deliberately NOT
     listed — pit-outcome prediction is never shown while aiming, so those
     sprites are neither gated on nor loaded. The PNGs stay in the pack. */
  function mandatoryAimAssets() {
    const list = [];
    for (const m of ['primary_gold', 'enemy_output', 'striker_deflection']) {
      for (const p of ['start_cap', 'shaft_tile', 'arrow_head']) list.push('aim/modular/' + m + '/aim_' + m + '_' + p + '.png');
    }
    for (const f of ['aim_contact_enemy', 'aim_contact_wall', 'aim_contact_pillar', 'aim_ricochet_joint']) {
      list.push('aim/markers/' + f + '.png');
    }
    for (let l = 1; l <= 3; l++) list.push('aim/power/aim_primary_gold_power_glow_' + l + '.png');
    return list;
  }
  /* every asset the attempt cannot start without (§ runtime fallback):
     board art, the striker, each enemy token and obstacle sprite the
     generated layout actually uses, plus the full aim pack */
  function criticalAttemptAssets(layout) {
    const list = mandatoryAimAssets();
    list.push('backgrounds/castle_ricochet_board_01.png');
    /* the rim IS the visible scoring area — starting an attempt without it
       would show a bare hole whose trigger the player cannot see */
    list.push(RIM_SPRITE);
    list.push('tokens/standardized_384/token_player_royal_striker.png');
    const seen = {};
    for (const e of layout.enemies) {
      const rel = 'tokens/standardized_384/' + enemyDef(e.type).file;
      if (!seen[rel]) { seen[rel] = 1; list.push(rel); }
    }
    for (const o of layout.obstacles) {
      const rel = 'obstacles/' + OBSTACLES[o.kind].file;
      if (!seen[rel]) { seen[rel] = 1; list.push(rel); }
    }
    return list;
  }
  function preloadCore() {
    rimg('backgrounds/castle_ricochet_board_01.png');
    rimg(RIM_SPRITE);
    ['ui_hud_shots_left.png', 'ui_hud_reward.png', 'ui_hud_enemies_sunk.png', 'ui_pause_icon.png',
      /* ui_button_play.png retired: the pause screen's Resume button now uses
         the main game's play sprite (icon-cohesion pass); ui_button_pause.png
         likewise retired for the shared ui_pause_icon.png crest */
      'ui_banner_game_over.png', 'ui_banner_victory.png', 'ui_logo_castle_ricochet.png',
      'ui_warning_player_token_game_over.png', 'ui_currency_coin_castle.png',
      'ui_reward_badge_500.png', 'ui_reward_badge_1000.png', 'ui_reward_badge_1500.png']
      .forEach(f => rimg('ui/' + f));
    /* Professional Aim Arrow Pack: modular pieces, contact markers, power glows */
    for (const rel of mandatoryAimAssets()) rimg(rel);
    rimg('tokens/standardized_384/token_player_royal_striker.png');
  }

  /* ---------------- persistent state (inside Castle Fling's META save) ---------------- */
  function rico() {
    if (!META.castleRicochet) {
      META.castleRicochet = {
        nextFreeAttemptAt: 0, paidAttemptCount: 0, totalAttempts: 0,
        totalEnemiesSunk: 0, bestEnemiesSunk: 0, lastAttemptSeed: null,
        lastKnownUtc: 0, tutorialCompleted: false, activeAttempt: null,
        installId: 'cf-' + Math.floor(Math.random() * 1e9) + '-' + Date.now(),
      };
    }
    return META.castleRicochet;
  }
  /* clock-rollback-safe time: never travels backwards more than a minute */
  function safeNow() {
    const r = rico(), t = Date.now();
    if (t < (r.lastKnownUtc || 0) - 60000) return r.lastKnownUtc;
    if (t > (r.lastKnownUtc || 0)) { r.lastKnownUtc = t; saveMetaSoon(); }
    return t;
  }
  function freeAvailable() { return safeNow() >= (rico().nextFreeAttemptAt || 0); }
  function cooldownText() {                      // MM:SS (§ required UI text)
    const ms = Math.max(0, (rico().nextFreeAttemptAt || 0) - safeNow());
    const s = Math.ceil(ms / 1000);
    return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
  }

  /* ---------------- seeded RNG ---------------- */
  function hashSeed(a, b, c) {
    let h = 2166136261;
    const s = a + '|' + b + '|' + c;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ============================================================
     PHYSICS — shared verbatim by live play and the solver
     ============================================================ */
  function makeToken(kind, typeId, x, y, mass) {
    return { kind, typeId, x, y, vx: 0, vy: 0, r: TOKEN_RADIUS, mass, sunk: false, sunkAnim: 0 };
  }
  function buildSim(layout) {
    const tokens = [makeToken('player', 'striker', layout.player[0], layout.player[1], 1.0)];
    for (const e of layout.enemies) tokens.push(makeToken('enemy', e.type, e.x, e.y, e.mass));
    const obs = layout.obstacles.map(o => ({
      kind: o.kind, x: o.x, y: o.y, broken: false, exploded: false,
    }));
    return { tokens, obs, strikerSunk: false, sunkCount: 0, settledMs: 0, elapsedMs: 0 };
  }
  function cloneSim(st) {
    return {
      tokens: st.tokens.map(t => ({ kind: t.kind, typeId: t.typeId, x: t.x, y: t.y, vx: t.vx, vy: t.vy, r: t.r, mass: t.mass, sunk: t.sunk, sunkAnim: 0 })),
      obs: st.obs.map(o => ({ kind: o.kind, x: o.x, y: o.y, broken: o.broken, exploded: o.exploded })),
      strikerSunk: st.strikerSunk, sunkCount: st.sunkCount, settledMs: 0, elapsedMs: 0,
    };
  }
  function obstacleColliders(o) {
    const def = OBSTACLES[o.kind], out = [];
    if (o.broken || o.exploded) return out;
    for (const c of def.cols) {
      if (c.t === 'circle') out.push({ t: 'circle', x: o.x + (c.ox || 0), y: o.y + (c.oy || 0), r: c.r, o, def });
      else if (c.t === 'ellipse') out.push({ t: 'ellipse', x: o.x + (c.ox || 0), y: o.y + (c.oy || 0), rx: c.rx, ry: c.ry, o, def });
      else if (c.t === 'rect') out.push({ t: 'rect', x: o.x + (c.ox || 0), y: o.y + (c.oy || 0), hw: c.hw, hh: c.hh, o, def });
      else out.push({ t: 'seg', x1: o.x + c.x1, y1: o.y + c.y1, x2: o.x + c.x2, y2: o.y + c.y2, th: c.th, o, def });
    }
    return out;
  }
  /* closest point on an axis-aligned ellipse (semi-axes a,b at origin) to p —
     used for ground-footprint ellipses so pillars reflect with a smoothly
     varying normal instead of behaving like a flat wall (§ round-pillar
     contact). Bisection on the distance derivative over the point's
     quadrant: f(0) <= 0 <= f(pi/2) always brackets the minimum, so this
     cannot diverge (verified <0.01px against brute force). */
  function closestOnEllipse(a, b, px, py) {
    const sx = px < 0 ? -1 : 1, sy = py < 0 ? -1 : 1;
    const x = Math.abs(px), y = Math.abs(py);
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 40; i++) {
      const t = (lo + hi) / 2, ct = Math.cos(t), st = Math.sin(t);
      const f = (a * ct - x) * (-a * st) + (b * st - y) * (b * ct);
      if (f < 0) lo = t; else hi = t;
    }
    const t = (lo + hi) / 2;
    return { x: a * Math.cos(t) * sx, y: b * Math.sin(t) * sy };
  }
  /* ============================================================
     SWEPT-CIRCLE COLLISION CORE (§ one authoritative simulation)
     A moving token is a circle of radius tk.r. Every query below
     sweeps that circle against the SAME collider metadata the
     rest of the game uses (obstacleColliders + MAP.bounds), so
     the aim prediction, live movement, the solver and the debug
     overlay cannot disagree on radii, contact points or normals.
     Swept queries are needed because move-then-push-out let a
     token penetrate up to ~7 board px before resolving — corner
     hits then reflected off the WRONG feature normal, and the
     preview could only bend "near" the surface, never on it.
     Every hit reports BOTH the token center at impact (cx,cy —
     what physics integrates from) and the surface contact point
     (px,py = center − normal·r — where arrows/markers must meet
     the obstacle). COLLISION_EPSILON nudges the next query off
     the surface; it is orders of magnitude below one pixel and
     is never rendered.
     ============================================================ */
  const COLLISION_EPSILON = Math.max(0.0001, TOKEN_RADIUS * 0.001);   // ≈0.034 board px, world-scale aware
  const MAX_BOUNCES_PER_SUBSTEP = 4;
  /* ray (x,y)+(dx,dy)·t vs circle at (cx,cy) with combined radius R.
     Returns entry distance ≥ 0, or -1. A starting overlap reports 0 only
     when moving inward, so a token can always leave a surface. */
  function raySweepCircle(x, y, dx, dy, cx, cy, R, maxDist) {
    const mx = x - cx, my = y - cy;
    const b = mx * dx + my * dy;
    const c = mx * mx + my * my - R * R;
    if (c <= 0) return b < 0 ? 0 : -1;
    if (b >= 0) return -1;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const d = -b - Math.sqrt(disc);
    return d <= maxDist ? Math.max(0, d) : -1;
  }
  /* swept circle vs axis-aligned rect: the Minkowski-expanded shape is the
     rect grown by r with ROUNDED corners — flat faces + four corner arcs.
     This is what makes near-corner shots reflect off the corner radius
     instead of snapping to a horizontal/vertical face. */
  function sweepCircleVsRect(x, y, dx, dy, r, col, maxDist) {
    const rx = x - col.x, ry = y - col.y;
    let best = -1, nx = 0, ny = 0;
    if (dx > 1e-9 || dx < -1e-9) {                 // vertical faces
      const t = ((dx > 0 ? -(col.hw + r) : col.hw + r) - rx) / dx;
      if (t >= 0 && t <= maxDist) {
        const yAt = ry + dy * t;
        if (yAt >= -col.hh && yAt <= col.hh) { best = t; nx = dx > 0 ? -1 : 1; ny = 0; }
      }
    }
    if (dy > 1e-9 || dy < -1e-9) {                 // horizontal faces
      const t = ((dy > 0 ? -(col.hh + r) : col.hh + r) - ry) / dy;
      if (t >= 0 && t <= maxDist && (best < 0 || t < best)) {
        const xAt = rx + dx * t;
        if (xAt >= -col.hw && xAt <= col.hw) { best = t; nx = 0; ny = dy > 0 ? -1 : 1; }
      }
    }
    for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) {  // corner arcs
      const t = raySweepCircle(rx, ry, dx, dy, sx * col.hw, sy * col.hh, r, maxDist);
      if (t >= 0 && (best < 0 || t < best)) {
        const ix = rx + dx * t - sx * col.hw, iy = ry + dy * t - sy * col.hh;
        const d = Math.hypot(ix, iy) || 1;
        best = t; nx = ix / d; ny = iy / d;
      }
    }
    if (best < 0) {
      /* starting overlap (shoved by another token / bomb): immediate hit
         with the discrete push-out normal, only when moving inward */
      const hit = collideCollider({ x, y, r }, col);
      if (hit && dx * hit.nx + dy * hit.ny < 0) return { d: 0, nx: hit.nx, ny: hit.ny };
      return null;
    }
    return { d: best, nx, ny };
  }
  /* swept circle vs capsule (diagonal wood bumpers): flat side faces at
     combined radius + circular end caps. */
  function sweepCircleVsSeg(x, y, dx, dy, r, col, maxDist) {
    const R = r + col.th / 2;
    const abx = col.x2 - col.x1, aby = col.y2 - col.y1;
    const len = Math.hypot(abx, aby) || 1;
    const ex = abx / len, ey = aby / len;
    const qx = -ey, qy = ex;                       // axis perpendicular
    const mx = x - col.x1, my = y - col.y1;
    const side = mx * qx + my * qy;
    let best = -1, nx = 0, ny = 0;
    const dperp = dx * qx + dy * qy;
    if (Math.abs(side) >= R && Math.abs(dperp) > 1e-9) {
      const t = ((side > 0 ? R : -R) - side) / dperp;
      if (t >= 0 && t <= maxDist) {
        const u = (mx + dx * t) * ex + (my + dy * t) * ey;
        if (u >= 0 && u <= len) {
          best = t;
          nx = side > 0 ? qx : -qx; ny = side > 0 ? qy : -qy;
        }
      }
    }
    for (const cap of [[col.x1, col.y1], [col.x2, col.y2]]) {  // end caps
      const t = raySweepCircle(x, y, dx, dy, cap[0], cap[1], R, maxDist);
      if (t >= 0 && (best < 0 || t < best)) {
        const ix = x + dx * t - cap[0], iy = y + dy * t - cap[1];
        const d = Math.hypot(ix, iy) || 1;
        best = t; nx = ix / d; ny = iy / d;
      }
    }
    if (best < 0) {
      const hit = collideCollider({ x, y, r }, col);
      if (hit && dx * hit.nx + dy * hit.ny < 0) return { d: 0, nx: hit.nx, ny: hit.ny };
      return null;
    }
    return { d: best, nx, ny };
  }
  /* swept circle vs ground-footprint ellipse: no closed form exists, so
     sphere-trace the distance field of the r-inflated ellipse (distance to
     a convex shape inflated by r = distance to the shape − r), reusing the
     SAME closestOnEllipse the discrete resolver uses — identical geometry,
     contact accurate to ~0.01 px. Query lengths here are at most one
     physics substep (≤ ~7 px), so the trace converges in a few steps. */
  function sweepCircleVsEllipse(x, y, dx, dy, r, col, maxDist) {
    let t = 0;
    for (let iter = 0; iter < 40; iter++) {
      const px = x + dx * t - col.x, py = y + dy * t - col.y;
      const inside = (px * px) / (col.rx * col.rx) + (py * py) / (col.ry * col.ry) < 1;
      const q = closestOnEllipse(col.rx, col.ry, px, py);
      const qd = Math.hypot(px - q.x, py - q.y);
      const gap = (inside ? -qd : qd) - r;
      if (gap <= 0.01) {
        let nx = inside ? q.x - px : px - q.x, ny = inside ? q.y - py : py - q.y;
        const nd = Math.hypot(nx, ny) || 1;
        nx /= nd; ny /= nd;
        if (t === 0 && dx * nx + dy * ny >= 0) return null;   // touching but leaving
        return { d: t, nx, ny };
      }
      t += gap;
      if (t > maxDist) return null;
    }
    return null;
  }
  /* nearest first contact for a moving token along (dx,dy) within maxDist:
     board walls + every active obstacle collider, one standardized result.
     Token-vs-token stays impulse-based in stepSim (relative closing speeds
     are far below one radius per substep, so no tunneling is possible). */
  function findNearestTokenCollision(st, tk, dx, dy, maxDist) {
    let best = null;
    const b = MAP.bounds;                          // walls: axis-aligned planes, exact
    if (dx < -1e-9) { const t = (b.x0 + tk.r - tk.x) / dx; if (t >= 0 && t <= maxDist) best = { d: t, nx: 1, ny: 0, o: null, def: null, shape: 'flat' }; }
    if (dx > 1e-9) { const t = (b.x1 - tk.r - tk.x) / dx; if (t >= 0 && t <= maxDist && (!best || t < best.d)) best = { d: t, nx: -1, ny: 0, o: null, def: null, shape: 'flat' }; }
    if (dy < -1e-9) { const t = (b.y0 + tk.r - tk.y) / dy; if (t >= 0 && t <= maxDist && (!best || t < best.d)) best = { d: t, nx: 0, ny: 1, o: null, def: null, shape: 'flat' }; }
    if (dy > 1e-9) { const t = (b.y1 - tk.r - tk.y) / dy; if (t >= 0 && t <= maxDist && (!best || t < best.d)) best = { d: t, nx: 0, ny: -1, o: null, def: null, shape: 'flat' }; }
    for (const o of st.obs) {
      if (o.broken || o.exploded) continue;
      const def = OBSTACLES[o.kind];
      for (const col of obstacleColliders(o)) {
        const reach = best ? best.d : maxDist;
        /* bounding-circle reject: collider unreachable within this sweep */
        let bx, by, br;
        if (col.t === 'circle') { bx = col.x; by = col.y; br = col.r; }
        else if (col.t === 'ellipse') { bx = col.x; by = col.y; br = Math.max(col.rx, col.ry); }
        else if (col.t === 'rect') { bx = col.x; by = col.y; br = Math.hypot(col.hw, col.hh); }
        else { bx = (col.x1 + col.x2) / 2; by = (col.y1 + col.y2) / 2; br = Math.hypot(col.x2 - col.x1, col.y2 - col.y1) / 2 + col.th; }
        if (Math.hypot(bx - tk.x, by - tk.y) > br + tk.r + reach + 1) continue;
        let hit = null;
        if (col.t === 'circle') {
          const t = raySweepCircle(tk.x, tk.y, dx, dy, col.x, col.y, tk.r + col.r, reach);
          if (t >= 0) {
            const ix = tk.x + dx * t - col.x, iy = tk.y + dy * t - col.y;
            const d = Math.hypot(ix, iy) || 1;
            hit = { d: t, nx: ix / d, ny: iy / d };
          }
        } else if (col.t === 'ellipse') hit = sweepCircleVsEllipse(tk.x, tk.y, dx, dy, tk.r, col, reach);
        else if (col.t === 'rect') hit = sweepCircleVsRect(tk.x, tk.y, dx, dy, tk.r, col, reach);
        else hit = sweepCircleVsSeg(tk.x, tk.y, dx, dy, tk.r, col, reach);
        if (hit && (!best || hit.d < best.d)) {
          best = { d: hit.d, nx: hit.nx, ny: hit.ny, o, def, shape: (col.t === 'circle' || col.t === 'ellipse') ? 'round' : 'flat' };
        }
      }
    }
    if (!best) return null;
    best.cx = tk.x + dx * best.d; best.cy = tk.y + dy * best.d;   // token CENTER at impact
    best.px = best.cx - best.nx * tk.r;                           // SURFACE contact point
    best.py = best.cy - best.ny * tk.r;                           // (= center − normal·radius)
    return best;
  }
  /* returns {nx, ny, depth} push-out normal for token vs a collider, or null */
  function collideCollider(tk, col) {
    if (col.t === 'circle') {
      const dx = tk.x - col.x, dy = tk.y - col.y, rr = tk.r + col.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr || d2 === 0) return null;
      const d = Math.sqrt(d2);
      return { nx: dx / d, ny: dy / d, depth: rr - d };
    }
    if (col.t === 'ellipse') {
      const px = tk.x - col.x, py = tk.y - col.y;
      if (Math.abs(px) > col.rx + tk.r || Math.abs(py) > col.ry + tk.r) return null;   // cheap reject
      const q = closestOnEllipse(col.rx, col.ry, px, py);
      let dx = px - q.x, dy = py - q.y;
      const d = Math.hypot(dx, dy);
      const inside = (px * px) / (col.rx * col.rx) + (py * py) / (col.ry * col.ry) < 1;
      if (!inside && d >= tk.r) return null;
      if (d < 0.001) {                        // dead center / on boundary: push down (toward the camera)
        return { nx: 0, ny: 1, depth: tk.r + (inside ? col.ry : 0) };
      }
      /* outward normal at the contact point; when the center slipped inside,
         the closest boundary point is the exit direction */
      const nx = (inside ? -dx : dx) / d, ny = (inside ? -dy : dy) / d;
      return { nx, ny, depth: inside ? tk.r + d : tk.r - d };
    }
    if (col.t === 'rect') {
      const cx = clamp(tk.x, col.x - col.hw, col.x + col.hw);
      const cy = clamp(tk.y, col.y - col.hh, col.y + col.hh);
      let dx = tk.x - cx, dy = tk.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > tk.r * tk.r) return null;
      if (d2 === 0) {                          // center inside: push along min axis
        const px = col.hw - Math.abs(tk.x - col.x), py = col.hh - Math.abs(tk.y - col.y);
        if (px < py) return { nx: tk.x < col.x ? -1 : 1, ny: 0, depth: px + tk.r };
        return { nx: 0, ny: tk.y < col.y ? -1 : 1, depth: py + tk.r };
      }
      const d = Math.sqrt(d2);
      return { nx: dx / d, ny: dy / d, depth: tk.r - d };
    }
    /* seg: capsule around the diagonal bumper face */
    const ax = col.x1, ay = col.y1, bx = col.x2, by = col.y2;
    const abx = bx - ax, aby = by - ay;
    const t = clamp(((tk.x - ax) * abx + (tk.y - ay) * aby) / (abx * abx + aby * aby), 0, 1);
    const px = ax + abx * t, py = ay + aby * t;
    let dx = tk.x - px, dy = tk.y - py;
    const rr = tk.r + col.th / 2, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return null;
    const d = Math.sqrt(d2) || 0.001;
    return { nx: dx / d, ny: dy / d, depth: rr - d };
  }
  function explodeBarrel(st, o, fx, contact) {
    o.exploded = true;
    for (const tk of st.tokens) {
      if (tk.sunk) continue;
      const dx = tk.x - o.x, dy = tk.y - o.y, d = Math.hypot(dx, dy);
      if (d < BOMB_RADIUS + tk.r) {
        const f = BOMB_IMPULSE * (1 - Math.max(0, d - 40) / (BOMB_RADIUS + tk.r));
        const inv = 1 / Math.max(12, d);
        tk.vx += dx * inv * f; tk.vy += dy * inv * f;
      }
    }
    if (fx) fx.bomb(o.x, o.y, contact);        // contact only for direct token hits, not chains
  }
  /* swept (continuous) movement for one token over one substep: advance to
     the exact first contact, resolve there, continue with the remaining
     time — never "move the full step, then push out of overlap". This is
     what guarantees the fired shot reproduces the aim prediction: both run
     THIS function against THE SAME colliders (§ one authoritative
     simulation), and it makes tunneling impossible at any speed. */
  function moveTokenSwept(st, tk, dtSub, fx) {
    let remaining = dtSub;
    for (let bounce = 0; bounce <= MAX_BOUNCES_PER_SUBSTEP; bounce++) {
      const sp = Math.hypot(tk.vx, tk.vy);
      if (sp < 0.01 || remaining <= 1e-9) return;
      const dx = tk.vx / sp, dy = tk.vy / sp;
      const dist = sp * remaining;
      const hit = findNearestTokenCollision(st, tk, dx, dy, dist);
      if (!hit) { tk.x += dx * dist; tk.y += dy * dist; return; }
      tk.x = hit.cx; tk.y = hit.cy;                // exact center at impact
      remaining -= hit.d / sp;
      const def = hit.def;                          // null for board walls
      /* ONE contact record (surface point + normal + center) feeds bounce,
         break and explode reporting AND the aim preview's event log — the
         arrows join exactly where the physics touched the obstacle (§4/§5) */
      const contact = {
        nx: hit.nx, ny: hit.ny, sp,
        px: hit.px, py: hit.py,
        cx: tk.x, cy: tk.y, player: tk.kind === 'player',
        shape: hit.shape, tkRef: tk,
      };
      const vn = tk.vx * hit.nx + tk.vy * hit.ny;
      if (vn < 0) {
        const rest = def ? (def.spike ? 0.3 : (def.rest || WALL_RESTITUTION)) : WALL_RESTITUTION;
        tk.vx -= (1 + rest) * vn * hit.nx;
        tk.vy -= (1 + rest) * vn * hit.ny;
        if (def && def.spike) { tk.vx *= 0.55; tk.vy *= 0.55; }   // high-friction barricade
      }
      /* numerical epsilon OFF the surface so the next query cannot re-hit
         the same plane at distance 0. Internal only: the recorded contact —
         and therefore every rendered arrow joint — stays ON the surface. */
      tk.x += hit.nx * COLLISION_EPSILON;
      tk.y += hit.ny * COLLISION_EPSILON;
      if (def && def.bomb && sp > BOMB_TRIGGER_SPEED && !hit.o.exploded) { explodeBarrel(st, hit.o, fx, contact); continue; }
      if (def && def.breakable && sp > CRATE_BREAK_SPEED && !hit.o.broken) {
        hit.o.broken = true;
        tk.vx *= CRATE_KEEP_VELOCITY; tk.vy *= CRATE_KEEP_VELOCITY;
        if (fx) fx.crate(hit.o.x, hit.o.y, contact);
        continue;
      }
      if (fx) fx.wall(tk, def, contact);
    }
  }
  /* advance one frame; returns true while anything still moves */
  function stepSim(st, dt, fx) {
    const bounds = MAP.bounds;
    let moving = false;
    const sub = dt / MAX_SUBSTEPS;
    for (let s = 0; s < MAX_SUBSTEPS; s++) {
      /* swept movement + drag (walls/obstacles resolved continuously inside
         the move; the clamp/push-out passes below remain as a safety net for
         tokens shoved into geometry by token impulses or bomb blasts) */
      for (const tk of st.tokens) {
        if (tk.sunk) continue;
        const sp = Math.hypot(tk.vx, tk.vy);
        if (sp > MAX_TOKEN_SPEED) { tk.vx *= MAX_TOKEN_SPEED / sp; tk.vy *= MAX_TOKEN_SPEED / sp; }
        moveTokenSwept(st, tk, sub, fx);
        const damp = Math.exp(-LINEAR_DRAG * sub);
        tk.vx *= damp; tk.vy *= damp;
        if (Math.abs(tk.vx) + Math.abs(tk.vy) < 0.01) { tk.vx = 0; tk.vy = 0; }
      }
      /* board walls — the hit info carries the SURFACE contact point (on the
         wall plane, one token radius from the center) and the wall normal so
         the aim preview can join its arrows on the visible surface (§5/§6) */
      for (const tk of st.tokens) {
        if (tk.sunk) continue;
        if (tk.x < bounds.x0 + tk.r) { tk.x = bounds.x0 + tk.r; if (tk.vx < 0) { tk.vx = -tk.vx * WALL_RESTITUTION; if (fx) fx.wall(tk, null, { nx: 1, ny: 0, px: bounds.x0, py: tk.y, cx: tk.x, cy: tk.y, player: tk.kind === 'player', shape: 'flat', tkRef: tk }); } }
        if (tk.x > bounds.x1 - tk.r) { tk.x = bounds.x1 - tk.r; if (tk.vx > 0) { tk.vx = -tk.vx * WALL_RESTITUTION; if (fx) fx.wall(tk, null, { nx: -1, ny: 0, px: bounds.x1, py: tk.y, cx: tk.x, cy: tk.y, player: tk.kind === 'player', shape: 'flat', tkRef: tk }); } }
        if (tk.y < bounds.y0 + tk.r) { tk.y = bounds.y0 + tk.r; if (tk.vy < 0) { tk.vy = -tk.vy * WALL_RESTITUTION; if (fx) fx.wall(tk, null, { nx: 0, ny: 1, px: tk.x, py: bounds.y0, cx: tk.x, cy: tk.y, player: tk.kind === 'player', shape: 'flat', tkRef: tk }); } }
        if (tk.y > bounds.y1 - tk.r) { tk.y = bounds.y1 - tk.r; if (tk.vy > 0) { tk.vy = -tk.vy * WALL_RESTITUTION; if (fx) fx.wall(tk, null, { nx: 0, ny: -1, px: tk.x, py: bounds.y1, cx: tk.x, cy: tk.y, player: tk.kind === 'player', shape: 'flat', tkRef: tk }); } }
      }
      /* obstacles */
      for (const o of st.obs) {
        if (o.broken || o.exploded) continue;
        const def = OBSTACLES[o.kind];
        const cols = obstacleColliders(o);
        for (const tk of st.tokens) {
          if (tk.sunk) continue;
          for (const col of cols) {
            const hit = collideCollider(tk, col);
            if (!hit) continue;
            const sp = Math.hypot(tk.vx, tk.vy);
            tk.x += hit.nx * hit.depth; tk.y += hit.ny * hit.depth;
            /* after push-out the token rests exactly on the collider surface:
               the contact point is one token radius against the normal (§4).
               ONE contact record feeds bounce, break and explode reporting so
               the aim preview can mark every obstacle contact; the live fx
               layer applies its own particle/sfx speed gate. */
            const contact = {
              nx: hit.nx, ny: hit.ny, sp,
              px: tk.x - hit.nx * tk.r, py: tk.y - hit.ny * tk.r,
              cx: tk.x, cy: tk.y, player: tk.kind === 'player',
              shape: (col.t === 'circle' || col.t === 'ellipse') ? 'round' : 'flat',
              tkRef: tk,
            };
            const vn = tk.vx * hit.nx + tk.vy * hit.ny;
            if (vn < 0) {
              const rest = def.spike ? 0.3 : (def.rest || WALL_RESTITUTION);
              tk.vx -= (1 + rest) * vn * hit.nx;
              tk.vy -= (1 + rest) * vn * hit.ny;
              if (def.spike) { tk.vx *= 0.55; tk.vy *= 0.55; }   // high-friction barricade
            }
            if (def.bomb && sp > BOMB_TRIGGER_SPEED && !o.exploded) { explodeBarrel(st, o, fx, contact); break; }
            if (def.breakable && sp > CRATE_BREAK_SPEED && !o.broken) {
              o.broken = true;
              tk.vx *= CRATE_KEEP_VELOCITY; tk.vy *= CRATE_KEEP_VELOCITY;
              if (fx) fx.crate(o.x, o.y, contact);
              break;
            }
            if (fx) fx.wall(tk, def, contact);
          }
          if (o.broken || o.exploded) break;
        }
      }
      /* token vs token */
      for (let i = 0; i < st.tokens.length; i++) {
        const a = st.tokens[i];
        if (a.sunk) continue;
        for (let j = i + 1; j < st.tokens.length; j++) {
          const b = st.tokens[j];
          if (b.sunk) continue;
          const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr || d2 === 0) continue;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          const overlap = rr - d, tm = a.mass + b.mass;
          a.x -= nx * overlap * (b.mass / tm); a.y -= ny * overlap * (b.mass / tm);
          b.x += nx * overlap * (a.mass / tm); b.y += ny * overlap * (a.mass / tm);
          const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            const imp = -(1 + TOKEN_RESTITUTION) * vn / (1 / a.mass + 1 / b.mass);
            a.vx -= imp * nx / a.mass; a.vy -= imp * ny / a.mass;
            b.vx += imp * nx / b.mass; b.vy += imp * ny / b.mass;
            if (fx && -vn > 100) fx.tokenHit((a.x + b.x) / 2, (a.y + b.y) / 2, -vn, a, b);
          }
        }
      }
      /* pits: capture once the token centre is inside the rim's OPENING
         (p.sinkRX/RY — the drawn inner edge, inset by SINK_INSET). A token
         that only touches, rolls along or bounces off the metal rim is
         outside this ellipse and does not score.
         Scored exactly once: tk.sunk latches here and every token loop in the
         step skips sunk tokens, so a token that sits in the trigger for many
         physics frames can never increment st.sunkCount twice. */
      for (const tk of st.tokens) {
        if (tk.sunk) continue;
        for (const p of MAP.pits) {
          const dx = (tk.x - p.cx) / p.sinkRX, dy = (tk.y - p.cy) / p.sinkRY;
          if (dx * dx + dy * dy <= 1) {
            tk.sunk = true; tk.sunkPit = p.id; tk.sunkX = tk.x; tk.sunkY = tk.y; tk.sunkAnim = 0.4;
            tk.vx = 0; tk.vy = 0;
            if (tk.kind === 'player') st.strikerSunk = true;
            else st.sunkCount++;
            if (fx) fx.sunk(tk, p);
            break;
          }
        }
      }
    }
    /* settled? */
    for (const tk of st.tokens) {
      if (!tk.sunk && Math.hypot(tk.vx, tk.vy) >= STOP_SPEED) { moving = true; break; }
    }
    st.elapsedMs += dt * 1000;
    if (!moving) st.settledMs += dt * 1000; else st.settledMs = 0;
    if (st.elapsedMs > MAX_SHOT_RESOLUTION_MS) {          // hard safety: force settle
      for (const tk of st.tokens) { tk.vx = 0; tk.vy = 0; }
      return false;
    }
    return !(st.settledMs >= SETTLE_MS);
  }
  /* run a whole shot to completion (solver / validation path) */
  function simulateShot(st, angle, power) {
    const s = cloneSim(st);
    const p = s.tokens[0];
    if (p.sunk) return s;
    p.vx = Math.cos(angle) * power; p.vy = Math.sin(angle) * power;
    let guard = Math.ceil(MAX_SHOT_RESOLUTION_MS / (PHYSICS_STEP * 1000)) + 60;
    while (stepSim(s, PHYSICS_STEP, null) && guard-- > 0) { /* run to rest */ }
    for (const tk of s.tokens) { tk.vx = 0; tk.vy = 0; }     // same settle contract as live play
    return s;
  }

  /* ============================================================
     SOLVER — beam search over analytic candidate shots
     ============================================================ */
  function candidateShots(st) {
    const out = [], striker = st.tokens[0];
    const powers = [0.55, 0.7, 0.85, 1.0];
    const addAim = (tx, ty) => {
      const base = Math.atan2(ty - striker.y, tx - striker.x);
      for (const off of [0, -0.045, 0.045]) {
        for (const pw of powers) out.push({ angle: base + off, power: pw * MAX_SHOT_POWER });
      }
    };
    for (const tk of st.tokens) {
      if (tk.kind !== 'enemy' || tk.sunk) continue;
      for (const p of MAP.pits) {
        /* ghost-ball: contact point that sends the enemy toward the pit */
        const dx = p.cx - tk.x, dy = p.cy - tk.y, d = Math.hypot(dx, dy) || 1;
        addAim(tk.x - dx / d * (TOKEN_RADIUS * 2), tk.y - dy / d * (TOKEN_RADIUS * 2));
      }
      /* one-bank shots: mirror the striker across each board wall */
      const b = MAP.bounds;
      const mirrors = [
        [2 * b.x0 - striker.x, striker.y], [2 * b.x1 - striker.x, striker.y],
        [striker.x, 2 * b.y0 - striker.y], [striker.x, 2 * b.y1 - striker.y],
      ];
      for (const m of mirrors) {
        const base = Math.atan2(tk.y - m[1], tk.x - m[0]);
        for (const pw of [0.7, 0.85, 1.0]) out.push({ angle: base, power: pw * MAX_SHOT_POWER });
      }
    }
    return out;
  }
  function scoreState(st, shotsUsed) {
    let s = st.sunkCount * 100000 - shotsUsed * 150;
    if (st.strikerSunk) s -= 1000000;
    for (const tk of st.tokens) {
      if (tk.kind !== 'enemy' || tk.sunk) continue;
      let best = 1e9;
      for (const p of MAP.pits) best = Math.min(best, Math.hypot(tk.x - p.cx, tk.y - p.cy));
      s -= best * 0.5;
    }
    const striker = st.tokens[0];
    for (const p of MAP.pits) {                       // unsafe striker position penalty
      if (Math.hypot(striker.x - p.cx, striker.y - p.cy) < p.rx + TOKEN_RADIUS * 2) s -= 400;
    }
    return s;
  }
  function solveLayout(layout, budgetMs) {
    const t0 = performance.now();
    const BEAM = 8;
    let beam = [{ st: buildSim(layout), shots: [], used: 0 }];
    for (let depth = 1; depth <= 5; depth++) {
      const next = [];
      for (const node of beam) {
        if (performance.now() - t0 > budgetMs) return null;
        const cands = candidateShots(node.st);
        for (const c of cands) {
          if (performance.now() - t0 > budgetMs) return null;
          const res = simulateShot(node.st, c.angle, c.power);
          if (res.strikerSunk) continue;
          const n = { st: res, shots: node.shots.concat([c]), used: node.used + 1 };
          if (res.sunkCount === 3) return n;              // solved!
          next.push(n);
        }
      }
      if (!next.length) return null;
      next.sort((a, b) => scoreState(b.st, b.used) - scoreState(a.st, a.used));
      beam = next.slice(0, BEAM);
    }
    return null;
  }
  /* fairness: the first shot of the found solution must tolerate small error */
  function firstShotTolerant(layout, sol) {
    if (!sol || !sol.shots.length) return false;
    const base = sol.shots[0], st = buildSim(layout);
    const clean = simulateShot(st, base.angle, base.power);
    const cleanScore = scoreState(clean, 1);
    let ok = 0;
    const variants = [
      { angle: base.angle + 0.0436, power: base.power },
      { angle: base.angle - 0.0436, power: base.power },
      { angle: base.angle, power: Math.min(MAX_SHOT_POWER, base.power * 1.05) },
      { angle: base.angle, power: base.power * 0.95 },
    ];
    for (const v of variants) {
      const r = simulateShot(st, v.angle, v.power);
      if (!r.strikerSunk && (r.sunkCount > 0 || scoreState(r, 1) > cleanScore - 20000)) ok++;
    }
    return ok >= 2;
  }

  /* ============================================================
     PROCEDURAL GENERATION
     ============================================================ */
  function tierFor(attempts) { return attempts < 3 ? 0 : attempts < 10 ? 1 : 2; }
  function inZone(z, x, y) { return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1; }
  function pitClear(x, y, min) {
    for (const p of MAP.pits) {
      if (Math.hypot(x - p.cx, y - p.cy) < Math.max(p.rx, p.ry) + min) return false;
    }
    return true;
  }
  function obstacleFootprintRadius(kind) {
    const def = OBSTACLES[kind];
    let r = 0;
    for (const c of def.cols) {
      if (c.t === 'circle') r = Math.max(r, c.r + Math.hypot(c.ox || 0, c.oy || 0));
      else if (c.t === 'ellipse') r = Math.max(r, Math.max(c.rx, c.ry) + Math.hypot(c.ox || 0, c.oy || 0));
      else if (c.t === 'rect') r = Math.max(r, Math.hypot(c.hw + Math.abs(c.ox || 0), c.hh + Math.abs(c.oy || 0)));
      else r = Math.max(r, Math.max(Math.hypot(c.x1, c.y1), Math.hypot(c.x2, c.y2)) + c.th);
    }
    return r;
  }
  /* board-px offset below the anchor where the sprite's image bottom sits:
     explicit hand-calibrated footY when present, else the collider bottom.
     ONE function feeds both drawing and depth sorting so they never split. */
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
  function enemyDef(id) { for (const e of ENEMY_TOKENS) if (e.id === id) return e; return ENEMY_TOKENS[2]; }
  function pickEnemies(rng, pool) {
    const picks = [], src = pool.slice();
    while (picks.length < 3 && src.length) picks.push(src.splice(Math.floor(rng() * src.length), 1)[0]);
    return picks;
  }
  function layoutFromTemplate(t, rng) {
    const skins = pickEnemies(rng, ENEMY_TOKENS.map(e => e.id));
    return {
      source: 'template', templateId: t.id,
      player: [t.player[0], t.player[1]],
      enemies: t.enemies.map((e, i) => ({ type: skins[i], x: e[0], y: e[1], mass: enemyDef(skins[i]).mass })),
      obstacles: t.obstacles.map(o => ({ kind: o[0], x: o[1], y: o[2] })),
    };
  }
  function generateLayout(seed) {
    const t0 = performance.now();
    const rng = mulberry32(seed);
    const tier = tierFor(rico().totalAttempts);
    const pool = tier === 0 ? POOL_BEGINNER : tier === 1 ? POOL_STANDARD : POOL_ADVANCED;
    const nObsMin = tier === 0 ? 4 : tier === 1 ? 4 : 5;
    const nObsMax = tier === 0 ? 4 : tier === 1 ? 6 : 7;

    for (let attempt = 0; attempt < MAX_LAYOUT_GENERATION_ATTEMPTS; attempt++) {
      if (performance.now() - t0 > GENERATION_TIME_BUDGET_MS) break;
      /* player */
      const pz = MAP.playerZone;
      const px = pz.x0 + rng() * (pz.x1 - pz.x0), py = pz.y0 + rng() * (pz.y1 - pz.y0);
      if (!pitClear(px, py, PIT_SPAWN_CLEARANCE)) continue;
      /* enemies: one per zone, shuffled */
      const zones = MAP.enemyZones.slice();
      for (let i = zones.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = zones[i]; zones[i] = zones[j]; zones[j] = t; }
      const skins = pickEnemies(rng, ENEMY_TOKENS.map(e => e.id));
      const enemies = [];
      let bad = false;
      for (let i = 0; i < 3; i++) {
        let placed = false;
        for (let tri = 0; tri < 24 && !placed; tri++) {
          const z = zones[i];
          const x = z.x0 + rng() * (z.x1 - z.x0), y = z.y0 + rng() * (z.y1 - z.y0);
          if (!pitClear(x, y, PIT_SPAWN_CLEARANCE)) continue;
          if (Math.hypot(x - px, y - py) < TOKEN_TOKEN_CLEARANCE * 2) continue;
          let clash = false;
          for (const e of enemies) if (Math.hypot(x - e.x, y - e.y) < TOKEN_TOKEN_CLEARANCE) { clash = true; break; }
          if (clash) continue;
          enemies.push({ type: skins[i], x, y, mass: enemyDef(skins[i]).mass });
          placed = true;
        }
        if (!placed) { bad = true; break; }
      }
      if (bad) continue;
      /* obstacles */
      const nObs = nObsMin + Math.floor(rng() * (nObsMax - nObsMin + 1));
      const obstacles = [];
      const oz = MAP.obstacleZone;
      for (let i = 0; i < nObs; i++) {
        let placed = false;
        for (let tri = 0; tri < 30 && !placed; tri++) {
          const kind = pool[Math.floor(rng() * pool.length)];
          const def = OBSTACLES[kind];
          /* variation stays fair: at most one bomb and two spike pieces per board */
          if (def.bomb && obstacles.some(o => OBSTACLES[o.kind].bomb)) continue;
          if (def.spike && obstacles.filter(o => OBSTACLES[o.kind].spike).length >= 2) continue;
          const fr = obstacleFootprintRadius(kind);
          const x = oz.x0 + fr + rng() * (oz.x1 - oz.x0 - fr * 2);
          const y = oz.y0 + fr + rng() * (oz.y1 - oz.y0 - fr * 2);
          if (!pitClear(x, y, OBSTACLE_PIT_CLEARANCE + fr * 0.4)) continue;
          if (Math.hypot(x - px, y - py) < fr + TOKEN_OBSTACLE_CLEARANCE + TOKEN_RADIUS) continue;
          let clash = false;
          for (const e of enemies) if (Math.hypot(x - e.x, y - e.y) < fr + TOKEN_OBSTACLE_CLEARANCE + TOKEN_RADIUS) { clash = true; break; }
          if (!clash) for (const o of obstacles) if (Math.hypot(x - o.x, y - o.y) < fr + obstacleFootprintRadius(o.kind) + 30) { clash = true; break; }
          if (clash) continue;
          obstacles.push({ kind, x, y });
          placed = true;
        }
      }
      if (obstacles.length < nObsMin) continue;
      const layout = { source: 'procedural', player: [px, py], enemies, obstacles };
      /* solver validation (remaining budget) */
      const left = GENERATION_TIME_BUDGET_MS - (performance.now() - t0);
      if (left < 300) break;
      const sol = solveLayout(layout, Math.min(left, 1400));
      if (!sol) continue;
      if (!firstShotTolerant(layout, sol)) continue;
      layout.solutionShots = sol.used;
      return layout;
    }
    /* authored fallback — filtered by difficulty gating */
    const attempts = rico().totalAttempts;
    const eligible = TEMPLATES.filter(t => !(t.minAttempts && attempts < t.minAttempts));
    const t = eligible[Math.floor(rng() * eligible.length)];
    CrashDiagnostics.record('ricochet-fallback-template', { id: t.id, seed });
    return layoutFromTemplate(t, rng);
  }

  /* ============================================================
     ATTEMPT LIFECYCLE
     ============================================================ */
  let A = null;              // live attempt runtime; null when the mode is closed
  let purchasePending = false;

  function isActive() { return state === 'ricochet' || state === 'ricochetPause' || state === 'ricochetResult'; }

  function beginAttempt(type) {
    const r = rico();
    preloadCore();
    const seed = hashSeed(Math.floor(safeNow() / 3600000), r.totalAttempts, r.installId);
    r.lastAttemptSeed = seed;
    /* snapshot for the asset-failure refund path: an attempt that never
       became playable must cost neither the free slot nor crowns (§3) */
    const refund = { type, prevNextFree: r.nextFreeAttemptAt || 0 };
    if (type === 'free') r.nextFreeAttemptAt = safeNow() + FREE_COOLDOWN_MS;   // cooldown starts NOW
    r.totalAttempts += 1;
    r.activeAttempt = {
      id: 'ra-' + seed + '-' + Date.now(), attemptType: type,
      startedAt: safeNow(), seed, rewardGranted: false,
    };
    saveMeta();
    CrashDiagnostics.record('ricochet-attempt-start', { type, seed });

    A = {
      phase: 'loading', seed, type, refund,
      sim: null, layout: null,
      shotsLeft: 5, pendingCoins: 0,
      aim: null, hover: null, firstShotTaken: false, aimSession: 0,
      fx: [], floats: [],
      tut: (!r.tutorialCompleted) ? 0 : -1,     // tutorial step index, -1 = off
      resultShown: false, lastHitSfx: 0, dangerT: 0,
      pauseBtn: { x: 0, y: 0, w: 0, h: 0 },
    };
    canvas.classList.add('ricoCursor');          // the OS cursor is hidden game-wide; bring it back here
    state = 'ricochet';
    showScreen(null);
    /* generate off the tap's call stack so the loading frame paints first */
    setTimeout(() => {
      if (!A || A.phase !== 'loading') return;
      const layout = generateLayout(seed);
      /* per-attempt sprites only: the 3 chosen enemies + used obstacles */
      for (const e of layout.enemies) rimg('tokens/standardized_384/' + enemyDef(e.type).file);
      for (const o of layout.obstacles) rimg('obstacles/' + OBSTACLES[o.kind].file);
      A.layout = layout;
      A.sim = buildSim(layout);
      /* the board is built, but play is gated until every critical sprite
         (board, tokens, obstacles, aim pack) is decoded — the renderer must
         never depend on load timing (§3) */
      waitForAimAssets(A);
    }, 60);
  }

  /* hold the loading screen until every critical attempt sprite is drawable */
  const AIM_ASSET_TIMEOUT_MS = 10000;
  function waitForAimAssets(attempt) {
    const t0 = performance.now();
    (function poll() {
      if (A !== attempt || A.phase !== 'loading') return;    // attempt closed meanwhile
      const failed = [], pending = [];
      for (const rel of criticalAttemptAssets(attempt.layout)) {
        const img = rimg(rel);
        if (img.ricoFailed) failed.push(ASSET_ROOT + rel);
        else if (!ready(img)) pending.push(ASSET_ROOT + rel);
      }
      if (failed.length) { abortForAssets('failed', failed); return; }
      if (!pending.length) {
        A.phase = A.tut >= 0 ? 'tutorial' : 'aim';
        CrashDiagnostics.record('ricochet-board-ready', { source: A.layout.source, template: A.layout.templateId || null });
        return;
      }
      if (performance.now() - t0 > AIM_ASSET_TIMEOUT_MS) { abortForAssets('timeout', pending); return; }
      setTimeout(poll, 120);
    })();
  }
  /* a critical sprite never arrived: exact paths to diagnostics, full
     refund (free slot or crowns), themed error, back to the menu (§3) */
  function abortForAssets(why, paths) {
    CrashDiagnostics.record('ricochet-aim-assets-missing', { why, missing: paths.slice(0, 8) });
    const r = rico();
    if (A && A.refund) {
      if (A.refund.type === 'free') r.nextFreeAttemptAt = A.refund.prevNextFree;
      else { META.crowns += REPLAY_COST_CROWNS; r.paidAttemptCount = Math.max(0, (r.paidAttemptCount || 0) - 1); }
    }
    r.totalAttempts = Math.max(0, r.totalAttempts - 1);
    r.activeAttempt = null;
    saveMeta();
    A = null;
    canvas.classList.remove('ricoCursor');
    openMenu();
    gameConfirm('The royal quartermaster could not prepare the courtyard. Nothing was spent — your free attempt and crowns are untouched. Please try again.',
      { title: 'Castle Ricochet', okText: 'OK', cancelText: 'Close' });
  }

  function grantReward(enemyCount) {
    const r = rico(), act = r.activeAttempt;
    const amount = RICO_REWARDS[enemyCount] || 0;
    if (act && !act.rewardGranted) {
      act.rewardGranted = true;                  // duplication guard: one grant per attempt id
      if (amount > 0) { addGold(amount); }
      r.totalEnemiesSunk += enemyCount;
      r.bestEnemiesSunk = Math.max(r.bestEnemiesSunk || 0, enemyCount);
      saveMeta();
    }
    return amount;
  }

  function finishAttempt(kind) {                 // 'victory' | 'exhausted' | 'strikerLost' | 'abandoned'
    if (!A || A.phase === 'done') return;
    A.phase = 'done';
    const sunk = A.sim ? A.sim.sunkCount : 0;
    const failed = kind === 'strikerLost' || kind === 'abandoned';
    const coins = failed ? grantReward(0) && 0 : grantReward(sunk);
    rico().activeAttempt = null;
    saveMeta();
    CrashDiagnostics.record('ricochet-result', { kind, sunk: failed ? 0 : sunk, coins: failed ? 0 : coins });
    /* Royal Decrees: a finished (non-abandoned) attempt reports its outcome */
    if (kind !== 'abandoned' && typeof CastleDaily !== 'undefined') {
      try { CastleDaily.event('ricochetAttempt', { sunk: failed ? 0 : sunk, coins: failed ? 0 : coins }); }
      catch (e) { CrashDiagnostics.record('daily-event-error', { name: 'ricochetAttempt', message: String(e && e.message) }); }
    }
    if (kind === 'abandoned') { closeToMenu(); return; }
    A.result = { kind, sunk: failed ? 0 : sunk, coins: failed ? 0 : coins, shotsUsed: 5 - A.shotsLeft };
    if (kind === 'victory') Sfx.wave(); else if (kind === 'strikerLost') Sfx.lose(); else if (coins > 0) Sfx.coin();
    showResult();
  }

  function showResult() {
    state = 'ricochetResult';
    const res = A.result;
    const img = (f) => ASSET_ROOT + 'ui/' + f;
    $('ricoResultBanner').src = res.kind === 'strikerLost' ? img('ui_banner_game_over.png')
      : res.kind === 'victory' ? img('ui_banner_victory.png') : img('ui_logo_castle_ricochet.png');
    $('ricoResultTitle').textContent =
      res.kind === 'strikerLost' ? 'ROYAL STRIKER LOST'
        : res.sunk === 3 ? 'PERFECT CLEAR'
          : res.sunk === 1 ? '1 ENEMY SUNK' : res.sunk + ' ENEMIES SUNK';
    const reason = $('ricoResultReason');
    if (reason) {
      if (res.kind === 'strikerLost') { reason.textContent = 'YOUR ROYAL STRIKER FELL INTO A PIT'; reason.classList.remove('hidden'); }
      else reason.classList.add('hidden');
    }
    $('ricoResultCoins').textContent = res.coins.toLocaleString() + ' COINS EARNED';
    $('ricoResultShots').textContent = 'Shots used: ' + res.shotsUsed + ' / 5';
    const badge = $('ricoResultBadge');
    if (res.coins > 0) { badge.src = img('ui_reward_badge_' + res.coins + '.png'); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    showScreen('ricochetResultScreen');
    updateCountdownLabels();
  }

  function closeToMenu() {
    A = null;
    canvas.classList.remove('ricoCursor');       // hand cursor rules apply again outside the mode
    openMenu();
  }

  /* ---------------- entry / paid replay ---------------- */
  function open() {
    if (purchasePending) return;
    preloadCore();
    if (freeAvailable()) { beginAttempt('free'); return; }
    offerPaidAttempt();
  }
  function offerPaidAttempt() {
    if (purchasePending) return;
    if (META.crowns < REPLAY_COST_CROWNS) {
      gameConfirm('You need 20 crowns to play Castle Ricochet immediately.',
        { title: 'Not Enough Crowns', okText: 'Crown Shop', cancelText: 'Cancel' })
        .then(ok => { if (ok) openShop('menu'); });
      return;
    }
    gameConfirm('Spend 20 crowns to play immediately? Your free attempt timer will not be changed.',
      { title: 'Play Castle Ricochet?', okText: 'Play — 20 Crowns', cancelText: 'Cancel' })
      .then(ok => {
        if (!ok || purchasePending) return;
        if (META.crowns < REPLAY_COST_CROWNS) return;      // re-check: balance may have changed
        purchasePending = true;
        try {
          META.crowns -= REPLAY_COST_CROWNS;
          rico().paidAttemptCount += 1;
          saveMeta();
          beginAttempt('paid');                             // never touches nextFreeAttemptAt
        } finally { purchasePending = false; }
      });
  }

  /* ---------------- pause / abandon / back ---------------- */
  function pauseRico() {
    if (state !== 'ricochet' || !A || A.phase === 'done') return;
    if (A.aim) A.aim = null;                                 // opening the menu cancels any aim
    state = 'ricochetPause';
    showScreen('ricochetPauseScreen');
  }
  function resumeRico() {
    if (state !== 'ricochetPause') return;
    state = 'ricochet';
    showScreen(null);
  }
  function abandonRico() {
    gameConfirm('This attempt will end and no coins will be awarded.',
      { title: 'Abandon Castle Ricochet?', okText: 'Abandon', cancelText: 'Cancel', danger: true })
      .then(ok => {
        if (!ok) return;
        if (A) finishAttempt('abandoned');
      });
  }
  function handleBack() {
    if (state === 'ricochet') { pauseRico(); return true; }
    if (state === 'ricochetPause') { resumeRico(); return true; }
    if (state === 'ricochetResult') { closeToMenu(); return true; }
    return false;
  }
  function lifecyclePause() { if (state === 'ricochet') pauseRico(); }

  /* ---------------- boot-time cleanup: attempt orphaned by force-close ---------------- */
  function bootCheck() {
    const r = rico();
    if (r.activeAttempt) {
      CrashDiagnostics.record('ricochet-attempt-abandoned-by-close', { id: r.activeAttempt.id, type: r.activeAttempt.attemptType });
      r.activeAttempt = null;                                // zero coins, no refund, cooldown untouched
      saveMeta();
    }
  }

  /* ============================================================
     INPUT (registered once; gated by state — never duplicated)
     ============================================================ */
  let view = { s: 1, ox: 0, oy: 0 };                         // board->world transform, updated each frame
  function toBoard(p) { return { x: (p.x - view.ox) / view.s, y: (p.y - view.oy) / view.s }; }
  function initInput() {
    canvas.addEventListener('pointerdown', ev => {
      if (state !== 'ricochet' || !A) return;
      const wp = canvasPos(ev);
      /* pause button */
      const pb = A.pauseBtn;
      if (wp.x >= pb.x && wp.x <= pb.x + pb.w && wp.y >= pb.y && wp.y <= pb.y + pb.h) { Sfx.ui(); pauseRico(); return; }
      if (A.phase === 'tutorial') { advanceTutorial(); return; }
      if (A.phase !== 'aim') return;
      if (A.aim) { A.aim = null; return; }                   // a second pointer cancels the aim
      const bp = toBoard(wp);
      const striker = A.sim.tokens[0];
      if (Math.hypot(bp.x - striker.x, bp.y - striker.y) <= striker.r * 3.0) {
        A.preview = null;                                    // never reuse a stale board prediction
        A.aimSession = (A.aimSession || 0) + 1;              // fresh pointer session (§16 / diagnostics)
        A.aim = { cx: bp.x, cy: bp.y, pid: ev.pointerId };
        /* keep receiving moves even when the drag leaves the canvas — pulling
           backward from the low striker position routinely exits the element,
           which is exactly how mice aim (the closed-test "mouse broken" bug) */
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
        Sfx.unlock();
      }
    });
    /* moves tracked on WINDOW: the aim must survive the pointer leaving the
       canvas element; only release/second-pointer/pause ends it */
    window.addEventListener('pointermove', ev => {
      if (state !== 'ricochet' || !A) return;
      const bp = toBoard(canvasPos(ev));
      A.hover = bp;                                          // hover ring on the striker (mouse affordance)
      if (!A.aim) return;
      if (A.aim.pid !== undefined && ev.pointerId !== undefined && ev.pointerId !== A.aim.pid) return;
      A.aim.cx = bp.x; A.aim.cy = bp.y;
    });
    window.addEventListener('pointerup', ev => {
      if (!A || !A.aim) return;
      if (A.aim.pid !== undefined && ev.pointerId !== undefined && ev.pointerId !== A.aim.pid) return;
      try { canvas.releasePointerCapture(A.aim.pid); } catch (e) {}
      if (state !== 'ricochet' || A.phase !== 'aim') { A.aim = null; return; }
      releaseShot();
    });
    window.addEventListener('pointercancel', () => { if (A) A.aim = null; });
  }
  function aimVector() {
    const striker = A.sim.tokens[0];
    const dx = striker.x - A.aim.cx, dy = striker.y - A.aim.cy;    // launch = opposite of drag
    const pull = Math.min(MAX_PULL, Math.hypot(dx, dy));
    return { angle: Math.atan2(dy, dx), pull, power: pull / MAX_PULL * MAX_SHOT_POWER };
  }
  function releaseShot() {
    const v = aimVector();                                    // same source of truth the preview used
    A.aim = null;
    if (v.pull < MIN_PULL) return;                            // no shot consumed
    if (debugOn() && A.preview && A.preview.impact) {
      console.log('[Castle Ricochet Aim]', {
        target: A.preview.impact.enemyType,
        contactPoint: A.preview.impact.contact,
        collisionNormal: A.preview.impact.normal,
        predictedStrikerVelocity: A.preview.impact.strikerVel,
        predictedEnemyVelocity: A.preview.impact.enemyVel,
      });
    }
    A.preview = null;
    const striker = A.sim.tokens[0];
    striker.vx = Math.cos(v.angle) * v.power;
    striker.vy = Math.sin(v.angle) * v.power;
    A.firstShotTaken = true;
    A.shotsLeft--; A.phase = 'moving';
    A.sim.settledMs = 0; A.sim.elapsedMs = 0; A.physAcc = 0;
    Sfx.throwW();
    CrashDiagnostics.record('ricochet-shot', { n: 5 - A.shotsLeft, power: Math.round(v.power) });
  }

  /* ---------------- tutorial ---------------- */
  const TUT_STEPS = [
    'Drag backward from your Royal Striker.',
    'The longer the arrow, the stronger the shot.',
    'Use walls and obstacles to bank your shots.',
    'Knock enemy tokens into the pits.',
    'Do not let your Royal Striker fall in. That ends the game immediately.',
    'You have five shots to sink three enemies.',
  ];
  function advanceTutorial() {
    Sfx.ui();
    A.tut++;
    if (A.tut >= TUT_STEPS.length) {
      A.tut = -1; A.phase = 'aim';
      rico().tutorialCompleted = true;
      saveMeta();
    }
  }
  function replayTutorialNextAttempt() { rico().tutorialCompleted = false; saveMeta(); }

  /* ============================================================
     PER-FRAME UPDATE + RENDER (called from game.js frame loop)
     ============================================================ */
  const liveFx = {
    wall(tk, def, hit) {
      if (hit && hit.sp !== undefined && hit.sp <= 120) return;   // dribble: no particles/sfx
      spawnFx(tk.x, tk.y, 4, '#ffe9b0');
      const t = performance.now();
      if (t - (A ? A.lastHitSfx : 0) > 90) { if (A) A.lastHitSfx = t; Sfx.arrow(); }
    },
    tokenHit(x, y, force) {
      spawnFx(x, y, 6, '#ffd77a');
      const t = performance.now();
      if (t - (A ? A.lastHitSfx : 0) > 90) { if (A) A.lastHitSfx = t; Sfx.hit(clamp(force / 900, 0.3, 1.2)); }
    },
    crate(x, y) { spawnFx(x, y, 14, '#c78a4e'); Sfx.hit(0.9); },
    bomb(x, y) { spawnFx(x, y, 26, '#ff9d45'); spawnFx(x, y, 12, '#5a5a5a'); Sfx.boom(); },
    sunk(tk, p) {
      if (tk.kind === 'enemy') {
        spawnFx(p.cx, p.cy - 10, 16, '#7ad9ff');
        A.floats.push({ x: p.cx, y: p.cy - 40, text: '+500', t: 1.1 });
        A.pendingCoins = RICO_REWARDS[A.sim.sunkCount] || 0;
        Sfx.convert(); Sfx.coin();
      } else {
        spawnFx(p.cx, p.cy - 10, 20, '#ff6a4a');
        Sfx.hurt();
      }
    },
  };
  function spawnFx(x, y, n, color) {
    if (!A) return;
    for (let i = 0; i < n; i++) {
      if (A.fx.length >= 120) A.fx.shift();
      const a = Math.random() * TAU, s = 60 + Math.random() * 180;
      A.fx.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0.5, max: 0.5, color });
    }
  }

  function update(dt) {
    if (!A) return;
    for (let i = A.fx.length - 1; i >= 0; i--) {
      const p = A.fx[i];
      p.t -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.t <= 0) A.fx.splice(i, 1);
    }
    for (let i = A.floats.length - 1; i >= 0; i--) {
      A.floats[i].t -= dt; A.floats[i].y -= 45 * dt;
      if (A.floats[i].t <= 0) A.floats.splice(i, 1);
    }
    for (const tk of A.sim ? A.sim.tokens : []) if (tk.sunkAnim > 0) tk.sunkAnim -= dt;
    if (state !== 'ricochet' || A.phase !== 'moving') return;
    /* fixed-step accumulator: live play advances in the same PHYSICS_STEP
       quanta the aim preview and the solver use, so a fired shot replays
       the predicted trajectory step-for-step (variable frame dt used to
       discretize drag differently and let prediction and reality drift a
       few px apart over a long roll). Cap = brief hitches catch up, a
       backgrounded tab does not fast-forward. */
    A.physAcc = Math.min((A.physAcc || 0) + dt, PHYSICS_STEP * 6);
    let still = true;
    while (A.physAcc >= PHYSICS_STEP) {
      A.physAcc -= PHYSICS_STEP;
      still = stepSim(A.sim, PHYSICS_STEP, liveFx);
      if (!still) break;
    }
    /* striker pit danger glow */
    const striker = A.sim.tokens[0];
    A.dangerT = 0;
    if (!striker.sunk) {
      for (const p of MAP.pits) {
        const d = Math.hypot(striker.x - p.cx, striker.y - p.cy);
        if (d < p.rx + striker.r * 2) A.dangerT = 1;
      }
    }
    if (A.sim.strikerSunk) { finishAttempt('strikerLost'); return; }   // striker loss beats everything
    if (A.sim.sunkCount === 3) { finishAttempt('victory'); return; }
    if (!still) {
      /* settle contract: below STOP_SPEED for SETTLE_MS means stopped — zero
         the residual drift too. Leaving it made the next aim preview clone a
         board whose just-hit enemies still "moved" a few px/s, which read as
         a phantom first collision at the striker and demoted the whole guide
         to the short blue deflection arrow on every shot after an enemy
         contact (the alternating gold/blue-only bug). It also let those stale
         velocities resume on the next release. */
      for (const tk of A.sim.tokens) { tk.vx = 0; tk.vy = 0; }
      A.pendingCoins = RICO_REWARDS[A.sim.sunkCount] || 0;
      if (A.shotsLeft <= 0) { finishAttempt('exhausted'); return; }
      A.phase = 'aim';
    }
  }

  /* ============================================================
     AIM PREVIEW — cloned physics simulation, exact contact events
     The preview and the real shot share ONE physics engine
     (cloneSim/stepSim with swept-circle movement): identical token
     centers, radii, masses, restitution, drag, obstacle colliders,
     surface normals, reflection math, epsilon and pit capture — and
     live play steps in the same fixed PHYSICS_STEP quanta, so the
     fired projectile replays the prediction step-for-step. The
     trajectory drawn is built ONLY from contact events the physics
     itself emitted (exact surface points + normals), never from
     re-derived or approximated geometry. A token-to-token hit
     previews with the true impulse response — centered hits
     transfer forward, glancing hits split along the collision
     normal, and heavy tokens move less than light ones. Never a
     wall-style reflection off an enemy.
     ============================================================ */
  const MAX_PREVIEW_STEPS = 120;         // 2s of simulated flight
  const POST_IMPACT_STEPS = 55;          // ~0.9s of outgoing paths
  const AIM_ANGLE_EPS = 0.006;           // ~0.35° — recompute thresholds
  const AIM_POWER_EPS = MAX_SHOT_POWER * 0.01;
  const tokenCenter = tk => ({ x: tk.x, y: tk.y });   // physics center, never sprite bounds

  function computeAimPreview(v) {
    /* exact same launch values the release will use (aimVector is the single
       source of truth for both) */
    const sim = cloneSim(A.sim);
    const striker = sim.tokens[0];
    /* baseline speeds: a first collision is a speed JUMP above whatever a
       token already carried at aim start — never pre-existing drift. Drag
       only decays the baseline, so a real strike always clears it (§4) */
    const baseSpeed = sim.tokens.map(t => Math.abs(t.vx) + Math.abs(t.vy));
    striker.vx = Math.cos(v.angle) * v.power;
    striker.vy = Math.sin(v.angle) * v.power;
    const pre = [tokenCenter(striker)];  // striker path up to first token impact
    let impact = null;
    const enemyPath = [], strikerPost = [];
    /* EXACT contact events, straight from the shared swept physics (§4/§5).
       Each event stores TWO points: the token CENTER at impact (cx,cy — what
       the physics integrates from) and the visible SURFACE contact point
       (x,y — where the arrow joint, tip and marker must meet the obstacle).
       The trajectory model is built ONLY from these events — no polyline
       angle-detection heuristics anywhere. */
    const events = [];
    const recordEvent = (c, shapeOverride) => {
      if (!c || events.length >= 48) return;
      const idx = sim.tokens.indexOf(c.tkRef);
      if (idx < 0) return;
      events.push({
        idx, phase: impact ? 'post' : 'pre',
        x: c.px, y: c.py, cx: c.cx, cy: c.cy, nx: c.nx, ny: c.ny,
        shape: shapeOverride || c.shape,
      });
    };
    const evFx = {
      wall(tk2, def, hit) { recordEvent(hit); },
      /* breaking a crate and triggering a barrel are contacts too (§21):
         the guide marks them exactly where the striker touches the obstacle */
      crate(x, y, hit) { recordEvent(hit); },
      bomb(x, y, hit) { recordEvent(hit); },
      /* token-token hits bend the ENEMY/deflection paths at the post-
         resolution centers (the striker's first enemy hit is `impact` and is
         excluded from path building by its 'token' shape tag) */
      tokenHit(x, y, force, ta, tb) {
        if (ta) recordEvent({ px: ta.x, py: ta.y, cx: ta.x, cy: ta.y, nx: 0, ny: 0, tkRef: ta }, 'token');
        if (tb) recordEvent({ px: tb.x, py: tb.y, cx: tb.x, cy: tb.y, nx: 0, ny: 0, tkRef: tb }, 'token');
      },
      sunk() {},
    };
    let postSteps = 0, done = false;
    for (let i = 0; i < MAX_PREVIEW_STEPS + POST_IMPACT_STEPS && !done; i++) {
      const still = stepSim(sim, PHYSICS_STEP, evFx);
      if (!impact) {
        pre.push(tokenCenter(striker));
        if (sim.strikerSunk) break;                       // fell in before touching anyone
        /* first token collision: a previously stationary enemy started moving */
        for (let j = 1; j < sim.tokens.length; j++) {
          const e = sim.tokens[j];
          if (e.sunk || Math.abs(e.vx) + Math.abs(e.vy) < baseSpeed[j] + 5) continue;
          /* post-resolution geometry: both bodies sit exactly in contact, so
             the normal from the striker center to the enemy center IS the
             collision normal and the contact point lies one striker radius
             along it (§7) */
          const dx = e.x - striker.x, dy = e.y - striker.y;
          const d = Math.hypot(dx, dy) || 1;
          impact = {
            enemyIdx: j, enemyType: e.typeId, enemyMass: e.mass,
            strikerAt: tokenCenter(striker),
            normal: { x: dx / d, y: dy / d },
            contact: { x: striker.x + dx / d * striker.r, y: striker.y + dy / d * striker.r },
            enemyVel: { x: e.vx, y: e.vy },
            strikerVel: { x: striker.vx, y: striker.vy },
          };
          enemyPath.push(tokenCenter(e));
          strikerPost.push(tokenCenter(striker));
          break;
        }
        if (i >= MAX_PREVIEW_STEPS) break;
      } else {
        const e = sim.tokens[impact.enemyIdx];
        if (!e.sunk && Math.hypot(e.vx, e.vy) > STOP_SPEED * 0.6) enemyPath.push(tokenCenter(e));
        if (!striker.sunk && Math.hypot(striker.vx, striker.vy) > STOP_SPEED * 0.6) strikerPost.push(tokenCenter(striker));
        if (++postSteps >= POST_IMPACT_STEPS) done = true;
      }
      if (!still) done = true;
    }
    const struckEnemy = impact ? sim.tokens[impact.enemyIdx] : null;
    const pv = {
      valid: true, angle: v.angle, power: v.power,
      pre, impact, enemyPath, strikerPost, events,
      /* internal simulation results only (§ no result reveal): kept for the
         dev diagnostics log — the trajectory model and renderer never read
         them, so no aiming visual can depend on a predicted pit outcome */
      enemySunkPit: struckEnemy && struckEnemy.sunk ? struckEnemy.sunkPit : null,
      strikerSunkPit: sim.strikerSunk ? (striker.sunkPit || true) : null,
      segments: [], markers: [],
    };
    buildTrajectoryModel(pv);
    return pv;
  }
  /* ============================================================
     TRAJECTORY MODEL — one ordered list of role-tagged segments,
     built entirely from the EXACT contact events the shared swept
     physics emitted (§4). The renderer only walks this list; it
     never rediscovers paths, never estimates a bend. Between two
     contacts drag is a straight-line deceleration, so connecting
     launch point → each surface contact → path end IS the physics
     trajectory — no sampled-polyline angle heuristics anywhere.
     Roles: striker_incoming · striker_bank · enemy_output ·
            striker_deflection
     Invariant (§5/§12): a valid aim ALWAYS carries striker_incoming.
     Outcome blindness (§ no result reveal): the simulator still knows
     whether a token ends in a pit (pv.enemySunkPit / pv.strikerSunkPit —
     internal data), but NOTHING here may read it. The guide shows
     geometry only: identical roles, modes, lengths, trims and markers
     whether a shot would win, lose, or do nothing.
     ============================================================ */
  function buildTrajectoryModel(pv) {
    const segs = pv.segments, markers = pv.markers;
    const origin = pv.pre[0];                       // striker center at launch
    /* ---- striker pre-impact path: launch point through every exact bank
       surface contact (up to 4 bounces stay visible) to the token-to-token
       contact point or the final resting center — never a sprite rect ---- */
    const preBanks = [];
    for (const ev of pv.events) {
      if (ev.idx !== 0 || ev.phase !== 'pre' || ev.shape === 'token') continue;
      preBanks.push(ev);
      if (preBanks.length >= 4) break;
    }
    const preEnd = pv.impact ? pv.impact.contact : pv.pre[pv.pre.length - 1];
    const prePts = [{ x: origin.x, y: origin.y }];
    for (const bk of preBanks) prePts.push({ x: bk.x, y: bk.y });
    if (preEnd) prePts.push({ x: preEnd.x, y: preEnd.y });
    let preSegs = segmentsThroughPoints(prePts, 5);
    if (!preSegs.length) {
      /* immediate collision at launch leaves no path length — still show
         the direction the physics actually took; the guide never vanishes (§12) */
      let end = preEnd;
      if (!end || Math.hypot(end.x - origin.x, end.y - origin.y) < 2) {
        end = { x: origin.x + Math.cos(pv.angle) * TOKEN_RADIUS * 1.8, y: origin.y + Math.sin(pv.angle) * TOKEN_RADIUS * 1.8 };
      }
      preSegs = [{ x1: origin.x, y1: origin.y, x2: end.x, y2: end.y }];
      if (debugOn()) console.warn('[Castle Ricochet Aim] MISSING REQUIRED PRIMARY SEGMENT — rebuilt from physics', { origin, end });
    }
    /* start at the striker's disc edge — inset clamped so a short first
       segment can never reverse its direction (§8) */
    const s0 = preSegs[0];
    const a0 = Math.atan2(s0.y2 - s0.y1, s0.x2 - s0.x1);
    const inset = Math.min(TOKEN_RADIUS * 0.7, segLen(s0) * 0.35);
    s0.x1 += Math.cos(a0) * inset; s0.y1 += Math.sin(a0) * inset;
    preSegs.forEach((s, i) => {
      segs.push({
        role: i === 0 ? 'striker_incoming' : 'striker_bank',
        mode: 'primary_gold',
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, cap: i === 0, h: 46,
      });
    });
    /* wall/pillar contact markers centered on the exact surface contact the
       arrow joint sits on — overlays on the path, never substitutes (§19) */
    const nJoints = Math.min(preBanks.length, preSegs.length - 1, 3);
    for (let j = 0; j < nJoints; j++) {
      markers.push({
        name: preBanks[j].shape === 'round' ? 'aim_contact_pillar' : 'aim_contact_wall',
        x: preSegs[j].x2, y: preSegs[j].y2, w: 44,
      });
    }
    if (!pv.impact) return;
    /* ---- enemy outgoing path: start center → exact bounce contacts →
       final center. Always the same enemy_output art — whether the sim
       sinks the enemy is never revealed (§ no result reveal) ---- */
    let enSegs = [];
    if (pv.enemyPath.length) {
      const enPts = [{ x: pv.enemyPath[0].x, y: pv.enemyPath[0].y }];
      let nEn = 0;
      for (const ev of pv.events) {
        if (ev.idx !== pv.impact.enemyIdx || nEn >= 3) continue;
        enPts.push({ x: ev.x, y: ev.y }); nEn++;
      }
      const enLast = pv.enemyPath[pv.enemyPath.length - 1];
      enPts.push({ x: enLast.x, y: enLast.y });
      enSegs = segmentsThroughPoints(enPts, 3);
    }
    let enemyLen = 0;
    if (enSegs.length) {
      const e0 = enSegs[0];
      const ea = Math.atan2(e0.y2 - e0.y1, e0.x2 - e0.x1);
      const einset = Math.min(TOKEN_RADIUS * 0.8, segLen(e0) * 0.4);
      e0.x1 += Math.cos(ea) * einset; e0.y1 += Math.sin(ea) * einset;
      enSegs.forEach((s, i) => {
        enemyLen += segLen(s);
        segs.push({
          role: 'enemy_output', mode: 'enemy_output',
          x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, cap: i === 0, h: 46,
        });
      });
      if (enSegs.length > 1) markers.push({ name: 'aim_ricochet_joint', x: enSegs[0].x2, y: enSegs[0].y2, w: 34 });
    }
    /* ---- striker deflection: shorter and dimmer than the enemy arrow.
       ALWAYS trimmed by the same rule — a longer deflection arrow must
       never leak that the striker is pit-bound (§ no result reveal) ---- */
    let defSegs = [];
    if (pv.strikerPost.length) {
      const dfPts = [{ x: pv.strikerPost[0].x, y: pv.strikerPost[0].y }];
      let nDf = 0;
      for (const ev of pv.events) {
        if (ev.idx !== 0 || ev.phase !== 'post' || nDf >= 2) continue;
        dfPts.push({ x: ev.x, y: ev.y }); nDf++;
      }
      const dfLast = pv.strikerPost[pv.strikerPost.length - 1];
      dfPts.push({ x: dfLast.x, y: dfLast.y });
      defSegs = segmentsThroughPoints(dfPts, 2);
    }
    defSegs = trimSegments(defSegs, Math.max(90, enemyLen * 0.6));
    defSegs.forEach(s => segs.push({
      role: 'striker_deflection',
      mode: 'striker_deflection',
      x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, cap: false, h: 38,
    }));
    /* enemy contact marker rides on top of the already-drawn incoming tip */
    markers.push({ name: 'aim_contact_enemy', x: pv.impact.contact.x, y: pv.impact.contact.y, w: 46 });
  }
  /* Arrow Diagnostics (§22) — dev builds only, never production */
  function logAimDiagnostics(pv) {
    const hasIncoming = pv.segments.length && pv.segments[0].role === 'striker_incoming' && segLen(pv.segments[0]) > 0.5;
    if (!hasIncoming) console.error('[Castle Ricochet Aim] PRIMARY GOLD SEGMENT MISSING');
    let hasBlue = false;
    for (const s of pv.segments) if (s.mode === 'striker_deflection') hasBlue = true;
    if (hasBlue && !pv.impact) console.error('[Castle Ricochet Aim] BLUE DEFLECTION WITHOUT ENEMY COLLISION');
    if (hasBlue && !hasIncoming) console.error('[Castle Ricochet Aim] BLUE DEFLECTION WITHOUT PRIMARY GOLD');
    const notLoaded = [];
    for (const rel of mandatoryAimAssets()) if (!ready(rimg(rel))) notLoaded.push(rel);
    if (notLoaded.length) console.error('[Castle Ricochet Aim] MANDATORY GOLDEN ASSET UNAVAILABLE', notLoaded);
    console.log('[Castle Ricochet Aim]', {
      valid: pv.valid, segments: pv.segments.length, hasIncoming,
      shot: A ? 6 - A.shotsLeft : 0, session: A ? (A.aimSession || 0) : 0,
      pointerId: A && A.aim && A.aim.pid !== undefined ? A.aim.pid : null,
      previousCleared: !A || A.preview === null,
      firstCollision: pv.impact ? 'enemy' : pv.events.length ? (pv.events[0].shape === 'round' ? 'pillar' : 'wall') : pv.strikerSunkPit ? 'pit' : 'none',
      events: pv.events.map(ev => ({ idx: ev.idx, phase: ev.phase, shape: ev.shape, surface: [Math.round(ev.x), Math.round(ev.y)], center: [Math.round(ev.cx), Math.round(ev.cy)], normal: [+ev.nx.toFixed(3), +ev.ny.toFixed(3)] })),
      target: pv.impact ? pv.impact.enemyType : null,
      detail: pv.segments.map(s => ({
        role: s.role, mode: s.mode, len: Math.round(segLen(s)),
        from: [Math.round(s.x1), Math.round(s.y1)], to: [Math.round(s.x2), Math.round(s.y2)],
        rotation: +(Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180 / Math.PI).toFixed(1),
      })),
    });
  }
  /* §7 gate: a preview is renderable only when its FIRST segment is a real
     golden striker_incoming (finite endpoints, positive length) and no blue
     deflection exists without a predicted enemy collision. The renderer
     never sees anything that fails this. */
  function validPreview(pv) {
    if (!pv || !pv.segments || !pv.segments.length) return false;
    const s0 = pv.segments[0];
    if (s0.role !== 'striker_incoming' || s0.mode === 'striker_deflection') return false;
    if (!isFinite(s0.x1) || !isFinite(s0.y1) || !isFinite(s0.x2) || !isFinite(s0.y2)) return false;
    if (!(segLen(s0) > 0.5)) return false;
    if (!pv.impact) {
      for (const s of pv.segments) if (s.role === 'striker_deflection') return false;
    }
    return true;
  }
  /* cached + thresholded: recompute only on a meaningful aim change. The
     swap is atomic (§13): the next trajectory is fully built and validated
     before it replaces the visible one — never a half-built frame. A
     candidate that fails validation is discarded; the last complete valid
     preview of this drag stays visible instead (§8) — never the blue arrow. */
  function aimPreview(v) {
    const p = A.preview;
    if (p && Math.abs(p.angle - v.angle) < AIM_ANGLE_EPS && Math.abs(p.power - v.power) < AIM_POWER_EPS) return p;
    const next = computeAimPreview(v);
    if (debugOn()) logAimDiagnostics(next);
    if (!validPreview(next)) {
      if (debugOn()) console.error('[Castle Ricochet Aim] PRIMARY GOLD SEGMENT MISSING — preview rejected');
      return p && validPreview(p) ? p : null;
    }
    A.preview = next;
    return next;
  }

  /* ---------------- rendering ---------------- */
  function computeView() {
    const topL = Layout.cropTopL || 0;
    const availH = H - topL;
    const s = Math.min(W / BW, availH / BH);
    view = { s, ox: (W - BW * s) / 2, oy: topL + (availH - BH * s) / 2, topL };
  }
  function drawSpriteCentered(img, x, y, w) {
    if (!ready(img)) return false;
    const h = w * img.naturalHeight / img.naturalWidth;
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
    return true;
  }
  function drawTokenSprite(tk) {
    const file = tk.kind === 'player' ? 'token_player_royal_striker.png' : enemyDef(tk.typeId).file;
    const img = rimg('tokens/standardized_384/' + file);
    const dw = tk.r * 2 * 1.14;
    let scale = 1, alpha = 1, y = tk.y;
    if (tk.sunk) {                                            // shrink-into-pit animation
      const q = clamp(tk.sunkAnim / 0.4, 0, 1);
      scale = q; alpha = q; y += (1 - q) * 10;
      if (q <= 0) return;
    }
    ctx.globalAlpha = alpha;
    if (!drawSpriteCentered(img, tk.x, y - tk.r * 0.12, dw * scale)) {
      ctx.fillStyle = tk.kind === 'player' ? '#3f6fd0' : '#8a3535';
      ctx.beginPath(); ctx.arc(tk.x, y, tk.r * scale, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#e8d9a0'; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  /* the four metal hole rims — floor inlays, drawn straight after the board
     art and BEFORE the depth-sorted obstacles and tokens, so a token always
     rolls visibly OVER the rim (a rim can never hide a token, and nothing
     else on the board is ever hidden behind a rim). One sprite, four rects
     precomputed on MAP.pits: no per-frame geometry, no offscreen surface and
     no filter (§ GPU fence rule). */
  function drawHoleRims() {
    const img = rimg(RIM_SPRITE);
    if (!ready(img)) return;                     // board art alone, exactly as before
    for (const p of MAP.pits) ctx.drawImage(img, p.rimX, p.rimY, p.rimW, p.rimH);
  }
  function drawObstacleSprite(o) {
    if (o.broken || o.exploded) return;
    const def = OBSTACLES[o.kind];
    const img = rimg('obstacles/' + def.file);
    if (!ready(img)) {
      /* themed stand-in (§ fallback): rounded stone slab with border,
         never a bare gray rectangle or broken-image box */
      const hw = (def.cols[0].hw || def.cols[0].rx || 50), hh = (def.cols[0].hh || def.cols[0].ry || 30);
      const r = Math.min(12, hw, hh);
      ctx.beginPath();
      ctx.moveTo(o.x - hw + r, o.y - hh);
      ctx.arcTo(o.x + hw, o.y - hh, o.x + hw, o.y + hh, r);
      ctx.arcTo(o.x + hw, o.y + hh, o.x - hw, o.y + hh, r);
      ctx.arcTo(o.x - hw, o.y + hh, o.x - hw, o.y - hh, r);
      ctx.arcTo(o.x - hw, o.y - hh, o.x + hw, o.y - hh, r);
      ctx.closePath();
      ctx.fillStyle = 'rgba(64,58,52,.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(140,126,104,.9)'; ctx.lineWidth = 3;
      ctx.stroke();
      return;
    }
    const w = def.drawW, h = w * img.naturalHeight / img.naturalWidth;
    /* bottom-anchored on the footprint's lower edge so 3/4 depth reads right */
    ctx.drawImage(img, o.x - w / 2, o.y + footprintBottom(def) - h, w, h);
  }
  function sortYOf(e) {
    if (e.tk) return e.tk.y + e.tk.r * 0.5;
    return e.o.y + footprintBottom(OBSTACLES[e.o.kind]);
  }
  /* ============================================================
     TRAJECTORY ARROWS — every path segment is the supplied golden
     arrow sprite (star cap / stretchable shaft / fixed arrowhead),
     billiards-style. No dotted lines, no procedural paths, no new
     artwork. § no result reveal: only the geometry-role modes
     (primary_gold / enemy_output / striker_deflection) are ever
     drawn — the pack's sink_safe and danger outcome modes are
     intentionally unused so aiming never discloses a pit result.
     ============================================================ */
  /* ---- Professional Aim Arrow Pack (assets/castle_ricochet/aim/) ----
     Each arrow mode is assembled live from a FIXED start cap +
     TILED shaft + FIXED arrow head (per the pack manifest: never
     stretch the cap or head; thickness constant at every length). */
  const aimModeImg = (mode, piece) => rimg('aim/modular/' + mode + '/aim_' + mode + '_' + piece + '.png');
  const aimMarkerImg = name => rimg('aim/markers/' + name + '.png');
  /* one arrow from (x1,y1) to (x2,y2) in the given mode.
     §8 short-segment ladder: full cap+shaft+head → shaft shrinks away →
     cap and head shrink together → cap drops, a minimum-readable head
     stays pinned to the tip (slight controlled overlap allowed). A
     segment is never skipped for being short; only a degenerate point
     (no direction to orient) draws nothing. */
  function drawArrowSegment(x1, y1, x2, y2, o) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.5) return;                         // degenerate point, not a path
    const mode = o.mode || 'primary_gold';
    const cap = aimModeImg(mode, 'start_cap');     // 96×96
    const shaft = aimModeImg(mode, 'shaft_tile');  // 128×48
    const head = aimModeImg(mode, 'arrow_head');   // 128×96
    /* attempts are gated on the full pack (§3); this only guards dev reloads */
    if (!(ready(cap) && ready(shaft) && ready(head))) {
      if (debugOn()) console.error('[Castle Ricochet Aim] MANDATORY ARROW ASSET NOT LOADED', mode);
      return;
    }
    ctx.save();
    ctx.translate(x1, y1);
    ctx.rotate(Math.atan2(y2 - y1, x2 - x1));      // rotate about the segment start (§10)
    ctx.globalAlpha = o.alpha !== undefined ? o.alpha : 1;
    const H = o.h || 46, sc = H / 96;
    let capW = o.cap ? 96 * sc : 0, headW = 128 * sc;
    if (capW + headW > len * 0.92) {               // shaft is gone: shrink cap+head together
      const q = (len * 0.92) / (capW + headW);
      capW *= q; headW *= q;
    }
    const MIN_HEAD_W = 20;                         // smallest readable arrowhead (board px)
    if (headW < MIN_HEAD_W) {
      capW = 0;                                    // extremely short: head only, tip on the endpoint
      headW = Math.min(MIN_HEAD_W, Math.max(len * 1.25, 12));  // ≤25% controlled overlap past the start
    }
    const shaftLen = Math.max(0, len - capW - headW);
    const k = Math.min(1, headW / (128 * sc));     // shrunk pieces keep their aspect + shared thickness
    const shaftH = 48 * sc * k, tileW = 128 * sc;
    if (shaftLen >= 1) {                           // tiled shaft (crisp at any length — never stretched)
      ctx.save();
      ctx.beginPath(); ctx.rect(capW - 1, -shaftH / 2, shaftLen + 2, shaftH); ctx.clip();
      for (let tx = capW - 1; tx < capW + shaftLen + 1; tx += tileW) {
        ctx.drawImage(shaft, tx, -shaftH / 2, tileW, shaftH);
      }
      ctx.restore();
    }
    if (capW > 4) ctx.drawImage(cap, 0, -capW / 2, capW, capW);          // cap art is square
    const headH = headW * 96 / 128;
    ctx.drawImage(head, len - headW, -headH / 2, headW, headH);          // head pinned to the tip
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  function drawAimMarker(name, x, y, w, alpha) {
    const img = aimMarkerImg(name);
    if (!ready(img)) return;
    ctx.globalAlpha = alpha !== undefined ? alpha : 1;
    ctx.drawImage(img, x - w / 2, y - w / 2, w, w);
    ctx.globalAlpha = 1;
  }
  /* ordered EXACT path points (launch → contact events → end) -> arrow
     segments. This replaced the old sampled-polyline bend detection
     (7 px dedupe + 9° angle threshold), which was why arrows used to bend
     a few px before/away from the obstacle surface: bends now come only
     from physics contact events, so a joint can only sit ON a surface.
     Points closer than 6 px merge (later point wins — it is the exact
     surface/end point); the final endpoint is always kept. */
  function segmentsThroughPoints(pts, maxSegs) {
    const P = [];
    for (const p of pts) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      if (!P.length || Math.hypot(p.x - P[P.length - 1].x, p.y - P[P.length - 1].y) >= 6) P.push({ x: p.x, y: p.y });
      else { P[P.length - 1].x = p.x; P[P.length - 1].y = p.y; }
    }
    const segs = [];
    for (let i = 1; i < P.length && segs.length < maxSegs; i++) {
      segs.push({ x1: P[i - 1].x, y1: P[i - 1].y, x2: P[i].x, y2: P[i].y });
    }
    return segs;
  }
  function segLen(s) { return Math.hypot(s.x2 - s.x1, s.y2 - s.y1); }
  function trimSegments(segs, maxLen) {
    const out = [];
    let used = 0;
    for (const s of segs) {
      const l = segLen(s);
      if (used + l <= maxLen) { out.push(s); used += l; continue; }
      const keep = maxLen - used;
      if (keep > 24) {
        const q = keep / l;
        out.push({ x1: s.x1, y1: s.y1, x2: s.x1 + (s.x2 - s.x1) * q, y2: s.y1 + (s.y2 - s.y1) * q });
      }
      break;
    }
    return out;
  }
  function drawAimArrow() {
    const v = aimVector();
    if (v.pull < MIN_PULL) return;                  // below the minimum valid shot: no guide
    const striker = A.sim.tokens[0];
    const pv = aimPreview(v);                       // cloned-physics prediction (cached, atomic, validated)
    if (!pv || !pv.segments.length) return;         // no valid preview yet: draw nothing, never a fallback arrow
    const norm = v.pull / MAX_PULL;
    const power = 0.6 + 0.4 * norm;                 // glow/alpha grow with pull, thickness never
    /* ONE ordered pass over the trajectory model (§14):
       power glow → striker arrows → enemy arrows → deflection →
       contact markers → (dev) debug overlay.
       § no result reveal: every input to this pass is pure geometry — no
       branch anywhere below reads a predicted pit outcome, so the guide
       looks identical for winning, losing and neutral shots. */
    /* 1. power glow behind the start cap: three discrete levels by pull */
    const first = pv.segments[0];
    const glowLevel = norm < 0.45 ? 1 : norm < 0.8 ? 2 : 3;
    const glowImg = rimg('aim/power/aim_primary_gold_power_glow_' + glowLevel + '.png');
    if (ready(glowImg)) {
      const gw = 54 + glowLevel * 10;
      ctx.globalAlpha = 0.85;
      ctx.drawImage(glowImg, first.x1 - gw / 2, first.y1 - gw / 2, gw, gw);
      ctx.globalAlpha = 1;
    }
    /* 2. every arrow segment, in model order — the golden incoming arrow is
       always segments[0], so it can never be suppressed by a later branch */
    for (const s of pv.segments) {
      let alpha, mode;
      if (s.role === 'striker_incoming' || s.role === 'striker_bank') {
        /* hard rule: the striker's primary path renders ONLY the golden art —
           no other mode can ever leak onto it, whatever upstream tagging
           produced (§ no blue primary, § no result reveal) */
        mode = 'primary_gold';
        alpha = power;
      } else if (s.role === 'enemy_output') {
        mode = 'enemy_output';
        alpha = 1;                                  // headline prediction: brightest
      } else {
        mode = 'striker_deflection';
        alpha = 0.6;                                // deflection: dimmer
      }
      drawArrowSegment(s.x1, s.y1, s.x2, s.y2, { cap: s.cap, h: s.h, mode, alpha });
    }
    /* 3. contact markers — overlays on the arrows beneath them, never a
       substitute for a path (§19) */
    for (const m of pv.markers) drawAimMarker(m.name, m.x, m.y, m.w);
    /* trajectory debug overlay (window.RICO_DEBUG, dev builds only): every
       exact contact event — token disc at impact, surface contact cross,
       normal, and the epsilon restart point — makes any residual gap's
       origin (collider vs contact vs rendering) immediately visible */
    if (debugOn()) {
      for (const ev of pv.events) {
        ctx.strokeStyle = ev.idx === 0 ? 'rgba(120,255,160,.85)' : 'rgba(255,200,80,.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(ev.cx, ev.cy, TOKEN_RADIUS, 0, TAU); ctx.stroke();   // center at impact
        ctx.lineWidth = 2;
        ctx.beginPath();                                                              // surface contact cross
        ctx.moveTo(ev.x - 6, ev.y - 6); ctx.lineTo(ev.x + 6, ev.y + 6);
        ctx.moveTo(ev.x - 6, ev.y + 6); ctx.lineTo(ev.x + 6, ev.y - 6);
        ctx.stroke();
        if (ev.nx || ev.ny) {                                                         // surface normal
          ctx.beginPath(); ctx.moveTo(ev.x, ev.y);
          ctx.lineTo(ev.x + ev.nx * 40, ev.y + ev.ny * 40); ctx.stroke();
          ctx.fillStyle = 'rgba(255,120,120,.95)';                                    // epsilon restart (internal)
          ctx.beginPath(); ctx.arc(ev.cx + ev.nx * COLLISION_EPSILON, ev.cy + ev.ny * COLLISION_EPSILON, 2.5, 0, TAU); ctx.fill();
        }
      }
    }
    if (pv.impact) {
      /* trajectory debug overlay — never in production */
      if (debugOn()) {
        const im = pv.impact;
        ctx.strokeStyle = 'rgba(120,255,160,.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(im.strikerAt.x, im.strikerAt.y, striker.r, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(im.contact.x, im.contact.y);
        ctx.lineTo(im.contact.x + im.normal.x * 60, im.contact.y + im.normal.y * 60); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,120,255,.9)';
        ctx.beginPath(); ctx.moveTo(im.contact.x, im.contact.y);
        ctx.lineTo(im.contact.x + im.enemyVel.x * 0.12, im.contact.y + im.enemyVel.y * 0.12); ctx.stroke();
        ctx.strokeStyle = 'rgba(120,200,255,.9)';
        ctx.beginPath(); ctx.moveTo(im.strikerAt.x, im.strikerAt.y);
        ctx.lineTo(im.strikerAt.x + im.strikerVel.x * 0.12, im.strikerAt.y + im.strikerVel.y * 0.12); ctx.stroke();
      }
    }
  }
  /* ---- HUD frame metrics, measured from the shipped art ----
     The reward frame carries a BAKED example value ("0"): that region is
     repainted with a matching dark panel fill at load (pure canvas
     composition, no pixel readback — safe under file:// on Android), and
     the live value is drawn in its place. The enemies-sunk frame's baked
     "0 /3" was inpainted out of the PNG itself (rv=6), so its art is
     drawn as-is and the live text centres on the window (textCX/CY =
     centre of the recessed panel, x132-372 / y66-138; drawn with
     textBaseline 'middle', unlike the reward's baseline metric). */
  const HUD_SPRITES = {
    shots: { file: 'ui_hud_shots_left.png', w: 445, h: 190,
      sockets: [[76, 109], [150, 109], [224, 109], [298, 109], [371, 109]], socketR: 25 },
    reward: { file: 'ui_hud_reward.png', w: 278, h: 204, panelH: 162,
      patch: { x: 138, y: 66, w: 102, h: 84 }, textCX: 189, textCY: 120 },
    enemies: { file: 'ui_hud_enemies_sunk.png', w: 416, h: 178,
      textCX: 252, textCY: 102 },
  };
  const CLEANED = {};
  function cleanedFrame(key) {
    if (CLEANED[key]) return CLEANED[key];
    const spec = HUD_SPRITES[key];
    const img = rimg('ui/' + spec.file);
    if (!ready(img)) return null;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    if (spec.patch) {
      const p = spec.patch, r = 10;
      const grad = g.createLinearGradient(0, p.y, 0, p.y + p.h);
      grad.addColorStop(0, '#141417');
      grad.addColorStop(0.5, '#1f1f23');
      grad.addColorStop(1, '#28282c');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(p.x + r, p.y);
      g.arcTo(p.x + p.w, p.y, p.x + p.w, p.y + p.h, r);
      g.arcTo(p.x + p.w, p.y + p.h, p.x, p.y + p.h, r);
      g.arcTo(p.x, p.y + p.h, p.x, p.y, r);
      g.arcTo(p.x, p.y, p.x + p.w, p.y, r);
      g.closePath();
      g.fill();
    }
    CLEANED[key] = c;
    return c;
  }
  function drawHUD() {
    const topL = view.topL || 0;
    const M = 10, GAP = 8, HH = 72;                     // uniform HUD row height
    /* ---- shots left (top-left): baked sockets ARE the pips; used shots dim,
       consumed from the right so the row empties toward the pause corner ---- */
    const shSpec = HUD_SPRITES.shots;
    const shImg = cleanedFrame('shots');
    const sw2 = HH * shSpec.w / shSpec.h, sx = M, sy = topL + M;
    if (shImg) {
      ctx.drawImage(shImg, sx, sy, sw2, HH);
      const sc = HH / shSpec.h;
      const used = 5 - A.shotsLeft;
      for (let i = 0; i < used; i++) {
        const sk = shSpec.sockets[4 - i];               // rightmost socket dims first
        ctx.fillStyle = 'rgba(8,8,12,.72)';
        ctx.beginPath();
        ctx.arc(sx + sk[0] * sc, sy + sk[1] * sc, shSpec.socketR * sc, 0, TAU);
        ctx.fill();
      }
    } else hudText('Shots: ' + A.shotsLeft + '/5', sx + 8, sy + 26);
    /* ---- right cluster (pause · enemies sunk · reward), one aligned row ---- */
    const pw = 52;
    const px = W - M - pw, py = topL + M + (HH - pw) / 2;
    A.pauseBtn = { x: px - 8, y: py - 8, w: pw + 16, h: pw + 16 };
    /* the shared pause crest is drawn to the exact visible footprint of the
       retired ui_button_pause.png: that sprite's ink filled 118×120 of its
       134px canvas, i.e. inset 8/134 inside the pw slot. Containing the
       trimmed crest in that same box keeps the HUD corner from growing or
       shifting; A.pauseBtn (the hit area) is untouched either way. */
    const pauseImg = rimg('ui/ui_pause_icon.png');
    const pInset = pw * 8 / 134, pInkH = pw * 120 / 134;
    const pInkW = ready(pauseImg) ? pInkH * pauseImg.naturalWidth / pauseImg.naturalHeight : pw * 118 / 134;
    drawHudImg(pauseImg, px + (pw - pInkW) / 2, py + pInset, pInkW);
    const enSpec = HUD_SPRITES.enemies;
    const enImg = cleanedFrame('enemies');
    const ew = HH * enSpec.w / enSpec.h, ex = px - GAP - ew, ey = topL + M;
    if (enImg) {
      ctx.drawImage(enImg, ex, ey, ew, HH);
      const sc = HH / enSpec.h;
      ctx.font = 'bold ' + Math.round(58 * sc) + 'px Georgia';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';                      // true vertical centring in the window
      const n = String(A.sim ? A.sim.sunkCount : 0);
      const cx2 = ex + enSpec.textCX * sc, cy2 = ey + enSpec.textCY * sc;
      const numW = ctx.measureText(n).width, restW = ctx.measureText(' / 3').width;
      const startX = cx2 - (numW + restW) / 2;
      ctx.fillStyle = '#f5c542';
      ctx.fillText(n, startX + numW / 2, cy2);          // gold count, matching the frame's own style
      ctx.fillStyle = '#f0eee8';
      ctx.fillText(' / 3', startX + numW + restW / 2, cy2);
      ctx.textBaseline = 'alphabetic';
    } else hudText('Sunk ' + (A.sim ? A.sim.sunkCount : 0) + '/3', ex, ey + 24);
    const rwSpec = HUD_SPRITES.reward;
    const rwImg = cleanedFrame('reward');
    /* scaled so the PANEL body (not the hanging gem) matches the row height */
    const rh2 = HH * rwSpec.h / rwSpec.panelH;
    const rw2 = rh2 * rwSpec.w / rwSpec.h;
    const rx = ex - GAP - rw2, ry = topL + M;
    if (rwImg) {
      ctx.drawImage(rwImg, rx, ry, rw2, rh2);
      const sc = rh2 / rwSpec.h;
      const txt = A.pendingCoins.toLocaleString();
      let fs = Math.round(52 * sc);
      ctx.font = 'bold ' + fs + 'px Georgia';
      const maxW = rwSpec.patch.w * sc * 0.94;          // "1,500" must fit the cleaned panel
      while (fs > 12 && ctx.measureText(txt).width > maxW) {
        fs -= 2; ctx.font = 'bold ' + fs + 'px Georgia';
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f0eee8';
      ctx.fillText(txt, rx + rwSpec.textCX * sc, ry + rwSpec.textCY * sc);
    } else hudText('+' + A.pendingCoins, rx, ry + 24);
    ctx.textAlign = 'left';
  }
  function drawHudImg(img, x, y, w) {
    if (!ready(img)) return false;
    ctx.drawImage(img, x, y, w, w * img.naturalHeight / img.naturalWidth);
    return true;
  }
  function hudText(txt, x, y) {
    ctx.font = 'bold 20px Georgia'; ctx.fillStyle = '#ffe9b0';
    ctx.strokeStyle = 'rgba(20,16,12,.9)'; ctx.lineWidth = 3;
    ctx.strokeText(txt, x, y); ctx.fillText(txt, x, y);
  }
  function drawTutorial() {
    const step = A.tut;
    const striker = A.sim.tokens[0];
    ctx.save();
    ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s);
    /* highlights on the real board */
    const ring = (x, y, r, color) => {
      const pulse = 1 + Math.sin(performance.now() / 220) * 0.08;
      ctx.strokeStyle = color; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(x, y, r * pulse, 0, TAU); ctx.stroke();
    };
    if (step <= 1) ring(striker.x, striker.y, striker.r * 1.8, 'rgba(255,214,74,.95)');
    if (step === 1) {                                        // demo arrow
      ctx.save();
      ctx.translate(striker.x, striker.y); ctx.rotate(-Math.PI / 3);
      ctx.strokeStyle = 'rgba(255,214,74,.9)'; ctx.lineWidth = 10; ctx.lineCap = 'round';
      const l = 180 + Math.sin(performance.now() / 300) * 70;
      ctx.beginPath(); ctx.moveTo(40, 0); ctx.lineTo(l, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(l + 26, 0); ctx.lineTo(l - 6, -16); ctx.lineTo(l - 6, 16); ctx.closePath();
      ctx.fillStyle = 'rgba(255,214,74,.9)'; ctx.fill();
      ctx.restore();
    }
    if (step === 3) {
      const en = A.sim.tokens[1];
      if (en && !en.sunk) ring(en.x, en.y, en.r * 1.8, 'rgba(255,120,90,.95)');
      const p = MAP.pits[0];
      ring(p.cx, p.cy, p.rx, 'rgba(120,215,255,.95)');
    }
    if (step === 4) for (const p of MAP.pits) ring(p.cx, p.cy, p.rx, 'rgba(255,90,70,.95)');
    ctx.restore();
    /* text panel — sized from the wrapped result, never a fixed height.
       The step strings are short enough for two lines today, but Georgia does
       not exist on Android (the WebView falls back to a serif with its own
       metrics) and copy changes: a third line has to grow the box rather than
       spill over the footer and out of the frame. */
    const topL = view.topL || 0;
    const pw2 = Math.min(760, W - 60);
    const textW = pw2 - (step === 4 ? 220 : 60);
    ctx.font = 'bold 24px Georgia';
    const tutLines = wrapLines(TUT_STEPS[step], textW);
    const ph = Math.max(118, 88 + (tutLines.length - 1) * 30);
    const px = (W - pw2) / 2, py = Math.max(topL + 10, H - ph - 26);
    ctx.fillStyle = 'rgba(16,14,20,.88)';
    ctx.strokeStyle = 'rgba(201,169,74,.9)'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(px, py, pw2, ph); ctx.fill(); ctx.stroke();
    if (step === 4) {
      const wimg = rimg('ui/ui_warning_player_token_game_over.png');
      if (ready(wimg)) drawHudImg(wimg, px + 12, py + ph / 2 - 42, 170);
    }
    ctx.font = 'bold 24px Georgia'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffe9b0';
    drawLines(tutLines, W / 2 + (step === 4 ? 70 : 0), py + 46, 30);
    ctx.font = '16px Georgia'; ctx.fillStyle = '#c9b98f';
    ctx.fillText('Step ' + (step + 1) + ' of ' + TUT_STEPS.length + ' — tap to continue', W / 2, py + ph - 16);
    ctx.textAlign = 'left';
  }
  /* wrap and draw are split so a caller can size its box from the line count
     BEFORE anything is painted. Set ctx.font first: measurement uses it. */
  function wrapLines(text, maxW) {
    const words = text.split(' ');
    let line = '', lines = [];
    for (const w2 of words) {
      const test = line ? line + ' ' + w2 : w2;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w2; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function drawLines(lines, cx, y, lh) {
    lines.forEach((l, i) => ctx.fillText(l, cx, y + i * lh));
  }

  function render() {
    computeView();
    /* darkened extension behind the letterboxed board (never crop the board) */
    ctx.fillStyle = '#0d0b09';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.s, view.s);
    const bg = rimg('backgrounds/castle_ricochet_board_01.png');
    if (ready(bg)) ctx.drawImage(bg, 0, 0, bg.naturalWidth, bg.naturalHeight, 0, 0, BW, BH);
    else { ctx.fillStyle = '#3a3630'; ctx.fillRect(0, 0, BW, BH); }
    drawHoleRims();
    if (A && A.sim) {
      /* striker pit-danger flash */
      if (A.dangerT > 0 && A.phase === 'moving') {
        const striker = A.sim.tokens[0];
        ctx.strokeStyle = 'rgba(255,70,50,' + (0.5 + Math.sin(performance.now() / 90) * 0.3) + ')';
        ctx.lineWidth = 7;
        ctx.beginPath(); ctx.arc(striker.x, striker.y, striker.r + 12, 0, TAU); ctx.stroke();
      }
      /* depth sort: obstacles + tokens by ground-contact Y */
      const ents = [];
      for (const o of A.sim.obs) ents.push({ o });
      for (const tk of A.sim.tokens) { if (!tk.sunk || tk.sunkAnim > 0) ents.push({ tk }); }
      ents.sort((a, b) => sortYOf(a) - sortYOf(b));
      for (const e of ents) {
        if (e.tk) {
          /* soft contact shadow */
          if (!e.tk.sunk) {
            ctx.fillStyle = 'rgba(10,8,6,.35)';
            ctx.beginPath(); ctx.ellipse(e.tk.x, e.tk.y + e.tk.r * 0.72, e.tk.r * 0.95, e.tk.r * 0.38, 0, 0, TAU); ctx.fill();
          }
          drawTokenSprite(e.tk);
        } else drawObstacleSprite(e.o);
      }
      /* aim affordance: the striker is the interactive piece — ring it while
         waiting for input (brighter when the pointer hovers over it) */
      if (A.phase === 'aim' && !A.aim) {
        const striker = A.sim.tokens[0];
        if (!striker.sunk) {
          const hovering = A.hover && Math.hypot(A.hover.x - striker.x, A.hover.y - striker.y) <= striker.r * 3.0;
          const pulse = 1 + Math.sin(performance.now() / 260) * 0.08;
          ctx.strokeStyle = hovering ? 'rgba(255,230,120,.95)' : 'rgba(255,214,74,.55)';
          ctx.lineWidth = hovering ? 6 : 4;
          ctx.beginPath(); ctx.arc(striker.x, striker.y, striker.r * 1.55 * pulse, 0, TAU); ctx.stroke();
        }
      }
      /* aim */
      if (A.phase === 'aim' && A.aim) drawAimArrow();
      /* effects */
      for (const p of A.fx) {
        ctx.globalAlpha = clamp(p.t / p.max, 0, 1);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6 * (0.4 + 0.6 * p.t / p.max), 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
      for (const f of A.floats) {
        ctx.globalAlpha = clamp(f.t, 0, 1);
        ctx.font = 'bold 34px Georgia'; ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(20,16,12,.9)'; ctx.lineWidth = 5;
        ctx.strokeText(f.text, f.x, f.y);
        ctx.fillStyle = '#ffd24a'; ctx.fillText(f.text, f.x, f.y);
        ctx.textAlign = 'left';
      }
      ctx.globalAlpha = 1;
      /* map calibration + collider-alignment overlay — dev only, never in
         production builds. Colors: gray = full PNG rect as drawn · cyan =
         visible artwork alpha bounds · red = physics/trajectory collider
         (they are the same data) · yellow = anchor · orange = depth-sort /
         ground-contact line. */
      if (debugOn()) {
        ctx.strokeStyle = 'rgba(90,220,120,.9)'; ctx.lineWidth = 3;
        const b = MAP.bounds;
        ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        /* pits: cyan = the rim's drawn OPENING · magenta = the sink trigger
           (the same ellipse inset by SINK_INSET) · gray = the rim image rect.
           If cyan does not hug the metal inner edge on screen, the rim art and
           the physics have drifted apart and MAP.pits is what to fix. */
        for (const p of MAP.pits) {
          ctx.strokeStyle = 'rgba(170,170,170,.45)';
          ctx.strokeRect(p.rimX, p.rimY, p.rimW, p.rimH);
          ctx.strokeStyle = 'rgba(120,200,255,.9)';
          ctx.beginPath(); ctx.ellipse(p.cx, p.cy, p.rx, p.ry, 0, 0, TAU); ctx.stroke();
          ctx.strokeStyle = 'rgba(255,80,220,.9)';
          ctx.beginPath(); ctx.ellipse(p.cx, p.cy, p.sinkRX, p.sinkRY, 0, 0, TAU); ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(120,200,255,.9)';
        ctx.lineWidth = 2;
        for (const o of A.sim.obs) {
          if (o.broken || o.exploded) continue;
          const def = OBSTACLES[o.kind];
          const img = rimg('obstacles/' + def.file);
          if (ready(img)) {
            const w = def.drawW, h = w * img.naturalHeight / img.naturalWidth;
            const ix = o.x - w / 2, iy = o.y + footprintBottom(def) - h;
            ctx.strokeStyle = 'rgba(170,170,170,.7)';
            ctx.strokeRect(ix, iy, w, h);                       // full PNG image bounds
            const ab = artBounds(img);
            if (ab) {                                           // visible artwork bounds
              const sc = w / img.naturalWidth;
              ctx.strokeStyle = 'rgba(80,220,255,.85)';
              ctx.strokeRect(ix + ab.x0 * sc, iy + ab.y0 * sc, (ab.x1 - ab.x0 + 1) * sc, (ab.y1 - ab.y0 + 1) * sc);
            }
          }
          /* anchor + ground-contact/depth-sort line */
          ctx.strokeStyle = 'rgba(255,220,60,.95)';
          ctx.beginPath(); ctx.moveTo(o.x - 8, o.y); ctx.lineTo(o.x + 8, o.y);
          ctx.moveTo(o.x, o.y - 8); ctx.lineTo(o.x, o.y + 8); ctx.stroke();
          const fb = o.y + footprintBottom(def);
          ctx.strokeStyle = 'rgba(255,160,60,.95)';
          ctx.beginPath(); ctx.moveTo(o.x - 20, fb); ctx.lineTo(o.x + 20, fb); ctx.stroke();
        }
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,120,120,.9)';
        for (const o of A.sim.obs) for (const c of obstacleColliders(o)) {
          if (c.t === 'circle') { ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, TAU); ctx.stroke(); }
          else if (c.t === 'ellipse') { ctx.beginPath(); ctx.ellipse(c.x, c.y, c.rx, c.ry, 0, 0, TAU); ctx.stroke(); }
          else if (c.t === 'rect') ctx.strokeRect(c.x - c.hw, c.y - c.hh, c.hw * 2, c.hh * 2);
          else { ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke(); }
        }
        ctx.strokeStyle = 'rgba(255,255,120,.9)';
        for (const tk of A.sim.tokens) if (!tk.sunk) { ctx.beginPath(); ctx.arc(tk.x, tk.y, tk.r, 0, TAU); ctx.stroke(); }
      }
    }
    ctx.restore();
    /* screen-space layers */
    if (A && A.phase === 'loading') {
      const logo = rimg('ui/ui_logo_castle_ricochet.png');
      if (ready(logo)) drawHudImg(logo, W / 2 - 160, H / 2 - 140, 320);
      ctx.font = 'bold 24px Georgia'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffe9b0';
      ctx.fillText('Preparing the courtyard…', W / 2, H / 2 + 90);
      ctx.textAlign = 'left';
    } else if (A && A.sim) {
      drawHUD();
      if (A.phase === 'tutorial') drawTutorial();
      /* until the first shot of the attempt: spell out how to start.
         Drawn on a dark pill so it never fights the board art behind it. */
      else if (A.phase === 'aim' && !A.aim && !A.firstShotTaken) {
        const hint = 'Drag backward from your Royal Striker to aim';
        ctx.font = 'bold 21px Georgia';
        const tw = ctx.measureText(hint).width;
        const ph = 40, pw2 = tw + 46, px2 = (W - pw2) / 2, py2 = H - ph - 14, r = ph / 2;
        ctx.fillStyle = 'rgba(14,12,18,.82)';
        ctx.strokeStyle = 'rgba(201,169,74,.75)'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px2 + r, py2);
        ctx.arcTo(px2 + pw2, py2, px2 + pw2, py2 + ph, r);
        ctx.arcTo(px2 + pw2, py2 + ph, px2, py2 + ph, r);
        ctx.arcTo(px2, py2 + ph, px2, py2, r);
        ctx.arcTo(px2, py2, px2 + pw2, py2, r);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffe9b0';
        ctx.fillText(hint, W / 2, py2 + 27);
        ctx.textAlign = 'left';
      }
    }
  }

  /* one call from the main game loop per frame while the mode owns the screen */
  function frame(dt) { update(dt); render(); }

  /* ============================================================
     MENU INTEGRATION (button + once-per-second countdown)
     ============================================================ */
  let menuTimer = null;
  /* The menu entry is the logo button with a compact countdown beneath it, so
     the chip carries the availability line only and keeps it to one line. The
     cost / reward detail moved to the button's tooltip; freeAvailable() and
     cooldownText() are untouched, so the timing itself is unchanged. */
  function updateMenuButton() {
    const el = $('ricochetStatus');
    if (!el) return;
    const ready = freeAvailable();
    el.textContent = ready ? 'Available now' : 'Available in ' + cooldownText();
    el.classList.toggle('ricoReady', ready);
    const btn = $('btnRicochet');
    if (btn) {
      btn.setAttribute('data-tip', 'Castle Ricochet — bank your Royal Striker off castle obstacles and knock ' +
        'enemy tokens into the pits. ' + (ready ? 'Free attempt available now — up to 1,500 Coins!' :
        'Next free attempt in ' + cooldownText() + ', or play now for 20 Crowns.'));
    }
  }
  function updateCountdownLabels() {
    updateMenuButton();
    const rc = $('ricoResultNext');
    if (rc) rc.textContent = freeAvailable() ? 'Free attempt: AVAILABLE NOW' : 'Free attempt: AVAILABLE IN ' + cooldownText();
  }
  function onScreenChange(id) {
    const needsTimer = id === 'menuScreen' || id === 'ricochetResultScreen';
    if (needsTimer && !menuTimer) menuTimer = setInterval(() => {
      if (document.hidden) return;                            // no work while backgrounded
      updateCountdownLabels();
    }, 1000);
    if (!needsTimer && menuTimer) { clearInterval(menuTimer); menuTimer = null; }
    if (needsTimer) updateCountdownLabels();
  }

  /* ---------------- wiring (buttons exist in index.html) ---------------- */
  function init() {
    bootCheck();
    initInput();
    $('btnRicochet').addEventListener('click', () => { Sfx.unlock(); Sfx.ui(); open(); });
    $('btnRicoResume').addEventListener('click', () => { Sfx.ui(); resumeRico(); });
    $('btnRicoHowTo').addEventListener('click', () => { Sfx.ui(); openHowTo('ricochetPause'); });
    $('btnRicoSettings').addEventListener('click', () => { Sfx.ui(); openSettings('ricochetPause'); });
    $('btnRicoAbandon').addEventListener('click', () => { Sfx.ui(); abandonRico(); });
    $('btnRicoPlayAgain').addEventListener('click', () => { Sfx.ui(); if (state === 'ricochetResult') offerPaidAttempt(); });
    $('btnRicoHome').addEventListener('click', () => { Sfx.ui(); closeToMenu(); });
    /* game.js booted (and showed the menu) before this file was parsed —
       sync the menu chip/countdown for the screen we are already on */
    onScreenChange(state === 'menu' ? 'menuScreen' : null);
  }

  const api = {
    isActive, frame, open, handleBack, lifecyclePause, onScreenChange,
    updateMenuButton, init, replayTutorialNextAttempt,
    pauseScreenId: 'ricochetPauseScreen',
  };
  if (!(window.BUILD_CONFIG && BUILD_CONFIG.isProduction)) {
    api._test = { MAP, TEMPLATES, OBSTACLES, generateLayout, solveLayout, layoutFromTemplate, simulateShot, buildSim, stepSim, cloneSim, hashSeed, mulberry32, rico, firstShotTolerant, getAttempt: () => A, getView: () => view, computeAimPreview: v => computeAimPreview(v), findNearestTokenCollision, obstacleColliders, collideCollider, segmentsThroughPoints, COLLISION_EPSILON, TOKEN_RADIUS, PHYSICS_STEP, RIM_GEO, RIM_SPRITE, SINK_INSET, footprintBottom };
  }
  return api;
})();

CastleRicochet.init();
