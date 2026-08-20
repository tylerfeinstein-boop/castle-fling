'use strict';
/* ============================================================
   CASTLE FLING — a physics castle-defense roguelite
   Vanilla JS + Canvas. No external assets required.
   ============================================================ */

/* ---------------- tiny helpers ---------------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const choice = arr => arr[Math.floor(Math.random() * arr.length)];
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
const TAU = Math.PI * 2;

/* ============================================================
   CRASH DIAGNOSTICS (Galaxy S20 FE closed-test investigation)
   Release-safe rolling log of the last ~100 MEANINGFUL events
   (screen changes, waves, taps, lifecycle edges, errors) —
   never per-frame. Persisted to localStorage so a hard crash
   or renderer kill leaves a readable trail for the next boot,
   and mirrored to Android Logcat through the native bridge
   (window.CastleFlingDiagnostics, attached by MainActivity).
   ============================================================ */
const CrashDiagnostics = (() => {
  const EVENTS_KEY = 'castlefling_diag_events_v1';
  const SESSION_KEY = 'castlefling_diag_session_v1';
  const CRASH_KEY = 'castlefling_diag_lastcrash_v1';
  const MAX_EVENTS = 100;
  let events = [];
  const session = {
    startedAt: Date.now(),
    closedCleanly: false,
    lastScreen: null, lastWave: null, lastAction: null,
    rendererRecovered: false,
  };

  /* boot-time: did the PREVIOUS session end without a clean close?
     If so, preserve its final event trail before this session overwrites it. */
  let previousCrash = null;
  try {
    const prev = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (prev && prev.closedCleanly === false) {
      previousCrash = { session: prev, events: JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]') };
      localStorage.setItem(CRASH_KEY, JSON.stringify(previousCrash));
    } else {
      previousCrash = JSON.parse(localStorage.getItem(CRASH_KEY) || 'null');
    }
  } catch (e) { /* diagnostics must never block boot */ }

  /* game state may not exist yet while booting (let-declared below) —
     capture defensively, never throw from inside the logger */
  function ctxNow() {
    const c = {};
    try { c.state = state; } catch (e) {}
    try { if (G && G.wave) c.wave = G.wave; } catch (e) {}
    try { if (G && G.nightmare) c.nightmare = true; } catch (e) {}
    return c;
  }
  function persist() {
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) { /* storage full / unavailable: keep the in-memory log */ }
  }
  /* Which build produced this report. The native bridge value is authoritative
     (it comes from the package manager); WEB_BUILD covers web/desktop and any
     boot where the bridge is absent. Bump WEB_BUILD on every release — a report
     that cannot name its build cannot tell a live bug from a shipped fix. */
  const WEB_BUILD = '2026-08-06a';
  function appVersion() {
    try {
      if (window.CastleFlingDiagnostics && window.CastleFlingDiagnostics.appVersion) {
        const v = window.CastleFlingDiagnostics.appVersion();
        if (v) return v + ' / web ' + WEB_BUILD;
      }
    } catch (e) {}
    return 'web ' + WEB_BUILD;
  }
  function toNative(entry) {
    try {
      if (window.CastleFlingDiagnostics && window.CastleFlingDiagnostics.log) {
        window.CastleFlingDiagnostics.log(JSON.stringify(entry));
      }
    } catch (e) {}
  }

  return {
    previousCrash,
    appVersion,
    record(type, details) {
      try {
        const c = ctxNow();
        const entry = { t: Date.now(), type };
        if (c.state !== undefined) entry.state = c.state;
        if (c.wave !== undefined) entry.wave = c.wave;
        if (details !== undefined) entry.details = details;
        events.push(entry);
        if (events.length > MAX_EVENTS) events.shift();
        session.lastScreen = entry.state !== undefined ? entry.state : session.lastScreen;
        session.lastWave = entry.wave !== undefined ? entry.wave : session.lastWave;
        if (type === 'action') session.lastAction = details && details.name;
        persist();
        console.log('[CastleFling]', type, details !== undefined ? details : '');
        toNative(entry);
      } catch (e) { /* never let diagnostics crash the game */ }
    },
    /* the OS killing a BACKGROUNDED app is normal, not a crash: mark the
       session clean on every hide/unload edge, dirty again when visible */
    markClean(clean) { session.closedCleanly = !!clean; persist(); },
    markRendererRecovered() { session.rendererRecovered = true; persist(); },
    /* Store/ads snapshot for the copyable report. Everything here is state the
       game already holds — no native round-trip, so report() stays synchronous.
       storeSnapshot is refreshed by refreshStoreSnapshot() just before the
       report is copied. */
    storeSnapshot: null,
    report() {
      const r = {
        generatedAt: new Date().toISOString(),
        appVersion: appVersion(),
        store: (() => {
          try {
            const native = window.CastleFlingNative;
            return {
              adsAdapterMode: typeof Ads !== 'undefined' ? Ads.getMode() : 'n/a',
              payAdapterMode: typeof StorePayments !== 'undefined' ? StorePayments.getMode() : 'n/a',
              catalogIds: typeof IAP_PRODUCTS === 'object' ? Object.keys(IAP_PRODUCTS) : [],
              bridge: native && native.getDiagnostics ? native.getDiagnostics() : 'no-native-bridge',
              billing: CrashDiagnostics.storeSnapshot || 'not-sampled',
              adFree: typeof META === 'object' ? !!META.adFree : null,
            };
          } catch (e) { return { error: String(e && e.message) }; }
        })(),
        userAgent: navigator.userAgent,
        screen: { w: window.screen && window.screen.width, h: window.screen && window.screen.height },
        devicePixelRatio: window.devicePixelRatio || 1,
        canvas: (() => { try { return { w: canvas.width, h: canvas.height, cssW: canvas.style.width, cssH: canvas.style.height }; } catch (e) { return null; } })(),
        memory: (() => {
          try {
            const m = performance.memory;
            return m ? { usedMB: Math.round(m.usedJSHeapSize / 1048576), limitMB: Math.round(m.jsHeapSizeLimit / 1048576) } : null;
          } catch (e) { return null; }
        })(),
        session,
        previousSessionCrash: previousCrash,
        events,
      };
      return JSON.stringify(r, null, 2);
    },
    copyReport() {
      const text = this.report();
      return new Promise(resolve => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(fallbackCopy(text)));
            return;
          }
        } catch (e) {}
        resolve(fallbackCopy(text));
      });
      function fallbackCopy(t) {
        try {
          const ta = document.createElement('textarea');
          ta.value = t;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch (e) { return false; }
      }
    },
  };
})();
/* native side (evaluateJavascript) reaches the logger through this global */
window.CastleFlingDiag = CrashDiagnostics;

/* every JS exception and unhandled rejection lands in the trail — the two
   signatures that distinguish "script died" from "renderer was killed" */
window.addEventListener('error', ev => {
  CrashDiagnostics.record('javascript-error', {
    message: ev.message,
    file: ev.filename, line: ev.lineno, column: ev.colno,
    stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 800) : null,
  });
});
window.addEventListener('unhandledrejection', ev => {
  CrashDiagnostics.record('unhandled-promise-rejection', {
    reason: String(ev.reason).slice(0, 300),
    stack: ev.reason && ev.reason.stack ? String(ev.reason.stack).slice(0, 800) : null,
  });
});
/* last user action: one delegated listener — never per-widget duplicates */
document.addEventListener('click', ev => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
  if (btn && btn.id) CrashDiagnostics.record('action', { name: 'tap:' + btn.id });
}, true);

CrashDiagnostics.record('app-launch', {
  /* stamped into the TRAIL as well as the report header, so a preserved
     previous-session crash trail also names the build it came from */
  build: CrashDiagnostics.appVersion(),
  ua: navigator.userAgent.slice(0, 160),
  dpr: window.devicePixelRatio || 1,
  hadUncleanExit: !!(CrashDiagnostics.previousCrash && CrashDiagnostics.previousCrash.session),
});

/* ---------------- canvas & layout ---------------- */
const canvas = $('game');
const ctx = canvas.getContext('2d');
const W = 1280, H = 720;
const GAME_ASPECT_RATIO = 16 / 9;
const Layout = {
  baseWidth: W,
  baseHeight: H,
  scale: 1,
  uiScale: 1,
  worldScale: 1,
  isMobile: false,
  dpr: 1,
  viewport: { viewWidth: W, viewHeight: H, offsetX: 0, offsetY: 0 },
  safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
};
// Geometry matched to bg_battlefield_scenic_valley_v2 (full-scene art, castle
// baked into the left side, grass platform along the bottom)
const GROUND_TOP = 575, GROUND_BOT = 665;     // walkable lane band (feet y)
const CASTLE_X = 425;                          // castle front wall x
const CONVERT = { x: 515, y: 630, r: 56 };     // conversion circle
const SPAWN_X = W + 30;

/* ============================================================
   ASSET REGISTRY & LOADER
   All art lives under assets/castle-fling/, addressed by the
   stable ids from asset-manifest.json. Sprites cropped from
   source sheets carry a crop rect [sx,sy,sw,sh] that isolates
   the main subject from neighbor-sheet bleed.
   ============================================================ */
const PACKS = {
  v1:  'assets/castle-fling/',              // original pack (defenders, icons, logo, some card art)
  fix: 'assets/castle-fling-fix-pack-v2/',  // ACTIVE pack: scenic bg, modular upgrades, corrected
                                            // left-facing enemies (enemy-direction-fix applied)
  ui:  'assets/ui/',                        // conversion-and-cosmetic-hands pack (cursor skins, convert flag)
  ab:  'assets/abilities/',                 // ability-sprites pack (ability icons + bomb projectile)
};
/* music tracks by context — each loops; Music.play() crossfades between them
   and guarantees a track never overlaps or double-starts itself */
const MUSIC_TRACKS = {
  menu: 'assets/audio/main_menu.mp3',            // main menu + all its sub menus
  gameplay: 'assets/audio/main_loop.mp3',        // classic siege runs
  ricochet: 'assets/audio/castle_ricochet.mp3',  // Castle Ricochet mode (registered ahead of the mode itself)
};
const TRIM = PACKS.v1 + 'ui-trimmed/';     // pre-cropped copies for DOM <img> use
const UIPOLISH = PACKS.v1 + 'ui-polish/trimmed/';   // ui-polish pack DOM icons (settings/howto/bargains/hud)

/* ---- authoritative currency icons (icon-cohesion pass) ----
   ONE sprite per currency everywhere: the Crown Shop crown and the Castle
   Ricochet coin. Inline <img> helpers default to .curIco (1em, baseline-
   aligned) so a sprite occupies exactly the slot the old emoji glyph did. */
const CROWN_ICON_SRC = TRIM + 'icon_crown_gold.png';
const COIN_ICON_SRC = 'assets/castle_ricochet/ui/ui_currency_coin_castle.png';
const crownIco = (cls = 'curIco') => `<img class="${cls}" src="${CROWN_ICON_SRC}" alt="crowns" draggable="false">`;
const coinIco = (cls = 'curIco') => `<img class="${cls}" src="${COIN_ICON_SRC}" alt="coins" draggable="false">`;
/* canvas-side currency images: floaters draw these sprites instead of the
   🪙 / 👑 emoji glyphs */
const COIN_IMG = new Image();
COIN_IMG.src = COIN_ICON_SRC;
const CROWN_IMG = new Image();
CROWN_IMG.src = CROWN_ICON_SRC;

/* ------- Milestones sprite pack: ONE central icon map -------
   Every milestone icon display site resolves through this map — no raw
   paths in UI code. Keys are the MILESTONE_CATS ids plus 'menu' for the
   home-screen / header Holy Grail. Bump MILESTONE_ART_VERSION whenever
   one of these PNGs changes so stale WebView/browser caches are busted. */
const MILESTONE_ART_VERSION = 1;
const MILESTONE_ART_DIR = 'assets/ui/milestones/';
const MILESTONE_ART = {
  menu:     'milestones_menu_holy_grail.png',
  slayer:   'milestone_slayer.png',
  boss:     'milestone_boss_breaker.png',
  convert:  'milestone_recruiter.png',
  wave:     'milestone_siege_survivor.png',
  defender: 'milestone_defender.png',
  gold:     'milestone_gold_hoarder.png',
  crown:    'milestone_crown_collector.png',
};
const msArtSrc = id => MILESTONE_ART_DIR + MILESTONE_ART[id] + '?mv=' + MILESTONE_ART_VERSION;
/* card icon: a failed load logs the exact id+path and falls back to the
   category's emoji glyph so the card never shows a broken-image square */
function msArtIco(id, fallback) {
  const src = msArtSrc(id);
  return `<img class="msImg" src="${src}" alt="" draggable="false" ` +
    `onerror="console.error('[CastleFling] milestone-icon-missing: ${id} ${src}');this.outerHTML='${fallback}'">`;
}
/* decode each sprite once up front (menu chrome + all categories) and wire
   the two static chrome slots: home-screen button and screen header */
const MILESTONE_ART_CACHE = {};
function initMilestoneArt() {
  for (const id of Object.keys(MILESTONE_ART)) {
    const im = new Image();
    im.src = msArtSrc(id);
    im.onerror = () => CrashDiagnostics.record('asset-load-failed', { id: 'milestone_' + id, src: msArtSrc(id) });
    MILESTONE_ART_CACHE[id] = im;
  }
  for (const elId of ['btnMilestonesIco', 'milestoneHeadIco']) {
    const el = $(elId);
    if (!el) continue;
    el.addEventListener('error', () => {
      console.error('[CastleFling] milestone-icon-missing: menu ' + msArtSrc('menu'));
      el.outerHTML = '🏆';
    });
    el.src = msArtSrc('menu');
  }
}

/* id -> { pack, path, crop }
   The v2 pack (enemy-direction-fix applied) corrected the previously shuffled
   enemy filenames, so ids map straight to matching files. All enemies face
   LEFT in the art — no mirroring is applied anywhere in the renderer.
   Crops [sx,sy,sw,sh] isolate the main subject (alpha-scan derived; the
   twin ram keeps a manual crop because a sheet-bleed sliver sits only 2px
   left of the body). */
const SPRITE_DEFS = {
  /* --- scenic battlefield (full-canvas, opaque) --- */
  bg_scenic: { pack: 'fix', path: 'backgrounds/bg_battlefield_scenic_valley_v2.png' },
  /* --- enemies (all face LEFT, toward the castle) --- */
  fe_runner:  { pack: 'fix', path: 'sprites/enemies/enemy_runner.png',       crop: [4, 4, 251, 226] },
  fe_soldier: { pack: 'fix', path: 'sprites/enemies/enemy_soldier.png',      crop: [4, 4, 294, 290] },
  fe_shield:  { pack: 'fix', path: 'sprites/enemies/enemy_shieldbearer.png', crop: [4, 4, 224, 275] },
  fe_hammer:  { pack: 'fix', path: 'sprites/enemies/enemy_hammer_brute.png', crop: [4, 4, 366, 288] },
  fe_bomber:  { pack: 'fix', path: 'sprites/enemies/enemy_bomb_carrier.png', crop: [4, 4, 187, 275] },
  fe_healer:  { pack: 'fix', path: 'sprites/enemies/enemy_healer.png',       crop: [4, 4, 282, 279] },
  fe_banner:  { pack: 'fix', path: 'sprites/enemies/enemy_banner_carrier.png', crop: [4, 17, 246, 348] },
  fe_knight:  { pack: 'fix', path: 'sprites/enemies/enemy_heavy_knight.png', crop: [4, 4, 247, 295] },
  fe_climber: { pack: 'fix', path: 'sprites/enemies/enemy_wall_climber.png', crop: [4, 4, 215, 296] },
  fe_captain: { pack: 'fix', path: 'sprites/enemies/enemy_siege_captain.png', crop: [4, 4, 337, 326] },  // corrected left-facing
  fe_cart:    { pack: 'fix', path: 'sprites/enemies/enemy_bomb_cart.png',    crop: [4, 4, 321, 291] },
  fe_ram:     { pack: 'fix', path: 'sprites/enemies/enemy_twin_ram.png',     crop: [18, 4, 352, 269] },
  /* --- modular castle upgrades --- */
  fu_mason:     { pack: 'fix', path: 'sprites/upgrades/upgrade_crystal_tower.png',   crop: [4, 4, 299, 342] }, // mason workshop
  fu_archer:    { pack: 'fix', path: 'sprites/upgrades/upgrade_mason_workshop.png',  crop: [4, 4, 258, 339] }, // archer platform
  fu_bombshop:  { pack: 'fix', path: 'sprites/upgrades/upgrade_bomb_workshop.png',   crop: [4, 4, 323, 317] },
  fu_bell:      { pack: 'fix', path: 'sprites/upgrades/upgrade_fortified_wall.png',  crop: [4, 4, 195, 442] }, // bell tower
  fu_shieldgen: { pack: 'fix', path: 'sprites/upgrades/upgrade_shield_generator.png', crop: [4, 3, 231, 316] },
  fu_vault:     { pack: 'fix', path: 'sprites/upgrades/upgrade_gold_vault.png',      crop: [4, 4, 288, 285] },
  /* retired: fu_crystal (crystal tower) and fu_wall (wall segment) — replaced by
     the wall-integrated fu2_mage_tower / fu2_wall_forge below; files remain on disk */
  /* --- grabbed/scared enemy pack (shown while held or airborne after a throw;
         humanoids panic, siege carts stay expressionless by design) --- */
  feg_runner:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_runner_scared.png',       crop: [4, 4, 274, 301] },
  feg_soldier: { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_soldier_scared.png',      crop: [4, 4, 281, 301] },
  feg_shield:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_shieldbearer_scared.png', crop: [4, 4, 307, 291] },
  feg_hammer:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_hammer_brute_scared.png', crop: [4, 4, 360, 302] },
  feg_bomber:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_bomb_carrier_scared.png', crop: [4, 4, 262, 314] },
  feg_healer:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_healer_scared.png',       crop: [4, 4, 310, 309] },
  feg_banner:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_banner_carrier_scared.png', crop: [4, 4, 308, 322] },
  feg_knight:  { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_heavy_knight_scared.png', crop: [4, 4, 286, 307] },
  feg_climber: { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_wall_climber_scared.png', crop: [4, 4, 258, 337] },
  feg_captain: { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_siege_captain_scared.png', crop: [4, 4, 321, 302] },
  feg_cart:    { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_bomb_cart_grabbed.png',   crop: [4, 4, 282, 256] },
  feg_ram:     { pack: 'v1', path: 'grabbed-enemies/sprites/enemies_grabbed/enemy_twin_ram_grabbed.png',    crop: [4, 4, 367, 279] },
  /* --- ui-polish pack: ground death marks (bottom-anchored decals) --- */
  dm_cracked:  { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_cracked_dirt.png',    crop: [8, 8, 538, 192] },
  dm_scorched: { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_scorched_crater.png', crop: [8, 8, 502, 207] },
  dm_rocky:    { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_rocky_crater.png',    crop: [8, 8, 546, 193] },
  dm_grass:    { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_grass_scar.png',      crop: [8, 68, 546, 188] },
  dm_splinter: { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_splinter_debris.png', crop: [8, 8, 522, 188] },
  dm_smoke:    { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_smoke_puff.png',      crop: [8, 8, 505, 212] },
  dm_dust:     { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_dust_smudge.png',     crop: [8, 8, 483, 171] },
  dm_arcane:   { pack: 'v1', path: 'ui-polish/sprites/death_marks/death_mark_arcane_residue.png',  crop: [23, 40, 475, 171] },
  /* --- ui-polish pack: castle damage stages (replace the baked castle visual) --- */
  castle_stage0: { pack: 'v1', path: 'ui-polish/sprites/castle_damage/castle_damage_stage_0_healthy.png',  crop: [8, 8, 566, 574] },
  castle_stage1: { pack: 'v1', path: 'ui-polish/sprites/castle_damage/castle_damage_stage_1_light.png',    crop: [8, 8, 569, 559] },   // terrain skirt removed in-place
  castle_stage2: { pack: 'v1', path: 'ui-polish/sprites/castle_damage/castle_damage_stage_2_heavy.png',    crop: [8, 0, 573, 583] },
  castle_stage3: { pack: 'v1', path: 'ui-polish/sprites/castle_damage/castle_damage_stage_3_critical.png', crop: [8, 0, 583, 588] },
  /* --- castle-upgrade-and-cursor pack (wall-integrated visuals + gauntlet cursor) --- */
  fu2_mage_tower: { pack: 'v1', path: 'upgrade-and-cursor/sprites/upgrades/upgrade_mage_tower_wall_attach.png', crop: [4, 4, 717, 1170] },
  fu2_wall_forge: { pack: 'v1', path: 'upgrade-and-cursor/sprites/upgrades/upgrade_wall_forge_wall_attach.png', crop: [4, 4, 923, 995] },
  cursor_open:    { pack: 'v1', path: 'upgrade-and-cursor/sprites/cursor/cursor_hand_open.png',   crop: [4, 4, 798, 1099] },
  cursor_closed:  { pack: 'v1', path: 'upgrade-and-cursor/sprites/cursor/cursor_hand_closed.png', crop: [4, 4, 663, 1007] },
  /* --- conversion-and-cosmetic-hands pack: dedicated art per cursor skin + convert-post flag --- */
  cursor_spectral_open:   { pack: 'ui', path: 'cursors/cursor_spectral_hand_open.png',    crop: [30, 30, 808, 1158] },
  cursor_spectral_closed: { pack: 'ui', path: 'cursors/cursor_spectral_hand_closed.png',  crop: [77, 82, 717, 1089] },
  cursor_royal_open:      { pack: 'ui', path: 'cursors/cursor_royal_gauntlet_open.png',   crop: [30, 30, 781, 1122] },
  cursor_royal_closed:    { pack: 'ui', path: 'cursors/cursor_royal_gauntlet_closed.png', crop: [109, 164, 630, 971] },
  convert_flag:           { pack: 'ui', path: 'world/conversion_flag_banner.png',         crop: [24, 24, 548, 1011] },
  /* --- ability-sprites pack: rolling bomb field projectile --- */
  bomb_proj:              { pack: 'ab', path: 'projectiles/bomb_tower_projectile.png',    crop: [59, 19, 137, 197] },
  /* --- kept from the original pack --- */
  defender_archer: { pack: 'v1', path: 'sprites/defenders/defender_archer.png', crop: [10, 0, 323, 311] },
  defender_mage:   { pack: 'v1', path: 'sprites/defenders/defender_mage.png',   crop: [0, 10, 287, 328] },
  defender_mason:  { pack: 'v1', path: 'sprites/defenders/defender_mason.png',  crop: [10, 10, 297, 306] },
  upgrade_conversion_barracks: { pack: 'v1', path: 'sprites/upgrades/upgrade_conversion_barracks.png', crop: [11, 48, 269, 276] },
  icon_convert: { pack: 'v1', path: 'ui/icons/icon_convert.png', crop: [6, 6, 148, 152] },
};

const IMGS = {};             // id -> HTMLImageElement (set once loaded)
function loadAssets() {
  for (const [id, def] of Object.entries(SPRITE_DEFS)) {
    const img = new Image();
    img.onload = () => { IMGS[id] = img; };
    /* a missing/corrupt file must never crash the game: the sprite simply
       stays absent (every draw site checks IMGS and falls back to the
       procedural vector look), and the exact path lands in the trail */
    img.onerror = () => {
      CrashDiagnostics.record('asset-load-failed', { id, src: PACKS[def.pack] + def.path });
    };
    img.src = PACKS[def.pack] + def.path;
  }
}

/* ---- pre-tinted sprite variants ----
   Chromium routes every ctx.filter draw through its own offscreen render
   surface, and each allocate/release cycle spawns EGL sync objects. Tinting
   enemies that way per sprite per frame crashed the Adreno driver inside
   gsl_syncobj_destroy on deep waves (S20 FE closed test, waves 48 and 50):
   the WebView GPU thread runs inside the app process, so the whole app died
   and onRenderProcessGone never fired. Each (sprite, tint) pair is now baked
   ONCE into a crop-sized offscreen canvas and drawn as a plain image, so the
   combat renderer allocates no per-frame surfaces at all. Baking is lazy —
   only the variants a run actually shows are ever built. */
const SPRITE_TINTS = {
  flash:    'brightness(2.4)',
  golden:   'sepia(0.65) saturate(2.4) brightness(1.15)',
  goldTint: 'sepia(0.45) saturate(1.9) brightness(1.1)',
};
const TINT_CACHE = {};       // "sprId|tint" -> HTMLCanvasElement, or null when unavailable
function tintedSprite(sprId, tint) {
  const img = IMGS[sprId];
  if (!img) return null;                       // not decoded yet — plain draw, retry next frame
  const key = sprId + '|' + tint;
  if (key in TINT_CACHE) return TINT_CACHE[key];
  let out = null;
  try {
    const c = SPRITE_DEFS[sprId].crop || [0, 0, img.naturalWidth, img.naturalHeight];
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(c[2]));
    cv.height = Math.max(1, Math.round(c[3]));
    const g = cv.getContext('2d');
    g.filter = SPRITE_TINTS[tint];
    g.drawImage(img, c[0], c[1], c[2], c[3], 0, 0, cv.width, cv.height);
    out = cv;
  } catch (e) {
    /* a device that refuses the offscreen canvas simply shows untinted sprites
       rather than losing the frame — never let a cosmetic tint break combat */
    CrashDiagnostics.record('sprite-tint-failed', { sprId, tint, message: String(e && e.message) });
    out = null;
  }
  TINT_CACHE[key] = out;     // null is cached too: a variant that failed is never retried
  return out;
}

/* draw an asset by id, center-bottom anchored at (x, feetY), scaled to height h */
function drawSpriteCB(id, x, feetY, h, alpha) {
  const img = IMGS[id];
  if (!img) return false;
  const c = SPRITE_DEFS[id].crop || [0, 0, img.naturalWidth, img.naturalHeight];
  const w = h * c[2] / c[3];
  if (alpha !== undefined) ctx.globalAlpha = alpha;
  ctx.drawImage(img, c[0], c[1], c[2], c[3], x - w / 2, feetY - h, w, h);
  if (alpha !== undefined) ctx.globalAlpha = 1;
  return true;
}

function viewportSize() {
  const vv = window.visualViewport;
  return {
    width: Math.max(1, vv ? vv.width : window.innerWidth),
    height: Math.max(1, vv ? vv.height : window.innerHeight),
  };
}
function calculateGameViewport(screenWidth, screenHeight) {
  const screenRatio = screenWidth / screenHeight;
  let viewWidth, viewHeight, offsetX = 0, offsetY = 0, fullBleed = false;
  if (screenRatio > GAME_ASPECT_RATIO) {
    // screen is wider than the 16:9 world (landscape phones, ultrawides):
    // fill the full width and anchor to the BOTTOM so only sky is cropped —
    // no side pillarboxing, and the ground/castle/HUD space stays intact
    fullBleed = true;
    viewWidth = screenWidth;
    viewHeight = viewWidth / GAME_ASPECT_RATIO;
    offsetY = screenHeight - viewHeight;          // negative: overflows above the screen
  } else {
    viewWidth = screenWidth;
    viewHeight = viewWidth / GAME_ASPECT_RATIO;
    offsetY = (screenHeight - viewHeight) / 2;
  }
  return { viewWidth, viewHeight, offsetX, offsetY, fullBleed };
}
function fitCanvas() {
  const { width: ww, height: wh } = viewportSize();
  const viewport = calculateGameViewport(ww, wh);
  const isMobile = window.matchMedia('(pointer: coarse), (max-width: 800px)').matches;
  const baseScale = Math.min(viewport.viewWidth / W, viewport.viewHeight / H);
  const uiScale = clamp(baseScale * (isMobile ? 1.08 : 1), isMobile ? 0.82 : 0.86, isMobile ? 1.08 : 1.04);
  /* Render-DPR cap (S20 FE stability pass): the backing store never exceeds
     the pixels physically displayed (viewWidth CSS px × real DPR), and never
     2× the logical world. High-DPR phones (S20 FE reports ~2.75) previously
     allocated a 2560×1440 canvas even when the screen could only show ~2400
     wide — pure GPU/memory pressure with zero visual gain. Touch mapping is
     unaffected: canvasPos() works off the CSS rect, not the backing store. */
  const rawDpr = window.devicePixelRatio || 1;
  const displayDpr = (viewport.viewWidth * rawDpr) / W;   // backing scale that exactly matches screen pixels
  const dpr = Math.min(rawDpr, 2, Math.max(0.75, displayDpr));

  Layout.scale = baseScale;
  Layout.worldScale = baseScale;
  Layout.uiScale = uiScale;
  Layout.isMobile = isMobile;
  Layout.dpr = dpr;
  Layout.viewport = viewport;
  // logical px of world hidden above the screen in full-bleed mode; screen-
  // anchored canvas text (wave banner, combo) offsets by this to stay visible
  Layout.cropTopL = viewport.fullBleed ? Math.max(0, -viewport.offsetY) / (viewport.viewWidth / W) : 0;
  $('gameContainer').classList.toggle('fullbleed', !!viewport.fullBleed);

  canvas.style.width = `${viewport.viewWidth}px`;
  canvas.style.height = `${viewport.viewHeight}px`;
  const pixelWidth = Math.max(1, Math.round(W * dpr));
  const pixelHeight = Math.max(1, Math.round(H * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    CrashDiagnostics.record('canvas-resize', {
      w: pixelWidth, h: pixelHeight, renderDpr: Math.round(dpr * 100) / 100, deviceDpr: rawDpr,
      cssW: Math.round(viewport.viewWidth), cssH: Math.round(viewport.viewHeight),
    });
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const root = document.documentElement;
  root.style.setProperty('--game-view-width', `${viewport.viewWidth}px`);
  root.style.setProperty('--game-view-height', `${viewport.viewHeight}px`);
  root.style.setProperty('--game-offset-x', `${viewport.offsetX}px`);
  root.style.setProperty('--game-offset-y', `${viewport.offsetY}px`);
  root.style.setProperty('--world-scale', Layout.worldScale.toFixed(4));
  root.style.setProperty('--ui-scale', Layout.uiScale.toFixed(4));
  root.classList.toggle('is-mobile', isMobile);
  root.classList.toggle('is-portrait', wh > ww);
  applySizeClass(root, ww, wh);
  updateOrientationGate(ww, wh);
}

/* ---- responsive size classes ----
   Layout keys off the window the game actually has, never a device name, so a
   tablet, an unfolded foldable, a split-screen pane and a freeform window all
   land in the right bucket by measurement alone. */
const SIZE_CLASSES = ['size-compact', 'size-standard', 'size-wide', 'size-large'];
function applySizeClass(root, w, h) {
  const cls = w < 700 ? 'size-compact'
    : w < 1100 ? 'size-standard'
    : w < 1440 ? 'size-wide'
    : 'size-large';
  for (const c of SIZE_CLASSES) root.classList.toggle(c, c === cls);
  root.classList.toggle('is-short', h < 420);
  root.classList.toggle('is-ultrawide', (w / h) >= 2.1);
}

/* ---- landscape gate ----
   The Activity no longer locks orientation (Play treats a hard lock as a
   large-screen restriction), so the window can genuinely be portrait or a narrow
   split-screen sliver. Rather than render a crushed board, cover the screen and
   park gameplay: a live run drops into the normal pause state and resumes
   automatically once the window is usable again. Nothing reloads, no progress is
   discarded, and a pause the player opened by hand is never auto-resumed.
   gateReady stays false until boot finishes because fitCanvas() runs before
   `state` is initialised — before that the gate only shows and hides itself. */
const GATE_MIN_ASPECT = 1.15;   // below this the board stops being playable
const GATE_MIN_WIDTH = 480;     // CSS px
let gateReady = false;
let gateActive = false;
let gateAutoPaused = false;
function updateOrientationGate(w, h) {
  const playable = (w / h) >= GATE_MIN_ASPECT && w >= GATE_MIN_WIDTH;
  const gate = $('rotateGate');
  if (gate) gate.classList.toggle('hidden', playable);
  if (!gateReady) { gateActive = !playable; return; }
  if (!playable && !gateActive) {
    gateActive = true;
    gateAutoPaused = (state === 'playing');
    if (gateAutoPaused) pauseGame();
  } else if (playable && gateActive) {
    gateActive = false;
    if (gateAutoPaused && state === 'paused') resumeGame();
    gateAutoPaused = false;
  }
}

window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', fitCanvas);
if (window.visualViewport) window.visualViewport.addEventListener('resize', fitCanvas);
/* Native Android hooks — both are plain re-measures.
   __castleFlingOnInsets fires from the inset bridge in index.html once the CSS
   variables are written; __castleFlingOnConfigChange fires from MainActivity's
   onConfigurationChanged (rotation, fold/unfold, split-screen, freeform drag).
   The Activity is never recreated, so game state, audio and listeners survive. */
window.__castleFlingOnInsets = function () { fitCanvas(); };
window.__castleFlingOnConfigChange = function () {
  /* the WebView can still report the pre-resize dimensions on the first frame
     after a window change, so settle it with one more pass next frame */
  fitCanvas();
  requestAnimationFrame(fitCanvas);
};
fitCanvas();

/* ---------------- persistent meta save ---------------- */
const SAVE_KEY = 'castlefling_save_v1';
/* META is the persistent save (the "saveData" of the platform layer):
   coins are a PERSISTENT wallet — earned in runs, bought in the shop,
   spent on rooms — surviving app restarts and abandoned runs. */
const defaultMeta = () => ({
  coins: ECONOMY_STARTING_COINS,   // persistent gold wallet
  crowns: 0, bestWave: 0, bestScore: 0, totalKills: 0, runs: 0,
  totalBosses: 0, totalConverts: 0,    // lifetime milestone counters
  totalWavesCleared: 0, totalCoinsEarned: 0, totalCrownsEarned: 0,
  playerXp: 0,                          // stars (score) banked across all runs
  milestonesClaimed: {},                // legacy one-shot milestones (kept for migration)
  milestoneTiers: null,                 // category id -> claimed tier count (see migrateMilestones)
  /* permanent milestone reward ledger — additive field, so saves written
     before it existed simply start empty. Tiers claimed back when milestones
     paid crowns have no entry here and must never get one: the tier COUNT
     already marks them claimed, and claimMilestone only ever writes the
     ledger for a tier it is granting right now. */
  milestoneTx: {},                      // txId -> { coins, at }
  claimedLevelRewards: {},              // level number -> true (auto-granted on level-up)
  savedRun: null,                       // between-wave checkpoint (Save Run)
  adFree: false,
  purchases: { transactions: {}, restored: false, lastRestoreAt: null },
  /* ad pacing ledger. Additive: loadMeta merges these defaults over old saves,
     so a save written before these counters existed simply starts them at zero.
     lastInterstitialWave guards against showing two ads for the same wave
     number within a run; the time/run counters pace everything else. */
  ads: {
    totalInterstitialsShown: 0, totalRewardedCompleted: 0, lastInterstitialWave: null,
    lastInterstitialAt: 0,      // epoch ms of the last interstitial actually shown
    lastInterstitialRun: null,  // META.runs at that moment
    lastRewardedAt: 0,          // epoch ms of the last completed rewarded ad
    /* A REQUIRED interstitial the player still owes, or null. Persisted with
       the save (and therefore mirrored to native SharedPreferences), which is
       what makes closing, force-stopping or restarting the app a non-bypass.
       Backward compatible by construction: a save written before this field
       existed merges to null here, i.e. "nothing owed" — the old behaviour.
       Shape: { required: true, placement, wave, createdAt }. */
    pendingInterstitial: null,
  },
  owned: {},                       // treasury unlock ids
  handSkin: 'gauntlet', banner: 'emerald',
  /* per-mode tutorial state. Castle Ricochet keeps its own long-standing flag
     at META.ricochet.tutorialCompleted and is never mirrored or reset here. */
  tutorials: { castleFling: { completed: false, skipped: false, version: 1 } },
  settings: { sound: true, music: true, musicVol: 0.6, shake: true, numbers: true, particles: true, nightmare: false },
});
const ECONOMY_STARTING_COINS = 100;
let META = defaultMeta();
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    const p = JSON.parse(raw);
    META = Object.assign(defaultMeta(), p);
    META.settings = Object.assign(defaultMeta().settings, p.settings || {});
    META.owned = p.owned || {};
    META.purchases = Object.assign(defaultMeta().purchases, p.purchases || {});
    META.ads = Object.assign(defaultMeta().ads, p.ads || {});
    /* tutorial state: additive only. Existing saves keep every currency,
       level, milestone, purchase, saved run and Castle Ricochet flag exactly
       as stored — they simply gain the missing Castle Fling defaults. */
    META.tutorials = Object.assign(defaultMeta().tutorials, p.tutorials || {});
    META.tutorials.castleFling = Object.assign(
      defaultMeta().tutorials.castleFling,
      (p.tutorials && p.tutorials.castleFling) || {});
    if (typeof META.coins !== 'number' || !Number.isFinite(META.coins)) META.coins = ECONOMY_STARTING_COINS;
    /* crimson/azure banner cosmetics were removed from the treasury: unequip
       them (fall back to the default emerald look) and drop the ownership
       keys so old saves stay harmless */
    if (META.banner === 'crimson' || META.banner === 'azure') META.banner = 'emerald';
    delete META.owned.banner_crimson;
    delete META.owned.banner_azure;
  }
} catch (e) { /* fresh save */ }
/* localStorage is the live store (synchronous boot reads); on Android every
   write is mirrored to native SharedPreferences via the Capacitor Preferences
   plugin, which survives WebView data loss and rides Android Auto Backup. */
const NATIVE_PREFS = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;
function saveMeta() {
  try {
    const json = JSON.stringify(META);
    localStorage.setItem(SAVE_KEY, json);
    const P = NATIVE_PREFS();
    if (P) P.set({ key: SAVE_KEY, value: json }).catch(() => {});
  } catch (e) {}
}
/* one-time recovery: if the WebView store came up empty but the native mirror
   has a save (data loss / backup restore), copy it back and reboot the game */
(async function restoreFromNativeMirror() {
  try {
    const P = NATIVE_PREFS();
    if (!P || localStorage.getItem(SAVE_KEY)) return;
    const { value } = await P.get({ key: SAVE_KEY });
    if (value) { localStorage.setItem(SAVE_KEY, value); location.reload(); }
  } catch (e) {}
})();
/* debounced save for high-frequency events (per-kill coin awards) */
let saveTimer = null;
function saveMetaSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveMeta(); }, 700);
}
const owns = id => !!META.owned[id];

/* ============================================================
   TUTORIAL SANDBOX GATE
   ============================================================
   The Castle Fling tutorial (tutorial.js) runs the real game inside a
   throwaway run: it swaps G for a practice run, plays the actual battle
   and the actual Castle Rooms screen, then puts the player's run back.
   `tutSandbox` is the single switch every persistence chokepoint below
   reads, so nothing that happens in the tutorial can reach the save.

   Declared with `var` on purpose: it must be readable from the very first
   line of this file (a `let`/`const` would sit in TDZ during boot). */
var tutSandbox = false;
function inTut() { return tutSandbox === true; }
/* interactive tutorial steps wait on these; outside the tutorial the call
   is a no-op, and a tutorial-side error must never break gameplay */
function tutEvent(name, data) {
  if (!tutSandbox) return;
  if (typeof CastleFlingTutorial === 'undefined' || !CastleFlingTutorial.event) return;
  try { CastleFlingTutorial.event(name, data); }
  catch (e) { CrashDiagnostics.record('fling-tutorial-event-error', { name, message: String(e && e.message) }); }
}

/* ---- persistent coin wallet helpers ----
   All gold mutations flow through these so the wallet always matches
   the in-run display and every change hits disk. */
function addGold(n) {
  if (!n) return;
  /* tutorial sandbox: practice coins move the practice wallet only — never
     META.coins, never the lifetime totals that feed milestones */
  if (inTut()) { if (G) G.gold += n; return; }
  if (n > 0) META.totalCoinsEarned = (META.totalCoinsEarned || 0) + Math.round(n);   // lifetime (milestones)
  if (G) G.gold += n;
  META.coins = Math.max(0, Math.round((G ? G.gold : META.coins + n)));
  saveMetaSoon();
}
function spendGold(n) {
  if (inTut()) { if (G) G.gold -= n; return; }
  if (G) G.gold -= n;
  META.coins = Math.max(0, Math.round(G ? G.gold : META.coins - n));
  saveMeta();   // spends are rare and important — save immediately
}

/* ---------------- audio (procedural, no files) ---------------- */
/* ---------------- music (multi-track, crossfading, single instance) ----------------
   One <audio> element PER TRACK, created lazily and reused forever — never a
   new element per play (that was a duplicate-audio-buffer risk). play(name)
   is idempotent: asking for the already-active track does nothing, so music
   can never loop over itself; switching tracks runs one short crossfade. */
const Music = (() => {
  const els = {};            // track name -> HTMLAudioElement (lazy, reused)
  let current = null;        // active track name
  let started = false;       // a play() has been attempted (gesture context seen)
  let fadeTimer = null;      // the single crossfade interval — always cleared first
  let retryArmed = false;    // one pending autoplay-retry listener, never stacked
  function ensure(name) {
    if (!els[name]) {
      const a = new Audio(MUSIC_TRACKS[name]);
      a.loop = true;
      a.preload = 'auto';
      /* a missing music file logs and stays silent — it must never throw */
      a.addEventListener('error', () => {
        CrashDiagnostics.record('music-load-failed', { track: name, src: MUSIC_TRACKS[name] });
      });
      els[name] = a;
    }
    return els[name];
  }
  function targetVol() {
    return clamp(META.settings.musicVol, 0, 1) * (musicDucked() ? 0.3 : 1);
  }
  function clearFade() { if (fadeTimer !== null) { clearInterval(fadeTimer); fadeTimer = null; } }
  function tryPlay(a) {
    const p = a.play();
    if (p && p.catch) p.catch(() => {
      /* blocked by autoplay policy — retry the then-current track on the next
         direct touch; exactly one retry listener may be armed at a time */
      if (retryArmed) return;
      retryArmed = true;
      const retry = () => {
        retryArmed = false;
        if (!META.settings.music || !current) return;
        const el = ensure(current);
        if (el.paused) { const rp = el.play(); if (rp && rp.catch) rp.catch(() => {}); }
      };
      window.addEventListener('pointerup', retry, { once: true });
    });
  }
  /* ~0.6s equal-step crossfade from whatever plays now to `next` */
  function crossfadeTo(next) {
    clearFade();
    const from = current !== null && current !== next ? ensure(current) : null;
    const to = ensure(next);
    current = next;
    const vol = targetVol();
    if (to.paused) { to.volume = from ? 0 : vol; to.currentTime = to.currentTime || 0; tryPlay(to); }
    if (!from) { to.volume = vol; return; }
    const fromStart = from.volume;
    const STEPS = 20, MS = 30;
    let step = 0;
    fadeTimer = setInterval(() => {
      step++;
      const q = step / STEPS;
      try {
        from.volume = fromStart * (1 - q);
        to.volume = vol * q;
      } catch (e) {}
      if (step >= STEPS) {
        clearFade();
        from.pause();          // fully faded out — never left running underneath
        to.volume = vol;
      }
    }, MS);
  }
  return {
    /* switch to (or keep) a named track; safe to call on every screen change */
    play(name) {
      if (!MUSIC_TRACKS[name]) return;
      started = true;
      if (!META.settings.music) { current = name; return; }   // remember intent for onToggle
      if (current === name) {
        const el = ensure(name);
        el.volume = targetVol();
        if (el.paused) tryPlay(el);          // resume after lifecycle stop — same position
        return;                              // already the active track: never restart/overlap
      }
      crossfadeTo(name);
    },
    stop() { clearFade(); for (const k in els) els[k].pause(); },
    /* duck instead of hard-pausing so the loop position stays musical */
    duck() { if (current && els[current]) els[current].volume = targetVol(); },
    setVolume(v) { META.settings.musicVol = clamp(v, 0, 1); this.duck(); saveMeta(); },
    onToggle() { if (META.settings.music) { if (current) this.play(current); } else this.stop(); },
    isStarted: () => started,
    /* state probe for tests/debugging */
    status() {
      const el = current && els[current];
      return el ? { track: current, paused: el.paused, time: el.currentTime, loop: el.loop, volume: el.volume } : null;
    },
  };
})();

/* the one place that decides WHICH track a given app state wants: the main
   menu and every menu-reached sub screen share the menu theme; anything that
   belongs to an active run (including pause and its sub screens) keeps the
   gameplay theme. When the Castle Ricochet mode lands, its state returns
   'ricochet' here and the rest of the system already handles it. */
function desiredMusicTrack() {
  const fromRet = ret => ret === 'pause' ? 'gameplay' : ret === 'ricochetPause' ? 'ricochet' : 'menu';
  switch (state) {
    case 'menu': case 'castle': case 'meta': case 'milestones': case 'daily':
      return 'menu';
    case 'ricochet': case 'ricochetPause': case 'ricochetResult':
      return 'ricochet';
    case 'howto': return fromRet(howtoReturnTo);
    case 'settings': return fromRet(settingsReturnTo);
    case 'shop': return fromRet(shopReturnTo);
    case 'levelRewards': return fromRet(levelRewardsReturnTo);
    case 'legal':
      if (legalReturnTo === 'settings') return fromRet(settingsReturnTo);
      if (legalReturnTo === 'shop') return fromRet(shopReturnTo);
      return 'menu';
    /* playing | paused | cards | build | modifier | gameover */
    default: return 'gameplay';
  }
}
function syncMusic() { Music.play(desiredMusicTrack()); }
/* ducked (30% volume) whenever a run is paused underneath — including the
   sub screens reachable FROM pause, so the quiet doesn't pop back up */
function musicDucked() {
  const paused = ret => ret === 'pause' || ret === 'ricochetPause';
  if (state === 'paused' || state === 'ricochetPause') return true;
  if (state === 'settings') return paused(settingsReturnTo);
  if (state === 'howto') return paused(howtoReturnTo);
  if (state === 'shop') return paused(shopReturnTo);
  if (state === 'levelRewards') return paused(levelRewardsReturnTo);
  if (state === 'legal') {
    if (legalReturnTo === 'settings') return paused(settingsReturnTo);
    if (legalReturnTo === 'shop') return paused(shopReturnTo);
  }
  return false;
}

const Sfx = (() => {
  let ac = null;   // the ONE AudioContext — created lazily, reused for the whole session
  const ctxA = () => {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { CrashDiagnostics.record('audio-context-failed', { message: String(e && e.message) }); }
    }
    if (ac && ac.state === 'suspended') {
      /* resume() returns a promise that CAN reject on Android — swallowing it
         here is what keeps a flaky audio stack from becoming an unhandled
         rejection storm; failures are recorded once via the catch */
      try {
        const p = ac.resume();
        if (p && p.catch) p.catch(err => {
          CrashDiagnostics.record('audio-resume-failed', { message: String(err && err.message) });
        });
      } catch (e) {}
    }
    return ac;
  };
  /* lifecycle: release the audio hardware while backgrounded */
  const suspendA = () => {
    try {
      if (ac && ac.state === 'running') {
        const p = ac.suspend();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {}
  };
  function tone(freq, dur, type = 'square', vol = 0.08, slide = 0, delay = 0) {
    if (!META.settings.sound) return;
    const a = ctxA(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  /* One second of white noise, generated once and reused by every noise() call.
     Building a fresh AudioBuffer per call meant a native allocation plus a JS
     Math.random() loop on every enemy impact — dozens per second during deep
     waves. The decay envelope that used to be baked into the samples is now a
     gain ramp, which sounds identical and costs nothing; a random read offset
     keeps repeated hits from sounding like a loop. */
  const NOISE_BUFFER_SECONDS = 1;
  let noiseBuf = null;
  function noiseBuffer(a) {
    if (noiseBuf && noiseBuf.sampleRate === a.sampleRate) return noiseBuf;
    const len = Math.max(1, Math.floor(a.sampleRate * NOISE_BUFFER_SECONDS));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return buf;
  }
  function noise(dur, vol = 0.12, lp = 800) {
    if (!META.settings.sound) return;
    const a = ctxA(); if (!a) return;
    const buf = noiseBuffer(a);
    const play = Math.min(dur, buf.duration);
    const s = a.createBufferSource(); s.buffer = buf;
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
    const g = a.createGain();
    const t = a.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.linearRampToValueAtTime(0, t + play);
    s.connect(f).connect(g).connect(a.destination);
    s.start(t, Math.random() * (buf.duration - play), play);
    s.stop(t + play + 0.02);
  }
  return {
    unlock: () => ctxA(),
    suspend: suspendA,
    ui: () => tone(520, 0.07, 'square', 0.05, 100),
    grab: () => tone(300, 0.08, 'square', 0.06, 120),
    throwW: () => { noise(0.15, 0.07, 2500); tone(700, 0.12, 'sawtooth', 0.03, -400); },
    hit: p => { noise(0.12, 0.10 + p * 0.08, 900); tone(120 - p * 30, 0.1, 'square', 0.07, -60); },
    kill: () => { tone(400, 0.1, 'square', 0.06, -200); tone(200, 0.15, 'square', 0.05, -120, 0.05); },
    coin: () => { tone(880, 0.07, 'square', 0.05); tone(1320, 0.09, 'square', 0.05, 0, 0.06); },
    boom: () => { noise(0.45, 0.22, 500); tone(70, 0.4, 'sawtooth', 0.12, -40); },
    spell: () => { tone(600, 0.2, 'sine', 0.07, 500); tone(900, 0.25, 'sine', 0.05, 400, 0.08); },
    freeze: () => tone(1000, 0.3, 'sine', 0.06, -600),
    bell: () => { tone(660, 0.6, 'triangle', 0.12, -30); tone(662, 0.7, 'sine', 0.08, -20, 0.02); },
    hurt: () => { noise(0.2, 0.12, 400); tone(90, 0.2, 'sawtooth', 0.09, -30); },
    convert: () => { tone(440, 0.12, 'sine', 0.07, 220); tone(660, 0.15, 'sine', 0.07, 220, 0.1); tone(880, 0.2, 'sine', 0.06, 100, 0.2); },
    wave: () => { tone(330, 0.18, 'triangle', 0.08); tone(440, 0.18, 'triangle', 0.08, 0, 0.15); tone(550, 0.3, 'triangle', 0.08, 0, 0.3); },
    lose: () => { tone(220, 0.5, 'sawtooth', 0.09, -100); tone(165, 0.7, 'sawtooth', 0.09, -60, 0.35); },
    arrow: () => noise(0.06, 0.03, 3000),
  };
})();

/* ---------------- enemy definitions ---------------- */
/* weight: 0 = light (instant lift), 1 = medium (hold), 2 = heavy (drag only) */
/* sprite: asset id; grabSprite: scared/neutral variant shown while held or
   airborne after a throw; dispH: on-screen height in px (bottom-center
   anchored, aspect preserved — values follow the fix-pack manifest's
   recommended display heights, boss variants scaled up). r = physics/grab radius. */
const ENEMIES = {
  runner:  { name: 'Runner',        hp: 20,  spd: 88, gold: 18, score: 10, weight: 0, r: 20, dps: 2.5, color: '#7ec46a', helm: 'cap',  sprite: 'fe_runner', grabSprite: 'feg_runner', dispH: 95 },
  soldier: { name: 'Soldier',       hp: 38,  spd: 42, gold: 30, score: 15, weight: 0, r: 24, dps: 5,  color: '#8f9fb5', helm: 'round', sprite: 'fe_soldier', grabSprite: 'feg_soldier', dispH: 112 },
  shield:  { name: 'Shieldbearer',  hp: 60,  spd: 35, gold: 50, score: 20, weight: 1, r: 27, dps: 5,  color: '#5f87c7', helm: 'round', shielded: true, sprite: 'fe_shield', grabSprite: 'feg_shield', dispH: 124 },
  hammer:  { name: 'Hammerman',     hp: 72,  spd: 30, gold: 90, score: 25, weight: 1, r: 33, dps: 24, color: '#c78a4e', helm: 'horn', hammer: true, sprite: 'fe_hammer', grabSprite: 'feg_hammer', dispH: 150 },
  bomber:  { name: 'Bomb Carrier',  hp: 28,  spd: 56, gold: 75, score: 25, weight: 0, r: 26, dps: 0,  color: '#3d3d3d', helm: 'cap', bomb: true, boomCastle: 55, boomR: 110, sprite: 'fe_bomber', grabSprite: 'feg_bomber', dispH: 122 },
  healer:  { name: 'Healer',        hp: 42,  spd: 38, gold: 85, score: 30, weight: 0, r: 26, dps: 2,  color: '#e0d3f5', helm: 'hood', healer: true, sprite: 'fe_healer', grabSprite: 'feg_healer', dispH: 126 },
  banner:  { name: 'Banner Carrier',hp: 62,  spd: 40, gold: 85, score: 30, weight: 1, r: 30, dps: 4,  color: '#d46a6a', helm: 'round', bannerman: true, sprite: 'fe_banner', grabSprite: 'feg_banner', dispH: 145 },
  knight:  { name: 'Heavy Knight',  hp: 150, spd: 23, gold: 150, score: 40, weight: 2, r: 34, dps: 15, color: '#9a8fc7', helm: 'great', sprite: 'fe_knight', grabSprite: 'feg_knight', dispH: 156 },
  climber: { name: 'Climber',       hp: 32,  spd: 68, gold: 70, score: 25, weight: 0, r: 26, dps: 7,  color: '#c7b45f', helm: 'hood', climber: true, sprite: 'fe_climber', grabSprite: 'feg_climber', dispH: 126 },
  /* elite pickup fix (2026-07): weight was 1 (medium) — an Elite Guard wears
     the Heavy Knight's body and outweighs it in HP, yet lifted after a short
     hold while the normal knight is drag-only. Elites now use the heavy
     class, matching their normal counterpart's pickup difficulty; Titan Grip
     is the intended upgrade path to lifting them. */
  elite:   { name: 'Elite Guard',   hp: 190, spd: 33, gold: 220, score: 60, weight: 2, r: 33, dps: 20, color: '#e6b04a', helm: 'great', tough: 0.3, sprite: 'fe_knight', grabSprite: 'feg_knight', dispH: 150, goldTint: true },
  /* bosses (spawned specially; grabbed variants reuse their base art's scared pose) */
  captain: { name: 'Siege Captain', hp: 550, spd: 20, gold: 650, score: 300, weight: 2, r: 38, dps: 26, color: '#4a6ea8', helm: 'great', boss: 'captain', sprite: 'fe_captain', grabSprite: 'feg_captain', dispH: 175 },
  brute:   { name: 'Hammer Brute',  hp: 700, spd: 17, gold: 750, score: 350, weight: 2, r: 43, dps: 60, color: '#b0622f', helm: 'horn', hammer: true, boss: 'brute', unliftable: true, sprite: 'fe_hammer', grabSprite: 'feg_hammer', dispH: 195 },
  bannerlord:{ name: 'Banner Lord', hp: 620, spd: 22, gold: 800, score: 350, weight: 2, r: 40, dps: 24, color: '#c04848', helm: 'crown', bannerman: true, boss: 'bannerlord', sprite: 'fe_banner', grabSprite: 'feg_banner', dispH: 185 },
  cart:    { name: 'Bomb Cart',     hp: 480, spd: 46, gold: 900, score: 400, weight: 2, r: 44, dps: 0,  color: '#454545', boss: 'cart', bomb: true, boomCastle: 999, boomR: 150, cart: true, sprite: 'fe_cart', grabSprite: 'feg_cart', dispH: 160 },
  ram:     { name: 'Siege Ram',     hp: 460, spd: 22, gold: 400, score: 200, weight: 2, r: 48, dps: 45, color: '#7a6248', helm: 'horn', boss: 'rams', sprite: 'fe_ram', grabSprite: 'feg_ram', dispH: 165 },
};
/* ============================================================
   PROCEDURAL ANIMATION PROFILES
   Per-type tuning for the transform-based animation system:
   bobAmp/bobFreq  walk bounce ·  rotAmp step rotation
   squash          walk squash/stretch ·  lunge attack push (px)
   atkDur/atkStyle attack animation ·  roll/float/jitter/sway variants
   All enemies stay left-facing; transforms never mirror sprites.
   ============================================================ */
const ANIM = {
  runner:  { bobAmp: 3.5, bobFreq: 13,  rotAmp: 0.06,  squash: 0.05,  lunge: 26, atkDur: 0.28, atkStyle: 'slash' },
  soldier: { bobAmp: 3,   bobFreq: 9,   rotAmp: 0.045, squash: 0.04,  lunge: 20, atkDur: 0.35, atkStyle: 'slash' },
  shield:  { bobAmp: 2.5, bobFreq: 8,   rotAmp: 0.035, squash: 0.03,  lunge: 16, atkDur: 0.4,  atkStyle: 'bash' },
  hammer:  { bobAmp: 4.5, bobFreq: 5.5, rotAmp: 0.05,  squash: 0.05,  lunge: 18, atkDur: 0.65, atkStyle: 'slam', slamShake: 3 },
  bomber:  { bobAmp: 3,   bobFreq: 11,  rotAmp: 0.05,  squash: 0.04,  lunge: 10, atkDur: 0.3,  atkStyle: 'bash', jitter: 1.3, fuse: true },
  healer:  { bobAmp: 4,   bobFreq: 3.2, rotAmp: 0.02,  squash: 0.015, lunge: 8,  atkDur: 0.4,  atkStyle: 'magic', float: true },
  banner:  { bobAmp: 2.5, bobFreq: 7,   rotAmp: 0.045, squash: 0.03,  lunge: 12, atkDur: 0.4,  atkStyle: 'bash', sway: 0.045 },
  knight:  { bobAmp: 3.5, bobFreq: 4.5, rotAmp: 0.04,  squash: 0.05,  lunge: 16, atkDur: 0.6,  atkStyle: 'slam', slamShake: 2 },
  climber: { bobAmp: 3,   bobFreq: 15,  rotAmp: 0.08,  squash: 0.06,  lunge: 22, atkDur: 0.25, atkStyle: 'slash' },
  elite:   { bobAmp: 3.5, bobFreq: 5,   rotAmp: 0.04,  squash: 0.045, lunge: 18, atkDur: 0.5,  atkStyle: 'slam', slamShake: 2 },
  captain: { bobAmp: 3,   bobFreq: 4,   rotAmp: 0.03,  squash: 0.03,  lunge: 20, atkDur: 0.55, atkStyle: 'command' },
  brute:   { bobAmp: 5,   bobFreq: 4,   rotAmp: 0.05,  squash: 0.05,  lunge: 22, atkDur: 0.7,  atkStyle: 'slam', slamShake: 6 },
  bannerlord: { bobAmp: 3, bobFreq: 5,  rotAmp: 0.04,  squash: 0.03,  lunge: 16, atkDur: 0.5,  atkStyle: 'command', sway: 0.04 },
  cart:    { bobAmp: 2,   bobFreq: 10,  rotAmp: 0.028, squash: 0,     lunge: 12, atkDur: 0.4,  atkStyle: 'bash', roll: true, fuse: true },
  ram:     { bobAmp: 2.5, bobFreq: 8,   rotAmp: 0.03,  squash: 0,     lunge: 32, atkDur: 0.55, atkStyle: 'ram',  roll: true, slamShake: 6 },
};
const DYING_TIME = 0.42;
const animOf = e => ANIM[e.type] || ANIM.soldier;

const BOSS_ORDER = ['captain', 'brute', 'bannerlord', 'cart', 'rams'];
const BOSS_INTRO = {
  captain: 'Siege Captain — his aura shields nearby foes. Throw enemies INTO him to break it!',
  brute: 'Hammer Brute — too heavy to lift. Drag and slam him, or wear him down!',
  bannerlord: 'Banner Lord — his banner drives the horde faster. Smash it with hard hits!',
  cart: 'Bomb Cart — hurl it away before it reaches your gate!',
  rams: 'Twin Rams — two siege beasts on separate lanes!',
};

/* ============================================================
   ECONOMY BALANCE
   Crowns (permanent treasury currency) arrive slowly — big
   unlocks should take multiple runs. Coins (in-run gold) flow
   generously per kill, but rooms cost 10x their old prices so
   every build is a real decision. Treasury crown prices are
   intentionally untouched.
   ============================================================ */
const ECONOMY = {
  crowns: {
    waveDivisor: 2,       // + floor(wavesSurvived / this)
    scoreDivisor: 2500,   // + floor(score / this)
    minimumPerRun: 1,
    riskModBank: 2,       // "Masons on Strike" instant banked crowns (was 6)
  },
  startingGold: 100,
  skipCardGold: 75,
  waveClearBase: 60,      // wave-clear gold bonus = (base + wave*perWave) * hp factor
  waveClearPerWave: 15,
  // (gold magnet tuning moved to PASSIVE_BALANCE.goldMagnetPerCombo)
};
/* ============================================================
   KINGDOM RESTORATION PASSIVES (read side)
   Restoring a district pays a permanent bonus to the core game at each of
   its four completion milestones. daily.js owns the numbers and DERIVES the
   totals from the saved checkpoints every time they are read, so nothing is
   accumulated or stored on this side: every consumer below simply asks for
   the current snapshot at the moment it needs it. That is what makes the
   bonuses correct for a brand-new run, a resumed saved run, a reopened app
   and a save written long before the passives existed, without a migration
   and without any chance of applying a reward twice.

   Deliberately NOT written as DAILY().kingdomBonuses(): this file evaluates
   coin and price text while it loads, before daily.js exists and before the
   DAILY binding is initialised, so the guard has to be a typeof test.
   ============================================================ */
const KR_BONUS_NONE = {
  castleHp: 0, treasuryDiscount: 0, roomDiscount: 0,
  archerDamage: 1, allyDamage: 1, throwDamage: 1, mageDamage: 1, coinGain: 1,
  stacks: {},
};
function kingdomBonus() {
  if (typeof CastleDaily === 'undefined' || !CastleDaily || typeof CastleDaily.kingdomBonuses !== 'function') return KR_BONUS_NONE;
  try {
    const b = CastleDaily.kingdomBonuses();
    return b || KR_BONUS_NONE;
  } catch (e) { return KR_BONUS_NONE; }
}
/* THE one place a Kingdom Restoration discount is applied to a price. Both
   the figure printed on a button and the figure actually charged call this,
   so they can never disagree, and the base price tables (ROOMS.costs, SHOP
   costs) are never rewritten — the discount is applied on read, every time. */
function krPrice(base, kind) {
  const b = kingdomBonus();
  const off = kind === 'room' ? b.roomDiscount : b.treasuryDiscount;
  if (!(off > 0)) return base;
  return Math.max(1, Math.round(base * (1 - off)));
}

const COIN_GAIN_MULTIPLIER = 0.1;
/* Every core-game coin reward funnels through here — kill gold, combo gold,
   wave-clear gold, the skip-card bonus — so the Festival Grounds coin bonus
   is applied exactly once, at the moment a reward is figured, and never on a
   save, a load or a wallet write. */
function scaleCoinReward(amount, minimum = 1) {
  const base = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const scaled = Math.floor(base * COIN_GAIN_MULTIPLIER * kingdomBonus().coinGain);
  return minimum > 0 && base > 0 ? Math.max(minimum, scaled) : scaled;
}

/* ============================================================
   PLATFORM INTEGRATION — purchases & ads (adapters in platform.js)
   The UI never grants rewards directly: purchases flow through
   StorePayments.purchase() -> grantPurchaseReward(), and rewarded
   ads only grant an upgrade credit after a confirmed completion.
   ============================================================ */
function grantPurchaseReward(purchaseResult) {
  if (!purchaseResult || !purchaseResult.success) return false;
  const product = IAP_PRODUCTS[purchaseResult.productId];
  if (!product) return false;
  if (!META.purchases) META.purchases = { transactions: {}, restored: false, lastRestoreAt: null };
  if (!META.purchases.transactions) META.purchases.transactions = {};
  // never grant the same store transaction twice
  if (purchaseResult.transactionId && META.purchases.transactions[purchaseResult.transactionId]) return false;
  // Crown Shop: purchases grant premium crowns (legacy coin products, if a
  // stored transaction ever replays one, still grant their coins safely)
  if (product.crowns) META.crowns += product.crowns;
  else if (product.coins) addGold(product.coins);
  /* Ad-free is the canonical entitlement, so acquiring it settles any
     outstanding forced-ad requirement on the spot — including one the player
     is looking at a connection prompt for right now. */
  if (product.adFreeIncluded) {
    META.adFree = true;
    clearPendingInterstitial('ad-free');
  }
  if (purchaseResult.transactionId) {
    META.purchases.transactions[purchaseResult.transactionId] = {
      productId: purchaseResult.productId,
      platform: purchaseResult.platform,
      grantedAt: Date.now(),
    };
  }
  saveMeta();
  return true;
}

async function restorePurchasesFlow() {
  const res = await StorePayments.restorePurchases();
  META.purchases.restored = true;
  META.purchases.lastRestoreAt = Date.now();
  let adFreeRestored = false;
  if (res && res.success && res.restored) {
    // restoring re-enables ad-free; consumable coins are NOT re-granted
    // unless the platform reports an unconsumed (never-granted) transaction
    for (const r of res.restored) {
      adFreeRestored = true;
      if (r.transactionId && !META.purchases.transactions[r.transactionId]) {
        grantPurchaseReward({ success: true, productId: r.productId, transactionId: r.transactionId, platform: res.platform });
      }
    }
  }
  // any previously recorded local transaction also proves ad-free entitlement
  if (Object.keys(META.purchases.transactions).length > 0) adFreeRestored = true;
  if (adFreeRestored) { META.adFree = true; clearPendingInterstitial('ad-free'); }
  saveMeta();
  return { success: !!(res && res.success), adFree: META.adFree };
}

/* ============================================================
   INTERSTITIAL PACING — one central gate

   Two placements, both at breaks where combat has already ended:
     wave_interval — every AD_GATE.waveInterval cleared waves, after the wave
                     bonus is banked and before the upgrade cards
     run_complete  — once the run is over and the game-over screen is up

   Every suppression rule lives in interstitialDue() rather than at the call
   site, so a new placement cannot accidentally bypass one. In particular the
   shared minSecondsBetween floor means the two placements can never stack into
   back-to-back ads when a run ends shortly after a wave-interval ad.

   REQUIRED, not opportunistic (2026-08-06). An interstitial that comes due is
   written to META.ads.pendingInterstitial BEFORE any load is attempted, and
   only a real presentation clears it. That is the fix for the offline bypass:
   the debt is created by the game's own pacing rules, never by whether an ad
   happened to be loaded, so pulling the network no longer makes the
   requirement evaporate — and because it lives in the save, neither does
   force-stopping the app. Exactly one requirement may be outstanding at a
   time, so time spent offline never builds a queue of ads to play back.

   The cadence numbers below are unchanged: this pass alters WHETHER a due ad
   can be skipped, never how often one comes due.
   ============================================================ */
const AD_GATE = {
  waveInterval: 5,            // between-wave interstitial cadence
  minSecondsBetween: 90,      // shared floor between ANY two interstitials
  minRunsBetween: 2,          // run-end placement only
  rewardedCooldownSec: 60,    // never immediately after a rewarded ad
  /* Online-but-no-ad handling. A provider outage or an empty bidder must never
     become a permanent lockout, so a bounded number of attempts is made and the
     requirement is then RELEASED. A confirmed-offline device never reaches
     this path — that one fails closed and stays pending. */
  providerAttempts: 3,
  providerCooldownMs: 1200,   // lets the load the plugin just kicked off land
};

/* Ad state machine. Diagnostic only — the requirement itself lives in META,
   which is what has to survive a restart. READY and SHOWING are owned by the
   native plugin (inventory and full-screen presentation are its facts, not
   ours) and appear here so a log line reads against the same vocabulary; this
   layer moves LOADING -> DISMISSED / FAILED_* on the plugin's verdict. */
const AD_STATE = {
  IDLE: 'IDLE', REQUIRED: 'REQUIRED', CHECKING_CONNECTION: 'CHECKING_CONNECTION',
  LOADING: 'LOADING', READY: 'READY', SHOWING: 'SHOWING', DISMISSED: 'DISMISSED',
  FAILED_OFFLINE: 'FAILED_OFFLINE', FAILED_PROVIDER: 'FAILED_PROVIDER',
};
let adGateState = AD_STATE.IDLE;
let adGateToken = 0;        // request id; a result carrying a stale one is dropped
let adGateRun = null;       // the single in-flight gate run (rapid taps share it)
let adProviderAttempts = 0;

/* Development logging: console only outside a production build, plus Logcat
   through the existing diagnostics interface. Never surfaced to a player, and
   never carries anything but ad placement/state. */
function adLog(event, data) {
  const line = '[ads] ' + event + (data ? ' ' + JSON.stringify(data) : '');
  if (!BUILD_CONFIG.isProduction) { try { console.log(line); } catch (e) { } }
  try {
    if (window.CastleFlingDiagnostics && window.CastleFlingDiagnostics.log) {
      window.CastleFlingDiagnostics.log(line);
    }
  } catch (e) { }
}

function adSetState(next, data) {
  if (adGateState === next) return;
  adGateState = next;
  adLog('state', Object.assign({ to: next }, data || {}));
}

/** Called whenever a rewarded ad completes, so the gate can stand off. */
function noteRewardedShown() {
  META.ads.lastRewardedAt = Date.now();
}

/* ------- the pending requirement ------- */

function pendingInterstitial() {
  const p = META.ads.pendingInterstitial;
  return (p && p.required !== false) ? p : null;
}

/* Whether the pacing rules say an interstitial is owed at this placement.
   Note what is deliberately NOT here any more: whether an ad is loaded.
   Availability decides whether an ad can be SHOWN, never whether one is OWED —
   conflating those two is what let a player switch off Wi-Fi and pay nothing. */
function interstitialDue(placement, waveNumber) {
  if (META.adFree) return false;                       // entitlement owned
  if (pendingInterstitial()) return false;             // one at a time, never a queue
  const a = META.ads, now = Date.now();
  if (a.lastRewardedAt && now - a.lastRewardedAt < AD_GATE.rewardedCooldownSec * 1000) return false;
  /* Shared floor. This is what stops a wave-10 ad being followed seconds later
     by a game-over ad when the castle falls on wave 11. */
  if (a.lastInterstitialAt && now - a.lastInterstitialAt < AD_GATE.minSecondsBetween * 1000) return false;
  if (placement === 'wave_interval') {
    if (!waveNumber || waveNumber % AD_GATE.waveInterval !== 0) return false;
    // one opportunity per wave number per run, even if the wave is re-entered
    if (a.lastInterstitialWave === waveNumber && G && G.interstitialsShownThisRun > 0) return false;
  }
  // run spacing applies to the end-of-run placement only, never between waves
  if (placement === 'run_complete'
      && a.lastInterstitialRun !== null
      && META.runs - a.lastInterstitialRun < AD_GATE.minRunsBetween) return false;
  return true;
}

/** Record the debt. Persisted immediately, BEFORE any load is attempted. */
function requireInterstitial(placement, waveNumber) {
  if (META.adFree) return null;
  const existing = pendingInterstitial();
  if (existing) return existing;
  META.ads.pendingInterstitial = {
    required: true, placement, wave: waveNumber || null, createdAt: Date.now(),
  };
  saveMeta();
  adSetState(AD_STATE.REQUIRED, { placement });
  adLog('requirement-created', { placement, wave: waveNumber || null });
  return META.ads.pendingInterstitial;
}

/* The ONLY three ways a requirement is cleared:
     'dismissed'            — loaded, presented full screen, then dismissed
     'ad-free'              — the player owns the entitlement
     'provider-unavailable' — online, but the ad network had nothing after
                              AD_GATE.providerAttempts tries
   Note what is absent: going offline, failing to load, failing to show,
   changing screens, backgrounding, restarting the app, and closing the
   connection prompt. */
function clearPendingInterstitial(why) {
  if (!META.ads.pendingInterstitial) return;
  const placement = META.ads.pendingInterstitial.placement;
  META.ads.pendingInterstitial = null;
  adGateToken++;                       // any in-flight result is now stale
  saveMeta();
  adLog('requirement-cleared', { placement, why });
}

/* Connectivity, tri-state (true / false / null-unknown). Only an explicit
   false blocks anything: "unknown" must read as online, or a device whose
   state we cannot query would be stuck behind a prompt it can never clear. */
function adConnectionState() {
  if (typeof Ads === 'undefined' || typeof Ads.isOnline !== 'function') return null;
  try { return Ads.isOnline(); } catch (e) { return null; }
}

/* ------- the gate -------
   runInterstitialGate resolves:
     'clear' — the caller may proceed
     'menu'  — the player chose Main Menu at the connection prompt, so the
               caller must abandon the transition it was about to make
   It never throws. Concurrent callers (a double tap, a button plus a lifecycle
   event) share ONE run and one outcome, so the continuation each is guarding
   can only ever fire once. */
let adGateRunAttemptOnly = false;
function runInterstitialGate(opts) {
  const o = opts || {};
  if (adGateRun) {
    /* A blocking request must never inherit the verdict of a background
       attemptOnly pass — that pass is allowed to give up quietly and would
       hand back "clear" without ever having settled the debt. Queue behind it
       instead and then run properly. Two blocking callers still share one run,
       which is what keeps a double tap to one ad and one continuation. */
    if (adGateRunAttemptOnly && !o.attemptOnly) {
      return adGateRun.then(() => runInterstitialGate(o));
    }
    return adGateRun;
  }
  adGateRunAttemptOnly = !!o.attemptOnly;
  const p = interstitialGateBody(o)
    .catch(e => { adLog('gate-exception', { message: String(e && e.message) }); return 'clear'; })
    .then(res => { adGateRun = null; adGateRunAttemptOnly = false; return res; });
  adGateRun = p;
  return p;
}

async function interstitialGateBody(opts) {
  const attemptOnly = !!opts.attemptOnly;   // never prompt, never release
  const midRun = !!opts.midRun;

  for (;;) {
    /* Entitlement first, and on every pass: a crown pack bought while the
       connection prompt is open must release the gate immediately. */
    if (META.adFree) {
      if (pendingInterstitial()) { adLog('ad-free-detected'); clearPendingInterstitial('ad-free'); }
      adSetState(AD_STATE.IDLE);
      return 'clear';
    }
    const pend = pendingInterstitial();
    if (!pend) { adSetState(AD_STATE.IDLE); return 'clear'; }

    const token = ++adGateToken;

    adSetState(AD_STATE.CHECKING_CONNECTION);
    let online = adConnectionState();
    // one fresh platform read before telling the player anything
    if (online === false && !attemptOnly) online = await Ads.refreshNetworkState();
    adLog('connection-state', { online: online === null ? 'unknown' : online });

    if (online === false) {
      adSetState(AD_STATE.FAILED_OFFLINE, { placement: pend.placement });
      if (attemptOnly) { adLog('offline-deferred', { placement: pend.placement }); return 'clear'; }
      const choice = await connectionRequiredPrompt(midRun);
      if (choice === 'menu') return 'menu';
      continue;                                    // Retry
    }

    adSetState(AD_STATE.LOADING, { placement: pend.placement });
    adLog('load-started', { placement: pend.placement });
    const result = await Ads.showInterstitial(pend.placement);

    /* Stale-result guard: the requirement this pass was settling is gone
       (entitlement granted, cleared elsewhere), so its outcome must not be
       applied to whatever replaced it. */
    if (token !== adGateToken) {
      adLog('stale-result-ignored', { placement: pend.placement });
      return 'clear';
    }

    if (result && result.success && result.shown) {
      /* loaded -> presented full screen -> dismissed. platform.js reports
         shown only for a native dismissal that followed a real presentation;
         a show-failure comes back shown:false and falls through below. */
      adSetState(AD_STATE.DISMISSED, { placement: pend.placement });
      adProviderAttempts = 0;
      if (G) G.interstitialsShownThisRun = (G.interstitialsShownThisRun || 0) + 1;
      META.ads.totalInterstitialsShown++;
      META.ads.lastInterstitialAt = Date.now();
      META.ads.lastInterstitialRun = META.runs;
      if (pend.placement === 'wave_interval' && pend.wave) META.ads.lastInterstitialWave = pend.wave;
      adLog('ad-dismissed', { placement: pend.placement });
      clearPendingInterstitial('dismissed');       // saves
      adSetState(AD_STATE.IDLE);
      return 'clear';
    }

    const reason = (result && result.reason) || 'failed';
    adLog('show-failed', { placement: pend.placement, reason });

    /* Classify the failure. Losing the connection DURING the attempt lands
       here too, which is why connectivity is re-read rather than reused. */
    let nowOnline = adConnectionState();
    if (nowOnline !== false && !attemptOnly) nowOnline = await Ads.refreshNetworkState();
    if (nowOnline === false) {
      adSetState(AD_STATE.FAILED_OFFLINE, { placement: pend.placement });
      if (attemptOnly) { adLog('offline-deferred', { placement: pend.placement }); return 'clear'; }
      const choice = await connectionRequiredPrompt(midRun);
      if (choice === 'menu') return 'menu';
      continue;
    }

    adSetState(AD_STATE.FAILED_PROVIDER, { placement: pend.placement, reason });
    if (attemptOnly) return 'clear';               // debt stands; settled later
    adProviderAttempts++;
    if (adProviderAttempts >= AD_GATE.providerAttempts) {
      /* Online, but the ad network has nothing to give. That is not the
         player's doing and must not lock them out of their own game — release
         the requirement, exactly as the pre-gate build would have continued. */
      adLog('provider-unavailable-released', { attempts: adProviderAttempts, reason });
      adProviderAttempts = 0;
      clearPendingInterstitial('provider-unavailable');
      adSetState(AD_STATE.IDLE);
      return 'clear';
    }
    await new Promise(r => setTimeout(r, AD_GATE.providerCooldownMs));
  }
}

/* The one blocking prompt. Reuses the themed confirm modal so it inherits the
   panel art, safe-area padding, landscape fit and Android back handling (back
   = Main Menu, which is the safe exit) instead of introducing a second modal
   system. Carries no SDK error codes, and only one can ever be open because
   the gate is single-flight. */
let connPromptOpen = false;
function connectionRequiredPrompt(midRun) {
  const tail = midRun
    ? ' Returning to the main menu will end this run — every coin and crown earned so far is kept.'
    : '';
  connPromptOpen = true;
  adLog('connection-prompt-shown', { midRun });
  return gameConfirm(
    'An internet connection is required to continue this ad-supported session. Reconnect and try again.' + tail,
    { title: 'Internet Connection Required', okText: 'Retry', cancelText: 'Main Menu' })
    .then(ok => {
      connPromptOpen = false;
      adLog('connection-prompt-choice', { choice: ok ? 'retry' : 'menu' });
      return ok ? 'retry' : 'menu';
    });
}

/* Connectivity or ad inventory changed. Registered ONCE — Ads.onStatusChange
   ignores a repeat subscription of the same function — so reconnecting can
   never accumulate duplicate listeners. */
function onAdStatusChanged() {
  resetWatchAdButton();
  if (connPromptOpen && adConnectionState() !== false) {
    const msg = $('confirmMsg');
    if (msg) msg.textContent = 'Connection restored. Tap Retry to continue.';
  }
}

/* ------- gated transitions -------
   Wave cleared: the gated transition is the upgrade-card screen. The wave is
   already over and the field is clear, so this is a break, not an interruption
   — combat is never covered. */
function gateWaveClearTransition(bonusText) {
  if (interstitialDue('wave_interval', G.wave)) requireInterstitial('wave_interval', G.wave);
  runInterstitialGate({ midRun: true }).then(res => {
    if (res === 'menu') { leaveRunForMenu(); return; }
    showCardScreen(bonusText, 3);
  });
}

/* Player chose Main Menu at the connection prompt during a run. Same terms as
   Abandon Run: the run ends, everything earned is banked and kept, and the ad
   requirement deliberately survives — it is settled before the next run. */
function leaveRunForMenu() {
  bankRunCrowns(true);
  saveMeta();
  Music.duck();
  openMenu();
}

/* Every doorway into ad-supported gameplay runs through here, which is what
   makes force-closing the app while a requirement is pending pointless: the
   debt is in the save and is settled before the next run begins. */
function gateEnterGameplay(go, onMenu) {
  runInterstitialGate({ midRun: !!onMenu }).then(res => {
    if (res === 'menu') { (onMenu || openMenu)(); return; }
    go();
  });
}

/* rewarded ad -> exactly one extra between-wave upgrade credit.
   Available to everyone — ad-free only removes FORCED ads. */
let rewardedInFlight = false;
async function watchAdForExtraUpgrade() {
  const btn = $('btnWatchAdUpgrade');
  /* One attempt at a time. The button is disabled below, but a repeated tap
     can still land in the frame before that paints. */
  if (rewardedInFlight) return;
  /* Offline: refuse before anything is spent. Nothing is deducted, no free
     pick or credit is consumed, no claimed state is written and no success
     animation plays — the panel is exactly as the player left it, and the
     button returns to normal on its own when the connection comes back
     (onAdStatusChanged -> resetWatchAdButton). */
  if (adConnectionState() === false) {
    adLog('rewarded-blocked-offline');
    $('noUpgradeMsg').textContent = 'No internet connection. Reconnect to watch an ad for an extra upgrade.';
    resetWatchAdButton();
    return;
  }
  if (!Ads.isAvailable()) {
    $('noUpgradeMsg').textContent = 'Rewarded ads are not available on this platform.';
    return;
  }
  if (!Ads.isRewardedAvailable()) {
    // online, just nothing loaded yet — asking for one starts a fresh load
    $('noUpgradeMsg').textContent = 'No ad is ready just yet. Try again in a moment.';
    adLog('rewarded-not-loaded');
    return;
  }
  rewardedInFlight = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Loading ad…'; }
  adLog('rewarded-show-started');
  const result = await Ads.showRewarded('extra_upgrade');
  rewardedInFlight = false;
  /* Restore the button UNCONDITIONALLY. Resetting it only on the failure path
     left a successful watch with the label stuck on "Loading ad…", so the next
     time the panel appeared the button read as permanently busy. */
  resetWatchAdButton();
  /* The grant condition is unchanged and deliberately narrow: platform.js sets
     these only from the native OnUserEarnedRewardListener. Dismissal, load
     completion, show completion, a timeout, a lost connection and app resume
     all land in the else branch. */
  if (result && result.success && result.rewarded && result.completed) {
    adLog('reward-callback-fired', { placement: 'extra_upgrade' });
    G.rewardedUpgradeCredits++;
    META.ads.totalRewardedCompleted++;
    noteRewardedShown();   // stand the interstitial gate off for a while
    saveMeta();
    showCardScreen($('cardBonusText').innerHTML, G.pendingCardCount || 3);
  } else {
    adLog('reward-not-granted', { reason: (result && result.reason) || 'unknown' });
    $('noUpgradeMsg').textContent = adConnectionState() === false
      ? 'Connection lost. No upgrade was granted.'
      : 'Ad was not completed. No upgrade was granted.';
  }
}

/* The rewarded button's resting state, in one place. Called after every ad
   attempt, every time the panel is rendered, and on every connectivity change,
   so the label can never be left stranded by a path that returns early. */
function resetWatchAdButton() {
  const btn = $('btnWatchAdUpgrade');
  if (!btn) return;
  if (rewardedInFlight) return;                  // a live attempt owns the label
  const offline = adConnectionState() === false;
  btn.disabled = offline;
  btn.textContent = offline ? 'Internet Required' : 'Watch Ad';
}

/* save on every lifecycle edge the platform gives us */
function lifecycleSave() {
  const runActive = G && G.wave > 0 && state !== 'gameover' && state !== 'menu';
  if (runActive) bankRunCrowns(false);
  saveMeta();
}
/* backgrounding / interruptions (home button, incoming call, app switch):
   save, auto-pause combat, stop the render loop, and silence ALL audio so
   nothing plays over a call; everything resumes from the same spot on return.
   The OS reclaiming a backgrounded app is normal — the session is marked
   clean on hide and dirty again on show, so only a death while VISIBLE
   counts as an unexpected end (Task: preserve crash info across restarts). */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    CrashDiagnostics.record('app-backgrounded');
    lifecycleSave();
    if (state === 'playing') pauseGame();   // lifecycle pause reuses the pause menu — the run is NOT reset
    if (RICO()) RICO().lifecyclePause();    // same rule for an active Castle Ricochet shot
    Music.stop();
    Sfx.suspend();
    stopGameLoop();                          // no rendering/simulation while hidden
    CrashDiagnostics.markClean(true);
  } else {
    CrashDiagnostics.markClean(false);
    CrashDiagnostics.record('app-foregrounded');
    startGameLoop();                         // guarded: can never start a second loop
    if (META.settings.music && Music.isStarted()) syncMusic();
  }
});
window.addEventListener('pagehide', () => { lifecycleSave(); CrashDiagnostics.markClean(true); });
window.addEventListener('beforeunload', () => { lifecycleSave(); CrashDiagnostics.markClean(true); });

/* ---------------- roguelite upgrade cards ---------------- */
/* art: trimmed PNG (in ui-trimmed/) shown on upgrade cards */
/* Descriptions must always match PASSIVE_BALANCE — final nerfed values */
const UPGRADES = [
  { id: 'strongThrows', name: 'Stronger Throws', icon: '💪', art: 'upgrade_junk_cannon.png',         max: 3, desc: 'Thrown enemies deal +5% impact damage.' },
  { id: 'doubleGrab',   name: 'Double Grab',     icon: '🤲', art: 'icon_convert.png',                max: 2, desc: '5% chance to grab a second small enemy nearby.' },
  { id: 'bounceDmg',    name: 'Bounce Damage',   icon: '🏀', art: 'upgrade_glue_trap_cauldron.png',  max: 3, desc: 'Enemies take +5% damage from bounces.' },
  { id: 'gate',         name: 'Reinforced Gate', icon: '🚪', art: 'upgrade_reinforced_gate.png',     max: 3, desc: 'Castle takes 5% less melee damage.' },
  { id: 'quickMasons',  name: 'Quick Masons',    icon: '🧱', art: 'icon_repair.png',                 max: 3, desc: 'Castle repairs are 5% faster.' },
  { id: 'archerFocus',  name: 'Archer Focus',    icon: '🎯', art: 'icon_archer.png',                 max: 1, desc: 'Archers target bomb carriers first and deal +5% damage.' },
  { id: 'mageBattery',  name: 'Mage Battery',    icon: '🔋', art: 'fix_shield_generator.png',        max: 2, desc: 'Ability cooldowns recharge 5% faster.' },
  { id: 'goldMagnet',   name: 'Gold Magnet',     icon: '🧲', art: 'fix_gold_vault.png',              max: 3, desc: 'Combo kills grant a little bonus gold. Builds a vault by the keep.' },
  { id: 'convRush',     name: 'Conversion Rush', icon: '✨', art: 'upgrade_conversion_barracks.png', max: 2, desc: 'Converted units join 5% faster.' },
  { id: 'panicBell',    name: 'Panic Bell',      icon: '🔔', art: 'fix_bell_tower.png',              max: 1, desc: 'New ability: once per wave, briefly stun enemies near the castle.' },
  { id: 'heavyGrip',    name: 'Heavy Grip',      icon: '🦾', art: 'icon_upgrade.png',                max: 1, desc: 'Medium enemies lift instantly.' },
  { id: 'chainReact',   name: 'Chain Reaction',  icon: '🧨', art: 'icon_bomb.png',                   max: 1, desc: 'Bomb carriers never damage the castle.' },
];

/* ---------------- castle rooms ---------------- */
/* info(lv) always describes what the room does AT level lv — the build screen
   passes lv+1 so cards preview the NEXT upgrade, never the one already owned */
/* 2026-07 balance pass: every castle room upgrade cost +20% (was 500/850/…),
   offsetting the −25% spawn rate. Values stay clean multiples of 10. */
const ROOMS = {
  archer:   { name: 'Archer Tower', icon: '🏹', art: 'fix_archer_platform.png', max: 5, costs: [600, 1020, 1560, 2220, 3000],
    info: lv => lv === 1 ? `Unlocks auto-fire: every ${archerInterval(1).toFixed(1)}s for ${archerDmg(1)} dmg.`
      : `Fires every ${archerInterval(lv).toFixed(1)}s for ${archerDmg(lv)} dmg.` },
  mason:    { name: 'Mason Room', icon: '🧱', art: 'fix_mason_workshop.png', max: 5, costs: [540, 900, 1380, 1980, 2700],
    info: lv => (lv === 1 ? `Starts auto-repair: ${masonRate(1).toFixed(1)} HP/s.`
      : `Repairs ${masonRate(lv).toFixed(1)} HP/s.`) + (lv >= 3 ? ' Emergency burst below 25% HP.' : '') },
  mage:     { name: 'Mage Tower', icon: '🔮', art: 'fix2_mage_tower.png', max: 5, costs: [840, 1320, 1920, 2520, 3240],
    info: lv => ['', 'Unlocks Lightning Strike ⚡.', 'Unlocks Frost Field ❄.', 'Unlocks Shield Burst 🛡.', '+30% spell power.', '+30% spell power, -20% cooldowns.'][lv] },
  bomb:     { name: 'Bomb Workshop', icon: '💣', art: 'fix_bomb_workshop.png', max: 4, costs: [720, 1200, 1800, 2520],
    info: lv => lv === 1 ? `Unlocks rolling bomb: ${bombDmg(1)} dmg, ${bombCd(1)}s cooldown.`
      : `Rolling bomb: ${bombDmg(lv)} dmg, ${bombCd(lv)}s cooldown.` },
  barracks: { name: 'Conversion Barracks', icon: '⚜', art: 'upgrade_conversion_barracks.png', max: 4, costs: [660, 1080, 1680, 2400],
    info: lv => `Convert foes under ${Math.round(convertThreshold(lv) * 100)}% HP (1/wave). Recruits: ${20 + lv * 12} HP, ${6 + lv * 3} dmg.` },
  wall:     { name: 'Wall Forge', icon: '🛡', art: 'fix2_wall_forge.png', max: 5, costs: [600, 1020, 1560, 2220, 3000],
    info: lv => `+80 max HP & +1 armor (after: +${lv * 80} HP, ${lv} armor).` },
};

/* ---------------- starting castles ---------------- */
const CASTLES = [
  { id: 'stonekeep',    name: 'Stonekeep',     icon: '🏰', art: 'upgrade_reinforced_gate.png', hp: 520, goldMult: 1.0, desc: 'Balanced walls and steady gold.', shop: null },
  { id: 'ironwall',     name: 'Ironwall',      icon: '🛡', art: 'fix2_wall_forge.png', hp: 700, goldMult: 0.8, armor: 1, desc: '+35% health, +1 armor, slower gold gain.', shop: 'castle_ironwall' },
  { id: 'spellspire',   name: 'Spellspire',    icon: '🔮', art: 'fix2_mage_tower.png', hp: 420, goldMult: 1.0, mage: 1, desc: 'Starts with a Mage Tower. Weaker walls.', shop: 'castle_spellspire' },
  { id: 'barrackshold', name: 'Barracks Hold', icon: '⚜', art: 'upgrade_conversion_barracks.png', hp: 520, goldMult: 1.0, barracks: 1, masonMult: 0.5, convertBonus: 0.15, desc: 'Starts with Barracks, easy conversion, weak repairs.', shop: 'castle_barrackshold' },
];

/* ---------------- meta shop (permanent unlocks) ---------------- */
/* art: PNG icon from the royal-treasury pack (rendered instead of the emoji;
   the emoji remains a fallback if the image ever fails to load).
   banner-class icons render slightly narrower per the pack's guidance. */
const TREASURY_ART = PACKS.v1 + 'royal-treasury/sprites/treasury/';
const SHOP = [
  /* prices ×10 across the board (2026-07 pricing pass); crimson/azure banner
     cosmetics removed — old saves are migrated at load */
  { id: 'castle_ironwall',     name: 'Ironwall Castle',   icon: '🛡', art: 'treasury_ironwall_castle.png',   cost: 300, desc: 'Unlock a fortress with mighty walls but slower gold.' },
  { id: 'castle_spellspire',   name: 'Spellspire Castle', icon: '🔮', art: 'treasury_spellspire_castle.png', cost: 500, desc: 'Unlock a castle that begins with a Mage Tower.' },
  { id: 'castle_barrackshold', name: 'Barracks Hold',     icon: '⚜', art: 'treasury_barracks_hold.png',     cost: 500, desc: 'Unlock a castle built around converting enemies.' },
  { id: 'hand_titan',          name: 'Titan Grip',        icon: '🦾', art: 'treasury_titan_grip.png',        cost: 400, desc: 'Hand power: heavy enemies can be fully lifted.' },
  { id: 'hand_storm',          name: 'Storm Fingers',     icon: '🌩', art: 'treasury_storm_fingers.png',     cost: 600, desc: 'Hand power: enemies you slam hard into the ground release an electric shock nova.' },
  { id: 'hand_midas',          name: 'Golden Touch',      icon: '🪙', art: 'treasury_golden_touch.png',      cost: 500, desc: 'Hand power: +15% gold from all sources.' },
  { id: 'room_ballista',       name: 'Ballista Variant',  icon: '🏹', art: 'treasury_ballista_variant.png',  cost: 450, desc: 'Archer Tower fires slow piercing bolts instead.' },
  { id: 'contract_chaos',      name: 'Chaos Contract',    icon: '🎲', art: 'treasury_chaos_contract.png',    cost: 250, desc: 'Rare golden enemies appear, worth 5× gold.' },
  { id: 'challenge_nightmare', name: 'Nightmare Sigil',   icon: '💀', art: 'treasury_nightmare_sigil.png',   cost: 800, desc: 'Unlock Nightmare mode: brutal enemies, double crowns.' },
  { id: 'skin_spectral',       name: 'Spectral Hand',     icon: '👻', art: 'treasury_spectral_hand.png',     cost: 200, desc: 'Cosmetic: a ghostly blue hand. Click to equip.', cosmetic: 'hand', skin: 'spectral' },
  { id: 'skin_royal',          name: 'Royal Gauntlet',    icon: '👑', art: 'treasury_royal_gauntlet.png',    cost: 300, desc: 'Cosmetic: a gilded royal gauntlet. Click to equip.', cosmetic: 'hand', skin: 'royal' },
];

/* ---------------- wave modifiers (risk/reward) ---------------- */
/* art: emblem from the ui-polish bargain set, matched by effect */
const MODIFIERS = [
  { id: 'horde',    name: 'Green Tide',       icon: '👥', art: 'bargain_golden_greed.png',    desc: '+40% more enemies this wave. All gold earned +60%.' },
  { id: 'swift',    name: 'War Drums',        icon: '🥁', art: 'bargain_time_warp.png',       desc: 'Enemies move 30% faster. +10% gold earned this wave.' },
  { id: 'norepair', name: 'Masons on Strike', icon: '🚫', art: 'bargain_shattered_armor.png', desc: 'No repairs this wave. +2 crowns banked immediately.' },
  { id: 'elite',    name: 'Elite Raid',       icon: '💂', art: 'bargain_nightmare_pact.png',  desc: `Two Elite Guards join this wave. +${scaleCoinReward(60)} bonus gold on clear.` },
  { id: 'overload', name: 'Arcane Overload',  icon: '⚡', art: 'bargain_arcane_overload.png', desc: 'Ability cooldowns halved this wave, but enemies gain +25% HP.' },
];

/* ============================================================
   RUN STATE
   ============================================================ */
let state = 'menu';   // menu | castle | meta | howto | settings | playing | cards | build | modifier | paused | gameover
let G = null;         // current run
let selectedCastle = 0;
let idCounter = 1;

function newRun(castleIdx) {
  const c = CASTLES[castleIdx];
  G = {
    castle: c,
    castleMax: c.hp, castleHp: c.hp,
    gold: META.coins, score: 0, wave: 0,   // gold IS the persistent wallet
    freeUpgradesUsed: 0, freeUpgradeLimit: 4, rewardedUpgradeCredits: 0,
    interstitialsShownThisRun: 0, crownsBankedSoFar: 0,
    nightmare: META.settings.nightmare && owns('challenge_nightmare'),
    enemies: [], arrows: [], bombs: [], defenders: [], corpses: [],
    particles: [], floaters: [], slowFields: [],
    shake: 0, flash: 0, time: 0,
    upgrades: {},                                     // id -> stacks
    rooms: { archer: 0, mason: 0, mage: c.mage || 0, bomb: 0, barracks: c.barracks || 0, wall: 0 },
    recruits: { total: 0, gate: 0, archer: 0, mason: 0 },
    abilities: [], cdStore: {},
    // wave bookkeeping
    spawnQueue: [], waveActive: false, banner: null, bannerT: 0,
    mod: null, pendingMod: null, bankedCrowns: 0,
    shieldT: 0, shieldMax: 0, bellUsed: false, emergencyUsed: false,
    combo: { n: 0, t: 0, best: 0 },
    archerCd: 0, masonAcc: 0,
    stats: { kills: 0, throws: 0, converts: 0, maxCombo: 0 },
    bossAlive: null,
  };
  /* Outer Walls: every restoration milestone permanently raises the castle's
     maximum health. Recorded on the run as well as added, so a run saved with
     one bonus and resumed with another can be reconciled exactly (see
     continueSavedRun) instead of compounding. */
  G.krHpBonus = Math.round(kingdomBonus().castleHp);
  G.castleMax = Math.round(G.castleMax) + G.krHpBonus;
  G.castleHp = G.castleMax;
}

/* ------- derived stats (upgrades + rooms + meta) ------- */
const up = id => (G && G.upgrades[id]) || 0;
function armorTotal() { return (G.castle.armor || 0) + G.rooms.wall; }
/* PASSIVE_BALANCE — final tuning: free between-wave passives are deliberately
   small per stack (~5%) so they nudge a run rather than break it. Every value
   here must match its card description in UPGRADES. */
const PASSIVE_BALANCE = {
  gateReduction: 0.05,        // was 0.20
  throwDamageBonus: 0.05,     // was 0.35
  bounceDamageBonus: 0.05,    // was 0.40
  cooldownBonus: 0.05,        // was 0.25
  masonSpeedBonus: 0.05,      // was 0.50
  convertSpeedBonus: 0.05,    // was 0.25
  doubleGrabChance: 0.05,     // was 0.30
  archerFocusDamage: 1.05,    // was 1.20
  goldMagnetPerCombo: 1,      // was 4
  bellStunSeconds: 2,         // was 3
};
function meleeReduction() { return 1 - PASSIVE_BALANCE.gateReduction * up('gate'); }
/* Blacksmith Quarter rides here, on the ONE multiplier every throwing-damage
   site already reads (slam impacts, billiard hits, ground slams, the Storm
   Fingers nova). Anything that gets its damage from another system — arrows,
   bombs, spells, recruits — never calls this, so it cannot be paid twice. */
function throwPowerMult() { return (1 + PASSIVE_BALANCE.throwDamageBonus * up('strongThrows')) * kingdomBonus().throwDamage; }
function bounceMult() { return 1 + PASSIVE_BALANCE.bounceDamageBonus * up('bounceDmg'); }
function goldMult() {
  let m = G.castle.goldMult * (owns('hand_midas') ? 1.15 : 1);
  if (G.mod === 'horde') m *= 1.6;
  if (G.mod === 'swift') m *= 1.1;   // War Drums: +10% gold for the faster wave
  return m;
}
function cdMult() {
  let m = 1 - PASSIVE_BALANCE.cooldownBonus * up('mageBattery');
  if (G.rooms.mage >= 5) m *= 0.8;
  if (G.mod === 'overload') m *= 0.5;
  if (G.siegeCdMult) m *= G.siegeCdMult;   // Daily Siege "Quickened Arts" modifier
  return Math.max(0.2, m);
}
function spellPower() { return 1 + (G.rooms.mage >= 4 ? 0.3 : 0) + (G.rooms.mage >= 5 ? 0.3 : 0); }
function archerInterval(lv) { return Math.max(0.35, (owns('room_ballista') ? 2.6 : 1.6) - lv * (owns('room_ballista') ? 0.35 : 0.22)); }
/* Barracks rides here: the Archer Tower's damage is computed in exactly one
   place, and the room card's "for N dmg" line reads the same function, so the
   number the player is shown is the number the arrow carries. */
function archerDmg(lv) { return Math.round((owns('room_ballista') ? 34 : 10) * (1 + (lv - 1) * 0.45) * (up('archerFocus') ? PASSIVE_BALANCE.archerFocusDamage : 1) * kingdomBonus().archerDamage); }
/* Mage District: applied to attacks deliberately classified as mage damage —
   today that is the Lightning strike, the only mage-tower ability that deals
   damage. NOT the Archer Tower, thrown bodies, bombs or recruited allies. */
function mageDamageMult() { return kingdomBonus().mageDamage; }
/* Adventurers' Guild: one shared modifier for every friendly unit the player
   creates, whether it was recruited between waves or converted mid-fight.
   Both paths spawn the same defender and both strike through updateDefenders,
   so this is read at the single point those attacks resolve. */
function allyDamageMult() { return kingdomBonus().allyDamage; }
function masonRate(lv) { return lv * 1.4 * (1 + PASSIVE_BALANCE.masonSpeedBonus * up('quickMasons')) * (G.castle.masonMult || 1); }
function bombDmg(lv) { return 60 + lv * 30; }
function bombCd(lv) { return Math.max(8, 18 - lv * 2); }
function barracksLv() { return G ? G.rooms.barracks : 0; }
function convertThreshold(lv = barracksLv()) { return clamp(0.35 + lv * 0.08 + (G.castle.convertBonus || 0), 0, 0.85); }
function convertTime() { return Math.max(0.35, (1.4 - barracksLv() * 0.15) * (1 - PASSIVE_BALANCE.convertSpeedBonus * up('convRush'))); }

/* ============================================================
   PARTICLES / FLOATERS / EFFECTS
   Hard caps (S20 FE stability pass): dense late-game moments —
   Storm Fingers novas into packed hordes, boss deaths, chained
   bomb blasts — must never grow the effect arrays without
   bound. At the cap the OLDEST effect is recycled, so the
   visual identity (newest, most relevant effects) is untouched.
   ============================================================ */
const MAX_ACTIVE_PARTICLES = 250;   // includes rings, slashes and bolts
const MAX_ACTIVE_FLOATERS = 50;     // damage numbers + combo/notice text
const MAX_GROUND_DECALS = 40;       // death marks / scorch craters
function pushParticle(p) {
  if (G.particles.length >= MAX_ACTIVE_PARTICLES) G.particles.shift();
  G.particles.push(p);
}
function pushCorpse(c) {
  if (G.corpses.length >= MAX_GROUND_DECALS) G.corpses.shift();
  G.corpses.push(c);
}
function puff(x, y, n, color, spd = 120, size = 5, grav = 0, life = 0.6) {
  if (!META.settings.particles) n = Math.ceil(n / 2);
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), s = rand(spd * 0.3, spd);
    pushParticle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - spd * 0.3, life: rand(life * 0.5, life), maxLife: life, size: rand(size * 0.5, size), color, grav });
  }
}
function dustLanding(x, y, power) {
  const n = clamp(Math.round(power * 10), 4, 26);
  for (let i = 0; i < n; i++) {
    const a = rand(-0.4, 0.4) + (i % 2 ? 0 : Math.PI);
    const s = rand(40, 100 + power * 60);
    pushParticle({ x, y, vx: Math.cos(a) * s, vy: -rand(20, 60 + power * 30), life: rand(0.3, 0.7), maxLife: 0.7, size: rand(3, 7 + power * 2), color: '#b9a37e', grav: 300 });
  }
}
function sparks(x, y, n, color = '#ffd77a') { puff(x, y, n, color, 260, 3, 500, 0.45); }
/* expanding aura ring (flattened ellipse, colorPrefix like 'rgba(255,90,70,') */
function spawnRing(x, y, r0, r1, colorPrefix, life = 0.7) {
  pushParticle({ ringP: { r0, r1, c: colorPrefix }, x, y, vx: 0, vy: 0, life, maxLife: life, size: 0, color: '' });
}
/* quick weapon arc (gold/white crescent) */
function spawnSlash(x, y, ang, size, colorPrefix, life = 0.22) {
  pushParticle({ slashP: { ang, size, c: colorPrefix }, x, y, vx: 0, vy: 0, life, maxLife: life, size: 0, color: '' });
}

/* ============================================================
   ENEMY ANIMATION HELPERS (procedural, transform-based)
   ============================================================ */
function triggerEnemyAttackAnim(e) {
  const a = animOf(e);
  e.atkAnimT = a.atkDur;
  const cx = e.x - e.r - 8, cy = e.y - e.def.dispH * 0.45;
  switch (a.atkStyle) {
    case 'slash':
      spawnSlash(cx, cy, rand(-0.6, 0.1), Math.max(24, e.def.dispH * 0.28), 'rgba(255,240,190,');
      break;
    case 'bash':
      sparks(cx, cy, 6, '#ffd77a');
      puff(cx, e.y, 4, '#b9a37e', 80, 4, 150, 0.4);
      break;
    case 'slam':
      dustLanding(e.x - e.r, e.gy, 0.8);
      sparks(cx, cy, 8, '#ffdf9a');
      addShake(a.slamShake || 2);
      break;
    case 'magic':
      spawnRing(cx + 10, cy, 12, 60, 'rgba(190,140,255,', 0.5);
      sparks(cx, cy, 5, '#d9b6ff');
      break;
    case 'command':
      spawnRing(e.x, cy, 20, 150, 'rgba(255,80,60,', 0.7);
      sparks(cx, cy, 6, '#ff9d45');
      break;
    case 'ram':
      dustLanding(e.x - e.r, e.gy, 1.2);
      addShake(a.slamShake || 5);
      sparks(cx, e.y - 24, 10, '#ffdf9a');
      break;
  }
}

function updateEnemyAnimation(e, dt) {
  if (e.atkAnimT > 0) e.atkAnimT = Math.max(0, e.atkAnimT - dt);
  if (e.squashT > 0) e.squashT = Math.max(0, e.squashT - dt);
  const a = animOf(e);
  // keep the step cycle ticking while in the ready stance
  if (e.state === 'attack' && e.stunT <= 0) e.walkPhase += dt * a.bobFreq * 0.5;
  if (e.hp <= 0) return;
  // fuse sparkle on bomb units
  if (a.fuse && (e.state === 'walk' || e.state === 'attack' || e.state === 'stunned') && Math.random() < dt * 8) {
    sparks(e.x + e.def.dispH * 0.1, e.y - e.def.dispH + rand(0, 10), 1, '#ffd24a');
  }
  // banner units pulse their rally aura
  if (e.def.bannerman && (e.state === 'walk' || e.state === 'attack') && !(e.def.boss === 'bannerlord' && e.bannerHp <= 0)) {
    e.auraT = (e.auraT || rand(0, 2)) - dt;
    if (e.auraT <= 0) { e.auraT = 2.6; spawnRing(e.x, e.y - 20, 26, e.def.boss ? 210 : 150, 'rgba(255,90,70,', 0.9); }
  }
  // siege captain menace pulse while shielded
  if (e.def.boss === 'captain' && e.shieldStacks > 0) {
    e.auraT = (e.auraT || 0) - dt;
    if (e.auraT <= 0) { e.auraT = 1.7; spawnRing(e.x, e.y - e.def.dispH / 2, 30, 180, 'rgba(110,190,255,', 0.9); }
  }
  // healer staff shimmer
  if (e.def.healer && Math.random() < dt * 5) {
    puff(e.x - e.def.dispH * 0.25, e.y - e.def.dispH * 0.82, 1, '#d9b6ff', 25, 3, -40, 0.5);
  }
}

/* single source of truth for the sprite's draw transform.
   dx/dy offset (px) · rot radians · sx/sy scale (bottom-anchored) · alpha */
function getEnemyDrawTransform(e) {
  const a = animOf(e);
  const tf = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, alpha: 1, glow: false };
  switch (e.state) {
    case 'walk': {
      const ph = e.walkPhase;
      if (a.roll) {                       // siege carts: rolling wobble, no leg bounce
        tf.rot = Math.sin(ph) * a.rotAmp;
        tf.dy = -Math.abs(Math.sin(ph * 2)) * a.bobAmp * 0.5;
      } else if (a.float) {               // healer: hover drift
        tf.dy = -(4 + Math.sin(ph) * a.bobAmp);
        tf.rot = Math.sin(ph * 0.5) * 0.02;
      } else {
        tf.dy = -Math.abs(Math.sin(ph)) * a.bobAmp;
        tf.rot = Math.sin(ph) * a.rotAmp - 0.015;      // step cycle + slight forward lean
        const sq = Math.sin(ph * 2) * a.squash;
        tf.sy = 1 + sq; tf.sx = 1 - sq * 0.7;
      }
      if (a.jitter) tf.dx += Math.sin(ph * 7) * a.jitter;   // nervous bomb carrier
      if (a.sway) tf.rot += Math.sin(ambientT * 2.2 + e.id) * a.sway;
      break;
    }
    case 'attack':
      tf.dy = -Math.abs(Math.sin(e.walkPhase)) * a.bobAmp * 0.4;
      tf.rot = -0.02;
      if (a.sway) tf.rot += Math.sin(ambientT * 2.2 + e.id) * a.sway;
      break;
    case 'grab':
      if (e.lifted) { tf.sx = tf.sy = 1.06; tf.rot = Math.sin(ambientT * 6 + e.id) * 0.06; tf.glow = true; }
      else tf.rot = Math.sin(ambientT * 30) * 0.12;          // struggle
      break;
    case 'thrown':
      tf.rot = e.spinA || 0;                                 // velocity-driven spin
      break;
    case 'stunned':
      tf.rot = Math.sin(ambientT * 3 + e.id) * 0.05;
      break;
    case 'climb':
      tf.rot = -0.12 + Math.sin(e.walkPhase * 2) * 0.08;     // twitchy crawl
      tf.dx = Math.sin(e.walkPhase * 3) * 2;
      break;
    case 'dying': {
      const p = clamp(e.dyingT / DYING_TIME, 0, 1);
      tf.rot = (e.dyingDir || 1) * p * 3.2;
      const s = 1 + Math.sin(p * Math.PI) * 0.18 - p * 0.55; // pop then shrink
      tf.sx = tf.sy = Math.max(0.25, s);
      tf.alpha = 1 - p * 0.9;
      tf.dy = -Math.sin(p * Math.PI) * 14;
      break;
    }
  }
  // attack lunge overlay (visual only; damage cadence lives in combat logic)
  if (e.atkAnimT > 0 && a.atkDur) {
    const p = 1 - e.atkAnimT / a.atkDur;
    if (a.atkStyle === 'slam' || a.atkStyle === 'ram') {
      if (p < 0.5) { const q = p * 2; tf.rot += q * 0.28; tf.dx += q * 6; }          // wind up
      else { const q = (p - 0.5) * 2; tf.rot += (1 - q) * 0.28 - q * 0.16; tf.dx += (1 - q) * 6 - Math.sin(q * Math.PI) * a.lunge; }
    } else {
      tf.dx += -Math.sin(p * Math.PI) * a.lunge;             // lunge toward the castle
      tf.rot += -Math.sin(p * Math.PI) * 0.08;
    }
  }
  // landing squash
  if (e.squashT > 0) {
    const q = e.squashT / 0.16;
    tf.sy *= 1 - 0.22 * q; tf.sx *= 1 + 0.18 * q;
  }
  return tf;
}
function floater(x, y, text, color = '#fff', size = 18, life = 1) {
  if (G.floaters.length >= MAX_ACTIVE_FLOATERS) G.floaters.shift();
  /* callers may pass numbers (e.g. damage amounts) — the renderer's emoji
     splicing needs real string methods, so coerce here for every caller */
  G.floaters.push({ x, y, text: String(text), color, size, life, maxLife: life, vy: -55 });
}
function dmgNumber(x, y, amount, crit) {
  if (!META.settings.numbers) return;
  floater(x + rand(-8, 8), y - 20, Math.round(amount), crit ? '#ffd24a' : '#ffefe0', crit ? 22 : 15, 0.8);
}
/* Screen shake is permanently disabled (every shake source funnels through
   here). Old saves' settings.shake value is ignored — nothing reads it. */
function addShake(v) {}

/* ============================================================
   ENEMIES
   ============================================================ */
/* Release balance: enemies are 25% tougher and 25% more numerous.
   Each multiplier is applied at exactly ONE site (makeEnemy hp and the
   wave-composition counts) so scaling can never compound. */
const ENEMY_HP_MULTIPLIER = 2.0;    // 200% of base (replaces the old 1.25 — never stacked)
const SPAWN_COUNT_MULTIPLIER = 1.2; // +20% foes per wave (replaces the old 1.25 — never stacked)

/* bosses arrive every 10th wave (10, 20, 30, ...) */
const BOSS_WAVE_INTERVAL = 10;
function isBossWave(waveNumber) {
  return waveNumber > 0 && waveNumber % BOSS_WAVE_INTERVAL === 0;
}

function hpScale(w) { return (1 + (w - 1) * 0.13) * (G.nightmare ? 1.4 : 1) * (G.mod === 'overload' ? 1.25 : 1); }
function spdScale(w) {
  let m = (1 + Math.min(0.45, (w - 1) * 0.015)) * (G.nightmare ? 1.25 : 1);
  if (G.mod === 'swift') m *= 1.3;
  return m;
}

/* Walk-speed balance pass: applied exactly once, at spawn (makeEnemy), on top
   of the base spd from ENEMIES. Bosses not listed here keep their own pacing. */
const ENEMY_WALK_SPEED_MULTIPLIERS = {
  runner:  2.0,
  soldier: 2.0,
  climber: 2.0,

  shield:  1.5,
  hammer:  1.5,
  bomber:  1.5,
  healer:  1.5,
  banner:  1.5,
  knight:  1.5,
  elite:   1.5,
  captain: 1.5,
  cart:    1.5,
  ram:     1.5,
};
function getEnemyWalkSpeed(enemyType, baseWalkSpeed) {
  // no ?? / ?. anywhere in shipped code: ES2020 syntax is a PARSE error on
  // un-updated Android 7-era WebViews and would blank the whole game
  const mult = ENEMY_WALK_SPEED_MULTIPLIERS[enemyType];
  return baseWalkSpeed * (mult !== undefined ? mult : 1);
}

function makeEnemy(type, wave) {
  const def = ENEMIES[type];
  const gy = rand(GROUND_TOP, GROUND_BOT);
  const golden = owns('contract_chaos') && !def.boss && Math.random() < 0.045;
  const e = {
    id: idCounter++, type, def,
    x: SPAWN_X + rand(0, 60), y: 0, gy,
    vx: 0, vy: 0,
    hp: Math.round(def.hp * hpScale(wave) * ENEMY_HP_MULTIPLIER * (golden ? 0.8 : 1)),
    r: def.r, weight: def.weight,
    state: 'walk', stunT: 0, slowT: 0,
    grabHold: 0, hitCd: 0, dmgFlash: 0,
    walkPhase: rand(0, TAU), attackT: rand(0, 0.6),
    attackX: CASTLE_X + rand(0, 34),               // staggered siege line so attackers don't stack
    atkAnimT: 0, squashT: 0, spinA: 0, spinDir: 0, dyingT: 0, auraT: rand(0, 2),

    healT: 2, convertT: 0, deadT: 0,
    golden,
    spd: getEnemyWalkSpeed(type, def.spd) * spdScale(wave) * rand(0.92, 1.08) * (golden ? 1.25 : 1),
    trail: [],
    // boss extras
    shieldStacks: def.boss === 'captain' ? 3 : 0,
    bannerHp: def.boss === 'bannerlord' ? 250 : 0,
  };
  e.maxhp = e.hp;
  e.y = gy;
  return e;
}

function enemySpeedNow(e) {
  let s = e.spd;
  // banner carrier / banner lord aura
  if (bannerAuraActive(e)) s *= 1.25;
  if (e.slowT > 0) s *= 0.4;
  return s;
}
function bannerAuraActive(e) {
  for (const o of G.enemies) {
    if (o === e || o.hp <= 0) continue;
    if (o.def.boss === 'bannerlord' && o.bannerHp > 0) return true;
    if (o.def.bannerman && !o.def.boss && o.state !== 'grab' && dist(o.x, o.y, e.x, e.y) < 150) return true;
  }
  return false;
}
function captainAura(e) {
  if (e.def.boss) return false;
  for (const o of G.enemies) {
    if (o.def.boss === 'captain' && o.hp > 0 && o.shieldStacks > 0 && dist(o.x, o.y, e.x, e.y) < 180) return true;
  }
  return false;
}

/* ------- damage & death ------- */
function damageEnemy(e, amount, opts = {}) {
  if (e.hp <= 0) return 0;
  let dmg = amount;
  if (opts.impact) {
    if (e.def.tough) dmg *= 1 - e.def.tough;
    if (captainAura(e)) { dmg *= 0.3; if (Math.random() < 0.3) floater(e.x, e.y - 30, 'SHIELDED', '#7ab8ff', 13, 0.6); }
    if (e.def.shielded && e.state === 'walk' && opts.horizontal) dmg *= 0.35;
  }
  dmg = Math.max(1, Math.round(dmg));
  e.hp -= dmg;
  e.dmgFlash = 0.15;
  if (e.bannerHp > 0 && opts.impact) {
    e.bannerHp -= dmg;
    if (e.bannerHp <= 0) { floater(e.x, e.y - 60, 'BANNER DESTROYED!', '#ffd24a', 20, 1.4); sparks(e.x, e.y - 50, 20, '#ff6a4a'); Sfx.kill(); }
  }
  if (e.def.boss === 'captain' && opts.thrownBody && e.shieldStacks > 0) {
    e.shieldStacks--;
    floater(e.x, e.y - 60, e.shieldStacks > 0 ? `SHIELD ${e.shieldStacks} LEFT` : 'SHIELD BROKEN!', '#7ab8ff', 18, 1.2);
    sparks(e.x, e.y - 40, 16, '#7ab8ff');
  }
  dmgNumber(e.x, e.y - e.r * 2, dmg, opts.impact && dmg > 40);
  if (e.hp <= 0) killEnemy(e, opts);
  return dmg;
}

function killEnemy(e, opts = {}) {
  if (e.state === 'dead' || e.state === 'dying') return;
  // pick the ground decal this death leaves behind (cause-based)
  e.deathMark = e.def.boss === 'rams' ? 'dm_splinter'
    : opts.magic ? 'dm_arcane'
    : choice(['dm_cracked', 'dm_rocky', 'dm_dust', 'dm_grass', 'dm_smoke']);
  if (e.def.bomb) {
    e.state = 'dead';                    // bombs vanish in their own explosion
  } else {
    e.state = 'dying'; e.dyingT = 0;     // quick spin-pop before removal
    e.dyingDir = e.vx > 20 ? 1 : e.vx < -20 ? -1 : (Math.random() < 0.5 ? -1 : 1);
  }
  // release from hand if held
  const gi = P.grabbed.indexOf(e);
  if (gi >= 0) P.grabbed.splice(gi, 1);
  /* Daily Siege attempts are freely retryable: kills there must never mint
     persistent coins (score still counts — it drives the siege tiers) */
  const goldGain = G.siege ? 0 : scaleCoinReward(e.noReward ? 0 : Math.round(e.def.gold * goldMult() * (e.golden ? 5 : 1)));
  let scoreGain = e.noReward ? 0 : e.def.score;
  G.stats.kills++;
  /* lifetime counters feed milestones — practice kills are not lifetime kills */
  if (!inTut()) {
    META.totalKills++;
    if (e.def.boss) META.totalBosses = (META.totalBosses || 0) + 1;
  }
  // combo logic for impact kills
  if (opts.impact) {
    G.combo.n++; G.combo.t = 1.9;
    G.stats.maxCombo = Math.max(G.stats.maxCombo, G.combo.n);
    if (G.combo.n >= 2) {
      scoreGain += G.combo.n * 20;
      const bonusGold = G.siege ? 0 : scaleCoinReward(up('goldMagnet') * G.combo.n * PASSIVE_BALANCE.goldMagnetPerCombo, 0);
      if (bonusGold > 0) { addGold(bonusGold); floater(e.x, e.y - 70, `+${bonusGold}🪙`, '#ffd24a', 14, 0.9); }
      floater(e.x, e.y - 90, `COMBO ×${G.combo.n}!`, '#ff9d45', 20 + Math.min(14, G.combo.n * 2), 1.1);
    }
    if (opts.speed) scoreGain += Math.floor(opts.speed / 120) * 5;   // velocity bonus
    if (opts.byEnemy) { scoreGain += 30; floater(e.x, e.y - 55, 'BILLIARD! +30', '#7ad9a0', 15, 1); }
    if (opts.fallHeight && opts.fallHeight > 130) { scoreGain += 25; floater(e.x, e.y - 55, 'LONG DROP! +25', '#7ad9a0', 15, 1); }
  }
  dailyEvent('kill', {
    type: e.type, boss: !!e.def.boss, elite: e.type === 'elite',
    siegeUnit: !!(e.def.cart || e.def.boss === 'rams' || e.def.boss === 'captain'),
    reachedCastle: !!e.reachedCastle, golden: !!e.golden,
    impact: !!opts.impact, byEnemy: !!opts.byEnemy,
    combo: G.combo.n, src: opts.src || null, inSiege: !!G.siege,
  });
  addGold(goldGain); G.score += Math.round(scoreGain);
  if (goldGain > 0) floater(e.x, e.y - 40, `+${goldGain}🪙`, '#ffe9b0', 14, 0.9);
  puff(e.x, e.y - e.r, e.golden ? 26 : 14, e.golden ? '#ffd24a' : e.def.color, 180, 5, 250, 0.7);
  puff(e.x, e.y - e.r, 8, '#eee', 120, 3, 100, 0.4);
  Sfx.kill(); if (e.golden) Sfx.coin();
  // bomb carriers explode on death
  if (e.def.bomb) explodeBomber(e);
  if (e.def.boss) {
    addShake(12); Sfx.boom();
    floater(e.x, e.y - 80, `${e.def.name} DEFEATED!`, '#ffd24a', 24, 2);
    if (!G.enemies.some(o => o !== e && o.def.boss && o.hp > 0)) G.bossAlive = null;
  }
  // (corpse is pushed when the dying animation finishes; bombs leave none)
}

function explodeBomber(e) {
  // explosions scorch the ground where they went off
  pushCorpse({ x: e.x, gy: e.gy, mark: 'dm_scorched', w: e.def.cart ? 150 : 100, t: 0, life: 4.5 });
  const R = e.def.boomR * (up('chainReact') ? 1.1 : 1);
  const dmg = (up('chainReact') ? 65 : 55) * hpScale(G.wave);
  addShake(e.def.cart ? 16 : 7); Sfx.boom();
  puff(e.x, e.y - 10, 30, '#ff9d45', 320, 8, 150, 0.6);
  puff(e.x, e.y - 10, 20, '#5a5a5a', 160, 10, -60, 1.1);
  sparks(e.x, e.y - 10, 18);
  for (const o of G.enemies) {
    if (o === e || o.hp <= 0) continue;
    const d = dist(o.x, o.y, e.x, e.y);
    if (d < R) {
      damageEnemy(o, dmg * (1 - d / R * 0.5), { impact: true });
      o.vx += (o.x - e.x) / Math.max(20, d) * 300; o.vy -= 200;
      if (o.state === 'walk' || o.state === 'attack') o.state = 'thrown';
    }
  }
  // castle splash (unless Chain Reaction upgrade)
  if (!up('chainReact')) {
    const dCastle = Math.max(0, e.x - CASTLE_X);
    if (e.atCastle || dCastle < R) {
      const castleDmg = e.def.cart ? Math.round(G.castleMax * 0.4) : (e.atCastle ? e.def.boomCastle : 30);
      damageCastle(castleDmg, { pierce: true });
    }
  }
}

/* ------- castle damage / repair ------- */
function damageCastle(amount, opts = {}) {
  /* the tutorial must never cost a player their castle (or their Decree
     progress) while it explains the game — its practice dummies are also
     speed-locked, so nothing normally reaches the walls in the first place */
  const tutC = TUT();
  if (tutC && tutC.shieldsCastle()) return;
  if (G.shieldT > 0) { floater(CASTLE_X, 300, 'SHIELDED', '#7ab8ff', 16, 0.7); return; }
  let dmg = amount;
  if (!opts.pierce) { dmg *= meleeReduction(); dmg = Math.max(1, dmg - armorTotal()); }
  G.castleHp -= dmg;
  dailyEvent('castleDamage', { amount: dmg });
  G.flash = Math.min(0.35, G.flash + dmg / 220);
  addShake(clamp(dmg / 8, 1, 10));
  if (Math.random() < 0.4) Sfx.hurt();
  puff(rand(120, CASTLE_X), rand(420, 620), 5, '#8a7a66', 90, 5, 200, 0.5);
  if (G.castleHp <= 0) { G.castleHp = 0; gameOver(); }
}
function repairCastle(amount) {
  if (G.castleHp >= G.castleMax || amount <= 0) return;
  G.castleHp = Math.min(G.castleMax, G.castleHp + amount);
}

/* ============================================================
   DEFENDERS (converted recruits assigned to the gate)
   ============================================================ */
function spawnGateGuards() {
  G.defenders = [];
  const n = G.recruits.gate;
  for (let i = 0; i < n; i++) {
    G.defenders.push({
      id: idCounter++,
      x: CASTLE_X + 30 + rand(0, 40), y: 0,
      gy: rand(GROUND_TOP, GROUND_BOT),
      hp: 20 + barracksLv() * 12, maxhp: 20 + barracksLv() * 12,
      dmg: 6 + barracksLv() * 3, atkCd: 0, walkPhase: rand(0, TAU),
      home: CASTLE_X + 40 + i * 18,
    });
    G.defenders[G.defenders.length - 1].y = G.defenders[G.defenders.length - 1].gy;
  }
}

function updateDefenders(dt) {
  for (let di = G.defenders.length - 1; di >= 0; di--) {
    const d = G.defenders[di];
    d.walkPhase += dt * 8;
    // find nearest living enemy that is on the ground and near castle
    let best = null, bd = 1e9;
    for (const e of G.enemies) {
      if (e.hp <= 0 || e.state === 'grab' || e.state === 'convert') continue;
      if (e.x > CASTLE_X + 420) continue;
      const dd = dist(d.x, d.gy, e.x, e.gy);
      if (dd < bd) { bd = dd; best = e; }
    }
    if (best && bd > 40) {
      const dir = Math.sign(best.x - d.x);
      d.x += dir * 55 * dt;
      d.gy += clamp(best.gy - d.gy, -40 * dt, 40 * dt);
      d.y = d.gy;
    } else if (!best && Math.abs(d.x - d.home) > 8) {
      d.x += Math.sign(d.home - d.x) * 45 * dt;
    }
    d.atkCd -= dt;
    if (best && bd <= 44 && d.atkCd <= 0) {
      d.atkCd = 0.7;
      damageEnemy(best, d.dmg * (G.siegeRecruitMult || 1) * allyDamageMult(), {});
      sparks(best.x, best.y - best.r, 3, '#cfd8e6');
      // enemy fights back
      if (!best.def.bomb && Math.random() < 0.5) {
        d.hp -= Math.max(2, best.def.dps * 0.5);
        if (d.hp <= 0) {
          puff(d.x, d.y - 12, 12, '#7ad9a0', 150, 5, 250, 0.6);
          floater(d.x, d.y - 30, 'Recruit lost', '#9fd8b0', 13, 0.9);
          G.defenders.splice(di, 1);
          G.recruits.gate = Math.max(0, G.recruits.gate - 1);
          G.recruits.total = Math.max(0, G.recruits.total - 1);
        }
      }
    }
  }
}

/* ============================================================
   ARROWS & BOMBS
   ============================================================ */
function updateArcher(dt) {
  const lv = G.rooms.archer;
  if (lv <= 0) return;
  const rateBonus = 1 + G.recruits.archer * 0.15;
  G.archerCd -= dt * rateBonus;
  if (G.archerCd > 0) return;
  // pick target
  let best = null, bScore = -1;
  for (const e of G.enemies) {
    if (e.hp <= 0 || e.state === 'grab' || e.state === 'convert' || e.x > W - 40) continue;
    let s = 1000 - (e.x - CASTLE_X);                    // closer = higher priority
    if (up('archerFocus') && e.def.bomb) s += 5000;     // bombers first
    if (s > bScore) { bScore = s; best = e; }
  }
  if (!best) return;
  G.archerCd = archerInterval(lv);
  const ap = socketPoint('wallCrest');   // arrows loose from the archer platform socket
  const sx = ap.x, sy = ap.y - 75;
  const t = clamp(dist(sx, sy, best.x, best.y) / 700, 0.25, 1.1);
  const tx = best.x + (best.state === 'walk' ? -enemySpeedNow(best) * t : 0);
  const ty = best.y - best.r;
  G.arrows.push({
    x: sx, y: sy,
    vx: (tx - sx) / t, vy: (ty - sy) / t - 0.5 * 480 * t,
    dmg: archerDmg(lv), pierce: owns('room_ballista') ? 3 : 1, hit: [],
    ballista: owns('room_ballista'),
  });
  Sfx.arrow();
}

function updateArrows(dt) {
  for (let i = G.arrows.length - 1; i >= 0; i--) {
    const a = G.arrows[i];
    a.vy += 480 * dt;
    a.x += a.vx * dt; a.y += a.vy * dt;
    let dead = a.y > GROUND_BOT + 10 || a.x > W + 40 || a.x < 0;
    for (const e of G.enemies) {
      // converting troops are friendlies-in-progress: arrows pass through them
      if (e.hp <= 0 || a.hit.includes(e.id) || e.state === 'grab' || e.state === 'convert') continue;
      if (dist(a.x, a.y, e.x, e.y - e.r) < e.r + 7) {
        a.hit.push(e.id);
        damageEnemy(e, a.dmg, {});
        sparks(a.x, a.y, 4, '#ffefe0');
        if (a.hit.length >= a.pierce) { dead = true; break; }
      }
    }
    if (dead) G.arrows.splice(i, 1);
  }
}

function launchBomb() {
  const lv = G.rooms.bomb;
  G.bombs.push({ x: CASTLE_X + 10, y: GROUND_TOP + 60, gy: GROUND_TOP + 60, vx: 240, fuse: 4, r: 13, lv });
  Sfx.throwW();
}
function updateBombs(dt) {
  for (let i = G.bombs.length - 1; i >= 0; i--) {
    const b = G.bombs[i];
    b.x += b.vx * dt; b.fuse -= dt;
    if (Math.random() < 0.5) sparks(b.x, b.y - 20, 1, '#ff9d45');
    let boom = b.fuse <= 0 || b.x > W + 20;
    for (const e of G.enemies) {
      if (e.hp <= 0 || e.state === 'grab' || e.state === 'convert') continue;
      if (Math.abs(e.gy - b.gy) < 70 && Math.abs(e.x - b.x) < e.r + b.r) { boom = true; break; }
    }
    if (boom) {
      G.bombs.splice(i, 1);
      const R = 115, dmg = bombDmg(b.lv) * hpScale(G.wave) * 0.9;
      addShake(8); Sfx.boom();
      puff(b.x, b.y - 10, 26, '#ff9d45', 300, 8, 150, 0.6);
      puff(b.x, b.y - 10, 16, '#5a5a5a', 140, 10, -60, 1);
      for (const e of G.enemies) {
        if (e.hp <= 0 || e.state === 'grab' || e.state === 'convert') continue;
        const d = dist(e.x, e.y, b.x, b.y);
        if (d < R) {
          damageEnemy(e, dmg * (1 - d / R * 0.4), { impact: true, src: 'bomb' });
          e.vx += (e.x - b.x) / Math.max(20, d) * 350; e.vy -= 260;
          if (e.state === 'walk' || e.state === 'attack') e.state = 'thrown';
        }
      }
    }
  }
}

/* ============================================================
   ABILITIES
   ============================================================ */
function rebuildAbilities() {
  const list = [];
  if (G.rooms.mage >= 1) list.push({ id: 'bolt', icon: '⚡', iconImg: 'icon_mage.png', name: 'Lightning', cdMax: 12, targeted: true });
  if (G.rooms.mage >= 2) list.push({ id: 'frost', icon: '❄', iconSrc: PACKS.ab + 'icons/ability_frost_attack.png', name: 'Frost Field', cdMax: 18, targeted: true });
  if (G.rooms.mage >= 3) list.push({ id: 'aegis', icon: '🛡', iconSrc: PACKS.ab + 'icons/ability_shield_burst.png', name: 'Shield Burst', cdMax: 30 });
  if (G.rooms.bomb >= 1) list.push({ id: 'bomb', icon: '💣', iconImg: 'icon_bomb.png', name: 'Rolling Bomb', cdMax: bombCd(G.rooms.bomb) });
  if (up('panicBell')) list.push({ id: 'bell', icon: '🔔', iconImg: 'fix_bell_tower.png', name: 'Panic Bell', perWave: true });
  list.forEach((a, i) => {
    a.key = String(i + 1);
    a.cd = G.cdStore[a.id] || 0;
  });
  G.abilities = list;
  renderAbilityBar();
}

function castAbility(a, tx, ty) {
  if (a.perWave) { if (G.bellUsed) return; }
  else if (a.cd > 0) return;
  switch (a.id) {
    case 'bolt': {
      const R = 85, dmg = 85 * spellPower() * hpScale(G.wave) * 0.8 * mageDamageMult();
      Sfx.spell(); addShake(6);
      pushParticle({ x: tx, y: ty, vx: 0, vy: 0, life: 0.25, maxLife: 0.25, size: R, color: 'bolt', grav: 0, bolt: { x: tx, y: ty } });
      sparks(tx, ty, 22, '#aee2ff');
      for (const e of G.enemies) {
        if (e.hp <= 0 || e.state === 'grab' || e.state === 'convert') continue;
        if (dist(e.x, e.y - e.r, tx, ty) < R + e.r) {
          damageEnemy(e, dmg, { impact: true, magic: true });   // arcane kills leave arcane residue
          e.stunT = Math.max(e.stunT, 1);
        }
      }
      break;
    }
    case 'frost': {
      Sfx.freeze();
      G.slowFields.push({ x: tx, y: clamp(ty, GROUND_TOP - 30, GROUND_BOT), r: 120 * spellPower(), t: 6 });
      break;
    }
    case 'aegis': {
      Sfx.spell();
      G.shieldT = 4 + spellPower();
      G.shieldMax = G.shieldT;                       // drives the fade-in/out curve
      // activation burst: expanding ring + sparkle wash from the castle heart
      spawnRing(SHIELD_DOME.x, SHIELD_DOME.y, 40, SHIELD_DOME.r, 'rgba(150,215,255,', 0.55);
      spawnRing(SHIELD_DOME.x, SHIELD_DOME.y, 20, SHIELD_DOME.r * 0.7, 'rgba(255,224,130,', 0.45);
      puff(CASTLE_X - 60, 400, 30, '#7ab8ff', 220, 7, -40, 0.9);
      for (const e of G.enemies) {
        if (e.hp <= 0 || e.state === 'grab' || e.state === 'convert') continue;
        if (e.x < CASTLE_X + 260) {
          e.vx += 320; e.vy -= 180;
          if (e.state === 'walk' || e.state === 'attack') e.state = 'thrown';
        }
      }
      break;
    }
    case 'bomb': launchBomb(); break;
    case 'bell': {
      G.bellUsed = true;
      Sfx.bell(); addShake(8);
      floater(CASTLE_X + 200, 300, '🔔 PANIC BELL!', '#ffd24a', 26, 1.5);
      for (const e of G.enemies) {
        if (e.hp <= 0 || e.state === 'grab') continue;
        if (e.x < CASTLE_X + 450) { e.stunT = Math.max(e.stunT, PASSIVE_BALANCE.bellStunSeconds); sparks(e.x, e.y - e.r * 2, 4); }
      }
      break;
    }
  }
  a.cd = (a.cdMax || 0) * cdMult();
  G.cdStore[a.id] = a.cd;
  dailyEvent('ability', { id: a.id, inSiege: !!G.siege });
  tutEvent('abilityActivated', { id: a.id, cd: a.cd });
  P.targeting = null;
  syncAbilityBar();
}

/* ============================================================
   POINTER / INPUT
   ============================================================ */
const P = { x: W / 2, y: H / 2, down: false, grabbed: [], samples: [], targeting: null, insideCanvas: false };

function canvasPos(ev) {
  const r = canvas.getBoundingClientRect();
  // clamp into world bounds: touches that slide past the screen edge (or land
  // in gesture/nav areas) must never map outside the playable battlefield
  return {
    x: clamp((ev.clientX - r.left) * (W / r.width), 0, W),
    y: clamp((ev.clientY - r.top) * (H / r.height), 0, H),
  };
}
function effWeight(e) {
  /* Effects key off the BASE weight class so they never chain: with Titan Grip
     + Heavy Grip together, heavies used to cascade 2→1→0 and lift instantly —
     the "inconsistent Heavy Knight pickup" closed-test bug. */
  const base = e.def.weight;
  let w = base;
  if (base === 2 && owns('hand_titan') && !e.def.unliftable) w = 1;   // heavies act medium
  if (base === 1 && up('heavyGrip')) w = 0;                           // true mediums only
  return w;
}
function grabbable(e) {
  return e.hp > 0 && e.state !== 'dead' && e.state !== 'convert' && e.state !== 'grab';
}
/* full-body grab test: an ellipse spanning the whole visible sprite (feet to
   helmet), so taps on heads/arms/legs connect — not just the torso circle */
function grabHit(e, x, y) {
  const h = (e.def.dispH || e.r * 3) + 10;
  const def = SPRITE_DEFS[e.def.sprite];
  const c = def && def.crop;
  const wBox = Math.max(e.r * 2.4, c ? h * (c[2] / c[3]) * 0.9 : e.r * 2.4);
  const cy = e.y - h / 2;                             // body center
  const dx = (x - e.x) / (wBox / 2), dy = (y - cy) / (h / 2);
  return dx * dx + dy * dy <= 1;
}
function tryGrab(x, y) {
  let best = null, bd = 1e9;
  for (const e of G.enemies) {
    if (!grabbable(e) || !grabHit(e, x, y)) continue;
    // among overlapping bodies, take the one whose center is nearest the tap
    const d = dist(x, y, e.x, e.y - (e.def.dispH || e.r * 3) / 2);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return;
  startGrab(best, 0);
  // Double Grab: chance to snag a second small enemy nearby
  if (up('doubleGrab') && effWeight(best) === 0 && Math.random() < PASSIVE_BALANCE.doubleGrabChance * up('doubleGrab')) {
    let second = null, sd = 1e9;
    for (const e of G.enemies) {
      if (e === best || !grabbable(e) || effWeight(e) !== 0) continue;
      const d = dist(best.x, best.y, e.x, e.y);
      if (d < 115 && d < sd) { sd = d; second = e; }
    }
    if (second) { startGrab(second, 1); floater(second.x, second.y - 40, 'DOUBLE GRAB!', '#7ad9a0', 15, 0.9); }
  }
}
function startGrab(e, slot) {
  e.state = 'grab'; e.grabHold = 0; e.lifted = false;
  e.spinA = 0; e.spinDir = 0; e.atkAnimT = 0;
  e.grabOx = slot === 0 ? 0 : rand(-38, 38) || 30;
  e.grabOy = slot === 0 ? 0 : -22;
  P.grabbed.push(e);
  Sfx.grab();
  tutEvent('enemyGrabbed', { type: e.type, tutorial: !!e.tutorial });
}
function pointerVel() {
  const s = P.samples;
  if (s.length < 2) return [0, 0];
  const a = s[0], b = s[s.length - 1];
  const dt = Math.max(0.016, (b.t - a.t) / 1000);
  return [(b.x - a.x) / dt, (b.y - a.y) / dt];
}
function releaseGrab() {
  const [pvx, pvy] = pointerVel();
  for (const e of P.grabbed) {
    if (e.hp <= 0) continue;
    if (!e.lifted) { e.state = e.x <= CASTLE_X + e.r + 10 ? 'attack' : 'walk'; continue; }
    const w = effWeight(e);
    const m = [1.05, 0.85, 0.55][w];
    e.state = 'thrown';
    e.playerThrown = true;        // Storm Fingers only procs on player flings
    e.stormNovaDone = false;      // re-armed on every new throw
    e.vx = clamp(pvx * m, -2100, 2100);
    e.vy = clamp(pvy * m, -2100, 1500);
    e.spinA = 0; e.spinDir = e.vx >= 0 ? 1 : -1;
    e.peakY = e.y; e.bounces = 0; e.hitCd = 0;
    e.gy = clamp(e.gy, GROUND_TOP, GROUND_BOT);
    G.stats.throws++;
    tutEvent('enemyFlung', { speed: Math.hypot(e.vx, e.vy), tutorial: !!e.tutorial });
    if (Math.hypot(e.vx, e.vy) > 420) Sfx.throwW();
  }
  P.grabbed = [];
}

canvas.addEventListener('pointerdown', ev => {
  ev.preventDefault();
  if (ev.button !== undefined && ev.button !== 0) return;   // main button / touch only
  Sfx.unlock();
  const p = canvasPos(ev);
  P.x = p.x; P.y = p.y; P.down = true;
  P.samples = [{ t: performance.now(), x: p.x, y: p.y }];
  // the tutorial panel owns the press on its reading pages and its buttons;
  // interactive pages let it through to the battlefield untouched
  const tut = TUT();
  if (tut && tut.pointerDown(p.x, p.y)) return;
  if (state !== 'playing') return;
  if (P.targeting) { castAbility(P.targeting, p.x, p.y); return; }
  tryGrab(p.x, p.y);
});
canvas.addEventListener('pointermove', ev => {
  const p = canvasPos(ev);
  P.x = p.x; P.y = p.y; P.insideCanvas = true;
  const now = performance.now();
  P.samples.push({ t: now, x: p.x, y: p.y });
  while (P.samples.length > 2 && now - P.samples[0].t > 110) P.samples.shift();
});
window.addEventListener('pointerup', () => {
  P.down = false;
  if (state === 'playing') releaseGrab();
  else dropGrab();
});
/* drop everything gently (used when leaving the playing state) */
function dropGrab() {
  for (const e of P.grabbed) {
    if (e.hp > 0) { e.state = 'thrown'; e.playerThrown = false; e.vx = 0; e.vy = 50; e.peakY = e.y; e.bounces = 0; }
  }
  P.grabbed = [];
}
canvas.addEventListener('pointerleave', () => { P.insideCanvas = false; });
canvas.addEventListener('contextmenu', ev => { ev.preventDefault(); P.targeting = null; syncAbilityBar(); });
document.addEventListener('touchmove', ev => { if (ev.target === canvas) ev.preventDefault(); }, { passive: false });

window.addEventListener('keydown', ev => {
  const tutK = TUT();
  if (tutK && tutK.handleKey(ev)) return;   // tutorial owns Escape / arrows while open
  const btutK = BTUT();
  if (btutK && btutK.handleKey(ev)) return; // Board tutorial: same key ownership
  if (ev.key === 'p' || ev.key === 'P' || ev.key === 'Escape') {
    if (state === 'playing') { pauseGame(); return; }
    if (state === 'paused') { resumeGame(); return; }
  }
  if (state !== 'playing') return;
  const n = parseInt(ev.key, 10);
  if (n >= 1 && n <= G.abilities.length) {
    const a = G.abilities[n - 1];
    abilityPressed(a, true);
  }
});
function abilityPressed(a, viaKey) {
  const tut = TUT();
  if (tut && tut.blocksAbility()) return;   // frozen while a tutorial page is being read
  if (a.perWave ? G.bellUsed : a.cd > 0) return;
  if (a.targeted) {
    if (viaKey && P.insideCanvas) { castAbility(a, P.x, P.y); return; }
    P.targeting = P.targeting === a ? null : a;
    syncAbilityBar();
  } else {
    castAbility(a, 0, 0);
  }
}

/* ============================================================
   ENEMY UPDATE & PHYSICS
   ============================================================ */
const GRAV = 1600, IMPACT_MIN = 330;

/* ---- Storm Fingers (Royal Treasury 'hand_storm') ----
   A hard PLAYER slam into the ground releases an electric nova. Checked at
   the ground-contact site itself, NOT inside impactDamage: impactDamage
   early-returns while hitCd runs (wall clips, billiards, bounces), which is
   what used to silently swallow the nova. Once per throw; re-armed on the
   next fling; never procs from knockback "throws". */
const STORM_NOVA = { minSpeed: 620, radius: 120, dmg: 25 };
function maybeStormNova(e, speed) {
  const owned = owns('hand_storm');
  const eligible = owned && e.playerThrown && !e.stormNovaDone;
  const triggered = eligible && speed >= STORM_NOVA.minSpeed;
  if (owned && !(window.BUILD_CONFIG && BUILD_CONFIG.isProduction) && speed > 250) {
    console.log('[StormFingers]', { enemy: e.def && e.def.id, speed: Math.round(speed),
      playerThrown: !!e.playerThrown, alreadyFired: !!e.stormNovaDone, triggered });
  }
  if (!triggered) return;
  e.stormNovaDone = true;
  // electric nova: expanding blue-white rings + arc flash + spark burst (no screen shake)
  spawnRing(e.x, e.gy, 16, STORM_NOVA.radius + 35, 'rgba(160,220,255,', 0.42);
  spawnRing(e.x, e.gy, 10, STORM_NOVA.radius * 0.65, 'rgba(240,250,255,', 0.3);
  pushParticle({ x: e.x, y: e.gy - 14, vx: 0, vy: 0, life: 0.22, maxLife: 0.22, size: 46, color: 'bolt', grav: 0, bolt: { x: e.x, y: e.gy - 14 } });
  sparks(e.x, e.gy - 8, 22, '#aee2ff');
  sparks(e.x, e.gy - 14, 10, '#e8f6ff');
  Sfx.spell();
  for (const o of G.enemies) {
    if (o === e || o.hp <= 0 || o.state === 'grab' || o.state === 'convert') continue;
    if (dist(o.x, o.gy, e.x, e.gy) < STORM_NOVA.radius) {
      damageEnemy(o, STORM_NOVA.dmg * throwPowerMult(), { impact: true });
      // light knockback away from the blast point
      o.vx += Math.sign(o.x - e.x || 1) * 130;
      o.vy -= 140;
      if (o.state === 'walk' || o.state === 'attack') o.state = 'thrown';
    }
  }
}

function impactDamage(e, speed, opts = {}) {
  if (speed < IMPACT_MIN || e.hitCd > 0) return;
  e.hitCd = 0.12;
  let dmg = (speed - 240) * 0.055 * throwPowerMult();
  if (opts.bounce) dmg *= bounceMult() * 0.7;
  const fallHeight = e.peakY !== undefined ? e.gy - e.peakY : 0;
  if (fallHeight > 130) dmg *= 1.25;                     // high drop bonus
  damageEnemy(e, dmg, { impact: true, speed, horizontal: opts.horizontal, fallHeight });
  /* the tutorial's "turn enemies into weapons" step waits on a REAL impact —
     ground slam or wall slam, both at the game's own IMPACT_MIN threshold */
  tutEvent('enemyImpact', { speed, ground: !!opts.ground, wall: !!opts.horizontal, tutorial: !!e.tutorial });
  const power = clamp(speed / 900, 0.3, 1.6);
  Sfx.hit(power);
  if (opts.ground) {
    dustLanding(e.x, e.gy, power);
    if (e.def.weight === 2 || speed > 900) addShake(clamp(speed / 180, 2, 9));
    // heavy slam shockwave (converting enemies are friendlies — never splashed)
    if (e.def.weight === 2 && speed > 500) {
      for (const o of G.enemies) {
        if (o === e || o.hp <= 0 || o.state === 'grab' || o.state === 'convert') continue;
        const d = dist(o.x, o.gy, e.x, e.gy);
        if (d < 120) { damageEnemy(o, 16 * throwPowerMult(), { impact: true }); o.vy -= 150; o.vx += Math.sign(o.x - e.x) * 120; if (o.state === 'walk' || o.state === 'attack') o.state = 'thrown'; }
      }
    }
  } else {
    sparks(e.x, e.y - e.r, 6);
  }
}

const MAX_CONVERSIONS_PER_WAVE = 1;
function canConvertThisWave() {
  // Daily Siege "Conversion Test" days raise the cap for their single long wave
  const lim = (G && G.siegeConvertMax) || MAX_CONVERSIONS_PER_WAVE;
  return (G.conversionsUsedThisWave || 0) < lim;
}

function tryConvertOnLand(e) {
  if (e.def.boss || e.hp <= 0) return false;
  if (dist(e.x, e.gy, CONVERT.x, CONVERT.y) > CONVERT.r) return false;
  if (!canConvertThisWave()) {
    floater(CONVERT.x, CONVERT.y - 70, 'Conversion used this wave', '#9fb0c8', 14, 0.9);
    return false;   // enemy just lands normally, unharmed
  }
  if (e.hp / e.maxhp <= convertThreshold()) {
    G.conversionsUsedThisWave = (G.conversionsUsedThisWave || 0) + 1;
    e.state = 'convert';
    e.convertT = convertTime();
    e.vx = e.vy = 0; e.y = e.gy;
    floater(e.x, e.y - 50, 'CONVERTING…', '#7ad9ff', 15, 0.9);
    return true;
  }
  floater(CONVERT.x, CONVERT.y - 70, 'Too strong to convert!', '#ff8a6a', 14, 0.9);
  return false;
}

function updateEnemy(e, dt) {
  updateEnemyAnimation(e, dt);
  // decree bookkeeping: has this foe ever reached the castle walls?
  if (e.state === 'attack' || e.state === 'climb') e.reachedCastle = true;
  e.dmgFlash = Math.max(0, e.dmgFlash - dt);
  e.hitCd = Math.max(0, e.hitCd - dt);
  e.stunT = Math.max(0, e.stunT - dt);
  // slow fields
  e.slowT = Math.max(0, e.slowT - dt);
  for (const f of G.slowFields) {
    if (dist(e.x, e.y, f.x, f.y) < f.r) { e.slowT = 0.2; break; }
  }
  switch (e.state) {
    case 'walk': {
      if (e.stunT > 0) break;
      e.walkPhase += dt * animOf(e).bobFreq;
      e.x -= enemySpeedNow(e) * dt;
      e.y = e.gy;                       // feet stay planted; the bob is a draw transform
      if (e.x <= (e.attackX || CASTLE_X) + e.r + 4) {
        if (e.def.climber) { e.state = 'climb'; e.x = CASTLE_X - 6; }   // hug the wall face
        else if (e.def.bomb) { e.atCastle = true; e.noReward = true; killEnemy(e); }
        else { e.state = 'attack'; e.attackT = rand(0.2, 0.6); }
      }
      break;
    }
    case 'attack': {
      if (e.stunT > 0) break;
      e.attackT -= dt;
      if (e.attackT <= 0) {
        e.attackT = 0.9;
        const dmg = e.def.dps * 0.9 * (1 + (G.wave - 1) * 0.03) * (G.nightmare ? 1.2 : 1);
        damageCastle(dmg, { pierce: e.pierce });
        triggerEnemyAttackAnim(e);
        sparks(CASTLE_X + rand(0, 14), e.y - e.r, 3, '#c9b98f');
      }
      break;
    }
    case 'climb': {
      if (e.stunT > 0) break;
      e.walkPhase += dt * 6;
      e.y -= getEnemyWalkSpeed(e.type, 55) * dt;   // climb rate scales with the walk-speed pass
      if (e.y <= 400) { e.state = 'attack'; e.pierce = true; e.attackT = 0.3; }
      break;
    }
    case 'grab': {
      const w = effWeight(e);
      e.grabHold += dt;
      const need = [0, 0.32, 0.55][w];
      if (e.grabHold >= need) {
        if (!e.lifted) { e.lifted = true; Sfx.grab(); }
      }
      if (e.lifted) {
        const spring = w === 2 ? 8 : 17;
        const tx = P.x + (e.grabOx || 0), ty = P.y + (e.grabOy || 0);
        e.x += (tx - e.x) * Math.min(1, dt * spring);
        let targetY = ty;
        if (w === 2) targetY = Math.max(ty, e.gy - 54);   // heavies stay low — Heavy Grip no longer raises them
        e.y += (targetY - e.y) * Math.min(1, dt * spring);
        e.gy = clamp(P.y, GROUND_TOP, GROUND_BOT);
        // heavies exhaust the grip: drop after a while
        if (w === 2) {
          if (e.grabHold > 2.6) {
            const gi = P.grabbed.indexOf(e); if (gi >= 0) P.grabbed.splice(gi, 1);
            e.state = 'thrown'; e.vx = 0; e.vy = 100; e.peakY = e.y; e.bounces = 0;
            floater(e.x, e.y - 50, 'TOO HEAVY!', '#ff8a6a', 15, 0.8);
          }
        }
      } else {
        e.x += Math.sin(e.grabHold * 40) * 40 * dt;     // struggle wiggle
      }
      break;
    }
    case 'thrown': {
      e.vy += GRAV * dt;
      e.x += e.vx * dt; e.y += e.vy * dt;
      e.peakY = Math.min(e.peakY !== undefined ? e.peakY : e.y, e.y);
      // velocity-driven tumble
      const sp = Math.hypot(e.vx, e.vy);
      if (!e.spinDir) e.spinDir = e.vx >= 0 ? 1 : -1;
      e.spinA = (e.spinA || 0) + (0.9 + sp / 480) * e.spinDir * dt * 4;
      if (sp > 480) { e.trail.push({ x: e.x, y: e.y - e.r, t: 0.3 }); if (e.trail.length > 12) e.trail.shift(); }
      // castle wall bounce (left)
      if (e.x < CASTLE_X + e.r && e.vx < 0) {
        e.x = CASTLE_X + e.r;
        impactDamage(e, Math.abs(e.vx) * 1.4, { horizontal: true });
        e.vx = Math.abs(e.vx) * 0.45;
        puff(CASTLE_X + 4, e.y - e.r, 6, '#b9a37e', 120, 4, 200, 0.5);
      }
      // right edge / top
      if (e.x > W - 8 && e.vx > 0) { e.x = W - 8; impactDamage(e, Math.abs(e.vx) * 1.2, { horizontal: true }); e.vx = -Math.abs(e.vx) * 0.45; }
      if (e.y < 14 && e.vy < 0) { e.y = 14; e.vy = Math.abs(e.vy) * 0.4; }
      // enemy-vs-enemy billiards
      if (sp > 300 && e.hp > 0) {
        for (const o of G.enemies) {
          if (o === e || o.hp <= 0 || o.state === 'grab' || o.state === 'convert' || o.state === 'dead') continue;
          if (Math.abs(o.gy - e.gy) > 90 && o.state !== 'thrown') continue;
          if (dist(e.x, e.y - e.r, o.x, o.y - o.r) < e.r + o.r) {
            if (e.hitCd <= 0) {
              const dmg = sp * 0.05 * throwPowerMult();
              damageEnemy(o, dmg, { impact: true, byEnemy: true, thrownBody: true, speed: sp });
              damageEnemy(e, dmg * 0.55, { impact: true, speed: sp });
              e.hitCd = 0.18;
              tutEvent('enemyCollision', { speed: sp, tutorial: !!(e.tutorial && o.tutorial) });
              Sfx.hit(clamp(sp / 900, 0.3, 1.3));
              sparks((e.x + o.x) / 2, (e.y + o.y) / 2 - e.r, 8);
              o.vx += e.vx * 0.45; o.vy -= 170;
              if (o.state === 'walk' || o.state === 'attack' || o.state === 'climb') { o.state = 'thrown'; o.peakY = o.y; o.bounces = 0; }
              e.vx *= 0.55; e.vy *= 0.8;
            }
          }
        }
      }
      // ground contact
      if (e.y >= e.gy && e.vy > 0) {
        e.y = e.gy;
        const vSpeed = Math.hypot(e.vx, e.vy);
        e.squashT = 0.16;                             // landing squash
        maybeStormNova(e, vSpeed);   // before impactDamage: its hitCd gate must not swallow the nova
        if (e.vy > 260 || vSpeed > IMPACT_MIN) {
          impactDamage(e, vSpeed, { ground: true, bounce: (e.bounces || 0) > 0 });
          e.bounces = (e.bounces || 0) + 1;
          e.vy = -e.vy * 0.45;
          e.vx *= 0.6;
          if (Math.abs(e.vy) < 180) e.vy = 0;
        } else {
          e.vy = 0; e.vx *= 0.75;
        }
        // came to rest?
        if (e.hp > 0 && Math.abs(e.vy) < 60 && Math.abs(e.vx) < 60) {
          e.vx = e.vy = 0;
          e.peakY = undefined;
          e.spinA = 0; e.spinDir = 0;
          e.x = clamp(e.x, CASTLE_X - 10, W - 14);   // never rest beyond the visible field
          if (!tryConvertOnLand(e)) {
            e.state = 'stunned'; e.restT = 0.35;
          }
        }
      }
      break;
    }
    case 'dying': {
      e.dyingT += dt;
      if (e.dyingT >= DYING_TIME) {
        e.state = 'dead';
        puff(e.x, e.y - e.r, 8, '#cfc4b0', 110, 4, -40, 0.5);   // pop smoke
        // ground decal where they fell (fades out; purely cosmetic)
        pushCorpse({ x: e.x, gy: e.gy, mark: e.deathMark || 'dm_dust', w: clamp(e.r * 3.4, 60, 130), t: 0, life: 3.5 });
      }
      break;
    }
    case 'stunned': {
      e.restT -= dt;
      if (e.restT <= 0) e.state = e.x <= CASTLE_X + e.r + 10 ? 'attack' : 'walk';
      break;
    }
    case 'convert': {
      e.convertT -= dt;
      if (Math.random() < 0.3) puff(e.x + rand(-14, 14), e.y - rand(0, 30), 1, '#7ad9ff', 40, 3, -80, 0.6);
      if (e.convertT <= 0) {
        e.state = 'dead'; e.deadT = 99;                 // no corpse
        G.recruits.total++; G.recruits.gate++;
        G.stats.converts++;
        META.totalConverts = (META.totalConverts || 0) + 1;
        dailyEvent('convert', { type: e.type, inSiege: !!G.siege });
        G.score += 40;
        Sfx.convert();
        floater(e.x, e.y - 60, '✨ RECRUITED!', '#7ad9ff', 20, 1.4);
        puff(e.x, e.y - 20, 22, '#7ad9ff', 200, 6, -60, 0.9);
        // new recruit joins the fight immediately
        G.defenders.push({
          id: idCounter++, x: e.x, y: e.gy, gy: e.gy,
          hp: 20 + barracksLv() * 12, maxhp: 20 + barracksLv() * 12,
          dmg: 6 + barracksLv() * 3, atkCd: 0, walkPhase: 0, home: CASTLE_X + 40 + rand(0, 60),
        });
      }
      break;
    }
  }
  // healer aura
  if (e.def.healer && e.hp > 0 && e.state !== 'grab' && e.state !== 'thrown') {
    e.healT -= dt;
    if (e.healT <= 0) {
      e.healT = 2;
      let healed = false;
      for (const o of G.enemies) {
        if (o === e || o.hp <= 0 || o.hp >= o.maxhp) continue;
        if (dist(o.x, o.y, e.x, e.y) < 140) {
          o.hp = Math.min(o.maxhp, o.hp + Math.round(8 + G.wave));
          puff(o.x, o.y - o.r * 2, 3, '#b0f0b0', 40, 3, -90, 0.7);
          healed = true;
        }
      }
      if (healed) spawnRing(e.x, e.y - 26, 20, 145, 'rgba(170,255,180,', 0.8);
    }
  }
  // trail decay
  for (let i = e.trail.length - 1; i >= 0; i--) { e.trail[i].t -= dt; if (e.trail[i].t <= 0) e.trail.splice(i, 1); }
}

/* ============================================================
   WAVES
   ============================================================ */
/* spawn frequency scale: 0.75 = enemies enter 25% less often (delays stretch
   by 1/0.75); counts per wave are unchanged so rewards stay identical */
const ENEMY_SPAWN_RATE_MULTIPLIER = 0.75;
const TYPE_UNLOCK = { runner: 1, soldier: 1, shield: 2, hammer: 3, bomber: 4, healer: 6, banner: 7, knight: 8, climber: 9, elite: 11 };
const TYPE_COST = { runner: 1, soldier: 1.4, shield: 2.2, hammer: 2.6, bomber: 2.2, healer: 3, banner: 3, knight: 4.5, climber: 1.8, elite: 6 };
const TYPE_WEIGHT = { runner: 3, soldier: 3, shield: 2, hammer: 2, bomber: 2, healer: 1.2, banner: 1.2, knight: 1.5, climber: 1.8, elite: 1 };

function buildWaveQueue(w) {
  // Daily Siege supplies its own fixed, pre-generated spawn sequence
  if (G.siege) return DAILY() ? DAILY().buildSiegeQueue() : [];
  const q = [];
  const isBoss = isBossWave(w);
  let budget = (6 + w * 3.2) * SPAWN_COUNT_MULTIPLIER;
  if (G.mod === 'horde') budget *= 1.4;
  const dur = Math.min(32, 13 + w * 1.3);
  const addSpread = (type, n, from = 0.5, to = dur) => {
    n = Math.ceil(n * SPAWN_COUNT_MULTIPLIER);   // scripted early waves scale too
    for (let i = 0; i < n; i++) q.push({ type, delay: rand(from, to) });
  };
  if (isBoss) {
    const boss = BOSS_ORDER[Math.floor(w / BOSS_WAVE_INTERVAL - 1) % BOSS_ORDER.length];
    if (boss === 'rams') {
      q.push({ type: 'ram', delay: 2.5, lane: GROUND_TOP + 12 });
      q.push({ type: 'ram', delay: 3.5, lane: GROUND_BOT - 12 });
    } else {
      q.push({ type: boss, delay: 2.5 });
    }
    G.bossAlive = boss;
    budget *= 0.55;
  }
  if (w === 1) { addSpread('runner', 5, 1, 12); addSpread('soldier', 2, 5, 14); }
  else if (w === 2) { addSpread('runner', 5, 1, 15); addSpread('soldier', 4, 3, 16); addSpread('shield', 1, 8, 14); }
  else if (w === 3) { addSpread('runner', 4); addSpread('soldier', 4); addSpread('shield', 2); addSpread('hammer', 1, 8, dur); }
  else {
    // procedural composition
    const pool = Object.keys(TYPE_UNLOCK).filter(t => TYPE_UNLOCK[t] <= w);
    let guard = 200;
    while (budget > 0 && guard-- > 0) {
      let total = 0;
      const avail = pool.filter(t => TYPE_COST[t] <= budget + 0.5);
      if (!avail.length) break;
      for (const t of avail) total += TYPE_WEIGHT[t];
      let r = Math.random() * total, pick = avail[0];
      for (const t of avail) { r -= TYPE_WEIGHT[t]; if (r <= 0) { pick = t; break; } }
      budget -= TYPE_COST[pick];
      q.push({ type: pick, delay: rand(0.5, dur) });
    }
  }
  if (G.mod === 'elite') { q.push({ type: 'elite', delay: rand(4, 10) }); q.push({ type: 'elite', delay: rand(8, 14) }); }
  /* 2026-07 balance pass: spawn RATE −25%. Wave composition (and therefore
     economy) is untouched — every spawn simply arrives on a 1/0.75 stretched
     timeline, so enemies enter the field 25% less frequently. */
  for (const s of q) s.delay /= ENEMY_SPAWN_RATE_MULTIPLIER;
  q.sort((a, b) => a.delay - b.delay);
  return q;
}

function startWave(w) {
  G.wave = w;
  G.mod = G.pendingMod; G.pendingMod = null;
  G.spawnQueue = buildWaveQueue(w);
  G.waveT = 0;
  G.waveActive = true;
  G.bellUsed = false;
  G.emergencyUsed = false;
  G.conversionsUsedThisWave = 0;   // 1 conversion per wave, refreshed here
  G.combo.n = 0; G.combo.t = 0;
  spawnGateGuards();
  rebuildAbilities();
  const isBoss = !G.siege && isBossWave(w);
  const bossKind = isBoss ? BOSS_ORDER[Math.floor(w / BOSS_WAVE_INTERVAL - 1) % BOSS_ORDER.length] : null;
  G.banner = G.siege ? '⚔ DAILY SIEGE ⚔' : isBoss ? `⚔ BOSS WAVE ${w} ⚔` : `Wave ${w}`;
  G.bannerSub = G.siege ? ((G.siegeCfg && G.siegeCfg.themeName) || 'Hold the line!')
    : bossKind ? BOSS_INTRO[bossKind] : (G.mod ? MODIFIERS.find(m => m.id === G.mod).name + ' active!' : '');
  G.bannerT = isBoss || G.siege ? 3.4 : 2.2;
  dailyEvent('waveStart', { wave: w, inSiege: !!G.siege });
  state = 'playing';
  CrashDiagnostics.record('wave-start', { wave: w, boss: !!isBoss, mod: G.mod || null });
  showScreen(null);
  $('hud').classList.remove('hidden');
  Sfx.wave();
  uiDirty = true;
}

function endWave() {
  /* Daily Siege is one wave, start to finish: clearing it ends the challenge —
     no rooms screen, no cards, no next wave, no wave-clear economy */
  if (G.siege) { if (DAILY()) DAILY().onSiegeCleared(); return; }
  G.waveActive = false;
  META.totalWavesCleared = (META.totalWavesCleared || 0) + 1;   // lifetime (milestones)
  dailyEvent('waveClear', { wave: G.wave, hpFrac: G.castleHp / G.castleMax, score: Math.round(G.score) });
  releaseGrab();
  // wave-clear gold bonus scaled by remaining castle health
  const hpFrac = G.castleHp / G.castleMax;
  let bonus = scaleCoinReward(Math.round((ECONOMY.waveClearBase + G.wave * ECONOMY.waveClearPerWave) * (0.4 + hpFrac) * goldMult()));
  let bonusText = `+${bonus}${coinIco()} wave bonus (castle at ${Math.round(hpFrac * 100)}%)`;
  if (G.mod === 'elite') {
    const eliteBonus = scaleCoinReward(60);
    bonus += eliteBonus;
    bonusText += ` · +${eliteBonus}${coinIco()} Elite Raid`;
  }
  addGold(bonus);
  bankRunCrowns(false);
  saveMeta();   // wave clear is a checkpoint — flush immediately
  G.score += Math.round(G.wave * 50 * (0.5 + hpFrac));
  G.mod = null;
  Sfx.coin();
  // top-up recruit roster count for assignment UI
  /* Between-wave interstitial every AD_GATE.waveInterval waves (never when
     ad-free). The wave is already over and the field is clear, so this is a
     break, not an interruption — combat is never covered. The upgrade cards
     are now GATED behind a due ad rather than shown regardless: the old
     .finally() handed them over even when the ad failed, which is what made
     switching the network off a free skip. */
  gateWaveClearTransition(bonusText);
}

/* Daily Siege only: a ceiling on how many foes may stand on the field at once.
   The siege sends far more bodies than a normal wave, so this is the guard that
   keeps a bad run (or a slow device) from turning into an unreadable, unplayable
   pile-up. Spawns are DEFERRED, never dropped: the entry stays at the head of
   the queue and lands as soon as the field has room, so the queue still empties
   and the wave-complete test (empty queue AND empty field) is untouched.
   Sized well above the ~15 peak the generator's own pacing model produces, so
   in normal play it never engages and never caps the escalation. */
const SIEGE_MAX_ACTIVE = 26;
/* ...and the opposite guard. The siege queue is a fixed, persisted script, so a
   player who kills faster than it spawns runs the field dry and stands waiting.
   When the field is EMPTY and the next arrival is further off than this, the
   whole remaining timeline is pulled forward — relative cadence, composition,
   count and score are all untouched, only the idle time is removed. It can
   never fire while anything is still alive, so it never crowds a player who is
   already struggling; it only refuses to let a strong one idle. */
const SIEGE_MAX_LULL = 1.0;

function updateWaveSpawns(dt) {
  G.waveT += dt;
  if (G.siege && G.spawnQueue.length && !G.enemies.length) {
    const wait = G.spawnQueue[0].delay - G.waveT;
    if (wait > SIEGE_MAX_LULL) {
      const shift = wait - SIEGE_MAX_LULL;
      for (const s of G.spawnQueue) s.delay -= shift;
    }
  }
  while (G.spawnQueue.length && G.spawnQueue[0].delay <= G.waveT) {
    if (G.siege && G.enemies.length >= SIEGE_MAX_ACTIVE) break;   // deferred, not lost
    const s = G.spawnQueue.shift();
    const e = makeEnemy(s.type, G.wave);
    if (s.lane !== undefined) { e.gy = s.lane; e.y = s.lane; }
    /* siege groups carry their own lane so a group of five arrives as a rank
       across the walking band instead of a stack nobody can grab apart */
    else if (s.laneFrac !== undefined) {
      const lane = GROUND_TOP + s.laneFrac * (GROUND_BOT - GROUND_TOP) + rand(-6, 6);
      e.gy = clamp(lane, GROUND_TOP, GROUND_BOT);
      e.y = e.gy;
      e.x += s.laneFrac * 46;                 // and staggered in depth, not abreast
    }
    // per-entry tuning (Daily Siege modifiers ride the spawn entries)
    if (s.hpMult) { e.hp = Math.max(1, Math.round(e.hp * s.hpMult)); e.maxhp = e.hp; }
    if (s.spdMult) e.spd *= s.spdMult;
    G.enemies.push(e);
    if (e.def.boss) { floater(W - 160, e.gy - 120, e.def.name + '!', '#ff8a6a', 22, 2); addShake(6); }
  }
}

/* ============================================================
   GAME FLOW
   ============================================================ */
/* Crowns bank INCREMENTALLY so nothing is lost if the app is killed,
   the run is abandoned, or the page is hidden. Idempotent: only the
   delta over what this run already banked is awarded. The per-run
   minimum applies once, when the run actually ends. */
function bankRunCrowns(final = false) {
  // Daily Siege awards Royal Seals through its tier system only — freely
  // retryable attempts must never bank crowns or star XP
  if (!G || !G.wave || G.siege) return 0;
  const ec = ECONOMY.crowns;
  let base = Math.floor(G.wave / ec.waveDivisor) + Math.floor(G.score / ec.scoreDivisor) + G.bankedCrowns;
  if (final) base = Math.max(ec.minimumPerRun, base);
  const total = base * (G.nightmare ? 2 : 1);
  const delta = Math.max(0, total - (G.crownsBankedSoFar || 0));
  // stars (score) bank incrementally into player XP the same delta-based way,
  // so app-kill mid-run never loses level progress and nothing double-counts
  const starDelta = Math.max(0, Math.round(G.score) - (G.starsBankedSoFar || 0));
  if (starDelta > 0) {
    META.playerXp = (META.playerXp || 0) + starDelta;
    G.starsBankedSoFar = (G.starsBankedSoFar || 0) + starDelta;
    grantLevelRewards();     // auto-grant coin rewards for any level just crossed
    dailyEvent('stars', { n: starDelta });
    uiDirty = true;
  }
  if (delta > 0) {
    META.crowns += delta;
    META.totalCrownsEarned = (META.totalCrownsEarned || 0) + delta;   // lifetime (milestones)
    G.crownsBankedSoFar = (G.crownsBankedSoFar || 0) + delta;
  }
  if (delta > 0 || starDelta > 0) saveMeta();
  return G.crownsBankedSoFar || 0;
}

/* current-run crown total for the live HUD indicator: the same formula
   bankRunCrowns() banks from (the end-of-run minimum applies only when the
   run actually ends, so the live number never overpromises). */
function runCrownsLive() {
  if (!G || !G.wave) return 0;
  const ec = ECONOMY.crowns;
  const base = Math.floor(G.wave / ec.waveDivisor) + Math.floor(G.score / ec.scoreDivisor) + G.bankedCrowns;
  return base * (G.nightmare ? 2 : 1);
}
/* total crowns the player actually OWNS right now, for the live HUD:
   banked treasury plus this run's not-yet-banked earnings. Incremental
   banking moves value from the pending term into META.crowns with the
   same delta, so this number never jumps at wave end — it only ticks up
   as crowns accrue, and down when crowns are spent (e.g. Save Run). */
function ownedCrownsLive() {
  return META.crowns + Math.max(0, runCrownsLive() - ((G && G.crownsBankedSoFar) || 0));
}

/* ------- player level: stars (score) accumulate into levels ------- */
/* Compounding curve to a hard cap of 99: level N -> N+1 needs
   5000 * 1.06^(N-1) stars (5000, 5300, 5618, ... ~1.5M at the top;
   ~25M total to max — a long-term goal without early-level windfalls).
   Level is always re-derived from total banked XP, so the curve is the
   single source of truth and legacy saves migrate implicitly. */
const MAX_PLAYER_LEVEL = 99;
function starsRequiredForLevel(level) {
  return Math.round(5000 * Math.pow(1.06, level - 1));
}
function playerLevelInfo(xpOverride) {
  let xp = (xpOverride !== undefined ? xpOverride : META.playerXp) || 0, level = 1;
  while (level < MAX_PLAYER_LEVEL && xp >= starsRequiredForLevel(level)) {
    xp -= starsRequiredForLevel(level);
    level++;
  }
  if (level >= MAX_PLAYER_LEVEL) return { level: MAX_PLAYER_LEVEL, into: 0, needed: 0, max: true };
  return { level, into: xp, needed: starsRequiredForLevel(level), max: false };
}
/* banked XP plus this run's not-yet-banked stars: the widgets track score
   gains live during play instead of jumping when stars bank at wave end.
   Reward GRANTS still key off banked XP only (grantLevelRewards). */
function liveStarXp() {
  const unbanked = (typeof G === 'object' && G && typeof G.score === 'number')
    ? Math.max(0, Math.round(G.score) - (G.starsBankedSoFar || 0)) : 0;
  return (META.playerXp || 0) + unbanked;
}

/* ------- level rewards: coin bonuses every 5 levels, auto-granted ------- */
/* (older saves that already collected the per-level rewards keep them; the
   claimed map carries over so nothing double-grants) */
const LEVEL_COIN_REWARDS = {
  5: 250, 10: 500, 15: 750, 20: 1000, 25: 1500, 30: 2000, 35: 2500, 40: 3000,
  45: 4000, 50: 5000, 55: 6000, 60: 7000, 65: 8000, 70: 9000, 75: 10000,
  80: 12500, 85: 15000, 90: 20000, 95: 25000, 99: 50000,
};
function levelRewardCoins(level) { return LEVEL_COIN_REWARDS[level] || 0; }
function grantLevelRewards() {
  if (!META.claimedLevelRewards) META.claimedLevelRewards = {};
  const { level } = playerLevelInfo();
  let granted = 0;
  for (let l = 2; l <= level; l++) {
    if (META.claimedLevelRewards[l]) continue;
    const coins = levelRewardCoins(l);
    META.claimedLevelRewards[l] = true;
    if (coins > 0) { addGold(coins); granted += coins; }
  }
  if (granted > 0) {
    saveMeta();
    if (G && state === 'playing') floater(W / 2, 200, `LEVEL UP! +${granted} 🪙`, '#ffd77a', 26, 2.2);
    else if (typeof Sfx !== 'undefined') Sfx.coin();
  }
  return granted;
}

/* shared renderer for the sprite-based level widgets (menu + HUD).
   The bar art's inner track spans ~7%–93% of the sprite width; the filled
   layer is clipped inside that range so end caps never look cut. */
function updateLevelWidget(numId, fillId, textId) {
  const pl = playerLevelInfo(liveStarXp());
  const numEl = $(numId), fillEl = $(fillId), textEl = $(textId);
  if (!numEl || !fillEl) return pl;
  /* EVERY write below is change-guarded: this runs once per frame from
     updateHUD during a run, and the HUD widget sits inside a filtered subtree
     (#levelBarWrap). An unguarded write repaints it 60x/second for nothing —
     the DOM-side version of the per-frame offscreen surface rule that killed
     the Adreno driver (see the SPRITE_TINTS note near loadAssets). */
  if (numEl.__lvlNum !== pl.level) { numEl.__lvlNum = pl.level; numEl.textContent = pl.level; }
  const frac = pl.max ? 1 : clamp(pl.into / pl.needed, 0, 1);
  const visible = 7 + frac * 86;              // % of sprite width to reveal
  const clip = `inset(0 ${(100 - visible).toFixed(1)}% 0 0)`;
  if (fillEl.__lvlClip !== clip) { fillEl.__lvlClip = clip; fillEl.style.clipPath = clip; }
  // the badge already shows the level — in-bar text shows progress instead
  if (textEl) {
    const html = pl.max ? 'Level 99 MAX'
      : `${pl.into.toLocaleString()} / ${pl.needed.toLocaleString()}${STAR_IMG}`;
    // called every frame from updateHUD — only touch the DOM on change
    if (textEl.__lvlHtml !== html) { textEl.__lvlHtml = html; textEl.innerHTML = html; }
  }
  return pl;
}

/* ------- milestones: one-time lifetime achievement rewards ------- */
/* Tiered milestones: each category is an endless-feeling ladder — claiming a
   tier immediately reveals the next, harder one. Progress reads lifetime
   stats; claimed tier COUNT per category is the only save state.
   `icon` is the emoji FALLBACK glyph only — the displayed icon comes from
   the MILESTONE_ART sprite map, keyed by the category id.

   REWARD CURRENCY: milestones pay COINS ONLY (reward version 2). Crowns stay
   the premium currency of the Treasury, Kingdom Restoration, Daily Siege,
   Decrees and per-run banking — a milestone objective may still COUNT crowns
   (Crown Collector), but it never PAYS them. This object is the single source
   of truth for both the amount shown on the claim button and the amount
   granted, so never hard-code a reward figure in UI or help text.

   Balance bands (conservative, ≈5 coins per retired crown, nudged so each
   ladder stays monotonic and its last visible tier lands like a capstone):
     early tiers 100–150 · mid 175–400 · advanced 500–1,000 · capstone 1,250+
   The whole ladder pays 18,625 coins across a player's lifetime, against
   540–3,240 per room upgrade and 250–50,000 per level reward — a supplement
   to normal earnings, never the main coin faucet. */
const MILESTONE_CATS = [
  { id: 'slayer',   name: 'Slayer',         icon: '⚔️', desc: n => `Defeat ${n.toLocaleString()} enemies`,   stat: () => META.totalKills || 0,
    tiers: [{ goal: 100, reward: { coins: 100 } }, { goal: 250, reward: { coins: 175 } }, { goal: 500, reward: { coins: 300 } }, { goal: 1000, reward: { coins: 450 } }, { goal: 2000, reward: { coins: 700 } }, { goal: 5000, reward: { coins: 1000 } }, { goal: 10000, reward: { coins: 1500 } }] },
  { id: 'boss',     name: 'Boss Breaker',   icon: '🔨', desc: n => `Defeat ${n.toLocaleString()} boss${n > 1 ? 'es' : ''}`, stat: () => META.totalBosses || 0,
    tiers: [{ goal: 1, reward: { coins: 150 } }, { goal: 5, reward: { coins: 250 } }, { goal: 15, reward: { coins: 400 } }, { goal: 40, reward: { coins: 650 } }, { goal: 100, reward: { coins: 1250 } }] },
  { id: 'convert',  name: 'Recruiter',      icon: '🌀', desc: n => `Convert ${n.toLocaleString()} enemies`,  stat: () => META.totalConverts || 0,
    tiers: [{ goal: 10, reward: { coins: 100 } }, { goal: 50, reward: { coins: 200 } }, { goal: 150, reward: { coins: 350 } }, { goal: 400, reward: { coins: 600 } }, { goal: 1000, reward: { coins: 1250 } }] },
  { id: 'wave',     name: 'Siege Survivor', icon: '🛡️', desc: n => `Reach wave ${n}`,                       stat: () => META.bestWave || 0,
    tiers: [{ goal: 10, reward: { coins: 100 } }, { goal: 25, reward: { coins: 250 } }, { goal: 40, reward: { coins: 400 } }, { goal: 60, reward: { coins: 700 } }, { goal: 100, reward: { coins: 1500 } }] },
  { id: 'defender', name: 'Defender',       icon: '🏰', desc: n => `Clear ${n.toLocaleString()} waves in total`, stat: () => META.totalWavesCleared || 0,
    tiers: [{ goal: 50, reward: { coins: 150 } }, { goal: 150, reward: { coins: 250 } }, { goal: 400, reward: { coins: 500 } }, { goal: 1000, reward: { coins: 1250 } }] },
  { id: 'gold',     name: 'Gold Hoarder',   icon: '💰', desc: n => `Earn ${n.toLocaleString()} coins in total`,  stat: () => META.totalCoinsEarned || 0,
    tiers: [{ goal: 5000, reward: { coins: 150 } }, { goal: 25000, reward: { coins: 300 } }, { goal: 100000, reward: { coins: 600 } }, { goal: 300000, reward: { coins: 1250 } }] },
  { id: 'crown',    name: 'Crown Collector', icon: '⚜️', desc: n => `Earn ${n.toLocaleString()} crowns from runs`, stat: () => META.totalCrownsEarned || 0,
    tiers: [{ goal: 50, reward: { coins: 150 } }, { goal: 200, reward: { coins: 400 } }, { goal: 600, reward: { coins: 1250 } }] },
];
/* bumped whenever the reward CURRENCY of the ladder changes: v2 = all coins.
   It is part of every claim's transaction id, so a currency change can never
   collide with a pre-existing ledger entry. */
const MILESTONE_REWARD_VERSION = 2;
const milestoneTxId = (catId, tierIdx) => `milestone|${catId}|${tierIdx}|coin_reward|v${MILESTONE_REWARD_VERSION}`;
const milestoneTierCoins = tier => (tier && tier.reward && tier.reward.coins) || 0;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const milestoneTierName = (cat, idx) => `${cat.name} ${ROMAN[idx] || idx + 1}`;

/* one-time migration from the legacy one-shot milestones: a tier counts as
   claimed if the player already claimed a legacy milestone with a goal at or
   past it (they were never offered the in-between tiers, so no reward is lost
   or duplicated) */
function migrateMilestones() {
  if (META.milestoneTiers) return;
  const old = META.milestonesClaimed || {};
  const LEGACY = { kills100: ['slayer', 100], kills500: ['slayer', 500], kills2000: ['slayer', 2000],
    wave10: ['wave', 10], wave25: ['wave', 25], boss1: ['boss', 1], boss5: ['boss', 5],
    convert10: ['convert', 10], convert50: ['convert', 50] };
  const maxClaimed = {};
  for (const [oid, [catId, goal]] of Object.entries(LEGACY))
    if (old[oid]) maxClaimed[catId] = Math.max(maxClaimed[catId] || 0, goal);
  META.milestoneTiers = {};
  for (const cat of MILESTONE_CATS) {
    let n = 0;
    for (const t of cat.tiers) { if ((maxClaimed[cat.id] || 0) >= t.goal) n++; else break; }
    META.milestoneTiers[cat.id] = n;
  }
  saveMeta();
}
migrateMilestones();

function activeMilestoneTier(cat) {
  const n = (META.milestoneTiers && META.milestoneTiers[cat.id]) || 0;
  return n >= cat.tiers.length ? null : { ...cat.tiers[n], index: n };
}
function milestoneClaimable(cat) {
  const t = activeMilestoneTier(cat);
  return !!t && cat.stat() >= t.goal;
}
/* ONE gate for every milestone coin grant. Two independent guards, in this
   order: the claimed-tier COUNT (which advances past this tier and is what
   older saves have always relied on) and a permanent transaction ledger keyed
   by milestone|<cat>|<tier>|coin_reward|v<n>. The ledger entry, the coin
   grant and the tier bump all land in ONE saveMeta(), so a crash mid-claim
   can only leave the pre-claim state or the fully-claimed state — never a
   granted-but-unclaimed or claimed-but-unpaid save.
   `busy` closes the last gap: two taps dispatched before the list re-renders
   can't re-enter this function. Sequential claiming of several already-earned
   tiers still works — each tap after the re-render is a fresh, different
   tier index, and therefore a different transaction id. */
let milestoneClaimBusy = false;
function claimMilestone(cat) {
  if (milestoneClaimBusy) return false;
  milestoneClaimBusy = true;
  try {
    if (!milestoneClaimable(cat)) return false;   // 1. requirement complete + not claimed
    const t = activeMilestoneTier(cat);
    const coins = milestoneTierCoins(t);          // 3. reward read from config only
    const txId = milestoneTxId(cat.id, t.index);
    if (!META.milestoneTx || typeof META.milestoneTx !== 'object') META.milestoneTx = {};
    const replay = !!META.milestoneTx[txId];      // 4. verify / create the transaction
    if (!replay) META.milestoneTx[txId] = { coins: coins, at: Date.now() };
    META.milestoneTiers[cat.id] = t.index + 1;    // 6. next tier appears immediately
    if (!replay && coins > 0) addGold(coins);     // 5. canonical coin wallet
    saveMeta();                                   // 7. ledger + tier + coins in one write
    dailyEvent('milestone', { cat: cat.id });
    return true;
  } finally {
    milestoneClaimBusy = false;
  }
}

/* ------- Save Run: a paid between-wave checkpoint ------- */
const SAVE_RUN_COST_CROWNS = 20;
function snapshotRun() {
  return {
    v: 1,
    castleIdx: selectedCastle,
    wave: G.wave,                       // completed waves; continue starts at wave+1
    castleHp: G.castleHp, castleMax: G.castleMax,
    /* the Kingdom Restoration HP bonus baked into castleMax above. Stored so
       resuming can swap it for the CURRENT bonus instead of adding a second
       copy — a save written before this field existed simply reports 0, which
       is exactly what it held. */
    krHpBonus: G.krHpBonus || 0,
    rooms: { ...G.rooms },
    recruits: { ...G.recruits },
    upgrades: { ...G.upgrades },
    freeUpgradesUsed: G.freeUpgradesUsed,
    rewardedUpgradeCredits: G.rewardedUpgradeCredits,
    cdStore: { ...G.cdStore },
    score: G.score,
    stats: { ...G.stats },
    nightmare: G.nightmare,
    crownsBankedSoFar: G.crownsBankedSoFar || 0,
    starsBankedSoFar: G.starsBankedSoFar || 0,
    bankedCrowns: G.bankedCrowns || 0,
    savedAt: Date.now(),
  };
}
function saveRunCheckpoint() {
  if (state !== 'build') return false;             // between waves only
  if (META.crowns < SAVE_RUN_COST_CROWNS) return false;
  META.crowns -= SAVE_RUN_COST_CROWNS;
  META.savedRun = snapshotRun();
  saveMeta();
  return true;
}
function continueSavedRun() {
  const s = META.savedRun;
  if (!s) return;
  newRun(clamp(s.castleIdx || 0, 0, CASTLES.length - 1));
  G.wave = s.wave;
  /* Reconcile the Outer Walls bonus rather than re-adding it: strip whatever
     the snapshot was written with (0 for a pre-passive save) and apply what
     the kingdom is worth NOW. A district restored while this run sat saved
     therefore raises the resumed castle too — by exactly one bonus, once. */
  const krHpWas = s.krHpBonus || 0;
  const krHpNow = Math.round(kingdomBonus().castleHp);
  G.krHpBonus = krHpNow;
  G.castleMax = Math.max(1, s.castleMax - krHpWas + krHpNow);
  G.castleHp = Math.min(Math.max(1, s.castleHp + (krHpNow - krHpWas)), G.castleMax);
  G.rooms = { ...G.rooms, ...s.rooms };
  G.recruits = { ...G.recruits, ...s.recruits };
  G.upgrades = { ...s.upgrades };
  G.freeUpgradesUsed = s.freeUpgradesUsed || 0;
  G.rewardedUpgradeCredits = s.rewardedUpgradeCredits || 0;
  G.cdStore = { ...s.cdStore };
  G.score = s.score || 0;
  G.stats = { ...G.stats, ...s.stats };
  G.nightmare = !!s.nightmare;
  G.crownsBankedSoFar = s.crownsBankedSoFar || 0;
  G.starsBankedSoFar = s.starsBankedSoFar || 0;
  G.bankedCrowns = s.bankedCrowns || 0;
  // rebuild recruits into fighting defenders at the gate
  for (let i = 0; i < (G.recruits.gate || 0); i++) {
    G.defenders.push({
      id: idCounter++, x: CASTLE_X + 40 + rand(0, 60), y: 0, gy: rand(GROUND_TOP, GROUND_BOT),
      hp: 20 + barracksLv() * 12, maxhp: 20 + barracksLv() * 12,
      dmg: 6 + barracksLv() * 3, atkCd: 0, walkPhase: 0, home: CASTLE_X + 40 + rand(0, 60),
    });
    G.defenders[G.defenders.length - 1].y = G.defenders[G.defenders.length - 1].gy;
  }
  META.savedRun = null;                 // one resume per checkpoint purchase
  saveMeta();
  Sfx.unlock();
  rebuildAbilities();
  showBuildScreen();                    // resume exactly where they saved: between waves
}

function gameOver() {
  /* a fallen castle in Daily Siege routes to the siege result panel (a Bronze
     may still be earned) — never the classic game-over flow or its stats */
  if (G && G.siege) { if (DAILY()) DAILY().onSiegeFailed(); return; }
  /* ...and once that panel is up the attempt is settled. The siege clears
     G.siege as it settles, so a SECOND attacker landing its blow in the same
     frame as the killing one used to fall straight through into the classic
     flow: game-over screen over the result panel, a siege attempt counted as a
     run, and its score banked as crowns. Dense siege waves put several foes on
     the wall at once, which made that a routine occurrence rather than a race. */
  if (state === 'siegeResult') return;
  if (state === 'gameover') return;
  state = 'gameover';
  CrashDiagnostics.record('game-over', { wave: G.wave, score: G.score });
  releaseGrab();
  Sfx.lose(); addShake(20);
  const crowns = bankRunCrowns(true);
  META.runs++;
  META.bestWave = Math.max(META.bestWave, G.wave);
  META.bestScore = Math.max(META.bestScore, G.score);
  saveMeta();
  $('goStats').innerHTML =
    `Waves survived: <b>${G.wave}</b><br>` +
    `Score: <b>${G.score.toLocaleString()}</b><br>` +
    `Enemies defeated: <b>${G.stats.kills}</b><br>` +
    `Recruits converted: <b>${G.stats.converts}</b><br>` +
    `Best combo: <b>×${G.stats.maxCombo}</b>`;
  $('goCrowns').innerHTML = `${artHtml('icon_crown_gold.png', 'ico big')} +${crowns} crowns earned${G.nightmare ? ' (Nightmare ×2!)' : ''}`;
  showScreen('gameoverScreen');
  /* The run is over and its results are already on screen — the one natural
     break where a forced ad belongs. Deliberately NOT awaited: the game-over
     screen is fully interactive whether or not an ad appears, so a slow or
     failed ad can never hold the player on a dead frame. All pacing rules
     (ad-free, cooldowns, post-rewarded standoff, run spacing) live in
     interstitialDue().

     attemptOnly: the requirement is recorded and one attempt is made here, but
     an offline device gets NO prompt at this moment — the player has not asked
     to go anywhere yet, and trapping them on the results screen would leave no
     safe exit. The debt simply stands, and gateEnterGameplay settles it the
     moment they try to start another run. That is deliberate: leaving to the
     main menu is never gated, only re-entering ad-supported gameplay is. */
  if (interstitialDue('run_complete')) requireInterstitial('run_complete');
  if (pendingInterstitial()) runInterstitialGate({ attemptOnly: true });
}

function pauseGame() {
  if (state !== 'playing') return;
  dropGrab();
  state = 'paused';
  /* document.hidden distinguishes a lifecycle auto-pause (home button, call,
     app switch) from the player opening the pause menu by hand */
  CrashDiagnostics.record('pause', { lifecycle: !!document.hidden });
  Music.duck();
  bankRunCrowns(false);   // checkpoint progress on pause
  saveMeta();
  const ups = Object.entries(G.upgrades).map(([id, n]) => {
    const u = UPGRADES.find(u => u.id === id);
    return `${u.icon} ${u.name}${n > 1 ? ' ×' + n : ''}`;
  });
  $('pauseUpgrades').innerHTML = ups.length ? '<b>Upgrades:</b> ' + ups.join(' · ') : 'No upgrades yet.';
  showScreen('pauseScreen');
}
function resumeGame() {
  if (state !== 'paused') return;
  state = 'playing';
  CrashDiagnostics.record('resume');
  Music.duck();
  showScreen(null);
}

/* ============================================================
   MASTER UPDATE
   ============================================================ */
function update(dt) {
  G.time += dt;
  G.shake = Math.max(0, G.shake - dt * 26);
  G.flash = Math.max(0, G.flash - dt * 1.2);
  G.shieldT = Math.max(0, G.shieldT - dt);
  G.bannerT = Math.max(0, G.bannerT - dt);
  if (G.combo.t > 0) { G.combo.t -= dt; if (G.combo.t <= 0) G.combo.n = 0; }

  // slow fields
  for (let i = G.slowFields.length - 1; i >= 0; i--) {
    G.slowFields[i].t -= dt;
    if (G.slowFields[i].t <= 0) G.slowFields.splice(i, 1);
  }
  // abilities cooldown
  for (const a of G.abilities) {
    if (a.cd > 0) { a.cd = Math.max(0, a.cd - dt); G.cdStore[a.id] = a.cd; }
  }

  if (G.waveActive) {
    updateWaveSpawns(dt);
    for (const e of G.enemies) if (e.state !== 'dead') updateEnemy(e, dt);
    // sweep dead
    for (let i = G.enemies.length - 1; i >= 0; i--) if (G.enemies[i].state === 'dead') G.enemies.splice(i, 1);
    updateDefenders(dt);
    updateArcher(dt);
    updateArrows(dt);
    updateBombs(dt);
    // mason repair
    if (G.mod !== 'norepair') {
      const rate = masonRate(G.rooms.mason) + G.recruits.mason * 0.8;
      if (rate > 0) repairCastle(rate * dt);
      if (G.rooms.mason >= 3 && !G.emergencyUsed && G.castleHp < G.castleMax * 0.25) {
        G.emergencyUsed = true;
        repairCastle(G.castleMax * 0.13);
        floater(280, 430, '🧱 EMERGENCY REPAIRS!', '#7ad9a0', 18, 1.4);
        puff(280, 480, 18, '#b9a37e', 150, 6, 100, 0.8);
      }
    }
    // wave complete? (the tutorial stashes the real queue while it runs, so
    // the momentarily empty field must not be read as a cleared wave)
    const tutW = TUT();
    if (!G.spawnQueue.length && !G.enemies.length && !(tutW && tutW.blocksWaveEnd())) endWave();
  }

  // particles
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.life -= dt;
    if (p.life <= 0) { G.particles.splice(i, 1); continue; }
    p.vy += (p.grav || 0) * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  // floaters
  for (let i = G.floaters.length - 1; i >= 0; i--) {
    const f = G.floaters[i];
    f.life -= dt; f.y += f.vy * dt;
    if (f.life <= 0) G.floaters.splice(i, 1);
  }
  // ground decals (death marks / scorch craters)
  for (let i = G.corpses.length - 1; i >= 0; i--) {
    const c = G.corpses[i];
    c.t += dt;
    if (c.t > (c.life || 3.5)) G.corpses.splice(i, 1);
  }
  updateHUD();
}

/* ============================================================
   RENDERING
   ============================================================ */
let ambientT = 0;

/* static background painted once to an offscreen canvas */
const bgCanvas = document.createElement('canvas');
bgCanvas.width = W; bgCanvas.height = H;
/* Plain loading backdrop — only visible for the instant before the scenic
   background image arrives. The battlefield art is a complete opaque scene
   (sky, mountains, valley, castle, grass), so nothing is painted behind it. */
(function paintBackground() {
  const b = bgCanvas.getContext('2d');
  const sky = b.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#7db4e0'); sky.addColorStop(0.6, '#a9c9d8'); sky.addColorStop(1, '#5f7a4a');
  b.fillStyle = sky; b.fillRect(0, 0, W, H);
})();

function drawImageCover(img, dx, dy, dw, dh) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const srcRatio = iw / ih;
  const dstRatio = dw / dh;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (srcRatio > dstRatio) {
    sw = ih * dstRatio;
    sx = (iw - sw) / 2;
  } else if (srcRatio < dstRatio) {
    sh = iw / dstRatio;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

const BANNER_COLORS = { emerald: ['#4ec27e', '#1d6b3e'], crimson: ['#e05a4a', '#7e1f16'], azure: ['#5a8ae0', '#1f3a7e'] };

/* painted-style hanging banner: shaded cloth, gold rail, emblem, swallowtail */
function drawBanner(x, y, wPix, hPix, wave) {
  const [lo, hi] = BANNER_COLORS[META.banner] || BANNER_COLORS.emerald;
  const sway = Math.sin(wave) * 2.5;
  ctx.save();
  // gold hanging rail
  ctx.fillStyle = '#c9a94a';
  ctx.fillRect(x - 3, y - 2, wPix + 6, 4);
  // cloth with vertical shading
  const g = ctx.createLinearGradient(x, y, x + wPix * 0.4, y + hPix);
  g.addColorStop(0, lo); g.addColorStop(1, hi);
  ctx.fillStyle = g;
  ctx.strokeStyle = 'rgba(20,16,12,.65)'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + 2);
  ctx.lineTo(x + wPix, y + 2);
  ctx.lineTo(x + wPix + sway * 0.5, y + hPix * 0.62);
  ctx.lineTo(x + wPix * 0.78 + sway, y + hPix);            // swallowtail right point
  ctx.lineTo(x + wPix * 0.5 + sway * 0.7, y + hPix * 0.78);
  ctx.lineTo(x + wPix * 0.22 + sway, y + hPix);            // swallowtail left point
  ctx.lineTo(x - sway * 0.3, y + hPix * 0.62);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // cloth highlight
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  ctx.beginPath();
  ctx.moveTo(x + 2, y + 3); ctx.lineTo(x + wPix * 0.4, y + 3);
  ctx.lineTo(x + wPix * 0.28, y + hPix * 0.65); ctx.lineTo(x + 1, y + hPix * 0.5);
  ctx.closePath(); ctx.fill();
  // gold crown emblem
  ctx.fillStyle = 'rgba(255,224,130,.85)';
  const ex = x + wPix / 2 + sway * 0.3, ey = y + hPix * 0.34, s = wPix * 0.16;
  ctx.beginPath();
  ctx.moveTo(ex - s, ey + s * 0.8);
  ctx.lineTo(ex - s, ey - s * 0.3); ctx.lineTo(ex - s * 0.45, ey + s * 0.15);
  ctx.lineTo(ex, ey - s * 0.7); ctx.lineTo(ex + s * 0.45, ey + s * 0.15);
  ctx.lineTo(ex + s, ey - s * 0.3); ctx.lineTo(ex + s, ey + s * 0.8);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

/* ============================================================
   CASTLE UPGRADE SOCKET SYSTEM
   The stronghold art is baked into the scenic background; all
   upgrade structures snap to fixed hardpoints defined RELATIVE
   to the castle's bounds — never to raw screen positions. The
   canvas has a fixed logical size (1280x720, uniformly CSS-
   scaled on resize), so ratio-derived points stay glued to the
   castle at every window/device size; moving or rescaling the
   stronghold only requires editing castleLayout.

   Socket types:
   - roof_socket      small tower additions on the battlements
   - wall_socket      pieces attached to the castle silhouette
   - ground_yard_slot support district hugging the castle base
   - foreground_slot  minor props (cosmetic war-standard)
   Layers draw back-to-front: roof (0) -> wall (1) -> yard (2),
   and the whole castle pass draws before defenders/enemies/VFX
   so gameplay always reads in front of the architecture.
   ============================================================ */
const castleLayout = {
  x: 0,          // left edge of the stronghold (world coords)
  y: 100,        // top of the tallest tower
  width: 430,    // footprint width — nothing may exceed this into the field
  height: 620,   // tower top to forecourt ground
  groundY: 600,  // courtyard ground line at the keep's front
};

/* Shield Burst dome: sized from the castle's world bounds (+ padding) so the
   gate, towers and every attached upgrade all sit inside the protection ring */
const SHIELD_DOME = {
  x: castleLayout.x + castleLayout.width / 2,
  y: castleLayout.y + castleLayout.height / 2,
  r: Math.max(castleLayout.width, castleLayout.height) / 2 + 40,
};

function drawShieldDome(t) {
  const { x, y } = SHIELD_DOME;
  // smooth fade: quick swell on cast, gentle dissolve at the end
  const a = Math.min(1, ((G.shieldMax || 5) - G.shieldT) / 0.3, G.shieldT / 0.7);
  const R = SHIELD_DOME.r * (1 + Math.sin(t * 5) * 0.012);   // gentle breathing
  ctx.save();
  ctx.globalAlpha = a;
  // 1. translucent blue energy dome (hollow center keeps the fight readable)
  const g = ctx.createRadialGradient(x, y, R * 0.35, x, y, R);
  g.addColorStop(0, 'rgba(110,190,255,0.03)');
  g.addColorStop(0.8, 'rgba(110,190,255,0.10)');
  g.addColorStop(0.96, 'rgba(160,220,255,0.22)');
  g.addColorStop(1, 'rgba(200,240,255,0.05)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
  // 2. thin silver-white rim + faint inner arc
  ctx.strokeStyle = 'rgba(225,240,255,0.75)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
  ctx.strokeStyle = 'rgba(150,215,255,0.28)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, R - 9, 0, TAU); ctx.stroke();
  // 3. gold sparkles drifting along the rim
  for (let i = 0; i < 7; i++) {
    const ang = t * 0.55 + i * (TAU / 7);
    const sx = x + Math.cos(ang) * (R - 4), sy = y + Math.sin(ang) * (R - 4);
    const tw = 0.5 + 0.5 * Math.sin(t * 6 + i * 1.7);
    ctx.fillStyle = `rgba(255,224,130,${0.35 + 0.45 * tw})`;
    ctx.beginPath(); ctx.arc(sx, sy, 1.6 + tw * 1.7, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

const CASTLE_UPGRADE_SOCKETS = {
  /* battlement / rooftop additions */
  roofLeft:     { type: 'roof_socket',      xRatio: 0.112, yRatio: 0.375, maxHeightRatio: 0.262, layer: 0 },
  roofRight:    { type: 'roof_socket',      xRatio: 0.856, yRatio: 0.253, maxHeightRatio: 0.210, layer: 0 },
  /* wall attachments */
  wallCrest:    { type: 'wall_socket',      xRatio: 0.693, yRatio: 0.287, maxHeightRatio: 0.185, layer: 1 },   // raised so the archer platform mounts ON the battlement
  wallRight:    { type: 'wall_socket',      xRatio: 0.977, yRatio: 0.358, maxHeightRatio: 0.190, layer: 1 },
  wallRightFace:{ type: 'wall_socket',      xRatio: 0.935, yRatio: 0.532, maxHeightRatio: 0.226, layer: 1 },
  wallBaseLeft: { type: 'wall_socket',      xRatio: 0.084, yRatio: 0.887, maxHeightRatio: 0.171, layer: 1 },
  /* support-district row along the castle base (bottom-left) */
  yardA:        { type: 'ground_yard_slot', xRatio: 0.128, yRatio: 0.968, maxHeightRatio: 0.187, layer: 2 },
  yardB:        { type: 'ground_yard_slot', xRatio: 0.377, yRatio: 0.977, maxHeightRatio: 0.192, layer: 2 },
  yardC:        { type: 'ground_yard_slot', xRatio: 0.628, yRatio: 0.987, maxHeightRatio: 0.166, layer: 2 },
  yardD:        { type: 'ground_yard_slot', xRatio: 0.872, yRatio: 0.994, maxHeightRatio: 0.163, layer: 2 },
  /* minor foreground props by the gate approach */
  foregroundGate: { type: 'foreground_slot', xRatio: 1.042, yRatio: 0.839, maxHeightRatio: 0.12, layer: 2 },
};
function socketPoint(name) {
  const s = CASTLE_UPGRADE_SOCKETS[name];
  return {
    x: castleLayout.x + s.xRatio * castleLayout.width,
    y: castleLayout.y + s.yRatio * castleLayout.height,
    maxH: s.maxHeightRatio * castleLayout.height,
    type: s.type, layer: s.layer,
  };
}

/* every upgrade has one defined home; sockets hold one structure each.
   show() gates on purchase state so only active upgrades render. */
const UPGRADE_PLACEMENT = [
  /* mage tower: wall-integrated turret, corbel base overlapping the left battlement */
  { id: 'fu2_mage_tower', socket: 'roofLeft',      maxHeight: 160, pips: 'mage', show: () => G.rooms.mage > 0 },
  /* Panic Bell is a passive card upgrade: it keeps its ability button but
     deliberately has NO castle attachment (removed from socket placement) */
  /* wall forge: built into the right wall face, beside the baked crane/scaffold */
  { id: 'fu2_wall_forge', socket: 'wallRightFace', maxHeight: 140, pips: 'wall', show: () => G.rooms.wall > 0 },
  { id: 'fu_archer',      socket: 'wallCrest',     maxHeight: 112, pips: 'archer', show: () => G.rooms.archer > 0 },
  { id: 'fu_shieldgen', socket: 'wallBaseLeft', maxHeight: 105,                   show: () => G.rooms.mage >= 3 },
  { id: 'fu_mason',     socket: 'yardA', maxHeight: 115, pips: 'mason',    show: () => G.rooms.mason > 0 },
  { id: 'fu_bombshop',  socket: 'yardB', maxHeight: 118, pips: 'bomb',     show: () => G.rooms.bomb > 0 },
  { id: 'upgrade_conversion_barracks', socket: 'yardC', maxHeight: 102, pips: 'barracks', show: () => G.rooms.barracks > 0 },
  { id: 'fu_vault',     socket: 'yardD', maxHeight: 100,                   show: () => up('goldMagnet') > 0 },
];

/* bottom-center anchored, aspect preserved, capped by both the
   placement's own max height and the socket's structural limit */
function drawAnchoredSprite(id, pt, maxHeight) {
  return drawSpriteCB(id, pt.x, pt.y, Math.min(maxHeight, pt.maxH));
}

function drawCastle() {
  const hpF = G.castleHp / G.castleMax;
  const t = ambientT;
  // ------- castle body: damage-stage artwork replaces the baked castle -------
  // 76-100% healthy · 51-75% light · 26-50% heavy · 0-25% critical
  const stage = hpF > 0.75 ? 0 : hpF > 0.5 ? 1 : hpF > 0.25 ? 2 : 3;
  const stageImg = IMGS['castle_stage' + stage];
  const bgImg = IMGS.bg_scenic;
  if (stageImg && bgImg) {
    // hide the baked castle by MIRRORING the neighbouring valley slice over
    // its region: at the boundary the mirrored pixels equal the originals,
    // so the seam is continuous (no visible box edge), and the full-height
    // slice avoids any horizontal seam in the sky
    const fx = bgImg.naturalWidth / W, fy = bgImg.naturalHeight / H;
    ctx.save();
    ctx.translate(440, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(bgImg, 440 * fx, 0, 440 * fx, 588 * fy, 0, 0, 440, 588);
    ctx.restore();
    // the damage-stage castle is the one and only castle. Per-stage draw
    // params compensate for differing content boxes so the structure keeps
    // the same on-screen size and footing across every stage (stage 1's
    // sprite had its baked terrain skirt removed, so it sits a touch higher
    // and slightly smaller in raw crop terms).
    const STAGE_DRAW = [
      { y: 606, h: 560 },   // healthy
      { y: 592, h: 546 },   // light damage (cleaned sprite)
      { y: 606, h: 560 },   // heavy damage
      { y: 606, h: 560 },   // critical
    ];
    const sd = STAGE_DRAW[stage];
    drawSpriteCB('castle_stage' + stage, 218, sd.y, sd.h);
  }
  // ------- socketed structures, back-to-front by socket layer -------
  const active = UPGRADE_PLACEMENT.filter(p => p.show());
  active.sort((a, b) => socketPoint(a.socket).layer - socketPoint(b.socket).layer);
  const used = {};                                  // one structure per socket
  for (const p of active) {
    const pt = socketPoint(p.socket);
    if (used[p.socket]) pt.x += 26;                 // defensive nudge, never stack
    used[p.socket] = true;
    // no drawn shadows/pads under castle structures — the sprites' own painted
    // shading carries the grounding; sockets place them flush with the stone
    drawAnchoredSprite(p.id, pt, p.maxHeight);
    if (p.pips) {
      const lv = G.rooms[p.pips];
      if (lv > 1) {
        ctx.fillStyle = '#ffd24a';
        ctx.strokeStyle = 'rgba(20,16,12,.8)'; ctx.lineWidth = 1.5;
        for (let i = 0; i < lv; i++) {
          ctx.beginPath(); ctx.arc(pt.x - (lv - 1) * 6 + i * 12, pt.y + 8, 3.5, 0, TAU); ctx.fill(); ctx.stroke();
        }
      }
    }
  }
  // crew: mason foreman beside his workshop slot
  if (G.rooms.mason > 0) {
    const ya = socketPoint('yardA');
    drawSpriteCB('defender_mason', ya.x + 64, ya.y - 4, 48);
  }
  // mage tower arcane glow (over the crystal window, tracks its socket)
  if (G.rooms.mage > 0) {
    const rl = socketPoint('roofLeft');
    const th = Math.min(160, rl.maxH);
    ctx.fillStyle = `rgba(160,120,255,${0.16 + Math.sin(t * 4) * 0.07})`;
    ctx.beginPath(); ctx.arc(rl.x, rl.y - th * 0.55, 22 + Math.sin(t * 4) * 5, 0, TAU); ctx.fill();
  }
  // shield generator idle shimmer
  if (G.rooms.mage >= 3) {
    const wb = socketPoint('wallBaseLeft');
    ctx.fillStyle = `rgba(110,200,255,${0.14 + Math.sin(t * 5) * 0.06})`;
    ctx.beginPath(); ctx.arc(wb.x, wb.y - Math.min(105, wb.maxH) + 16, 18 + Math.sin(t * 5) * 4, 0, TAU); ctx.fill();
  }
  // ------- conversion flag at the gate-approach prop slot -------
  // painted sprite (cosmetic-hands pack) replaces the old procedurally drawn
  // war-standard; dims with the convert zone once the wave's conversion is spent
  const fg = socketPoint('foregroundGate');
  if (IMGS.convert_flag) {
    drawSpriteCB('convert_flag', fg.x, fg.y + 6, 96, canConvertThisWave() ? 1 : 0.6);
  }
  // ------- torch flicker over the baked torches -------
  for (const [tx, ty] of [[157, 448], [283, 444], [453, 459]]) {
    const fl = Math.sin(t * 9 + tx) * 3;
    const fg = ctx.createRadialGradient(tx, ty + fl, 2, tx, ty + fl, 17);
    fg.addColorStop(0, 'rgba(255,230,140,.5)'); fg.addColorStop(0.5, 'rgba(255,150,50,.28)'); fg.addColorStop(1, 'rgba(255,100,20,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(tx, ty + fl, 17, 0, TAU); ctx.fill();
  }
  // ------- ambient damage FX (the stage artwork carries the cracks now) -------
  if (hpF < 0.5) {
    if (Math.random() < 0.06) puff(rand(120, 400), rand(400, 500), 1, '#6a6a72', 30, 8, -60, 1.4);
  }
  if (hpF < 0.25) {
    if (Math.random() < 0.18) puff(rand(100, 400), rand(380, 560), 2, '#3d3d44', 40, 10, -80, 1.6);
    if (Math.random() < 0.08) sparks(rand(120, 400), rand(400, 560), 3, '#ff9d45');
  }
  // shield dome
  if (G.shieldT > 0) drawShieldDome(t);
}

function drawConvertZone() {
  const spent = !canConvertThisWave();
  // (the conversion flag itself is drawn in drawCastle at the gate prop slot,
  // after the castle art, so nothing overlaps it)
  // spent: desaturated grey, no pulse or marching dashes — reads as "off"
  const pulse = spent ? 0.35 : 0.75 + Math.sin(ambientT * 3) * 0.25;
  const g = ctx.createRadialGradient(CONVERT.x, CONVERT.y, 5, CONVERT.x, CONVERT.y, CONVERT.r);
  if (spent) {
    g.addColorStop(0, 'rgba(150,160,175,0.12)');
    g.addColorStop(1, 'rgba(150,160,175,0)');
  } else {
    g.addColorStop(0, `rgba(90,210,255,${0.28 * pulse})`);
    g.addColorStop(1, 'rgba(90,210,255,0)');
  }
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(CONVERT.x, CONVERT.y, CONVERT.r, CONVERT.r * 0.45, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = spent ? 'rgba(160,170,185,.35)' : `rgba(120,220,255,${0.55 * pulse})`;
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 8]); ctx.lineDashOffset = spent ? 0 : -ambientT * 30;
  ctx.beginPath(); ctx.ellipse(CONVERT.x, CONVERT.y, CONVERT.r, CONVERT.r * 0.45, 0, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  // arcane vortex icon in the circle
  if (IMGS.icon_convert) drawSpriteCB('icon_convert', CONVERT.x, CONVERT.y + 2, 34, spent ? 0.22 : 0.5 + 0.25 * pulse);
  ctx.fillStyle = spent ? 'rgba(180,190,205,.55)' : `rgba(170,235,255,${0.8 * pulse})`;
  ctx.font = 'bold 12px Georgia';
  ctx.textAlign = 'center';
  ctx.fillText(spent ? 'USED THIS WAVE' : 'CONVERT', CONVERT.x, CONVERT.y + 20);
}

function drawEnemy(e) {
  const x = e.x, y = e.y, r = e.r;
  const isAir = e.state === 'thrown' || (e.state === 'grab' && e.lifted);
  // throw trail
  if (e.trail.length > 1) {
    ctx.strokeStyle = e.golden ? 'rgba(255,210,74,.5)' : 'rgba(255,255,255,.35)';
    ctx.lineWidth = Math.min(r * 0.6, 22); ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(e.trail[0].x, e.trail[0].y);
    for (const p of e.trail) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  // shadow
  const shAlpha = clamp(1 - (e.gy - y) / 320, 0.15, 0.5);
  ctx.fillStyle = `rgba(30,25,15,${shAlpha})`;
  ctx.beginPath(); ctx.ellipse(x, e.gy + 3, r * 1.05, r * 0.32, 0, 0, TAU); ctx.fill();

  const tf = getEnemyDrawTransform(e);

  /* while held (or still airborne from a throw) humanoids show their scared
     variant and siege carts their neutral grabbed one; walking, attacking,
     landing, and death all revert to the normal sprite */
  const grabbedLook = (e.state === 'grab' || e.state === 'thrown') && e.def.grabSprite && IMGS[e.def.grabSprite];
  const sprId = grabbedLook ? e.def.grabSprite : e.def.sprite;
  const img = IMGS[sprId];
  if (img) {
    /* ---- painted sprite path: bottom-anchored scale, center-pivot rotation ---- */
    const c = SPRITE_DEFS[sprId].crop || [0, 0, img.naturalWidth, img.naturalHeight];
    const dh = e.def.dispH, dw = dh * c[2] / c[3];
    ctx.save();
    if (tf.alpha < 1) ctx.globalAlpha = tf.alpha;
    ctx.translate(x + tf.dx, y + tf.dy);
    ctx.scale(tf.sx, tf.sy);              // feet stay planted during squash/stretch
    ctx.translate(0, -dh / 2);
    ctx.rotate(tf.rot);
    if (e.golden) {
      ctx.fillStyle = 'rgba(255,210,74,.3)';
      ctx.beginPath(); ctx.ellipse(0, 0, dw * 0.62, dh * 0.58, 0, 0, TAU); ctx.fill();
    }
    let tint = '';
    if (e.dmgFlash > 0) tint = 'flash';
    else if (e.golden) tint = 'golden';
    else if (e.def.goldTint) tint = 'goldTint';   // elite guard sheen
    if (tf.glow) {
      /* held by the giant hand. A radial gradient stands in for ctx.shadowBlur:
         canvas shadows force the same offscreen blur pass the tint cache exists
         to avoid, and only one enemy is ever held at a time. */
      const gr = Math.max(dw, dh) * 0.62;
      const halo = ctx.createRadialGradient(0, 0, gr * 0.45, 0, 0, gr);
      halo.addColorStop(0, 'rgba(255,220,120,.5)');
      halo.addColorStop(1, 'rgba(255,220,120,0)');
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(0, 0, gr, 0, TAU); ctx.fill();
    }
    /* a baked variant cannot bleed onto later sprites the way a live ctx.filter
       could (that needed its own save/restore to stop knights showing up
       "stuck" gold on some devices) */
    const tinted = tint ? tintedSprite(sprId, tint) : null;
    if (tinted) ctx.drawImage(tinted, -dw / 2, -dh / 2, dw, dh);
    else ctx.drawImage(img, c[0], c[1], c[2], c[3], -dw / 2, -dh / 2, dw, dh);
    // Elite Guards share the Heavy Knight sprite — give them an unmistakable
    // badge so the gold tint isn't mistaken for a rendering bug
    if (e.def.goldTint && e.hp > 0 && e.state !== 'dying') {
      ctx.fillStyle = 'rgba(255,215,90,.95)';
      ctx.font = 'bold 13px Georgia';
      ctx.textAlign = 'center';
      ctx.fillText('★', 0, -dh / 2 - 6);
    }
    if (e.slowT > 0) {
      ctx.fillStyle = 'rgba(120,200,255,.32)';
      ctx.beginPath(); ctx.ellipse(0, 0, dw * 0.55, dh * 0.55, 0, 0, TAU); ctx.fill();
    }
    if (e.state === 'convert') {
      ctx.strokeStyle = `rgba(120,220,255,${0.5 + Math.sin(ambientT * 10) * 0.3})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(0, 0, dw * 0.6, dh * 0.62, 0, 0, TAU); ctx.stroke();
    }
    if (e.stunT > 0) {
      ctx.fillStyle = '#ffe9b0'; ctx.font = `${Math.round(r * 0.8)}px Georgia`; ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const sa = ambientT * 5 + i * TAU / 3;
        ctx.fillText('✦', Math.cos(sa) * r * 0.9, -dh / 2 - 6 + Math.sin(sa) * 4);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  } else {
  /* ---- vector fallback (used until images finish loading) ---- */
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tf.rot);

  // ---- legs ----
  if (!e.def.cart) {
    const lp = Math.sin(e.walkPhase) * (e.state === 'walk' ? 5 : isAir ? 7 : 2);
    ctx.strokeStyle = '#2e2620'; ctx.lineWidth = Math.max(3, r * 0.3);
    ctx.beginPath();
    ctx.moveTo(-r * 0.35, -r * 0.4); ctx.lineTo(-r * 0.35 - lp * 0.5, 2);
    ctx.moveTo(r * 0.35, -r * 0.4); ctx.lineTo(r * 0.35 + lp * 0.5, 2);
    ctx.stroke();
  }
  // ---- body ----
  const bodyG = ctx.createLinearGradient(0, -r * 2.1, 0, 0);
  const col = e.golden ? '#e8bc3f' : e.def.color;
  bodyG.addColorStop(0, col);
  bodyG.addColorStop(1, shadeColor(col, -35));
  ctx.fillStyle = bodyG;
  ctx.strokeStyle = 'rgba(20,16,12,.75)'; ctx.lineWidth = 2;
  if (e.def.cart) {
    // bomb cart: wagon + barrel
    ctx.fillStyle = '#6b4e32';
    ctx.fillRect(-r * 1.3, -r * 1.1, r * 2.6, r * 0.7);
    ctx.fillStyle = '#3a3a40';
    ctx.beginPath(); ctx.ellipse(0, -r * 1.5, r * 0.95, r * 0.8, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#c9b98f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -r * 2.2); ctx.quadraticCurveTo(r * 0.4, -r * 2.6, r * 0.2, -r * 2.9); ctx.stroke();
    sparkAt(r * 0.2, -r * 2.9);
    ctx.fillStyle = '#4a3826'; ctx.strokeStyle = 'rgba(20,16,12,.75)';
    for (const wx of [-r * 0.8, r * 0.8]) {
      ctx.beginPath(); ctx.arc(wx, -r * 0.2, r * 0.45, 0, TAU); ctx.fill(); ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.ellipse(0, -r * 1.05, r * 0.85, r * 1.05, 0, 0, TAU);
    ctx.fill(); ctx.stroke();
    // belt
    ctx.fillStyle = 'rgba(40,30,20,.6)';
    ctx.fillRect(-r * 0.8, -r * 0.85, r * 1.6, r * 0.25);
    // ---- face ----
    ctx.fillStyle = '#f2d5b0';
    ctx.beginPath(); ctx.arc(-r * 0.25, -r * 1.75, r * 0.42, 0, TAU); ctx.fill();
    ctx.fillStyle = '#241b10';
    ctx.beginPath(); ctx.arc(-r * 0.38, -r * 1.8, 1.8, 0, TAU); ctx.arc(-r * 0.12, -r * 1.8, 1.8, 0, TAU); ctx.fill();
    // ---- helmet ----
    drawHelm(e, r);
    // ---- gear ----
    drawGear(e, r);
  }
  // damage flash
  if (e.dmgFlash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(255,255,255,${e.dmgFlash * 4})`;
    ctx.beginPath(); ctx.ellipse(0, -r, r, r * 1.4, 0, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  // slow tint
  if (e.slowT > 0) {
    ctx.fillStyle = 'rgba(120,200,255,.3)';
    ctx.beginPath(); ctx.ellipse(0, -r, r, r * 1.4, 0, 0, TAU); ctx.fill();
  }
  // stun stars
  if (e.stunT > 0) {
    ctx.fillStyle = '#ffe9b0'; ctx.font = `${Math.round(r * 0.8)}px Georgia`; ctx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const a = ambientT * 5 + i * TAU / 3;
      ctx.fillText('✦', Math.cos(a) * r * 0.9, -r * 2.4 + Math.sin(a) * 4);
    }
  }
  // convert glow
  if (e.state === 'convert') {
    ctx.strokeStyle = `rgba(120,220,255,${0.5 + Math.sin(ambientT * 10) * 0.3})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, -r, r * 1.3, r * 1.7, 0, 0, TAU); ctx.stroke();
  }
  ctx.restore();
  }

  // captain shield aura
  if (e.def.boss === 'captain' && e.shieldStacks > 0) {
    ctx.strokeStyle = `rgba(110,190,255,${0.35 + Math.sin(ambientT * 4) * 0.15})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y - r, 180, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(110,190,255,.06)';
    ctx.beginPath(); ctx.arc(x, y - r, 180, 0, TAU); ctx.fill();
  }
  // health bar (shown when damaged or grabbed) — sits just above the sprite
  const topY = img ? y - e.def.dispH : y - r * 2.6;
  if (e.hp < e.maxhp || e.state === 'grab') {
    const bw = e.def.boss ? 64 : 32;
    const f = clamp(e.hp / e.maxhp, 0, 1);
    ctx.fillStyle = 'rgba(20,16,12,.8)';
    ctx.fillRect(x - bw / 2 - 1, topY - 11, bw + 2, 7);
    ctx.fillStyle = f > 0.5 ? '#7ed957' : f > 0.25 ? '#e8a33d' : '#e85d4a';
    ctx.fillRect(x - bw / 2, topY - 10, bw * f, 5);
    // conversion-ready marker
    if (!e.def.boss && f <= convertThreshold()) {
      ctx.fillStyle = '#7ad9ff'; ctx.font = 'bold 12px Georgia'; ctx.textAlign = 'center';
      ctx.fillText('✨', x + bw / 2 + 9, topY - 4);
    }
  }
  // boss name
  if (e.def.boss) {
    ctx.fillStyle = '#ffe9b0'; ctx.font = 'bold 13px Georgia'; ctx.textAlign = 'center';
    ctx.fillText(e.def.name + (e.shieldStacks > 0 ? ` 🛡×${e.shieldStacks}` : ''), x, topY - 16);
  }
  // golden sparkle
  if (e.golden && Math.random() < 0.15) sparks(x + rand(-r, r), y - rand(0, r * 2), 1, '#ffd24a');
}

function sparkAt(x, y) {
  ctx.fillStyle = `rgba(255,${randi(150, 230)},60,.9)`;
  ctx.beginPath(); ctx.arc(x + rand(-2, 2), y + rand(-2, 2), rand(1.5, 3.5), 0, TAU); ctx.fill();
}

function drawHelm(e, r) {
  const h = e.def.helm;
  ctx.strokeStyle = 'rgba(20,16,12,.75)'; ctx.lineWidth = 2;
  if (h === 'cap') {
    ctx.fillStyle = '#8a6d3b';
    ctx.beginPath(); ctx.arc(-r * 0.2, -r * 2.0, r * 0.42, Math.PI, 0); ctx.fill(); ctx.stroke();
  } else if (h === 'round') {
    ctx.fillStyle = '#b8bfc9';
    ctx.beginPath(); ctx.arc(-r * 0.2, -r * 1.95, r * 0.5, Math.PI * 0.9, Math.PI * 0.1); ctx.fill(); ctx.stroke();
    ctx.fillRect(-r * 0.28, -r * 1.95, r * 0.14, r * 0.45);
  } else if (h === 'horn') {
    ctx.fillStyle = '#9aa2ad';
    ctx.beginPath(); ctx.arc(-r * 0.2, -r * 1.95, r * 0.5, Math.PI, 0); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e8dcc0';
    ctx.beginPath(); ctx.moveTo(-r * 0.65, -r * 2.0); ctx.quadraticCurveTo(-r * 1.05, -r * 2.3, -r * 0.85, -r * 2.6); ctx.lineTo(-r * 0.55, -r * 2.2); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(r * 0.25, -r * 2.0); ctx.quadraticCurveTo(r * 0.65, -r * 2.3, r * 0.45, -r * 2.6); ctx.lineTo(r * 0.15, -r * 2.2); ctx.closePath(); ctx.fill();
  } else if (h === 'great') {
    ctx.fillStyle = '#aab4c4';
    ctx.fillRect(-r * 0.62, -r * 2.4, r * 0.85, r * 0.85);
    ctx.strokeRect(-r * 0.62, -r * 2.4, r * 0.85, r * 0.85);
    ctx.fillStyle = '#1c1c24';
    ctx.fillRect(-r * 0.52, -r * 2.12, r * 0.62, r * 0.16);
    ctx.fillStyle = '#c04848';
    ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 2.4); ctx.quadraticCurveTo(0, -r * 3.0, r * 0.3, -r * 2.5); ctx.lineTo(-r * 0.05, -r * 2.4); ctx.closePath(); ctx.fill();
  } else if (h === 'hood') {
    ctx.fillStyle = shadeColor(e.def.color, -25);
    ctx.beginPath(); ctx.moveTo(-r * 0.7, -r * 1.6); ctx.quadraticCurveTo(-r * 0.2, -r * 2.7, r * 0.35, -r * 1.65); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (h === 'crown') {
    ctx.fillStyle = '#ffd24a';
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, -r * 2.0);
    for (let i = 0; i < 4; i++) { ctx.lineTo(-r * 0.6 + i * r * 0.27 + r * 0.13, -r * 2.45); ctx.lineTo(-r * 0.6 + (i + 1) * r * 0.27, -r * 2.0); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}

function drawGear(e, r) {
  ctx.strokeStyle = 'rgba(20,16,12,.75)'; ctx.lineWidth = 2;
  if (e.def.shielded) {
    ctx.fillStyle = '#5a7cb8';
    ctx.beginPath(); ctx.ellipse(-r * 0.95, -r * 1.05, r * 0.42, r * 0.75, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d9c9a0';
    ctx.beginPath(); ctx.arc(-r * 0.95, -r * 1.05, r * 0.16, 0, TAU); ctx.fill();
  }
  if (e.def.hammer) {
    const swing = e.state === 'attack' ? Math.sin(ambientT * 8) * 0.5 : 0.2;
    ctx.save(); ctx.translate(r * 0.7, -r * 1.2); ctx.rotate(swing - 0.6);
    ctx.fillStyle = '#6b4e32'; ctx.fillRect(-2, -r * 1.4, 4, r * 1.4);
    ctx.fillStyle = '#8f97a3'; ctx.fillRect(-r * 0.42, -r * 1.85, r * 0.84, r * 0.5);
    ctx.strokeRect(-r * 0.42, -r * 1.85, r * 0.84, r * 0.5);
    ctx.restore();
  }
  if (e.def.bomb && !e.def.cart) {
    ctx.fillStyle = '#26262e';
    ctx.beginPath(); ctx.arc(r * 0.15, -r * 2.75, r * 0.55, 0, TAU); ctx.fill(); ctx.stroke();
    sparkAt(r * 0.35, -r * 3.35);
  }
  if (e.def.healer) {
    ctx.fillStyle = '#8a6d3b'; ctx.fillRect(r * 0.75, -r * 2.5, 3, r * 2.2);
    const glow = ctx.createRadialGradient(r * 0.78, -r * 2.6, 1, r * 0.78, -r * 2.6, r * 0.5);
    glow.addColorStop(0, 'rgba(160,255,160,.95)'); glow.addColorStop(1, 'rgba(160,255,160,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(r * 0.78, -r * 2.6, r * 0.5, 0, TAU); ctx.fill();
  }
  if (e.def.bannerman) {
    const broken = e.def.boss === 'bannerlord' && e.bannerHp <= 0;
    ctx.fillStyle = '#6b4e32'; ctx.fillRect(r * 0.7, -r * 3.1, 3, r * 2.8);
    if (!broken) {
      ctx.fillStyle = e.def.boss ? '#ff4a4a' : '#d46a6a';
      ctx.beginPath();
      ctx.moveTo(r * 0.7 + 3, -r * 3.1);
      ctx.lineTo(r * 0.7 + 3 + r * 1.1 + Math.sin(ambientT * 6) * 3, -r * 2.8);
      ctx.lineTo(r * 0.7 + 3, -r * 2.4);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      ctx.strokeStyle = '#4a3826'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(r * 0.7, -r * 3.1); ctx.lineTo(r * 1.3, -r * 2.6); ctx.stroke();
    }
  }
}

function shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
  return `rgb(${clamp(r, 0, 255)},${clamp(g, 0, 255)},${clamp(b, 0, 255)})`;
}

function drawDefender(d) {
  ctx.fillStyle = 'rgba(30,25,15,.4)';
  ctx.beginPath(); ctx.ellipse(d.x, d.gy + 2, 12, 4, 0, 0, TAU); ctx.fill();
  if (IMGS.defender_mason) {
    /* recruit militia use the mason art (faces right, toward the foe) */
    const dh = 68;
    ctx.save();
    ctx.translate(d.x, d.y - dh / 2);
    ctx.rotate(Math.sin(d.walkPhase) * 0.05);
    const c = SPRITE_DEFS.defender_mason.crop;
    const dw = dh * c[2] / c[3];
    ctx.drawImage(IMGS.defender_mason, c[0], c[1], c[2], c[3], -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    if (d.hp < d.maxhp) {
      const f = d.hp / d.maxhp;
      ctx.fillStyle = 'rgba(20,16,12,.8)'; ctx.fillRect(d.x - 12, d.y - dh - 8, 24, 4);
      ctx.fillStyle = '#7ad9a0'; ctx.fillRect(d.x - 12, d.y - dh - 8, 24 * f, 4);
    }
    return;
  }
  ctx.save(); ctx.translate(d.x, d.y);
  const lp = Math.sin(d.walkPhase) * 4;
  ctx.strokeStyle = '#2e2620'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(-4 - lp * 0.4, 1); ctx.moveTo(4, -5); ctx.lineTo(4 + lp * 0.4, 1); ctx.stroke();
  const bodyG = ctx.createLinearGradient(0, -26, 0, 0);
  bodyG.addColorStop(0, '#5ec49a'); bodyG.addColorStop(1, '#357a5c');
  ctx.fillStyle = bodyG; ctx.strokeStyle = 'rgba(20,16,12,.75)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, -13, 10, 13, 0, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f2d5b0';
  ctx.beginPath(); ctx.arc(-3, -21, 5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#4ac0e0';
  ctx.beginPath(); ctx.arc(-3, -24, 6, Math.PI, 0); ctx.fill(); ctx.stroke();
  // spear
  ctx.strokeStyle = '#8a6d3b'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(9, -2); ctx.lineTo(16, -30); ctx.stroke();
  ctx.fillStyle = '#cfd8e6';
  ctx.beginPath(); ctx.moveTo(16, -30); ctx.lineTo(13, -36); ctx.lineTo(19, -34); ctx.closePath(); ctx.fill();
  ctx.restore();
  if (d.hp < d.maxhp) {
    const f = d.hp / d.maxhp;
    ctx.fillStyle = 'rgba(20,16,12,.8)'; ctx.fillRect(d.x - 12, d.y - 38, 24, 4);
    ctx.fillStyle = '#7ad9a0'; ctx.fillRect(d.x - 12, d.y - 38, 24 * f, 4);
  }
}

function render() {
  ctx.save();
  // screen shake
  if (G && G.shake > 0.3) ctx.translate(rand(-G.shake, G.shake), rand(-G.shake, G.shake));
  // scenic battlefield fills the whole view (1672x941 is effectively 16:9);
  // the flat gradient beneath only shows for the first frames while it loads
  const bg = IMGS.bg_scenic;
  if (bg) drawImageCover(bg, 0, 0, W, H);
  else ctx.drawImage(bgCanvas, 0, 0);
  if (!G) { ctx.restore(); return; }
  drawConvertZone();
  // slow fields
  for (const f of G.slowFields) {
    ctx.fillStyle = `rgba(120,200,255,${0.13 + Math.sin(ambientT * 5) * 0.04})`;
    ctx.strokeStyle = 'rgba(150,220,255,.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(f.x, clamp(f.y, GROUND_TOP, GROUND_BOT), f.r, f.r * 0.4, 0, 0, TAU); ctx.fill(); ctx.stroke();
    if (Math.random() < 0.2) puff(f.x + rand(-f.r, f.r) * 0.8, clamp(f.y, GROUND_TOP, GROUND_BOT) - rand(0, 20), 1, '#aee2ff', 20, 3, -50, 0.8);
  }
  drawCastle();
  // ground decals: painted death marks, bottom-anchored to the ground plane,
  // fading out over their lifetime (replaces the old tinted-ellipse "circles");
  // drawn after the castle so wall-adjacent marks aren't covered, and before
  // units so nothing gameplay-relevant is ever occluded
  for (const c of G.corpses) {
    const life = c.life || 3.5;
    const fade = clamp(1 - c.t / life, 0, 1);
    const img = IMGS[c.mark];
    if (img) {
      const cr = SPRITE_DEFS[c.mark].crop;
      const dw = c.w, dh = dw * cr[3] / cr[2];
      ctx.globalAlpha = Math.min(0.9, fade * 1.4);
      ctx.drawImage(img, cr[0], cr[1], cr[2], cr[3], c.x - dw / 2, c.gy + 8 - dh, dw, dh);
      ctx.globalAlpha = 1;
    }
  }
  // depth sort: things lower on screen draw last
  const drawables = [];
  for (const d of G.defenders) drawables.push({ y: d.gy, fn: () => drawDefender(d) });
  for (const e of G.enemies) drawables.push({ y: e.gy, fn: () => drawEnemy(e) });
  drawables.sort((a, b) => a.y - b.y);
  for (const d of drawables) d.fn();
  // bombs (painted projectile from the ability-sprites pack; spins as it rolls)
  for (const b of G.bombs) {
    ctx.fillStyle = 'rgba(30,25,15,.4)';
    ctx.beginPath(); ctx.ellipse(b.x, b.gy + 4, 17, 5, 0, 0, TAU); ctx.fill();
    ctx.save(); ctx.translate(b.x, b.y - 10); ctx.rotate(ambientT * 9);
    const bImg = IMGS.bomb_proj;
    if (bImg) {
      const c = SPRITE_DEFS.bomb_proj.crop;
      const h = 46, w = h * c[2] / c[3];   // ball ≈ 32px wide — reads against enemies without dwarfing them
      ctx.drawImage(bImg, c[0], c[1], c[2], c[3], -w / 2, -h * 0.62, w, h);
    } else {
      ctx.fillStyle = '#26262e'; ctx.strokeStyle = 'rgba(20,16,12,.8)'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, 16, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8f97a3'; ctx.fillRect(-4, -19, 8, 6);
    }
    ctx.restore();
  }
  // arrows
  for (const a of G.arrows) {
    const ang = Math.atan2(a.vy, a.vx);
    ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(ang);
    ctx.strokeStyle = a.ballista ? '#8a5a2c' : '#d9c9a0'; ctx.lineWidth = a.ballista ? 4 : 2;
    ctx.beginPath(); ctx.moveTo(-(a.ballista ? 18 : 10), 0); ctx.lineTo(4, 0); ctx.stroke();
    ctx.fillStyle = '#e8e8f0';
    ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(1, -3); ctx.lineTo(1, 3); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // particles
  for (const p of G.particles) {
    if (p.ringP) {
      // expanding aura ring (flattened to match the ground plane)
      const q = 1 - p.life / p.maxLife;
      const rr = lerp(p.ringP.r0, p.ringP.r1, q);
      ctx.strokeStyle = p.ringP.c + (0.7 * (1 - q)).toFixed(3) + ')';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rr, rr * 0.5, 0, 0, TAU); ctx.stroke();
      continue;
    }
    if (p.slashP) {
      // weapon arc: bright crescent sweeping as it fades
      const q = 1 - p.life / p.maxLife;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.slashP.ang + q * 1.5);
      ctx.strokeStyle = p.slashP.c + (0.9 * (1 - q)).toFixed(3) + ')';
      ctx.lineWidth = 5 * (1 - q * 0.5);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 0, p.slashP.size, -1.9, -0.2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * (1 - q)).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, p.slashP.size * 0.82, -1.8, -0.3); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.restore();
      continue;
    }
    if (p.bolt) {
      // lightning bolt zigzag
      ctx.strokeStyle = `rgba(190,230,255,${p.life / p.maxLife})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      let bx = p.bolt.x, by = 0;
      ctx.moveTo(bx, by);
      while (by < p.bolt.y) { by += rand(24, 50); bx += rand(-22, 22); ctx.lineTo(by >= p.bolt.y ? p.bolt.x : bx, Math.min(by, p.bolt.y)); }
      ctx.stroke();
      ctx.fillStyle = `rgba(190,230,255,${p.life / p.maxLife * 0.5})`;
      ctx.beginPath(); ctx.arc(p.bolt.x, p.bolt.y, p.size * (1 - p.life / p.maxLife + 0.3), 0, TAU); ctx.fill();
      continue;
    }
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * p.life / p.maxLife), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // floaters
  for (const f of G.floaters) {
    ctx.globalAlpha = clamp(f.life / f.maxLife * 1.5, 0, 1);
    ctx.font = `bold ${f.size}px Georgia`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(20,16,12,.85)'; ctx.lineWidth = 3;
    // currency amounts render the unified sprites in place of the 🪙 / 👑
    // glyphs — the icon is spliced exactly where the emoji sat in the text
    const emoji = f.text.indexOf('🪙') >= 0 ? '🪙' : f.text.indexOf('👑') >= 0 ? '👑' : null;
    const curImg = emoji === '🪙' ? COIN_IMG : emoji === '👑' ? CROWN_IMG : null;
    if (emoji && curImg && curImg.complete && curImg.naturalWidth > 0) {
      const at = f.text.indexOf(emoji);
      const pre = f.text.slice(0, at).trimEnd(), suf = f.text.slice(at + emoji.length).trimStart();
      const s = f.size, gap = 3;
      ctx.textAlign = 'left';
      const wPre = pre ? ctx.measureText(pre).width : 0;
      const wSuf = suf ? ctx.measureText(suf).width : 0;
      let x = f.x - (wPre + (pre ? gap : 0) + s + (suf ? gap : 0) + wSuf) / 2;
      if (pre) {
        ctx.strokeText(pre, x, f.y);
        ctx.fillStyle = f.color; ctx.fillText(pre, x, f.y);
        x += wPre + gap;
      }
      ctx.drawImage(curImg, x, f.y - s * 0.82, s, s);
      x += s + gap;
      if (suf) {
        ctx.strokeText(suf, x, f.y);
        ctx.fillStyle = f.color; ctx.fillText(suf, x, f.y);
      }
      ctx.textAlign = 'center';
    } else {
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
  }
  ctx.globalAlpha = 1;
  // wave banner
  if (G.bannerT > 0 && G.banner) {
    const a = clamp(G.bannerT, 0, 1);
    const topL = Layout.cropTopL || 0;               // stay below the cropped sky
    ctx.globalAlpha = a;
    ctx.font = 'bold 52px Georgia'; ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(20,16,12,.9)'; ctx.lineWidth = 6;
    ctx.strokeText(G.banner, W / 2, topL + 200);
    ctx.fillStyle = '#ffe9b0';
    ctx.fillText(G.banner, W / 2, topL + 200);
    if (G.bannerSub) {
      ctx.font = 'bold 20px Georgia';
      ctx.strokeText(G.bannerSub, W / 2, topL + 238);
      ctx.fillStyle = '#ffb27a';
      ctx.fillText(G.bannerSub, W / 2, topL + 238);
    }
    ctx.globalAlpha = 1;
  }
  // targeting crosshair
  if (P.targeting && state === 'playing') {
    ctx.strokeStyle = 'rgba(120,215,255,.9)'; ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.arc(P.x, P.y, P.targeting.id === 'frost' ? 120 * spellPower() : 85, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(P.x - 14, P.y); ctx.lineTo(P.x + 14, P.y); ctx.moveTo(P.x, P.y - 14); ctx.lineTo(P.x, P.y + 14); ctx.stroke();
  }
  // damage vignette flash
  if (G.flash > 0) {
    ctx.fillStyle = `rgba(200,30,10,${G.flash})`;
    ctx.fillRect(0, 0, W, H);
  }
  // hand cursor
  drawHand();
  ctx.restore();
}

function drawHand() {
  if (!P.insideCanvas && !P.down) return;
  const closed = P.down || P.grabbed.length > 0;
  const skin = META.handSkin;
  /* ---- cursor sprites (open hover / closed grab) ----
     Each treasury skin has dedicated open/closed art; the default hand keeps
     the original gauntlet sprites. All states share one hotspot — the
     palm/fist center sits exactly at (P.x, P.y), the same point grabs test
     against — so equip swaps and open/closed swaps never jump. */
  const SKIN_CURSORS = {
    spectral: ['cursor_spectral_open', 'cursor_spectral_closed'],
    royal:    ['cursor_royal_open',    'cursor_royal_closed'],
  };
  const [openId, closedId] = SKIN_CURSORS[skin] || ['cursor_open', 'cursor_closed'];
  const curId = closed ? closedId : openId;
  const cImg = IMGS[curId];
  if (cImg) {
    const c = SPRITE_DEFS[curId].crop;
    const h = 92, w = h * c[2] / c[3];
    ctx.drawImage(cImg, c[0], c[1], c[2], c[3], P.x - w / 2, P.y - h * 0.42, w, h);
    return;
  }
  /* ---- vector fallback (first frames before the sprites load) ---- */
  const palette = skin === 'spectral'
    ? { main: 'rgba(140,200,255,.75)', dark: 'rgba(60,120,200,.8)', trim: 'rgba(200,240,255,.9)' }
    : skin === 'royal'
      ? { main: '#e0b64a', dark: '#8f6a1a', trim: '#f5e6c0' }
      : { main: '#b8bfc9', dark: '#5e6674', trim: '#8a6d3b' };
  ctx.save();
  ctx.translate(P.x, P.y);
  ctx.rotate(closed ? -0.2 : 0);
  ctx.fillStyle = palette.main;
  ctx.strokeStyle = palette.dark; ctx.lineWidth = 2.5;
  // palm
  ctx.beginPath();
  ctx.ellipse(0, closed ? 6 : 10, 14, closed ? 12 : 15, 0, 0, TAU);
  ctx.fill(); ctx.stroke();
  // fingers
  const n = 4;
  for (let i = 0; i < n; i++) {
    const fx = -10 + i * 7;
    const len = closed ? 8 : 16 - Math.abs(i - 1.5) * 2;
    ctx.beginPath();
    if (closed) ctx.ellipse(fx, -2, 3.6, 6, 0.1, 0, TAU);
    else ctx.ellipse(fx, -len * 0.55, 3.6, len * 0.55 + 4, (i - 1.5) * 0.08, 0, TAU);
    ctx.fill(); ctx.stroke();
  }
  // thumb
  ctx.beginPath();
  ctx.ellipse(closed ? 13 : 16, 8, 4, 8, closed ? 0.9 : 0.6, 0, TAU);
  ctx.fill(); ctx.stroke();
  // wrist trim
  ctx.fillStyle = palette.trim;
  ctx.fillRect(-13, closed ? 15 : 22, 26, 7);
  ctx.strokeRect(-13, closed ? 15 : 22, 26, 7);
  if (skin === 'spectral') {
    ctx.fillStyle = 'rgba(140,200,255,.25)';
    ctx.beginPath(); ctx.arc(0, 6, 26, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

/* ============================================================
   HUD SYNC
   ============================================================ */
let uiDirty = true;
const hudCache = {};
function setText(id, val) { if (hudCache[id] !== val) { hudCache[id] = val; $(id).textContent = val; } }
function setHtml(id, val) { if (hudCache[id] !== val) { hudCache[id] = val; $(id).innerHTML = val; } }

function updateHUD() {
  const f = clamp(G.castleHp / G.castleMax, 0, 1);
  const fill = $('castleBarFill');
  const wPct = Math.round(f * 1000) / 10;
  if (hudCache.hpw !== wPct) { hudCache.hpw = wPct; fill.style.width = wPct + '%'; }
  const cls = f > 0.5 ? '' : f > 0.25 ? 'hurt' : 'critical';
  if (hudCache.hpc !== cls) { hudCache.hpc = cls; fill.className = cls; }
  setText('castleBarText', `${Math.ceil(G.castleHp)} / ${G.castleMax}`);
  const arm = armorTotal();
  const ab = $('armorBadge');
  if (arm > 0) { ab.classList.remove('hidden'); setText('armorText', arm); } else ab.classList.add('hidden');
  setHtml('waveLabel', G.siege ? 'Daily Siege' : `Wave ${G.wave}${isBossWave(G.wave) ? ' ' + crownIco() : ''}`);
  const foes = G.spawnQueue.length + G.enemies.length;
  setText('enemiesLeft', G.waveActive ? `${foes} foe${foes === 1 ? '' : 's'} remain` : '');
  setText('goldText', Math.floor(G.gold));
  setText('crownText', ownedCrownsLive().toLocaleString());
  setText('scoreText', G.score.toLocaleString());
  // player level bar (sits under castle health; tap opens Level Rewards)
  updateLevelWidget('hudLevelNum', 'hudLevelFill', 'hudLevelText');
  // passive upgrades intentionally have no HUD badges (reviewable on pause)
  uiDirty = false;
  syncAbilityBar();
}

/* (passive upgrade HUD chips removed — selected passives are listed on the
   pause screen instead, keeping the mobile HUD clear) */

function renderAbilityBar() {
  const bar = $('abilityBar');
  bar.innerHTML = '';
  for (const a of G.abilities) {
    const btn = document.createElement('button');
    btn.className = 'abilityBtn';
    btn.id = 'ab_' + a.id;
    btn.innerHTML = `<span class="keyHint">${a.key}</span>` +
      (a.iconSrc ? `<img class="abIco" src="${a.iconSrc}" alt="" draggable="false">`
        : a.iconImg ? artHtml(a.iconImg, 'abIco') : a.icon) +
      `<div class="cdOverlay"></div>`;
    btn.title = a.name;
    btn.addEventListener('pointerdown', ev => { ev.stopPropagation(); ev.preventDefault(); Sfx.unlock(); if (state === 'playing') abilityPressed(a, false); });
    bar.appendChild(btn);
  }
  syncAbilityBar();
}
function syncAbilityBar() {
  for (const a of G.abilities) {
    const btn = $('ab_' + a.id);
    if (!btn) continue;
    const ov = btn.querySelector('.cdOverlay');
    if (a.perWave) {
      btn.classList.toggle('spent', G.bellUsed);
      btn.classList.toggle('ready', !G.bellUsed);
      setCdHeight(ov, 0);
    } else {
      const f = a.cdMax ? clamp(a.cd / (a.cdMax * cdMult()), 0, 1) : 0;
      setCdHeight(ov, f * 100);
      btn.classList.toggle('ready', a.cd <= 0);
    }
    btn.classList.toggle('targeting', P.targeting === a);
  }
}
/* Cooldown wipes are the only HUD element that genuinely changes on most
   frames of a run, so they are quantized to whole percent and written only on
   change: a full-precision value repainted every frame turned a ticking
   cooldown into ~60 repaints/second per ability button, and the button subtree
   is composited GPU-side. Whole percent is finer than one screen pixel on a
   62px button, so nothing is visibly lost. */
function setCdHeight(ov, pct) {
  const q = Math.round(clamp(pct, 0, 100));
  if (ov.__cdPct === q) return;
  ov.__cdPct = q;
  ov.style.height = q + '%';
}

/* ============================================================
   SCREENS & MENUS
   ============================================================ */
/* html for a trimmed asset image (DOM side) */
const artHtml = (file, cls) => `<img class="${cls}" src="${TRIM}${file}" alt="" draggable="false">`;

const SCREENS = ['menuScreen', 'castleScreen', 'metaScreen', 'howtoScreen', 'settingsScreen', 'cardScreen', 'buildScreen', 'modScreen', 'pauseScreen', 'gameoverScreen', 'shopScreen', 'legalScreen', 'milestoneScreen', 'levelRewardsScreen', 'ricochetPauseScreen', 'ricochetResultScreen'];
/* Castle Ricochet is loaded after this file: every touchpoint guards on the
   binding existing so game.js stays self-sufficient during boot */
const RICO = () => (typeof CastleRicochet !== 'undefined' ? CastleRicochet : null);
/* Castle Fling tutorial (tutorial.js, loaded after this file) — same guard
   pattern. While it is open it plays inside its own practice run (see the
   tutSandbox gate near the top of this file), so every touchpoint below is a
   read, a frozen frame, or a cleanup of state the tutorial itself created. */
const TUT = () => (typeof CastleFlingTutorial !== 'undefined' ? CastleFlingTutorial : null);
/* Adventurers' Board tutorial (tutorial.js, second module) — same guard
   pattern. It runs entirely over the DOM Board screens inside its own
   daily/kingdom sandbox, so its touchpoints below are screen-change
   notifications, key routing and per-frame panel painting only. */
const BTUT = () => (typeof CastleBoardTutorial !== 'undefined' ? CastleBoardTutorial : null);
/* Daily systems (Royal Decrees / Daily Siege / Kingdom Restoration) load in
   daily.js after this file — same guard pattern. Gameplay emits events through
   dailyEvent(); a daily-side error must never break combat. */
const DAILY = () => (typeof CastleDaily !== 'undefined' ? CastleDaily : null);
function dailyEvent(name, data) {
  /* the tutorial sandbox is not a real run: no Decree progress, no Daily
     Siege scoring, no Kingdom Restoration advancement from practice */
  if (inTut()) return;
  const d = DAILY();
  if (!d) return;
  try { d.event(name, data); }
  catch (e) { CrashDiagnostics.record('daily-event-error', { name, message: String(e && e.message) }); }
}
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
  const rico = RICO();
  const inRico = rico && rico.isActive();
  $('hud').classList.toggle('hidden', !((id === null && !inRico) || id === 'pauseScreen'));
  if (rico) rico.onScreenChange(id);
  const tut = TUT();
  if (tut) tut.onScreenChange(id);
  const btut = BTUT();
  if (btut) btut.onScreenChange(id);
  requestAnimationFrame(() => updateScrollHint(id));
  /* every screen transition funnels through here (state is set by the caller
     first), making this the one reliable hook for the diagnostic trail and
     for keeping the right music theme playing — menu theme across the menu
     and its sub screens, gameplay theme across a run and its overlays */
  CrashDiagnostics.record('screen', { id: id || 'game', state });
  syncMusic();
}

/* ---- "Scroll for more" pill ----
   A LIVE indicator, not a one-shot hint. It is bound to the scroller it
   describes and repainted on every scroll and on every resize, so it is
   visible exactly while content remains below the fold and gone the moment
   the player reaches the bottom.

   .howtoBody, #milestoneList and #levelRewardsList are their own scrollers
   inside an overflow:hidden panel — the panel itself never overflows, which
   is why Milestones and Level Rewards could never raise the pill until these
   two ids were scanned directly.

   While the pill is MOUNTED its scroller carries .scrollHintPad, reserving
   the pill's lane at the end of the content so it can never sit on top of a
   reward row. The padding is tied to the pill being mounted (the scroller
   overflows) and NOT to it being visible (not at the bottom), so showing and
   hiding it can never change the scroller's geometry and oscillate. */
const SCROLL_HINT_SEL = '.panel, .menuPanel, .panelBody, .cardRow, .howtoBody, #milestoneList, #levelRewardsList';
const SCROLL_HINT_SLACK = 8;
let scrollHint = null;          // { el, scroller, host, onScroll }
let scrollHintScreen = null;    // the screen the pill was measured against

function detachScrollHint() {
  if (scrollHint) {
    scrollHint.scroller.removeEventListener('scroll', scrollHint.onScroll);
    scrollHint.scroller.classList.remove('scrollHintPad');
    scrollHint = null;
  }
  document.querySelectorAll('.scrollHint').forEach(el => el.remove());
}

/* visible only while there is more to reach; position is re-measured here so
   it stays correct at every breakpoint and after any inset change */
function paintScrollHint() {
  if (!scrollHint) return;
  const s = scrollHint.scroller;
  const more = s.scrollTop + s.clientHeight < s.scrollHeight - SCROLL_HINT_SLACK;
  scrollHint.el.classList.toggle('hidden', !more);
  /* Lift the pill to just above the SCROLLER's bottom edge. The mount is never
     the scroller itself (see updateScrollHint), so this gap is constant while
     scrolling — the pill holds still instead of being re-placed per event, and
     it can never cover controls pinned below the scroller (the Back button on
     Milestones, Level Rewards and How to Play). */
  const gap = Math.round(scrollHint.mount.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom);
  scrollHint.el.style.bottom = Math.max(4, gap + 6) + 'px';
}

function updateScrollHint(screenId) {
  detachScrollHint();
  scrollHintScreen = screenId || null;
  if (!screenId) return;
  const scr = $(screenId);
  if (!scr || scr.classList.contains('hidden')) return;
  for (const el of scr.querySelectorAll(SCROLL_HINT_SEL)) {
    if (el.scrollHeight <= el.clientHeight + SCROLL_HINT_SLACK) continue;
    const host = el.closest('.panel, .menuPanel') || el;
    /* The pill must never be mounted INSIDE the element that scrolls. An
       absolutely positioned child is offset from its container's padding box
       and then rides the content, so on a screen where the panel is its own
       scroller (Royal Treasury at any phone size; Settings, Crown Shop, Game
       Over and the rest once the viewport is short) the pill scrolled straight
       up off the top instead of holding at the bottom edge. When the panel
       scrolls itself, mount on the .screen behind it — it is position:absolute
       and inset:0, so the pill still measures against a fixed box. */
    const mount = host === el ? (el.parentElement || el) : host;
    const hint = document.createElement('div');
    hint.className = 'scrollHint';
    hint.textContent = 'Scroll for more ↓';
    mount.appendChild(hint);
    el.classList.add('scrollHintPad');
    const onScroll = () => paintScrollHint();
    el.addEventListener('scroll', onScroll, { passive: true });
    scrollHint = { el: hint, scroller: el, host, mount, onScroll };
    paintScrollHint();
    return;
  }
}
/* A rotation, a window resize or a keyboard/system-bar inset change can turn
   a fitting list into a scrolling one (and back), so the pill is re-measured
   from scratch against whichever screen is open. Cheap and idempotent. */
function remeasureScrollHint() {
  if (scrollHintScreen) updateScrollHint(scrollHintScreen);
}
window.addEventListener('resize', remeasureScrollHint);
window.addEventListener('orientationchange', remeasureScrollHint);
if (window.visualViewport) window.visualViewport.addEventListener('resize', remeasureScrollHint);

/* ------- main menu ------- */
function openMenu() {
  state = 'menu';
  /* memory hygiene: a finished/abandoned run must not pin its entity and
     effect arrays behind the menu. The menu backdrop keeps rendering G's
     castle scene, but enemies, particles, projectiles and decals from the
     previous run are dead weight — release them (and any held grab refs). */
  if (G) {
    G.waveActive = false;
    P.grabbed.length = 0;
    G.enemies.length = 0; G.defenders.length = 0;
    G.arrows.length = 0; G.bombs.length = 0;
    G.particles.length = 0; G.floaters.length = 0;
    G.corpses.length = 0; G.slowFields.length = 0;
  }
  showScreen('menuScreen');
  $('menuCrowns').innerHTML = `(${META.crowns}${artHtml('icon_crown_gold.png', 'ico')})`;
  /* real stats only — before the first run this line stays empty (and CSS
     collapses it) rather than printing flavour text under the level bar */
  $('menuBest').innerHTML = META.bestWave > 0 ? `Best: wave ${META.bestWave} · ${META.bestScore.toLocaleString()} pts · ${META.coins.toLocaleString()} ${coinIco()}` : '';
  // saved-run checkpoint
  const sr = META.savedRun;
  $('btnContinueRun').classList.toggle('hidden', !sr);
  /* with Continue hidden, Play spans the primary grid so it stays balanced */
  $('menuPrimary').classList.toggle('noContinue', !sr);
  if (sr) $('continueWave').textContent = `(wave ${sr.wave + 1})`;
  // player level widget from banked stars
  updateLevelWidget('menuLevelNum', 'menuLevelFill', 'menuLevelText');
  // claimable milestone badge — count pip on the Milestones icon (empty = hidden)
  const claimable = MILESTONE_CATS.filter(milestoneClaimable).length;
  $('menuMilestoneBadge').textContent = claimable > 0 ? String(claimable) : '';
  // Adventurers' Board summary badge (decrees done / siege tier / claimables)
  if (DAILY()) DAILY().refreshMenuBadge();
}
/* Both Play doorways settle any outstanding interstitial FIRST, at the menu —
   a safe break, and the point a requirement carried over from a previous
   session (or a previous app launch) is paid. */
$('btnPlay').addEventListener('click', () => {
  Sfx.unlock(); Sfx.ui();
  if (META.savedRun) {
    gameConfirm(`Your saved run at wave ${META.savedRun.wave + 1} will be replaced.`,
      { title: 'Start a new run?', okText: '▶ Start New Run', cancelText: 'Cancel', danger: true })
      .then(ok => { if (ok) gateEnterGameplay(openCastleSelect); });
    return;
  }
  gateEnterGameplay(openCastleSelect);
});
$('btnContinueRun').addEventListener('click', () => {
  Sfx.unlock(); Sfx.ui();
  gateEnterGameplay(continueSavedRun);
});
$('btnMilestones').addEventListener('click', () => { Sfx.ui(); openMilestones(); });
$('btnMilestonesBack').addEventListener('click', () => { Sfx.ui(); openMenu(); });
$('btnMeta').addEventListener('click', () => { Sfx.ui(); openMeta(); });
$('btnHowTo').addEventListener('click', () => { Sfx.ui(); openHowTo(); });
$('btnSettings').addEventListener('click', () => { Sfx.ui(); openSettings(); });

/* ------- themed confirm dialog (replaces OS confirm()) ------- */
function gameConfirm(msg, opts = {}) {
  return new Promise(resolve => {
    $('confirmTitle').textContent = opts.title || 'Are you sure?';
    $('confirmMsg').textContent = msg;
    const ok = $('confirmOk'), cancel = $('confirmCancel');
    ok.textContent = opts.okText || 'Confirm';
    cancel.textContent = opts.cancelText || 'Cancel';
    ok.classList.toggle('danger', !!opts.danger);
    ok.classList.toggle('gold', !opts.danger);
    $('confirmModal').classList.remove('hidden');
    const done = val => {
      $('confirmModal').classList.add('hidden');
      ok.onclick = cancel.onclick = null;
      Sfx.ui();
      resolve(val);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
  });
}

/* ------- combo indicator: lives in the HTML HUD stack, under the wave info,
   so it can never overlap the wave label like the old canvas text did ------- */
let lastComboTxt = '';
function updateComboLabel() {
  const show = state === 'playing' && G.combo.n >= 2 && G.combo.t > 0;
  const txt = show ? `🔥 Combo ×${G.combo.n}` : '';
  if (txt === lastComboTxt) return;
  lastComboTxt = txt;
  const el = $('comboLabel');
  el.textContent = txt;
  el.classList.toggle('hidden', !txt);
}

/* ------- level rewards screen ------- */
let levelRewardsReturnTo = 'menu';
function openLevelRewards(from) {
  levelRewardsReturnTo = from || 'menu';
  state = 'levelRewards';
  showScreen('levelRewardsScreen');
  const pl = playerLevelInfo(liveStarXp());   // match the live bar mid-run
  const list = $('levelRewardsList');
  list.innerHTML = '';
  // one row per bonus level (every 5 up to 99); the next unearned one is highlighted
  const rewardLevels = Object.keys(LEVEL_COIN_REWARDS).map(Number).sort((a, b) => a - b);
  const nextUp = rewardLevels.find(l => !(META.claimedLevelRewards && META.claimedLevelRewards[l]));
  for (const l of rewardLevels) {
    const coins = LEVEL_COIN_REWARDS[l];
    const done = !!(META.claimedLevelRewards && META.claimedLevelRewards[l]);
    const current = l === nextUp;
    const div = document.createElement('div');
    div.className = 'lvlRewardItem' + (done ? ' done' : current ? ' current' : '');
    div.innerHTML =
      `<img class="lvlRewardStar" src="${done ? 'assets/ui/rewards/reward_star_gold_128.png' : 'assets/ui/player_level/player_level_star_silver.png'}" alt="">` +
      `<div class="lvlRewardBody"><div class="lvlRewardLvl">Level ${l}</div>` +
      `<div class="lvlRewardCoins">+${coins.toLocaleString()} ${coinIco()}${current ? ` — reach Level ${l} (you are Level ${pl.level})` : ''}</div></div>` +
      `<div class="lvlRewardState">${done ? '✔ Earned' : ''}</div>`;
    list.appendChild(div);
  }
}
$('btnLevelRewardsBack').addEventListener('click', () => {
  Sfx.ui();
  if (levelRewardsReturnTo === 'pause') { state = 'paused'; showScreen('pauseScreen'); }
  else openMenu();
});
$('playerLevelWrap').addEventListener('click', () => { Sfx.ui(); openLevelRewards('menu'); });
$('levelBarWrap').addEventListener('click', () => {
  Sfx.ui();
  if (state === 'playing') pauseGame();          // run halts before the panel opens
  openLevelRewards(state === 'paused' || G && G.wave > 0 && state !== 'menu' ? 'pause' : 'menu');
});

/* ------- milestones screen ------- */
function openMilestones() {
  state = 'milestones';
  showScreen('milestoneScreen');
  const list = $('milestoneList');
  list.innerHTML = '';
  // one row per category: the current unclaimed tier (or a "complete" row)
  for (const cat of MILESTONE_CATS) {
    const t = activeMilestoneTier(cat);
    const div = document.createElement('div');
    if (!t) {
      const last = cat.tiers[cat.tiers.length - 1];
      div.className = 'milestoneItem claimed';
      div.innerHTML =
        `<div class="msIcon">${msArtIco(cat.id, cat.icon)}</div>` +
        `<div class="msBody"><div class="msName">${milestoneTierName(cat, cat.tiers.length - 1)}</div>` +
        `<div class="msDesc">${cat.desc(last.goal)} — <b>all tiers complete!</b></div>` +
        `<div class="msBar"><div class="msFill" style="width:100%"></div></div></div>` +
        '<div class="msDone">✔</div>';
      list.appendChild(div);
      continue;
    }
    const prog = Math.min(cat.stat(), t.goal);
    /* rewards are coins only — one currency sprite for every state of the
       button (claimable, locked/disabled, three- or four-digit), and the
       figure comes straight from the tier config that claimMilestone pays */
    const coins = milestoneTierCoins(t);
    const rewardTxt = `${coins.toLocaleString()} ${coinIco()}`;
    const claimable = milestoneClaimable(cat);
    div.className = 'milestoneItem';
    div.innerHTML =
      `<div class="msIcon">${msArtIco(cat.id, cat.icon)}</div>` +
      `<div class="msBody"><div class="msName">${milestoneTierName(cat, t.index)}</div>` +
      `<div class="msDesc">${cat.desc(t.goal)} — <b>${prog.toLocaleString()}/${t.goal.toLocaleString()}</b></div>` +
      `<div class="msBar"><div class="msFill" style="width:${Math.round(prog / t.goal * 100)}%"></div></div></div>` +
      `<button class="roomBtn msClaim" ${claimable ? '' : 'disabled'}` +
      ` aria-label="${claimable ? 'Claim' : 'Locked reward:'} ${coins.toLocaleString()} coins">${rewardTxt}</button>`;
    div.querySelector('button').addEventListener('click', () => {
      if (claimMilestone(cat)) { Sfx.coin(); openMilestones(); }   // re-render: next tier appears
    });
    list.appendChild(div);
  }
}
$('btnHowToBack').addEventListener('click', () => {
  Sfx.ui();
  if (howtoReturnTo === 'ricochetPause') { state = 'ricochetPause'; showScreen('ricochetPauseScreen'); }
  else if (howtoReturnTo === 'pause') { state = 'paused'; showScreen('pauseScreen'); }
  else openMenu();
});

/* ------- castle select ------- */
function openCastleSelect() {
  state = 'castle';
  showScreen('castleScreen');
  const list = $('castleList');
  list.innerHTML = '';
  CASTLES.forEach((c, i) => {
    const locked = c.shop && !owns(c.shop);
    const card = document.createElement('div');
    card.className = 'pickCard' + (locked ? ' locked' : '') + (i === selectedCastle ? ' selected' : '');
    const artEl = c.art ? artHtml(c.art, 'cardArt') : `<div class="cardIcon">${c.icon}</div>`;
    card.innerHTML = `${artEl}<div class="cardName">${c.name}</div><div class="cardDesc">${c.desc}</div>` +
      (locked ? `<div class="cardLvl">🔒 Unlock in Treasury (${krPrice(SHOP.find(s => s.id === c.shop).cost, 'treasury')} ${crownIco()})</div>` : '<div class="cardLvl">Tap to begin!</div>');
    card.addEventListener('click', () => {
      if (locked) { Sfx.ui(); return; }
      selectedCastle = i;
      Sfx.ui();
      startRun();
    });
    list.appendChild(card);
  });
  const nr = $('nightmareRow');
  if (owns('challenge_nightmare')) {
    nr.classList.remove('hidden');
    $('nightmareToggle').checked = META.settings.nightmare;
  } else nr.classList.add('hidden');
}
$('nightmareToggle').addEventListener('change', ev => { META.settings.nightmare = ev.target.checked; saveMeta(); });
$('btnCastleBack').addEventListener('click', () => { Sfx.ui(); openMenu(); });

/* ------- meta shop ------- */
function openMeta() {
  state = 'meta';
  showScreen('metaScreen');
  $('metaCrowns').innerHTML = `${META.crowns}${artHtml('icon_crown_gold.png', 'ico')}`;
  const list = $('metaList');
  list.innerHTML = '';
  for (const item of SHOP) {
    const has = owns(item.id);
    const div = document.createElement('div');
    div.className = 'metaItem' + (has ? ' owned' : '');
    /* Royal Keep discount: computed once per row and used for BOTH the price
       on the button and the crowns actually deducted. SHOP[].cost is never
       modified, so the discount can never compound across renders. */
    const price = krPrice(item.cost, 'treasury');
    const equipped = has && item.cosmetic && ((item.cosmetic === 'hand' && META.handSkin === item.skin) || (item.cosmetic === 'banner' && META.banner === item.skin));
    // painted treasury icon, emoji as load-failure fallback
    const iconEl = item.art
      ? `<div class="mIcon${item.narrow ? ' narrow' : ''}"><img src="${TREASURY_ART}${item.art}" alt="" draggable="false" onerror="this.parentNode.textContent='${item.icon}'"></div>`
      : `<div class="mIcon">${item.icon}</div>`;
    div.innerHTML = `${iconEl}<div class="mBody"><div class="mName">${item.name}${equipped ? ' (equipped)' : ''}</div><div class="mDesc">${item.desc}</div></div>` +
      (has ? (item.cosmetic ? '<button class="roomBtn">Equip</button>' : '') : `<button class="roomBtn" ${META.crowns < price ? 'disabled' : ''}>${price} ${crownIco()}</button>`);
    const btn = div.querySelector('button');
    if (btn) btn.addEventListener('click', () => {
      if (!has) {
        if (META.crowns < price) return;
        META.crowns -= price;
        META.owned[item.id] = true;
        Sfx.coin();
      } else Sfx.ui();
      if (item.cosmetic === 'hand') META.handSkin = item.skin;
      if (item.cosmetic === 'banner') META.banner = item.skin;
      saveMeta();
      openMeta();
    });
    list.appendChild(div);
  }
}
$('btnMetaBack').addEventListener('click', () => { Sfx.ui(); openMenu(); });

/* ------- how to play (platform-specific text, shared icons) -------
   The guide is BUILT AT OPEN TIME, not at load time, so every reward
   number it prints is read from the live configuration that grants it
   (CastleDaily.guideValues()) instead of being copied into prose. If the
   daily systems are unavailable for any reason the daily sections are
   skipped entirely — the guide never shows a number it cannot verify.

   Entry shapes:
     { head: 'Section title' }                       section heading
     { art: '<src>', alt: '…', mobile, desktop }     icon row (desktop text
                                                     falls back to mobile)
     { summary: { title, rows: [] } }                compact reward table */
const LEVEL_STAR_SRC = 'assets/ui/rewards/reward_star_gold_64.png';
const STAR_IMG = `<img class="starInline" src="${LEVEL_STAR_SRC}" alt="Level stars">`;
/* every sprite the guide uses, resolved once from the shared packs — no raw
   asset path is written inside a line of guide prose */
const HOWTO_ART = {
  grab:       UIPOLISH + 'howto_icon_grab_throw.png',
  weight:     UIPOLISH + 'howto_icon_weight_matters.png',
  defend:     UIPOLISH + 'howto_icon_defend_castle.png',
  rooms:      UIPOLISH + 'howto_icon_rooms.png',
  upgrades:   UIPOLISH + 'howto_icon_upgrades.png',
  convert:    UIPOLISH + 'howto_icon_convert.png',
  currency:   UIPOLISH + 'howto_icon_crowns.png',
  ability:    'assets/abilities/icons/ability_shield_burst.png',
  board:      'assets/ui/theme/ui_adventurers_board_icon.png',
  siege:      TRIM + 'icon_shield.png',
  ricochet:   'assets/castle_ricochet/ui/ui_logo_castle_ricochet.png',
  howto:      'assets/ui/theme/ui_how_to_icon.png',
  crown:      CROWN_ICON_SRC,
  milestones: msArtSrc('menu'),
};
/* the live daily/restoration reward configuration, or null when the daily
   systems are not loaded (the guide then omits those sections rather than
   printing numbers that could disagree with the game) */
function howtoValues() {
  try {
    if (typeof CastleDaily !== 'undefined' && CastleDaily && typeof CastleDaily.guideValues === 'function') {
      const v = CastleDaily.guideValues();
      if (v && typeof v.decreeMaxSeals === 'number') return v;
    }
  } catch (e) { CrashDiagnostics.record('howto-values-failed', {}); }
  return null;
}
function buildHowtoLines() {
  const gv = howtoValues();
  /* inline sprite helpers — same art the Board and Kingdom Map show */
  const seal = gv ? `<img class="curIco" src="${gv.sealIcon}" alt="Royal Seals">` : '';
  const pstar = gv ? `<img class="curIco" src="${gv.starIcon}" alt="Prosperity Stars">` : '';
  const lines = [
    { head: 'Castle Fling Basics' },
    /* The Tutorials SECTION is the button group moved to the END of this
       scroller by openHowTo() (authored in index.html) — the guide points at
       it here so it can be found without scrolling for it blind. */
    { art: HOWTO_ART.howto, alt: 'Tutorials',
      mobile: 'All three tutorials can be replayed at any time from the <b>Tutorials</b> section at the very bottom of this guide: the <b>Castle Fling Tutorial</b> walks through grabbing, flinging and Castle Rooms, the <b>Castle Ricochet Tutorial</b> plays at the start of your next Castle Ricochet attempt, and the <b>Adventurers&rsquo; Board Tutorial</b> covers Royal Decrees, the Daily Siege and Kingdom Restoration.' },
    { art: HOWTO_ART.grab, alt: 'Grab and fling',
      mobile: '<b>Grab &amp; Fling:</b> Touch and hold an enemy\'s body to grab it, drag your finger to build the throw, and release to fling it away from the castle. Faster swipes hit harder.',
      desktop: '<b>Grab &amp; Fling:</b> Click and hold an enemy\'s body to grab it, drag the mouse to build the throw, and release to fling it away from the castle. Faster flicks hit harder.' },
    { art: HOWTO_ART.defend, alt: 'Defend the castle',
      mobile: '<b>Enemies advance on the castle.</b> Slam them into the ground, into the walls and into each other — every hard impact damages them. Anything that reaches your walls starts attacking them.' },

    { head: 'Flinging &amp; Combat' },
    { art: HOWTO_ART.weight, alt: 'Weight matters',
      mobile: '<b>Weight matters:</b> Small foes lift instantly. Medium foes need a short hold. Heavy brutes can only be dragged and slammed low.' },
    { mobile: '<b>Elite enemies</b> marked with star badges are enhanced threats — stronger, tougher or faster than they look. Deal with them before they reach the castle.' },
    { mobile: '<b>Runner:</b> fast, rushes the castle. · <b>Soldier:</b> standard frontline fighter. · <b>Shieldbearer:</b> tough, protected by its shield. · <b>Hammer Brute:</b> heavy hitter that threatens the gate. · <b>Bomb Carrier:</b> explodes — keep it away from the walls. · <b>Healer:</b> mends other enemies; a priority target. · <b>Banner Carrier:</b> buffs the horde around it. · <b>Heavy Knight:</b> armored tank — needs a long hold to lift. · <b>Wall Climber:</b> scales your walls at speed. · <b>Siege Captain:</b> commands and strengthens the assault. · <b>Bomb Cart:</b> rolling siege bomb aimed at the castle. · <b>Twin Ram:</b> a two-man battering ram — a serious gate threat.' },

    { head: 'Castle Health &amp; Waves' },
    { art: HOWTO_ART.defend, alt: 'Castle health',
      mobile: `<b>Castle health</b> drops whenever enemies attack your walls. If it reaches zero the run ends and you return to the main menu with the coins ${coinIco()} and crowns ${crownIco()} you earned.` },
    { mobile: `<b>Each wave grows more dangerous</b> — more foes, tougher foes, and new enemy types as you climb. A <b>boss attacks every ${BOSS_WAVE_INTERVAL}th wave</b> (wave ${BOSS_WAVE_INTERVAL}, ${BOSS_WAVE_INTERVAL * 2}, ${BOSS_WAVE_INTERVAL * 3}…). Survive as many waves as you can.` },

    { head: 'Abilities' },
    { art: HOWTO_ART.ability, alt: 'Abilities',
      mobile: 'Castle Rooms unlock ability buttons that appear during battle: <b>Lightning Strike</b> zaps a target, <b>Rolling Bomb</b> sends a bomb across the field, <b>Frost</b> slows and freezes enemies, and <b>Shield Burst</b> shields the whole castle. Each has a cooldown — watch the button timers.',
      desktop: 'Castle Rooms unlock ability buttons that appear during battle: <b>Lightning Strike</b> zaps a target, <b>Rolling Bomb</b> sends a bomb across the field, <b>Frost</b> slows and freezes enemies, and <b>Shield Burst</b> shields the whole castle. Each has a cooldown. Press 1-5 (or click the buttons) · P or Esc pauses · right-click cancels targeting · F11 toggles fullscreen.' },

    { head: 'Castle Rooms &amp; Upgrades' },
    { art: HOWTO_ART.rooms, alt: 'Castle Rooms',
      mobile: `<b>Castle Rooms are chosen between waves</b> and paid for with coins ${coinIco()}. <b>Build</b> and <b>Upgrade</b> are separate actions: build a room to add it to your castle, then upgrade it to raise its level. Higher levels make a room stronger.` },
    { art: HOWTO_ART.upgrades, alt: 'Room effects',
      mobile: 'Every room does something different — rooms <b>attack</b>, <b>repair</b>, <b>defend</b>, <b>recruit</b>, <b>convert</b> and <b>unlock abilities</b>. The <b>Archer Tower</b>, <b>Mason Room</b>, <b>Mage Tower</b>, <b>Bomb Workshop</b>, <b>Conversion Barracks</b> and <b>Wall Forge</b> each shape the waves that follow, so pick the combination that answers the threats you expect.' },
    { art: HOWTO_ART.upgrades, alt: 'Passive upgrades',
      mobile: '<b>Passives:</b> After each wave, pick 1 of 3 passive upgrades. Each run includes <b>4 free picks</b>; extra picks are unlocked by watching a rewarded ad. An ad-free purchase removes the automatic between-wave ads only — rewarded ads for extra picks still apply.' },
    { art: HOWTO_ART.convert, alt: 'Convert enemies',
      mobile: '<b>Convert:</b> Drop a <i>weakened</i> enemy onto the glowing circle by your gate to recruit it (1 conversion per wave). Converted troops fight for you and your archers won\'t target them. Assign recruits to rooms between waves.' },
    { art: HOWTO_ART.crown, alt: 'Save Run',
      mobile: `<b>Save Run:</b> On the Castle Rooms screen you can save your run for ${SAVE_RUN_COST_CROWNS} ${crownIco()} — the session ends and "Continue Run" appears on the home screen to pick it back up later. Settings are available from both the main menu and the pause menu.` },
  ];

  if (gv) {
    const sealsWord = n => `${n} Royal Seal${n === 1 ? '' : 's'}`;
    lines.push(
      { head: 'Adventurers&rsquo; Board' },
      { art: HOWTO_ART.board, alt: 'Adventurers&rsquo; Board',
        mobile: 'The <b>Adventurers&rsquo; Board</b> is the hub for Castle Fling\'s daily activities and Kingdom Restoration. Open it from the main menu.' },
      { mobile: `The Board holds your <b>Royal Decrees</b>, today's <b>Daily Siege</b>, the <b>daily reset timer</b>, your banked <b>Royal Seals</b> ${seal} and a live <b>Kingdom Restoration</b> summary. Everything on it is earned by playing — opening the Board by itself never grants a reward.` },

      { head: 'Royal Decrees' },
      { art: gv.scrollIcon, alt: 'Royal Decrees',
        mobile: `<b>${gv.decreeCount} new objectives every day.</b> They are drawn from different categories and mechanics — defeating enemies, clearing waves, using abilities, converting foes, scoring points and playing the game's other modes. They progress through normal play; there is nothing extra to activate.` },
      { mobile: `Each completed Decree awards <b>${sealsWord(gv.decreeReward)}</b> ${seal} when you claim it. Complete and claim all ${gv.decreeCount} to earn an additional <b>${gv.decreeFullSetBonus}-Seal bonus</b>. Royal Seals are used to restore districts in Kingdom Restoration.` },
      { mobile: `One <b>free reroll</b> per day replaces a single incomplete Decree with a different one — progress on the replaced Decree is lost, and a Decree you have already completed or claimed cannot be rerolled. Decrees reset at local midnight; your progress and claims are saved.` },
      { summary: { title: 'Royal Decree Rewards', rows: [
        `One completed Decree: <b>${sealsWord(gv.decreeReward)}</b> ${seal}`,
        `Complete all ${gv.decreeCount}: <b>${gv.decreeFullSetBonus} bonus Royal Seals</b> ${seal}`,
        `Maximum per day: <b>${sealsWord(gv.decreeMaxSeals)}</b> ${seal}`,
      ] } },

      { head: 'Daily Siege' },
      { art: HOWTO_ART.siege, alt: 'Daily Siege',
        mobile: '<b>One fixed challenge per day:</b> a single long wave of normal Castle Fling grabbing and flinging, fought with a <b>preset Castle Room loadout</b> at preset levels. Rooms cannot be bought, sold or upgraded during the siege — victory comes from mastering the kit you are given. Some days add <b>modifiers</b> that change how the wave fights back.' },
      { mobile: `<b>Retry as often as you like.</b> Every attempt that day faces the exact same wave, the same enemy mix, the same rooms and levels, the same modifiers and the same score targets — retries never generate a new challenge, so practice pays. The Board records your <b>best tier</b>.` },
      { mobile: `<b>Bronze</b> holds ${gv.siegeBronzePct}% of the line. <b>Silver</b> repels the full siege. <b>Gold</b> beats the score target. Only your best tier is rewarded — improving from Bronze to Silver, or Silver to Gold, grants only the difference, never the tiers again.` },
      { summary: { title: 'Daily Siege Rewards', rows: [
        `Bronze: <b>${sealsWord(gv.siegeBronze)}</b> in total ${seal}`,
        `Silver: <b>${sealsWord(gv.siegeSilver)}</b> in total ${seal}`,
        `Gold: <b>${sealsWord(gv.siegeGold)}</b> in total ${seal}`,
        `Maximum per day: <b>${sealsWord(gv.siegeMaxSeals)}</b> ${seal}`,
      ] } },

      { head: 'Kingdom Restoration' },
      { art: gv.hammerIcon, alt: 'Kingdom Restoration',
        mobile: `Royal Decrees and the Daily Siege earn <b>Royal Seals</b> ${seal}; Seals rebuild <b>districts</b>; rebuilt districts pass <b>restoration checkpoints</b>; checkpoints award <b>Prosperity Stars</b> ${pstar}; Prosperity unlocks further districts and kingdom rewards.` },
      { mobile: `<b>Royal Seals are the only restoration resource</b>, and they are <b>never spent automatically</b>. Every Seal you earn goes into one shared balance and waits for you. Open the Kingdom Restoration bar on the Adventurers&rsquo; Board to reach the <b>Kingdom Map</b>.` },
      { mobile: `Choose a district and make it your <b>active project</b> — the active district is highlighted, and contributions go to it. Contribute <b>1</b>, <b>5</b> or <b>Max</b> Seals whenever you like; a contribution can never exceed your balance or the Seals the project still needs. Partial progress is saved permanently, other unlocked districts can still be inspected, and <b>switching projects never loses Seals already contributed</b>.` },
      { mobile: `The ${gv.districtCount} districts are the <b>${gv.districts.join('</b>, <b>')}</b>.` },
      { mobile: 'Each district rebuilds through five visual stages — ' +
        gv.stages.map(s => `<img class="howtoStageIco" src="${s.icon}" alt=""> <b>${s.pct}% ${s.label}</b>`).join(' · ') +
        '. Reaching a checkpoint changes the district art and awards Prosperity Stars.' },
      { art: gv.starIcon, alt: 'Prosperity Stars',
        mobile: `<b>Prosperity Stars</b> ${pstar} measure how much of the kingdom has been restored. They are permanent: they cannot be spent, and they cannot be lost. They fill the <b>Kingdom Prosperity</b> meter, which unlocks new districts and kingdom-wide milestone rewards. Decrees and the Daily Siege never award Prosperity Stars directly — only restoration checkpoints do.` },
      { art: gv.medallionIcons[gv.medallionIcons.length - 1].icon, alt: 'District completion rewards',
        mobile: `Every restoration checkpoint also pays that district's <b>permanent kingdom bonus</b> to the core game — one stack at ${gv.medallionIcons.map(m => `<b>${m.pct}%</b>`).join(', ')} — and the ${gv.passiveStackCount} stacks add together, so a fully restored district is worth ${gv.passiveStackCount}× its bonus. These bonuses are earned once, kept forever, and apply to every run, new or resumed. Restoring all ${gv.requiredDistrictCount} districts pays a further <b>${gv.kingdomCrowns.toLocaleString()} Crowns</b> ${crownIco()}, once.` },
      { summary: { title: 'Restoration Checkpoints', rows: gv.checkpoints.map(c =>
        `${c.pct}%: <b>${c.stars} Prosperity Star${c.stars === 1 ? '' : 's'}</b> ${pstar} and one stack of the district's bonus`
      ).concat([
        `Entire kingdom (all ${gv.requiredDistrictCount} districts at 100%): <b>${gv.kingdomCrowns.toLocaleString()} additional Crowns</b> ${crownIco()}`,
      ]) } },
      { summary: { title: 'District Bonuses (per checkpoint &rarr; fully restored)', rows:
        gv.passives.map(p => `<b>${p.district}</b>: ${p.perMilestone} &rarr; ${p.atFull}`) } });
  } else {
    lines.push(
      { head: 'Adventurers&rsquo; Board' },
      { art: HOWTO_ART.board, alt: 'Adventurers&rsquo; Board',
        mobile: 'The <b>Adventurers&rsquo; Board</b> is the hub for Castle Fling\'s daily activities and Kingdom Restoration — Royal Decrees, the Daily Siege, the daily reset timer and your Kingdom Restoration progress. Open it from the main menu to see today\'s objectives and their exact rewards.' });
  }

  lines.push(
    { head: 'Rewards &amp; Currencies' },
    { art: HOWTO_ART.currency, alt: 'Coins and Crowns',
      mobile: `<b>Coins ${coinIco()}</b> are earned in battle and from Milestones, and are spent on Castle Rooms and their upgrades. <b>Crowns ${crownIco()}</b> are the premium currency used by the Royal Treasury, Save Run and Castle Ricochet replays — earned each run, awarded by Kingdom Restoration, or bought in the Crown Shop.` });
  if (gv) {
    lines.push(
      { mobile: `<b>Royal Seals ${seal}</b> are the Kingdom Restoration construction resource — earned from Royal Decrees and the Daily Siege, banked in one shared balance, and contributed to your active project by hand.` },
      { mobile: `<b>Prosperity Stars ${pstar}</b> are permanent restoration progress from district checkpoints. They are never spent and never lost.` });
  }
  lines.push(
    { art: LEVEL_STAR_SRC, alt: 'Level stars',
      mobile: `<b>Level Stars ${STAR_IMG}</b> are a separate reward from Prosperity Stars: they raise your <b>player level</b> (up to <b>Level 99</b>), and every 5 levels grants a coin bonus that is collected automatically. Level Stars measure how much you have played; Prosperity Stars measure how much of the kingdom you have rebuilt.` });
  if (gv) {
    lines.push({ summary: { title: 'Royal Seals Per Day', rows: [
      `Royal Decrees: up to <b>${gv.decreeMaxSeals} Royal Seals</b> ${seal}`,
      `Daily Siege: up to <b>${gv.siegeMaxSeals} Royal Seals</b> ${seal}`,
      `Total: up to <b>${gv.dailyMaxSeals} Royal Seals</b> ${seal} — this requires completing and claiming all ${gv.decreeCount} Decrees, claiming the full-set bonus, and reaching Gold in the Daily Siege. Nothing here is awarded for simply logging in.`,
    ] } });
  }

  lines.push(
    { head: 'Milestones' },
    { art: HOWTO_ART.milestones, alt: 'Milestones',
      mobile: `<b>Milestones</b> reward lifetime accomplishments — enemies defeated, bosses broken, waves cleared, coins earned — and stack into tiers: defeat 100 enemies, then 250, then 500… Claiming a completed tier reveals the next, harder tier for a larger reward.` },
    { mobile: `Every Milestone reward is paid in <b>Coins ${coinIco()}</b>. Some objectives track other things — the Crown Collector line counts crowns you have earned — but the reward for claiming any Milestone tier is Coins.` },

    { head: 'Castle Ricochet' },
    { art: HOWTO_ART.ricochet, alt: 'Castle Ricochet',
      mobile: '<b>Castle Ricochet</b> becomes available once every hour from the main menu. You have <b>five shots</b> to use the Royal Striker to knock <b>three enemy tokens</b> into the castle pits.' },
    { mobile: '<b>Aim:</b> drag backward from the Royal Striker — pull farther for more power. Use walls, pillars, and angled barriers to make bank shots.' },
    { mobile: `<b>Rewards:</b> sink one enemy for <b>500 coins</b> ${coinIco()}, two for <b>1,000 coins</b>, or all three for <b>1,500 coins</b>. If the Royal Striker falls into any pit, the attempt ends immediately and no coins are earned.` },
    { mobile: `You may spend <b>20 crowns</b> ${crownIco()} to play again without waiting for the hourly timer — your free attempt timer is never changed by a paid replay.` });

  return lines;
}
let howtoReturnTo = 'menu';
function openHowTo(from) {
  howtoReturnTo = from || 'menu';
  state = 'howto';
  showScreen('howtoScreen');
  const key = Layout.isMobile ? 'mobile' : 'desktop';
  const body = document.querySelector('.howtoBody');
  /* The Tutorials block is the last thing in the scroller, so it is reached
     by reading (or scrolling) to the end of the guide. It is authored in the
     HTML and only ever MOVED — detached before the rebuild so innerHTML can
     never destroy it, then re-appended. Moving a node keeps its listeners,
     so the three buttons stay wired to the handlers tutorial.js bound once
     at init, and repeated opens can never stack or lose them. */
  const tutorials = document.querySelector('.tutorialGroup');
  if (tutorials) tutorials.remove();
  body.innerHTML = buildHowtoLines().map(l => {
    if (l.head) return `<h3 class="howtoHead">${l.head}</h3>`;
    if (l.summary) {
      return `<div class="howtoSummary"><span class="sumTitle">${l.summary.title}</span><ul>` +
        l.summary.rows.map(r => `<li>${r}</li>`).join('') + '</ul></div>';
    }
    const txt = l[key] || l.mobile;
    /* every icon row resolves its sprite from HOWTO_ART or the live
       restoration config — no raw path is written in a line of prose */
    const ico = l.art ? `<img class="howtoIco" src="${l.art}" alt="${l.alt || ''}" draggable="false">` : '';
    return `<p>${ico}<span>${txt}</span></p>`;
  }).join('');
  if (tutorials) body.appendChild(tutorials);
  /* the scroller always opens at the top, whichever screen sent us here */
  body.scrollTop = 0;
}

/* ------- coin shop -------
   The shop never grants rewards itself: it calls the StorePayments
   adapter and hands the result to grantPurchaseReward(). */
let shopReturnTo = 'menu';
function openShop(from) {
  shopReturnTo = from || 'menu';
  state = 'shop';
  showScreen('shopScreen');
  renderShop();
}
async function renderShop() {
  const status = $('shopStatus');
  const list = $('shopList');
  $('shopBanner').innerHTML = META.adFree
    ? '✅ Ad-Free Active — thank you for your support!'
    : '✨ Ad-free with any purchase ✨';
  if (!StorePayments.isAvailable()) {
    list.innerHTML = '';
    status.textContent = 'Purchases are unavailable on this platform.';
    return;
  }
  status.textContent = StorePayments.getMode() === 'mock' ? '(Development build — purchases are simulated)' : '';
  let products = await StorePayments.getProducts();
  /* Nothing to sell? Ask the store once more before believing it. The native
     catalog is fetched at launch, so a product activated in Play Console while
     the game was already running would otherwise stay invisible until a full
     restart — which looks exactly like a broken shop. */
  if (!products.some(p => p.available)) {
    status.textContent = 'Checking the store…';
    if (await StorePayments.refreshProducts()) {
      products = await StorePayments.getProducts();
    }
    status.textContent = '';
  }
  list.innerHTML = '';
  /* Only render what the store actually sells. A product the store did not
     return has no real price and cannot be bought, so showing a buy button for
     it would be a false claim — and tapping it could only ever fail. */
  const sellable = products.filter(p => p.available);
  if (!sellable.length) {
    status.textContent = 'The Crown Shop is not open yet — no items are available for purchase right now.';
    requestAnimationFrame(() => updateScrollHint('shopScreen'));
    return;
  }
  for (const p of sellable) {
    const row = document.createElement('div');
    row.className = 'shopItem';
    row.innerHTML =
      `${artHtml('icon_crown_gold.png', 'shopIco')}` +
      `<div class="shopBody"><div class="shopCoins">${(p.crowns || 0).toLocaleString()} Crowns</div>` +
      `<div class="shopSub">Removes forced ads</div></div>` +
      `<button class="roomBtn shopBuy">${p.priceLabel}</button>`;
    row.querySelector('button').addEventListener('click', ev => buyPack(p.id, ev.currentTarget));
    list.appendChild(row);
  }
  requestAnimationFrame(() => updateScrollHint('shopScreen'));   // async content settled
}
async function buyPack(productId, btn) {
  Sfx.ui();
  const status = $('shopStatus');
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = '…';
  status.textContent = 'Contacting store…';
  const result = await StorePayments.purchase(productId);
  btn.disabled = false;
  btn.textContent = oldLabel;
  if (result && result.success) {
    const granted = grantPurchaseReward(result);
    if (granted) Sfx.coin();
    await renderShop();
    status.textContent = granted
      ? `+${(IAP_PRODUCTS[productId].crowns || 0).toLocaleString()} crowns added! Forced ads are now disabled.`
      : 'Purchase already processed.';
    if (shopReturnTo === 'menu') $('menuCrowns').innerHTML = `(${META.crowns}${artHtml('icon_crown_gold.png', 'ico')})`;
  } else {
    const msgs = {
      cancelled: 'Purchase cancelled.',
      pending: 'Purchase pending — it will complete shortly.',
      unavailable: 'Purchases are unavailable right now.',
      not_supported: 'Purchases are unavailable on this platform.',
    };
    status.textContent = msgs[result && result.reason] || 'Purchase failed. Nothing was charged.';
  }
}
$('btnShop').addEventListener('click', () => { Sfx.ui(); openShop('menu'); });
$('btnPauseShop').addEventListener('click', () => { Sfx.ui(); openShop('pause'); });
$('btnPauseSettings').addEventListener('click', () => { Sfx.ui(); openSettings('pause'); });
$('btnShopBack').addEventListener('click', () => {
  Sfx.ui();
  if (shopReturnTo === 'pause') { state = 'paused'; showScreen('pauseScreen'); }
  else openMenu();
});
$('btnRestorePurchases').addEventListener('click', async () => {
  Sfx.ui();
  $('shopStatus').textContent = 'Restoring purchases…';
  const res = await restorePurchasesFlow();
  $('shopStatus').textContent = res.success
    ? (res.adFree ? 'Purchases restored — ad-free is active.' : 'No previous purchases found.')
    : 'Restore is unavailable on this platform.';
  renderShop();
});

/* ------- terms & privacy ------- */
let legalReturnTo = 'menu';
function openLegal(from) {
  legalReturnTo = from || 'menu';
  state = 'legal';
  showScreen('legalScreen');
  const body = $('legalBody');
  body.innerHTML = LEGAL.sections.map(s =>
    `<div class="legalSection"><h3>${s.title}</h3><p>${s.body}</p></div>`).join('');
}
$('btnLegalBack').addEventListener('click', () => {
  Sfx.ui();
  if (legalReturnTo === 'settings') openSettings();
  else if (legalReturnTo === 'shop') openShop(shopReturnTo);
  else openMenu();
});
$('menuLegalLink').addEventListener('click', ev => { ev.preventDefault(); Sfx.ui(); openLegal('menu'); });
$('btnSettingsLegal').addEventListener('click', () => { Sfx.ui(); openLegal('settings'); });
$('shopLegalLink').addEventListener('click', ev => { ev.preventDefault(); Sfx.ui(); openLegal('shop'); });

/* ------- settings ------- */
let settingsReturnTo = 'menu';
function openSettings(from) {
  settingsReturnTo = from || 'menu';
  state = 'settings';
  // from pause: dim overlay over the PAUSED RUN scene (the canvas keeps
  // rendering the run underneath); from menu: plain screen over the menu scene
  $('settingsScreen').classList.toggle('dim', settingsReturnTo === 'pause' || settingsReturnTo === 'ricochetPause');
  showScreen('settingsScreen');
  $('setSound').checked = META.settings.sound;
  $('setMusic').checked = META.settings.music;
  $('setMusicVol').value = META.settings.musicVol;
  $('setNumbers').checked = META.settings.numbers;
  $('setParticles').checked = META.settings.particles;
  refreshPrivacyOptionsButton();
}

/* ------- ad privacy options (UMP) -------
   Google requires a persistent entry point back to the consent form, but only
   where one is actually required (region + consent state). The UMP SDK is the
   authority on that, so the button mirrors its answer and stays hidden
   everywhere else — including web and desktop, where there is no ads SDK. */
function refreshPrivacyOptionsButton() {
  const btn = $('btnPrivacyOptions');
  if (!btn) return;
  const native = window.CastleFlingNative;
  const required = !!(native && native.isPrivacyOptionsRequired && native.isPrivacyOptionsRequired());
  btn.classList.toggle('hidden', !required);
}
$('btnPrivacyOptions').addEventListener('click', () => {
  Sfx.ui();
  const native = window.CastleFlingNative;
  if (!native || !native.showPrivacyOptionsForm) return;
  const btn = $('btnPrivacyOptions');
  btn.disabled = true;
  /* A consent error must not strand the player on a dead button: re-enable and
     re-evaluate visibility whichever way the form resolves. */
  native.showPrivacyOptionsForm()
    .catch(() => null)
    .then(() => native.refreshAdStatus ? native.refreshAdStatus() : null)
    .catch(() => null)
    .then(() => { btn.disabled = false; refreshPrivacyOptionsButton(); });
});
$('setSound').addEventListener('change', ev => { META.settings.sound = ev.target.checked; saveMeta(); });
$('setMusic').addEventListener('change', ev => {
  META.settings.music = ev.target.checked; saveMeta();
  Music.onToggle();
});
$('setMusicVol').addEventListener('input', ev => {
  Music.setVolume(parseFloat(ev.target.value));
});
$('setNumbers').addEventListener('change', ev => { META.settings.numbers = ev.target.checked; saveMeta(); });
$('setParticles').addEventListener('change', ev => { META.settings.particles = ev.target.checked; saveMeta(); });
/* closed-test diagnostics: tapping the Settings title 5× within 2s gaps
   reveals the Copy Diagnostic Report button (hidden from normal players) */
let diagTaps = 0, diagTapAt = 0;
$('settingsTitle').addEventListener('click', () => {
  const now = Date.now();
  if (now - diagTapAt > 2000) diagTaps = 0;
  diagTapAt = now;
  if (++diagTaps >= 5) { $('btnCopyDiag').classList.remove('hidden'); Sfx.ui(); }
});
$('btnCopyDiag').addEventListener('click', () => {
  Sfx.ui();
  const btn = $('btnCopyDiag');
  btn.textContent = 'Sampling store…';
  /* Ask the native billing plugin for its live state FIRST, so the copied
     report answers "is the store connected and what did Play return" without
     needing a PC and adb. Never let a missing or hung bridge block the copy. */
  const native = window.CastleFlingNative;
  const sample = (native && native.getBillingStatus)
    ? Promise.race([
        native.getBillingStatus().catch(e => ({ error: String(e && e.message) })),
        new Promise(res => setTimeout(() => res({ error: 'timeout' }), 3000)),
      ])
    : Promise.resolve('no-native-bridge');
  sample.then(s => { CrashDiagnostics.storeSnapshot = s; })
    .catch(() => { CrashDiagnostics.storeSnapshot = 'sample-failed'; })
    .then(() => CrashDiagnostics.copyReport())
    .then(ok => {
      btn.textContent = ok ? '✅ Report copied' : '⚠ Copy failed';
      setTimeout(() => { btn.textContent = '🩺 Copy Diagnostic Report'; }, 1600);
    });
});
$('btnResetSave').addEventListener('click', () => {
  gameConfirm('Erase ALL progress, crowns and unlocks? This cannot be undone.',
    { title: 'Reset save?', okText: 'Erase Everything', cancelText: 'Cancel', danger: true })
    .then(async ok => {
      if (!ok) return;
      // clear the native mirror too, or the boot-time restore resurrects the save
      try { const NP = NATIVE_PREFS(); if (NP) await NP.remove({ key: SAVE_KEY }); } catch (e) {}
      localStorage.removeItem(SAVE_KEY);
      location.reload();
    });
});
$('btnSettingsBack').addEventListener('click', () => {
  Sfx.ui();
  // opened from a pause menu: that run must stay paused underneath, never resume
  if (settingsReturnTo === 'pause') { state = 'paused'; showScreen('pauseScreen'); }
  else if (settingsReturnTo === 'ricochetPause') { state = 'ricochetPause'; showScreen('ricochetPauseScreen'); }
  else openMenu();
});

/* ------- run start ------- */
function startRun() {
  // one run slot: starting fresh replaces any saved checkpoint (the player
  // confirmed this on the Play button when a save existed). Cleared here —
  // not at the confirm — so backing out of castle select keeps the save.
  if (META.savedRun) { META.savedRun = null; saveMeta(); }
  newRun(selectedCastle);
  Sfx.unlock();
  startWave(1);
  /* first-time flow, mirroring Castle Ricochet: the tutorial arms itself on
     the first run of the core game and never again once completed. Continue
     Run resumes on the rooms screen and is deliberately not covered. */
  const tut = TUT();
  if (tut) tut.startAuto();
}

/* ------- upgrade cards -------
   Free picks are limited to 4 per run; after that a rewarded ad buys
   exactly one more selection (available even with ad-free status). */
function showCardScreen(bonusText, count) {
  state = 'cards';
  showScreen('cardScreen');
  G.pendingCardCount = count;
  $('cardWaveNum').textContent = G.wave;
  $('cardBonusText').innerHTML = bonusText;
  $('btnSkipCard').innerHTML = `Skip (+${scaleCoinReward(ECONOMY.skipCardGold)} ${coinIco()})`;
  const row = $('cardRow');
  const noPanel = $('noUpgradePanel');
  const usedUp = G.freeUpgradesUsed >= G.freeUpgradeLimit && G.rewardedUpgradeCredits <= 0;
  $('freeUpgradeCounter').textContent = G.rewardedUpgradeCredits > 0
    ? `Bonus upgrade ready! (${G.rewardedUpgradeCredits} credit${G.rewardedUpgradeCredits > 1 ? 's' : ''})`
    : `Free upgrades: ${Math.min(G.freeUpgradesUsed, G.freeUpgradeLimit)}/${G.freeUpgradeLimit} used`;
  if (usedUp) {
    // out of free picks: offer a rewarded ad or continue to the build screen
    row.classList.add('hidden');
    $('btnSkipCard').classList.add('hidden');
    $('cardChooseTitle').classList.add('hidden');
    noPanel.classList.remove('hidden');
    $('noUpgradeMsg').textContent = 'Free upgrades used for this run. Watch an ad for 1 more choice.';
    /* Authoritative reset: whatever the last ad attempt did to this button,
       showing the panel again always presents a fresh, enabled "Watch Ad". */
    resetWatchAdButton();
    return;
  }
  noPanel.classList.add('hidden');
  row.classList.remove('hidden');
  $('btnSkipCard').classList.remove('hidden');
  $('cardChooseTitle').classList.remove('hidden');
  row.innerHTML = '';
  const avail = UPGRADES.filter(u => (G.upgrades[u.id] || 0) < u.max);
  const picks = [];
  const pool = avail.slice();
  while (picks.length < count && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  if (!picks.length) { showBuildScreen(); return; }
  for (const u of picks) {
    const lvl = G.upgrades[u.id] || 0;
    const card = document.createElement('div');
    card.className = 'pickCard';
    const artEl = u.art ? artHtml(u.art, 'cardArt') : `<div class="cardIcon">${u.icon}</div>`;
    card.innerHTML = `${artEl}<div class="cardName">${u.name}</div><div class="cardDesc">${u.desc}</div>` +
      (lvl > 0 ? `<div class="cardLvl">Owned ×${lvl} → ×${lvl + 1}</div>` : '');
    card.addEventListener('click', () => {
      // consume a free slot first, then rewarded credits
      if (G.freeUpgradesUsed < G.freeUpgradeLimit) G.freeUpgradesUsed++;
      else if (G.rewardedUpgradeCredits > 0) G.rewardedUpgradeCredits--;
      G.upgrades[u.id] = (G.upgrades[u.id] || 0) + 1;
      uiDirty = true;
      Sfx.coin();
      if (u.id === 'panicBell') rebuildAbilities();
      showBuildScreen();
    });
    row.appendChild(card);
  }
}
$('btnWatchAdUpgrade').addEventListener('click', () => { Sfx.ui(); watchAdForExtraUpgrade(); });
$('btnNoUpgradeContinue').addEventListener('click', () => { Sfx.ui(); showBuildScreen(); });
$('btnSkipCard').addEventListener('click', () => { addGold(scaleCoinReward(ECONOMY.skipCardGold)); Sfx.coin(); showBuildScreen(); });

/* ------- build screen (rooms + recruits) ------- */
function showBuildScreen() {
  state = 'build';
  showScreen('buildScreen');
  renderBuild();
}
function renderBuild() {
  setTextRaw('buildGold', Math.floor(G.gold));
  // Save Run availability: costs crowns and only makes sense between waves
  const sb = $('btnSaveRun');
  sb.innerHTML = `💾 Save Run — 20 ${crownIco()}`;
  sb.disabled = META.crowns < SAVE_RUN_COST_CROWNS;
  const list = $('roomList');
  list.innerHTML = '';
  for (const [key, room] of Object.entries(ROOMS)) {
    const lv = G.rooms[key];
    const maxed = lv >= room.max;
    /* Market Square discount: ONE figure for the button label and the spend,
       derived from ROOMS[].costs on every render. The base table is never
       rewritten, so the discount cannot compound as the screen re-renders. */
    const cost = maxed ? 0 : krPrice(room.costs[lv], 'room');
    const div = document.createElement('div');
    div.className = 'roomCard';
    /* the tutorial finds and spotlights real cards through this attribute —
       it is the only thing that ties a guided step to a rendered room */
    div.dataset.room = key;
    // filled = owned levels, gold = the next level being previewed, empty = rest
    const pips = '●'.repeat(lv) +
      (maxed ? '' : '<span class="pipNext">○</span>' + '○'.repeat(room.max - lv - 1));
    // recruit-assignment badge (Tower Crew / Mason Aids) so players can see
    // where their recruits are working straight from the room card
    const crew = key === 'archer' ? G.recruits.archer : key === 'mason' ? G.recruits.mason : 0;
    const crewNote = key === 'archer' ? `+${Math.round(crew * 15)}% fire rate` : `+${(crew * 0.8).toFixed(1)} HP/s`;
    const badge = crew > 0 ? `<span class="recruitBadge" title="Assigned recruits: ${crewNote}">🧍×${crew}</span>` : '';
    // the card always previews the NEXT level's effect (info(lv+1)), never the owned one
    const lvlLine = maxed ? `Lv ${lv} — MAX` : `Lv ${lv} → ${lv + 1}`;
    div.innerHTML =
      `<div class="roomBody">${room.art ? artHtml(room.art, 'roomArt') : ''}<div class="roomText">` +
      `<div class="roomHead"><span class="roomName">${room.name}${badge}</span>` +
      `<span class="pips">${pips}</span></div>` +
      `<div class="roomDesc"><b class="roomLvl">${lvlLine}:</b> ${maxed ? 'Fully upgraded.' : room.info(lv + 1)}</div></div></div>` +
      `<button class="roomBtn" ${maxed || G.gold < cost ? 'disabled' : ''}>${maxed ? 'MAX' : (lv === 0 ? 'Build' : 'Upgrade') + ' — ' + cost + ' ' + coinIco()}</button>`;
    /* tapping the card body inspects the room — outside the tutorial this is
       the same no-op it always was; the tutorial's "choose a room" step is
       what listens for it */
    div.addEventListener('click', () => { tutEvent('roomSelected', { room: key, lv: G.rooms[key] }); });
    div.querySelector('button').addEventListener('click', () => {
      if (maxed || G.gold < cost) return;
      spendGold(cost);
      G.rooms[key]++;
      if (key === 'wall') { G.castleMax += 80; repairCastle(80); }
      Sfx.coin();
      dailyEvent('room', { room: key, lv: G.rooms[key] });
      /* Build and Upgrade are DIFFERENT tutorial events: the level before the
         press is what tells them apart, exactly as the button label did */
      tutEvent(lv === 0 ? 'roomBuilt' : 'roomUpgraded', { room: key, lv: G.rooms[key] });
      renderBuild();
    });
    list.appendChild(div);
  }
  // recruit assignment (panel only earns its space once someone is converted)
  $('defenderPanel').classList.toggle('hidden', G.recruits.total === 0);
  setTextRaw('defTotal', G.recruits.total);
  const assign = $('defAssign');
  assign.innerHTML = '';
  const roles = [
    { key: 'gate', label: '🛡 Gate Guards', desc: 'Fight at the gate' },
    { key: 'archer', label: '🏹 Tower Crew', desc: '+15% archer speed each' },
    { key: 'mason', label: '🧱 Mason Aids', desc: '+0.8 repair/s each' },
  ];
  for (const role of roles) {
    const row = document.createElement('div');
    row.className = 'assignRow';
    if (role.key === 'gate') {
      row.innerHTML = `<span>${role.label}: <b>${G.recruits.gate}</b></span>`;
      row.title = role.desc;
    } else {
      row.innerHTML = `<button data-a="-">−</button><span>${role.label}: <b>${G.recruits[role.key]}</b></span><button data-a="+">+</button>`;
      row.title = role.desc;
      const [minus, plus] = row.querySelectorAll('button');
      minus.disabled = G.recruits[role.key] <= 0;
      plus.disabled = G.recruits.gate <= 0;
      minus.addEventListener('click', () => { if (G.recruits[role.key] > 0) { G.recruits[role.key]--; G.recruits.gate++; Sfx.ui(); renderBuild(); } });
      plus.addEventListener('click', () => { if (G.recruits.gate > 0) { G.recruits.gate--; G.recruits[role.key]++; Sfx.ui(); dailyEvent('recruitAssign', { role: role.key }); renderBuild(); } });
    }
    assign.appendChild(row);
  }
}
function setTextRaw(id, v) { $(id).textContent = v; }

$('btnNextWave').addEventListener('click', () => {
  Sfx.ui();
  tutEvent('nextWavePressed', { wave: G.wave });
  const next = G.wave + 1;
  // sometimes offer a dangerous bargain (not before boss waves)
  if (next >= 4 && !isBossWave(next) && Math.random() < 0.5) {
    offerModifier();
  } else {
    startWave(next);
  }
});
$('btnAbandonRun').addEventListener('click', () => {
  Sfx.ui();
  gameConfirm('Return to the main menu? Coins and crowns earned this run are kept.',
    { title: 'Abandon this run?', okText: 'Abandon Run', cancelText: 'Keep Playing', danger: true })
    .then(ok => {
      if (!ok) return;
      bankRunCrowns(true);
      saveMeta();
      Music.duck();
      openMenu();
    });
});
/* Save Run = suspend & exit: confirming charges the crowns, checkpoints the
   run and ends the session — the player can't save and then also play on
   (that made the purchase feel wasted). */
let isSavingRun = false;   // double-tap guard: one confirm + charge at a time
$('btnSaveRun').addEventListener('click', () => {
  const btn = $('btnSaveRun');
  if (isSavingRun || state !== 'build') return;
  if (META.crowns < SAVE_RUN_COST_CROWNS) {
    Sfx.ui();
    btn.innerHTML = `Need 20 ${crownIco()} to save`;
    setTimeout(() => { btn.innerHTML = `💾 Save Run — 20 ${crownIco()}`; }, 1600);
    return;
  }
  isSavingRun = true;
  btn.disabled = true;
  Sfx.ui();
  gameConfirm('Saving costs 20 crowns and returns you to the main menu. Pick the run back up any time with "Continue Run".',
    { title: 'Save this run?', okText: '💾 Save Run', cancelText: 'Cancel' })
    .then(ok => {
      isSavingRun = false;
      if (!ok || !gameConfirmStillValid()) { btn.disabled = META.crowns < SAVE_RUN_COST_CROWNS; return; }
      bankRunCrowns(false);            // every coin/crown/star earned is banked first
      if (!saveRunCheckpoint()) { btn.disabled = META.crowns < SAVE_RUN_COST_CROWNS; return; }
      Sfx.coin();
      Music.duck();
      openMenu();                      // session over — Continue Run waits on the menu
    });
});
// the modal outlives screens: only act if we are still between waves
function gameConfirmStillValid() { return state === 'build'; }

/* ------- modifier offer ------- */
let offeredMod = null;
function offerModifier() {
  state = 'modifier';
  offeredMod = choice(MODIFIERS);
  const iconEl = offeredMod.art
    ? `<img class="modIcon" src="${UIPOLISH}${offeredMod.art}" alt="" draggable="false" onerror="this.outerHTML='${offeredMod.icon}'">`
    : offeredMod.icon;
  $('modCard').innerHTML = `${iconEl}<span class="modName">${offeredMod.name}</span>${offeredMod.desc}`;
  showScreen('modScreen');
}
$('btnModAccept').addEventListener('click', () => {
  Sfx.ui();
  G.pendingMod = offeredMod.id;
  if (offeredMod.id === 'norepair') {
    G.bankedCrowns += ECONOMY.crowns.riskModBank;
    floater(W / 2, 300, `+${ECONOMY.crowns.riskModBank} 👑 banked!`, '#ffd77a', 22, 1.5);
  }
  startWave(G.wave + 1);
});
$('btnModDecline').addEventListener('click', () => { Sfx.ui(); startWave(G.wave + 1); });

/* ------- pause / game over ------- */
$('pauseBtn').addEventListener('click', () => { Sfx.ui(); if (state === 'playing') pauseGame(); });
$('btnResume').addEventListener('click', () => { Sfx.ui(); resumeGame(); });
/* Both destructive pause actions confirm first — they sit right under Resume,
   and a mis-tap used to end the run instantly with no way back. The Daily
   Siege branches already confirm inside restartSiege()/abandonSiege(), so
   they return BEFORE these prompts and are never asked twice. Each callback
   re-checks that a paused run is still current, so a dialog left open across
   any other transition can't fire a stale restart or abandon.
   Note pauseGame() already ran bankRunCrowns(false): by the time this menu is
   open, coins, crowns and star XP earned this run are banked either way. */
function pauseActionStillValid() { return state === 'paused' && G && G.wave > 0; }
$('btnPauseRestart').addEventListener('click', () => {
  Sfx.ui();
  // pausing a Daily Siege: restart replays the SAME daily challenge
  if (G && G.siege) { if (DAILY()) DAILY().restartSiege(); return; }
  gameConfirm('Start over from wave 1? Coins and crowns earned this run are kept, but your castle rooms and upgrades are lost.',
    { title: 'Restart this run?', okText: 'Restart Run', cancelText: 'Keep Playing' })
    .then(ok => {
      if (!ok || !pauseActionStillValid()) return;
      /* A restart begins a new run: same gate as every other doorway. Leaving
         from here abandons the paused run on the usual terms, not silently. */
      gateEnterGameplay(() => { if (pauseActionStillValid()) startRun(); }, leaveRunForMenu);
    });
});
$('btnPauseQuit').addEventListener('click', () => {
  Sfx.ui();
  if (G && G.siege) { if (DAILY()) DAILY().abandonSiege(); return; }
  /* same copy, title and buttons as the Castle Rooms Abandon Run prompt */
  gameConfirm('Return to the main menu? Coins and crowns earned this run are kept.',
    { title: 'Abandon this run?', okText: 'Abandon Run', cancelText: 'Keep Playing', danger: true })
    .then(ok => {
      if (!ok || !pauseActionStillValid()) return;
      Music.duck();
      bankRunCrowns(true);   // abandoning keeps everything earned this run
      saveMeta();
      openMenu();
    });
});
/* Try Again re-enters ad-supported gameplay, so it settles any pending
   requirement first — this is the placement the run-end ad usually lands on.
   Main Menu is NOT gated: the player can always walk away safely. */
$('btnRetry').addEventListener('click', () => { Sfx.ui(); gateEnterGameplay(startRun); });
$('btnGoMenu').addEventListener('click', () => { Sfx.ui(); openMenu(); });

/* Android hardware back (called from MainActivity's OnBackPressedCallback —
   the deprecated onBackPressed() override is gone): returns true when handled
   in-game; false only on the main menu, which tells the native side it may
   exit the app. */
window.__castleFlingBack = function handlePlatformBack() {
  // an open confirm dialog owns the back press: back = cancel
  if (!$('confirmModal').classList.contains('hidden')) { $('confirmCancel').click(); return true; }
  // an open Castle Fling tutorial closes before anything else leaves a screen
  if (TUT() && TUT().handleBack()) return true;
  // the Adventurers' Board tutorial follows the same rule
  if (BTUT() && BTUT().handleBack()) return true;
  // Castle Ricochet states (gameplay pauses, pause resumes, result exits)
  if (RICO() && RICO().handleBack()) return true;
  if (state === 'playing') { pauseGame(); return true; }
  if (state === 'paused') { resumeGame(); return true; }
  if (state === 'levelRewards') { $('btnLevelRewardsBack').click(); return true; }
  // settings and shop can be entered from pause: their Back buttons know the
  // right return target, so back defers to them
  if (state === 'settings') { $('btnSettingsBack').click(); return true; }
  if (state === 'shop') { $('btnShopBack').click(); return true; }
  // Adventurers' Board and the Daily Siege result panel — the Kingdom
  // Restoration overlay steps back through notice → district panel → map
  if (state === 'daily') {
    if (DAILY() && DAILY().kingdomBack && DAILY().kingdomBack()) return true;
    const ov = $('kingdomOverlay');
    if (ov && !ov.classList.contains('hidden')) { ov.classList.add('hidden'); return true; }
    openMenu();
    return true;
  }
  if (state === 'siegeResult') { if (DAILY()) DAILY().closeSiegeResult(); return true; }
  /* How to Play can be opened from the menu OR from a pause menu: its own Back
     button knows the right return target, so back defers to it */
  if (state === 'howto') { $('btnHowToBack').click(); return true; }
  if (state === 'castle' || state === 'meta' ||
      state === 'gameover' || state === 'legal' || state === 'milestones') {
    openMenu();
    return true;
  }
  // mid-run overlays (upgrade cards, build screen, bargains): back must never
  // skip them or kill the run — swallow the press
  if (state === 'cards' || state === 'build' || state === 'modifier') return true;
  return false;   // main menu: allow app exit
};

/* ============================================================
   MAIN LOOP & BOOT
   Exactly ONE rAF loop may ever run: start/stop are guarded and
   the pending frame id is tracked so lifecycle resume, errors or
   double-calls can never stack a second loop (S20 FE pass).
   ============================================================ */
let lastT = performance.now();
let frameErrs = 0;
let gameLoopRunning = false;
let gameLoopAnimationFrameId = null;
function frame(t) {
  gameLoopAnimationFrameId = null;
  if (!gameLoopRunning) return;
  // A thrown exception must never kill the rAF loop — that reads as a total
  // freeze on device (reported on Galaxy S20 FE). Log, skip the frame, carry on.
  try {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    ambientT += dt;
    const rico = RICO();
    const tut = TUT();
    if (rico && rico.isActive()) {
      rico.frame(dt);              // Castle Ricochet owns the canvas for these states
    } else {
      /* a tutorial reading page freezes the run exactly like a pause: the
         simulation is skipped, the HUD stays in sync, nothing can walk,
         spawn or reach the walls while the player reads */
      if (state === 'playing') {
        if (tut && tut.holdsGameplay()) updateHUD();
        else update(dt);
      }
      render();
    }
    if (tut) { tut.tick(dt); tut.draw(); }
    const btut = BTUT();
    if (btut) { btut.tick(dt); btut.draw(); }
    updateComboLabel();
    frameErrs = 0;
  } catch (err) {
    if (frameErrs++ < 5) {
      console.error('[frame]', err);
      CrashDiagnostics.record('frame-error', {
        message: String(err && err.message),
        stack: err && err.stack ? String(err.stack).slice(0, 800) : null,
      });
    }
    lastT = t;
  }
  gameLoopAnimationFrameId = requestAnimationFrame(frame);
}
function startGameLoop() {
  if (gameLoopRunning) return;
  gameLoopRunning = true;
  lastT = performance.now();   // never integrate the hidden time as one giant dt
  gameLoopAnimationFrameId = requestAnimationFrame(frame);
}
function stopGameLoop() {
  gameLoopRunning = false;
  if (gameLoopAnimationFrameId !== null) {
    cancelAnimationFrame(gameLoopAnimationFrameId);
    gameLoopAnimationFrameId = null;
  }
}

loadAssets();
initMilestoneArt();
StorePayments.init();
Ads.init();
/* Startup order for the ad gate, in the order the state must be trusted:
     1. the ad-free entitlement is already loaded (META, read above)
     2. so is any pending interstitial requirement
     3. an ad-free player can never owe one — drop anything stale
     4. otherwise the debt stands, and gateEnterGameplay collects it at the
        next safe transition (starting a run), never mid-combat.
   Nothing here shows an ad: a requirement restored from the save must wait for
   the player to ask to play, not ambush them on the menu. */
if (META.adFree) {
  adLog('ad-free-detected', { atBoot: true });
  clearPendingInterstitial('ad-free');
} else if (pendingInterstitial()) {
  const restored = pendingInterstitial();
  adSetState(AD_STATE.REQUIRED, { placement: restored.placement });
  adLog('requirement-restored', { placement: restored.placement, createdAt: restored.createdAt });
}
Ads.onStatusChange(onAdStatusChanged);
/* Purchases can land with no shop UI waiting for them: completed while the app
   was closed, a deferred payment that later cleared, or a fulfillment that was
   interrupted and is being replayed by the native startup sweep. They go
   through the SAME grantPurchaseReward path as a foreground purchase, which
   dedupes on the store transaction id — so a replayed purchase can never pay
   out twice. */
if (window.CastleFlingNative && window.CastleFlingNative.setPurchaseHandler) {
  window.CastleFlingNative.setPurchaseHandler(payload => {
    if (grantPurchaseReward(payload)) uiDirty = true;
  });
}
newRun(0);            // ambient scene data for the menu backdrop
grantLevelRewards();  // legacy saves: pay out any level rewards already earned
openMenu();
startGameLoop();
/* `state` and the run now exist, so the landscape gate may pause and resume for
   real. Re-run it once here in case the app launched already in portrait. */
gateReady = true;
fitCanvas();

/* ------- boot-time diagnostics follow-ups ------- */
/* renderer recovery: MainActivity sets this flag after recreating a killed
   WebView renderer — surface a themed notice (never a stock AlertDialog) */
(function checkRendererRecovery() {
  let recovered = location.hash === '#renderer-recovered';
  try {
    if (!recovered && window.CastleFlingDiagnostics && window.CastleFlingDiagnostics.wasRendererRecovered) {
      recovered = window.CastleFlingDiagnostics.wasRendererRecovered();
    }
  } catch (e) {}
  if (!recovered) return;
  CrashDiagnostics.markRendererRecovered();
  CrashDiagnostics.record('webview-renderer-recovered');
  // themed one-button notice via the shared confirm modal
  const cancel = $('confirmCancel');
  cancel.style.display = 'none';
  gameConfirm('Castle Fling recovered from a display error. Your saved progress is safe.',
    { title: '🛡 All is well', okText: 'Continue' })
    .then(() => { cancel.style.display = ''; });
})();
/* if the last session died while visible, note it (details already preserved
   in the CRASH_KEY snapshot for the settings-screen diagnostic report) */
if (CrashDiagnostics.previousCrash && CrashDiagnostics.previousCrash.session &&
    CrashDiagnostics.previousCrash.session.closedCleanly === false) {
  CrashDiagnostics.record('previous-session-ended-unexpectedly', {
    lastScreen: CrashDiagnostics.previousCrash.session.lastScreen,
    lastWave: CrashDiagnostics.previousCrash.session.lastWave,
    lastAction: CrashDiagnostics.previousCrash.session.lastAction,
  });
}
/* coarse memory watermark (Chrome/WebView only) — one sample a minute while
   visible, never per frame; a steady climb across menu open/close cycles in
   the trail is the "memory leak" signature the task asks us to detect */
if (performance && performance.memory) {
  setInterval(() => {
    if (document.hidden) return;
    const m = performance.memory;
    CrashDiagnostics.record('memory-sample', {
      usedMB: Math.round(m.usedJSHeapSize / 1048576),
      totalMB: Math.round(m.totalJSHeapSize / 1048576),
    });
  }, 60000);
}

/* ------- publisher intro (Empty Helmet Games) -------
   Plays once over the menu on boot. Tap/click skips; any playback
   failure (missing file, autoplay refusal) dismisses immediately so
   the splash can never trap the player. */
(function playIntro() {
  const splash = $('introSplash'), vid = $('introVideo');
  if (!splash || !vid) return;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(failSafe);
    splash.style.opacity = '0';
    setTimeout(() => splash.remove(), 500);
  };
  let failSafe = setTimeout(finish, 12000);
  vid.addEventListener('loadedmetadata', () => {
    // re-arm the failsafe to the real runtime once known
    clearTimeout(failSafe);
    if (!done) failSafe = setTimeout(finish, (vid.duration + 2) * 1000);
  });
  vid.addEventListener('ended', finish);
  vid.addEventListener('error', finish);
  splash.addEventListener('pointerdown', finish);
  vid.play().catch(() => {
    // strict autoplay policy: retry muted, and bail out if even that fails
    vid.muted = true;
    vid.play().catch(finish);
  });
})();

/* ------- dev-only test hook (never active in production builds) -------
   Exposes just enough internals for localhost verification: spawning
   specific enemies, damaging the castle to a given stage, and reading
   run state. Mirrors the ricochet _test API workflow. */
if (!(window.BUILD_CONFIG && BUILD_CONFIG.isProduction)) {
  window.CF_TEST = {
    get G() { return G; },
    get state() { return state; },
    get META() { return META; },
    get P() { return P; },
    ENEMIES, ROOMS, ECONOMY,
    effWeight, runCrownsLive,
    startTestRun(castleIdx = 0) { newRun(castleIdx); startWave(1); },
    spawn(type, x, gy) {
      const e = makeEnemy(type, G.wave || 1);
      if (x !== undefined) { e.x = x; }
      if (gy !== undefined) { e.gy = gy; e.y = gy; }
      G.enemies.push(e);
      return e.id;
    },
    clearQueue() { G.spawnQueue.length = 0; },
    setCastleHp(hp) { G.castleHp = clamp(hp, 0, G.castleMax); },
    enemyById(id) { return G.enemies.find(e => e.id === id) || null; },
    /* synchronous sim step + render: verification never depends on rAF
       firing (a hidden preview pane pauses rAF and freezes the loop) */
    step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) { if (state === 'playing') update(dt); } },
    draw() { render(); },
    /* one whole frame INCLUDING the tutorial's tick + draw — the tutorial's
       canvas hit-boxes only exist once it has painted, so gating checks need
       this rather than step() alone */
    frame(dt = 1 / 60, n = 1) {
      for (let i = 0; i < n; i++) {
        const tut = TUT();
        if (state === 'playing') {
          if (tut && tut.holdsGameplay()) updateHUD();
          else update(dt);
        }
        render();
        if (tut) { tut.tick(dt); tut.draw(); }
      }
    },
    /* screen/flow entry points for UI verification */
    gameOver, showBuildScreen, openMilestones, openHowTo, openCastleSelect, openMenu, damageCastle,
    openLevelRewards, openMeta, renderBuild, updateScrollHint,
    /* Kingdom Restoration passives: the derived snapshot plus every consumer,
       so a verification pass can read the exact numbers combat and the price
       lines use rather than inferring them from rendered text */
    kingdomBonus, krPrice, scaleCoinReward,
    archerDmg, throwPowerMult, mageDamageMult, allyDamageMult,
    snapshotRun, continueSavedRun, newRun,
    /* combat entry points: a verification pass can act as the player (fling
       damage, kills) without synthesising pointer gestures — used to play the
       Daily Siege end to end at a chosen skill level */
    damageEnemy, killEnemy,
    /* milestone economy verification: seed lifetime stats / claimed tiers,
       then drive the real claim path and read the real ledger */
    MILESTONE_CATS, MILESTONE_REWARD_VERSION, milestoneTxId, claimMilestone, milestoneClaimable,
    activeMilestoneTier, saveMeta,
  };
}
