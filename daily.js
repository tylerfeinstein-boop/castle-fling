/* ============================================================
   CASTLE FLING — DAILY SYSTEMS
   Royal Decrees · Daily Siege · Kingdom Restoration backbone

   Loaded AFTER game.js (shares its script-global environment the
   same way ricochet.js does: META, saveMeta, showScreen, state,
   G, ROOMS, ENEMIES, gameConfirm, Sfx, …).

   Design contract (mirrors the rest of the codebase):
   - NO ?. / ?? anywhere — ES2020 syntax is a parse error on
     un-updated Android 7-era WebViews and blanks the whole game.
   - All persistent state lives in META.daily / META.kingdom and
     rides the existing save pipeline (localStorage + native
     mirror). Loading never resets any pre-existing META field.
   - Daily content is generated ONCE per accepted calendar day,
     persisted whole (including the full siege spawn sequence),
     and never regenerated on restart / screen change / resume.
   - Every reward grant flows through a transaction ledger keyed
     by (dayKey | source | detail); the tx record, the grant and
     the claimed flag land in ONE saveMeta() JSON write, so a
     crash can never double-grant or lose a claimed reward.
   ============================================================ */
const CastleDaily = (() => {
  'use strict';

  const GEN_VERSION = 2;                 // bump to reshuffle future days
  const HISTORY_DAYS = 60;               // generation history kept for anti-repetition

  /* ---- Royal Seal reward config (THE one place these numbers live) ----
     Every grant call AND every line of player-facing reward text (board,
     siege result, How to Play) reads from here, so the guide can never
     drift from what the game actually pays out. Values unchanged from the
     numbers that were previously written inline. */
  const SEAL_REWARDS = {
    perDecree: 1,          // one claimed Royal Decree
    fullSetBonus: 2,       // all three Decrees claimed
    perSiegeTier: 1,       // each Daily Siege tier step (Bronze/Silver/Gold)
    siegeTiers: 3,         // Bronze, Silver, Gold
  };
  /* daily decree slots: one core, one tactical, one variety — never 3 of a kind */
  const DECREE_SLOTS = ['core', 'tac', 'variety'];
  /* Bronze is awarded for holding this fraction of the siege line */
  const SIEGE_BRONZE_FRAC = 0.7;
  const decreeMaxSeals = () =>
    DECREE_SLOTS.length * SEAL_REWARDS.perDecree + SEAL_REWARDS.fullSetBonus;
  const siegeMaxSeals = () => SEAL_REWARDS.siegeTiers * SEAL_REWARDS.perSiegeTier;
  const SEAL_ICON_SRC = 'assets/kingdom-restoration/system-icons/icon_royal_seal.png';
  const sealIco = (cls) => `<img class="${cls || 'curIco'}" src="${SEAL_ICON_SRC}" alt="Royal Seals" draggable="false">`;
  const STAR_SRC = 'assets/ui/rewards/reward_star_gold_64.png';
  const starImg = (cls) => `<img class="${cls || 'curIco'}" src="${STAR_SRC}" alt="star" draggable="false">`;
  const ENEMY_ART = (file) => 'assets/castle-fling-fix-pack-v2/sprites/enemies/' + file;

  /* running outside the game (QA harness): pure generation still works,
     everything DOM/game-flow related is skipped */
  const HAS_DOM = typeof document !== 'undefined' && typeof document.getElementById === 'function'
    && document.getElementById('dailyScreen') !== null;

  const diag = (ev, data) => { try { if (typeof CrashDiagnostics !== 'undefined') CrashDiagnostics.record(ev, data); } catch (e) {} };
  const isProd = () => !!(typeof window !== 'undefined' && window.BUILD_CONFIG && window.BUILD_CONFIG.isProduction);

  /* ============================================================
     DETERMINISTIC RNG
     ============================================================ */
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
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
  const rpick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  const rint = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
  function weightedPick(rng, items, weightOf) {
    let total = 0;
    for (const it of items) total += Math.max(0, weightOf(it));
    if (total <= 0) return items.length ? items[Math.floor(rng() * items.length)] : null;
    let r = rng() * total;
    for (const it of items) { r -= Math.max(0, weightOf(it)); if (r <= 0) return it; }
    return items[items.length - 1];
  }

  /* ============================================================
     DAILY KEY — one stable key per calendar day
     Acceptance only ever moves FORWARD: a device clock rolled
     backward (or a westward timezone hop) keeps the current day
     active instead of re-rolling content or re-opening rewards.
     ============================================================ */
  function localDayKey(now) {
    const d = now !== undefined ? new Date(now) : new Date();
    const mm = String(d.getMonth() + 1);
    const dd = String(d.getDate());
    return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }
  function msUntilLocalMidnight() {
    const d = new Date();
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
    return Math.max(0, next.getTime() - d.getTime());
  }
  function fmtCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = n => (n < 10 ? '0' : '') + n;
    return p(h) + ':' + p(m) + ':' + p(sec);
  }

  /* ============================================================
     KINGDOM RESTORATION — persistent progression mode
     Royal Seals (from Decrees + Daily Siege) are BANKED into one
     shared spendable balance. The player opens the Kingdom Map,
     picks an unlocked district, makes it the active project, and
     contributes 1 / 5 / Max Seals. Each district restores through
     five visual stages (0/25/50/75/100%); checkpoints award
     permanent Prosperity Stars which unlock further districts and
     kingdom-wide milestone rewards.
     ============================================================ */
  const KR_BASE = 'assets/kingdom-restoration/';
  const KR_V = '?kv=1';                  // bump on any kingdom PNG change
  const krSrc = p => KR_BASE + p + KR_V;
  const KR_SCHEMA = 2;                   // META.kingdom schema version

  const KR_STAGES = [
    { pct: 0,   key: 'ruined',      file: '00_ruined',       label: 'Ruined' },
    { pct: 25,  key: 'cleared',     file: '25_cleared',      label: 'Cleared' },
    { pct: 50,  key: 'rebuilt',     file: '50_rebuilt',      label: 'Rebuilt' },
    { pct: 75,  key: 'improved',    file: '75_improved',     label: 'Improved' },
    { pct: 100, key: 'flourishing', file: '100_flourishing', label: 'Flourishing' },
  ];
  /* checkpoint rewards are config: pct reached -> permanent Prosperity Stars */
  const KR_CHECKPOINTS = [
    { pct: 25, stars: 1 }, { pct: 50, stars: 1 }, { pct: 75, stars: 2 }, { pct: 100, stars: 3 },
  ];
  const KR_DISTRICT_STARS = KR_CHECKPOINTS.reduce((a, c) => a + c.stars, 0);   // 7 per district

  /* ---- Crown reward for restoring the ENTIRE kingdom ----
     The one remaining Crown payout in Kingdom Restoration. The per-district
     completion Crowns that used to sit beside it were replaced in 2026-08 by
     the permanent district passives below (see KR_PASSIVES): a district
     milestone no longer mints coins or Crowns at all. Crowns already granted
     under the old rule stay granted — the ledger is never rewritten. */
  const KR_REWARDS = {
    kingdomCompletionCrowns: 1000,    // once, when every required district is Flourishing
  };
  /* stable, permanent transaction ids — see krGrantCrowns() */
  const KR_TX_PREFIX = 'kingdom_restoration:';
  const KR_TX_KINGDOM = KR_TX_PREFIX + 'entire_kingdom:completion_crowns';

  /* ============================================================
     PERMANENT DISTRICT PASSIVES
     Every district pays ONE stack of its own passive at each of its four
     restoration checkpoints (25 / 50 / 75 / 100%), and the four stacks add
     up — a fully restored district is four stacks. These REPLACE the coin
     and Crown payouts those milestones used to make. The Prosperity Stars
     each checkpoint awards are untouched: Stars are the unlock currency the
     kingdom map runs on, not a reward wallet.

     Nothing here is ever ADDED to a stored number. The save records which
     checkpoints a district has reached — ds.checkpoints, which it always
     did — and every passive is DERIVED from that count on demand. A reload,
     a re-opened popup, a replayed reconcile pass or a save written before
     this system existed therefore cannot stack a bonus twice, and existing
     players need no migration at all: their saved checkpoints already say
     exactly how many stacks they own.

     `per` is ONE stack. `kind` is how game.js consumes the total:
       'flat'  value is added outright                (+25 max castle HP)
       'pct'   value is a fraction added to 1         (+0.025 -> ×1.025)
       'disc'  value is a fraction taken off a price  (0.025 -> 2.5% off)
     `stat` is the field name in the kingdomBonuses() snapshot.
     ============================================================ */
  const KR_PASSIVES = {
    outer_walls:       { stat: 'castleHp',         kind: 'flat', per: 25,    label: 'Maximum Castle HP' },
    royal_keep:        { stat: 'treasuryDiscount', kind: 'disc', per: 0.025, label: 'Royal Treasury prices' },
    barracks:          { stat: 'archerDamage',     kind: 'pct',  per: 0.025, label: 'Archer Tower damage' },
    adventurers_guild: { stat: 'allyDamage',       kind: 'pct',  per: 0.025, label: 'allied unit damage' },
    market_square:     { stat: 'roomDiscount',     kind: 'disc', per: 0.025, label: 'Castle Room prices' },
    blacksmith_quarter:{ stat: 'throwDamage',      kind: 'pct',  per: 0.025, label: 'throwing damage' },
    mage_district:     { stat: 'mageDamage',       kind: 'pct',  per: 0.0125, label: 'mage damage' },
    festival_grounds:  { stat: 'coinGain',         kind: 'pct',  per: 0.0125, label: 'coins earned' },
  };
  /* multipliers start at 1, additive/discount fields at 0 */
  const KR_BONUS_BASE = { castleHp: 0, treasuryDiscount: 0, roomDiscount: 0,
    archerDamage: 1, allyDamage: 1, throwDamage: 1, mageDamage: 1, coinGain: 1 };

  /* "2.5", "10", "1.25" — never "2.50" and never "10.0" */
  const krPctText = frac => {
    const n = Math.round(frac * 10000) / 100;
    return (Math.round(n * 100) / 100).toString();
  };
  /* ONE formatter for every line of passive text the game prints, so the
     popup, the district card and How to Play can never disagree. */
  function krPassiveText(id, stacks) {
    const p = KR_PASSIVES[id];
    if (!p || stacks <= 0) return '';
    if (p.kind === 'flat') return '+' + (p.per * stacks) + ' ' + p.label;
    if (p.kind === 'disc') return krPctText(p.per * stacks) + '% discount on ' + p.label;
    return '+' + krPctText(p.per * stacks) + '% ' + p.label;
  }

  /* the eight districts: cost = total Seals to fully restore (divisible by 4
     so every 25% checkpoint lands on a whole Seal), unlock = Prosperity Stars
     required, map = [left%, top%] ground anchor (base-center of the stage art)
     on the kingdom map, w = stage-art width as % of the map width.
     `requiredForKingdomCompletion` = part of the original Kingdom Restoration
     campaign, i.e. it must be Flourishing before the full-kingdom Crown reward
     pays out. A future expansion region added WITHOUT this flag can still earn
     its own district Crowns, but it can never hold the kingdom reward hostage. */
  const KR_DISTRICTS = [
    { id: 'royal_keep', name: 'Royal Keep', folder: 'royal-keep', prefix: 'royal_keep',
      cost: 24, unlock: 0, map: [27, 56], w: 15, requiredForKingdomCompletion: true,
      desc: 'The heart of the realm. Restore the throne, and the kingdom follows.' },
    { id: 'outer_walls', name: 'Outer Walls', folder: 'outer-walls', prefix: 'outer_walls',
      cost: 32, unlock: 2, map: [10, 64], w: 16, requiredForKingdomCompletion: true,
      desc: 'Shattered ramparts that once guarded every road into the vale.' },
    { id: 'barracks', name: 'Barracks', folder: 'barracks', prefix: 'barracks',
      cost: 40, unlock: 5, map: [38, 25], w: 13, requiredForKingdomCompletion: true,
      desc: 'Empty bunks and broken racks await the muster of new defenders.' },
    { id: 'blacksmith_quarter', name: 'Blacksmith Quarter', folder: 'blacksmith-quarter', prefix: 'blacksmith_quarter',
      cost: 48, unlock: 9, map: [50, 40], w: 13, lblAnchor: 'top', requiredForKingdomCompletion: true,
      desc: 'Cold forges and silent anvils — the kingdom’s arms are made here.' },
    { id: 'market_square', name: 'Market Square', folder: 'market-square', prefix: 'market_square',
      cost: 56, unlock: 14, map: [65, 49], w: 13, requiredForKingdomCompletion: true,
      desc: 'Toppled stalls and bare shelves where trade once thrived.' },
    { id: 'mage_district', name: 'Mage District', folder: 'mage-district', prefix: 'mage_district',
      cost: 64, unlock: 20, map: [79, 26], w: 13, requiredForKingdomCompletion: true,
      desc: 'Cracked spires still humming with old enchantments.' },
    { id: 'adventurers_guild', name: 'Adventurers’ Guild', folder: 'adventurers-guild', prefix: 'adventurers_guild',
      cost: 72, unlock: 27, map: [47, 71], w: 13, requiredForKingdomCompletion: true,
      desc: 'The guild hall’s hearth has gone dark; heroes need a home.' },
    { id: 'festival_grounds', name: 'Festival Grounds', folder: 'festival-grounds', prefix: 'festival_grounds',
      cost: 80, unlock: 35, map: [76, 73], w: 13, requiredForKingdomCompletion: true,
      desc: 'A field of faded banners waiting for music to return.' },
  ];
  /* the districts the full-kingdom reward waits on (`requiredForKingdomCompletion`) */
  const krRequiredDistricts = () => KR_DISTRICTS.filter(d => d.requiredForKingdomCompletion === true);
  const KR_TOTAL_STARS = KR_DISTRICTS.length * KR_DISTRICT_STARS;   // 56

  /* kingdom-wide Prosperity milestones; `layer` reveals a map overlay */
  const KR_MILESTONES = [
    { stars: 2,  name: 'Roads & Bridges',    desc: 'Roads and bridges are rebuilt across the realm.', reward: { coins: 200 }, layer: 'roads' },
    { stars: 7,  name: 'Banner of Hope',     desc: 'The first new banner flies over the kingdom.',    reward: { crowns: 15 } },
    { stars: 14, name: 'Gardens Bloom',      desc: 'Gardens and orchards flourish once more.',        reward: { coins: 750 }, layer: 'foliage' },
    { stars: 21, name: 'Festival of Lights', desc: 'Lanterns glow in every rebuilt street.',          reward: { crowns: 30 }, layer: 'lighting' },
    { stars: 30, name: 'Royal Charter',      desc: 'The realm is granted its charter anew.',          reward: { coins: 2000 } },
    { stars: 42, name: 'Golden Age',         desc: 'A golden age dawns over the restored realm.',     reward: { crowns: 60 } },
    { stars: 56, name: 'Eternal Kingdom',    desc: 'Every stone stands. The kingdom is whole.',       reward: { crowns: 100 } },
  ];

  const KR_ICON = {
    seal:     'system-icons/icon_royal_seal.png',
    star:     'system-icons/icon_prosperity_star.png',
    hammer:   'system-icons/icon_construction_hammer.png',
    locked:   'system-icons/icon_locked_district.png',
    complete: 'system-icons/icon_restoration_complete.png',
    project:  'system-icons/icon_daily_project.png',
    marker:   'map-markers/icon_district_marker.png',
    worker:   'map-markers/icon_worker_marker.png',
    pipOn:    'progress-icons/icon_progress_pip_filled.png',
    pipOff:   'progress-icons/icon_progress_pip_empty.png',
    scroll:   'story-events/icon_story_event_scroll.png',
  };
  /* ---- restoration completion medallions ----
     THE one place a milestone percentage is turned into artwork. All four are
     the same badge with a different numeral, cut from one shared square crop
     (scripts/build-kr-completion-icons.js), so they share a disc diameter and
     a centre and sit identically in the popup's square icon slot. They are
     square and drawn with object-fit: contain — never stretched to a slot. */
  const KR_MEDALLION = {
    25: 'progress-icons/icon_completion_25.png',
    50: 'progress-icons/icon_completion_50.png',
    75: 'progress-icons/icon_completion_75.png',
    100: 'progress-icons/icon_completion_100.png',
  };
  /* the badge for a milestone percentage; anything off-grid falls back to the
     nearest lower badge so a future checkpoint table can never render blank */
  function krMedallion(pct) {
    let pick = KR_MEDALLION[25];
    for (const p of [25, 50, 75, 100]) if (pct >= p) pick = KR_MEDALLION[p];
    return pick;
  }
  const KR_UI = {
    bar:    'ui/ui_project_progress_bar.png',
    meter:  'ui/ui_prosperity_meter.png',
    card:   'ui/ui_district_project_card.png',
    select: 'ui/ui_select_project_button.png',
    claim:  'ui/ui_claim_reward_button.png',
  };
  const KR_MAP_LAYERS = {
    base:    'kingdom-map/kingdom_map_base_ground.png',
    water:   'kingdom-map/kingdom_map_water_and_shoreline.png',
    roads:   'kingdom-map/kingdom_map_roads_bridges.png',
    foliage: 'kingdom-map/kingdom_map_foliage_overlay.png',
    lighting:'kingdom-map/kingdom_map_lighting_overlay.png',
    ruins:   'kingdom-map/kingdom_map_ruins_and_debris.png',
  };
  const pstarImg = (cls) => `<img class="${cls || 'curIco'}" src="${krSrc(KR_ICON.star)}" alt="Prosperity Star" draggable="false">`;
  /* the shared Crown sprite from game.js — reused, never re-declared, so the
     restoration rewards show the exact icon the Crown Shop and HUD show */
  const krCrownIco = (cls) => (typeof crownIco === 'function') ? crownIco(cls || 'curIco') : '';

  const krDef = id => KR_DISTRICTS.find(d => d.id === id) || null;
  const krNum = v => (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
  function krStageFor(pct) {
    let s = KR_STAGES[0];
    for (const st of KR_STAGES) if (pct >= st.pct) s = st;
    return s;
  }
  const krStageArt = (def, pct) =>
    krSrc('district-stages/' + def.folder + '/' + def.prefix + '_stage_' + krStageFor(pct).file + '.png');
  /* krPct is the STAGE percentage: floored, because it selects the stage art
     and the "Ruined · 9%" label. It must never drive a bar width — flooring
     6/64 to 9 and then to a whole pixel is how a real 9.375% fill vanishes. */
  const krPct = (def, ds) => Math.min(100, Math.floor(ds.contributed / def.cost * 100));

  /* ---- one progress calculation for every restoration meter ----
     Full decimal precision, clamped to 0..1, safe against a zero or missing
     denominator. The label may round; the fill width never does. */
  function krProgressRatio(current, maximum) {
    const cur = Number(current) || 0;
    const max = Number(maximum) || 0;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(1, cur / max));
  }
  const krProgressPercent = (current, maximum) => krProgressRatio(current, maximum) * 100;

  /* Divider ticks measured off ui_prosperity_meter.png (336×98): the sprite's
     inner well spans x 91..313, and these are its seven cells' boundaries as a
     percentage of that well. Redrawn over the fill so the frame's segmented
     look survives being filled — the sprite itself is untouched. */
  const KR_METER_SEGS = [15.70, 29.15, 43.27, 56.95, 70.85, 84.75];

  /* Each meter remembers the percentage it last painted, so a re-render
     animates from the value the player actually saw instead of replaying
     from empty. Keyed per meter, so switching districts never animates one
     district's progress into another's. */
  const krMeterLast = Object.create(null);

  /* THE single place a restoration meter's fill + accessibility state is set.
     `current`/`maximum` are the very numbers the meter's label prints, so the
     text, the stage percentage and the fill width can never disagree. */
  function krPaintMeter(root, key, current, maximum, valueText) {
    if (!root) return;
    const cur = Number(current) || 0;
    const max = Number(maximum) || 0;
    const pct = krProgressPercent(cur, max);
    root.setAttribute('role', 'progressbar');
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', String(max));
    root.setAttribute('aria-valuenow', String(cur));
    root.setAttribute('aria-valuetext', valueText);
    const fill = root.querySelector('.krFill');
    if (!fill) return;
    /* Re-rendering the panel replaces this element, so its transition would
       otherwise start from the stylesheet's empty width and replay from zero.
       Commit the previous REAL value first with transitions suppressed, flush,
       restore the transition, flush again — only then write the new value. The
       bar therefore animates from where the player last saw it, and if frames
       are not being composited at all it sits at the last true value rather
       than at zero. First paint (screen opened, save loaded, district picked)
       seeds at the current value, so it initialises without any replay. */
    const prev = krMeterLast[key];
    const seed = prev == null ? pct : prev;
    fill.style.transition = 'none';
    fill.style.width = seed + '%';
    void fill.offsetWidth;
    fill.style.transition = '';
    void fill.offsetWidth;
    /* always write the truth, even when it equals the seed */
    fill.style.width = pct + '%';
    krMeterLast[key] = pct;
  }

  /* focused meter updaters — always read the latest canonical state, never a
     value captured before the contribution was applied */
  function updateKingdomProsperityMeter() {
    if (!HAS_DOM) return;
    const k = ensureKingdom();
    const root = document.querySelector('#kingdomPanel .krMeter');
    krPaintMeter(root, 'prosperity', k.stars, KR_TOTAL_STARS,
      k.stars + ' of ' + KR_TOTAL_STARS + ' Kingdom Prosperity Stars');
  }
  function updateDistrictRestorationMeter(id) {
    if (!HAS_DOM) return;
    const k = ensureKingdom();
    const def = krDef(id);
    if (!def) return;
    const ds = k.districts[def.id];
    if (!ds) return;
    const root = document.querySelector('#kingdomPanel .krBar');
    krPaintMeter(root, 'district:' + def.id, ds.contributed, def.cost,
      ds.contributed + ' of ' + def.cost + ' Royal Seals contributed');
  }

  function ensureKingdom() {
    if (!META.kingdom || typeof META.kingdom !== 'object') META.kingdom = {};
    let k = META.kingdom;
    if (k.v !== KR_SCHEMA) {
      /* ---- migration from the pre-rebuild placeholder save ----
         The old model auto-spent seals into six fake projects. We keep the
         spendable balance, lifetime total and earned Prosperity Stars, and
         snapshot everything else under legacyPlaceholder so no player data
         is ever erased. Old projects are NOT mapped onto the new districts.
         Milestones at or below the migrated star count are marked claimed
         WITHOUT granting, because the placeholder already paid its own
         improvement rewards for those stars. */
      const hadOld = (typeof k.seals === 'number') || k.projects;
      const legacy = hadOld ? {
        seals: krNum(k.seals), totalSeals: krNum(k.totalSeals), stars: krNum(k.stars),
        projects: k.projects || {}, activeProject: k.activeProject || null,
        improvementsClaimed: k.improvementsClaimed || {},
      } : null;
      k = META.kingdom = {
        v: KR_SCHEMA,
        seals: legacy ? legacy.seals : 0,
        totalSeals: legacy ? legacy.totalSeals : 0,
        stars: legacy ? legacy.stars : 0,
        migratedStars: legacy ? legacy.stars : 0,
        districts: {}, activeDistrict: null,
        milestonesClaimed: {}, newUnlocks: {},
        tx: {},
        legacyPlaceholder: legacy,
      };
      if (legacy) {
        for (const m of KR_MILESTONES) if (k.stars >= m.stars) k.milestonesClaimed['m' + m.stars] = true;
        diag('kingdom-migrated', { seals: k.seals, stars: k.stars });
      }
    }
    if (typeof k.seals !== 'number' || !isFinite(k.seals) || k.seals < 0) k.seals = krNum(k.seals);
    if (typeof k.totalSeals !== 'number' || !isFinite(k.totalSeals)) k.totalSeals = krNum(k.totalSeals);
    if (typeof k.stars !== 'number' || !isFinite(k.stars)) k.stars = krNum(k.stars);
    if (typeof k.migratedStars !== 'number' || !isFinite(k.migratedStars)) k.migratedStars = 0;
    if (!k.districts || typeof k.districts !== 'object') k.districts = {};
    for (const d of KR_DISTRICTS) {
      if (!k.districts[d.id] || typeof k.districts[d.id] !== 'object') k.districts[d.id] = { contributed: 0, complete: false, checkpoints: {} };
      const ds = k.districts[d.id];
      if (typeof ds.contributed !== 'number' || !isFinite(ds.contributed)) ds.contributed = 0;
      if (!ds.checkpoints || typeof ds.checkpoints !== 'object') ds.checkpoints = {};
    }
    if (!k.milestonesClaimed || typeof k.milestonesClaimed !== 'object') k.milestonesClaimed = {};
    if (!k.newUnlocks || typeof k.newUnlocks !== 'object') k.newUnlocks = {};
    /* PERMANENT reward ledger — additive field, so a v2 save written before
       the Crown rewards existed simply gains an empty one on next load (no
       schema bump, nothing else in the save is touched). Unlike META.daily.tx
       this is NEVER pruned: a restoration reward is a one-time lifetime
       entitlement, not a daily claim. */
    if (!k.tx || typeof k.tx !== 'object') k.tx = {};
    if (k.pendingRewardSummary && typeof k.pendingRewardSummary !== 'object') delete k.pendingRewardSummary;
    /* the active project must exist, be unlocked and not complete; otherwise
       there simply is no active project — the player picks one on the map */
    if (k.activeDistrict) {
      const def = krDef(k.activeDistrict);
      const ds = def ? k.districts[def.id] : null;
      if (!def || !ds || ds.complete || k.stars < def.unlock) k.activeDistrict = null;
    }
    return k;
  }

  const krUnlocked = (def, k) => k.stars >= def.unlock;
  function krNextCheckpoint(ds) {
    for (const cp of KR_CHECKPOINTS) if (!ds.checkpoints[cp.pct]) return cp;
    return null;
  }
  const krCpSeals = (def, cp) => Math.ceil(def.cost * cp.pct / 100);

  /* ---- restoration Crown rewards ----
     THE canonical completion test. `ds.complete` is the saved flag the 100%
     checkpoint sets, so a reward can never be inferred from displayed artwork,
     the selected district, a progress label or an animation still playing. */
  const krDistrictComplete = (k, id) => {
    const ds = k.districts[id];
    return !!(ds && ds.complete);
  };
  /* every required district Flourishing = the campaign is finished */
  function krKingdomComplete(k) {
    const req = krRequiredDistricts();
    if (!req.length) return false;
    for (const d of req) if (!krDistrictComplete(k, d.id)) return false;
    return true;
  }

  /* ONE gate for every restoration Crown grant. The ledger check, the ledger
     write and the balance change happen together and synchronously, so a
     replayed call — rapid taps, a re-render, a reopened screen, a reconcile
     pass — can only ever return false. Crowns land in the SAME META.crowns the
     Crown Shop, Save Run and Milestones use; there is no second wallet. The
     caller owns the saveMeta() that persists ledger + balance in one write. */
  function krGrantCrowns(txId, amount, source) {
    const k = ensureKingdom();
    if (!k.tx || typeof k.tx !== 'object') k.tx = {};
    if (k.tx[txId]) return false;                            // already entitled — never twice
    if (!(amount > 0)) return false;
    k.tx[txId] = { amount: amount, source: source, at: Date.now() };
    META.crowns += amount;
    diag('kingdom-crown-grant', { tx: txId, amount: amount, source: source });
    return true;
  }

  function krAwardKingdomCrowns(k, notices, source) {
    if (!krKingdomComplete(k)) return 0;
    if (!krGrantCrowns(KR_TX_KINGDOM, KR_REWARDS.kingdomCompletionCrowns, source)) return 0;
    if (notices) notices.push({ kind: 'kingdomCrowns', crowns: KR_REWARDS.kingdomCompletionCrowns });
    return KR_REWARDS.kingdomCompletionCrowns;
  }

  /* ---- one-time reconciliation for saves that predate the kingdom reward ----
     A player who finished the campaign before the reward existed must not be
     punished for finishing early. This ONLY reads saved completion flags and
     writes the missing ledger entry: no district stage moves, no checkpoint
     replays, no Seal is asked for again, and an incomplete kingdom is never
     touched. It is idempotent — the ledger makes every repeat run a no-op —
     but it must be driven by boot / screen entry, NEVER by a render loop.

     The DISTRICT passives need no counterpart here. They are derived from the
     saved checkpoints every time they are read (see kingdomBonuses), so a
     player who restored districts before the passives existed already owns
     the matching stacks the moment this build boots — nothing is granted,
     nothing is written, and nothing can be granted twice. The old per-district
     completion Crowns are deliberately NOT backfilled any more: that reward
     no longer exists, and Crowns already paid under it stay paid. */
  function krReconcileRewards() {
    const k = ensureKingdom();
    const kingdomCrowns = krAwardKingdomCrowns(k, null, 'kingdom-complete-backfill');
    if (kingdomCrowns > 0) {
      /* the Crowns are already in the balance — this only remembers that the
         player is owed the explanation, so the summary survives being closed
         before the Kingdom screen was ever opened */
      k.pendingRewardSummary = { kingdomCrowns: kingdomCrowns, total: kingdomCrowns };
      saveMeta();
      diag('kingdom-reward-backfill', { crowns: kingdomCrowns });
    }
    return { kingdomCrowns: kingdomCrowns, total: kingdomCrowns };
  }

  /* ============================================================
     DERIVED PASSIVE TOTALS
     ============================================================ */
  /* how many of this district's four checkpoints have been reached. Read from
     the saved checkpoint flags, with the contributed-Seal thresholds as a
     second opinion so a save whose flags were never written (an interrupted
     write, a hand-edited save, the legacy migration) still reports the truth
     its progress bar shows. Pure read — it never writes a flag, never grants
     a Star and never moves a stage. */
  function krPassiveStacks(k, def) {
    const ds = k.districts[def.id];
    if (!ds) return 0;
    if (ds.complete) return KR_CHECKPOINTS.length;
    let n = 0;
    for (const cp of KR_CHECKPOINTS) {
      if (ds.checkpoints[cp.pct] || ds.contributed >= krCpSeals(def, cp)) n++;
    }
    return n;
  }

  /* cheap change signature: the districts object identity (the Board tutorial
     swaps a deep copy in and the real object back out) plus every district's
     contribution and completion. Any restoration progress at all changes it. */
  function krStateSig(k) {
    let s = 0;
    for (let i = 0; i < KR_DISTRICTS.length; i++) {
      const ds = k.districts[KR_DISTRICTS[i].id];
      s = (s * 131 + (ds ? (ds.contributed | 0) * 2 + (ds.complete ? 1 : 0) : 0)) | 0;
    }
    return s;
  }
  let krBonusCache = null, krBonusRef = null, krBonusSig = -1;

  /* THE snapshot every core-game system reads. Recomputed only when the
     kingdom actually changed, so it is safe to call from a damage path or a
     price line. Never mutates anything: no META write, no ledger, no save. */
  function kingdomBonuses() {
    const k = ensureKingdom();
    const sig = krStateSig(k);
    if (krBonusCache && krBonusRef === k.districts && krBonusSig === sig) return krBonusCache;
    const b = {};
    for (const key in KR_BONUS_BASE) b[key] = KR_BONUS_BASE[key];
    b.stacks = {};
    for (const def of KR_DISTRICTS) {
      const p = KR_PASSIVES[def.id];
      if (!p) continue;
      const n = krPassiveStacks(k, def);
      b.stacks[def.id] = n;
      if (n > 0) b[p.stat] += p.per * n;
    }
    krBonusCache = b; krBonusRef = k.districts; krBonusSig = sig;
    return b;
  }

  /* how many Seals a single contribution may move right now: capped by the
     bank AND by the next checkpoint boundary of the active district */
  function krMaxContribution() {
    const k = ensureKingdom();
    if (!k.activeDistrict) return 0;
    const def = krDef(k.activeDistrict);
    const ds = k.districts[def.id];
    if (ds.complete) return 0;
    const cp = krNextCheckpoint(ds);
    if (!cp) return 0;
    return Math.max(0, Math.min(k.seals, krCpSeals(def, cp) - ds.contributed));
  }

  /* spend banked Seals into the active district; returns notices for the UI.
     Partial contributions persist; checkpoint rewards fire exactly once via
     per-district checkpoint flags (never inferable from star totals). */
  function contributeSeals(n) {
    const k = ensureKingdom();
    const notices = [];
    if (!k.activeDistrict) return notices;
    const def = krDef(k.activeDistrict);
    const ds = k.districts[def.id];
    const put = Math.max(0, Math.min(krNum(n), krMaxContribution()));
    if (put <= 0) return notices;
    const starsBefore = k.stars;
    ds.contributed += put;
    k.seals -= put;
    const cp = krNextCheckpoint(ds);
    if (cp && ds.contributed >= krCpSeals(def, cp)) {
      ds.checkpoints[cp.pct] = true;
      k.stars += cp.stars;
      /* ONE checkpoint notice carries everything this milestone paid: the
         Prosperity Stars (unchanged) and the district's permanent passive.
         The passive figures are read back out of the DERIVED totals — the
         same numbers the game will apply — after the flag above was set, so
         the popup can never print a bonus the save does not actually hold.
         Nothing is granted here; there is no reward to grant, only a flag. */
      const stacks = krPassiveStacks(k, def);
      notices.push({
        kind: 'checkpoint', district: def.name, districtId: def.id,
        pct: cp.pct, stars: cp.stars, stage: krStageFor(cp.pct).label,
        gained: krPassiveText(def.id, 1), total: krPassiveText(def.id, stacks),
      });
      if (cp.pct >= 100) {
        ds.complete = true;
        k.activeDistrict = null;      // fully restored — the player picks the next focus
        notices.push({ kind: 'complete', district: def.name });
        /* the 100% checkpoint pays its Prosperity Stars and the district's
           fourth passive stack above — never coins, never Crowns. Only the
           whole-kingdom entitlement still pays Crowns, and only when this was
           the last required district. */
        krAwardKingdomCrowns(k, notices, 'kingdom-complete');
      }
    }
    if (k.stars !== starsBefore) {
      for (const m of KR_MILESTONES) {
        const key = 'm' + m.stars;
        if (k.stars >= m.stars && !k.milestonesClaimed[key]) {
          k.milestonesClaimed[key] = true;
          if (m.reward.coins && typeof addGold === 'function') addGold(m.reward.coins);
          if (m.reward.crowns) META.crowns += m.reward.crowns;
          notices.push({ kind: 'milestone', name: m.name, desc: m.desc, reward: m.reward });
        }
      }
      for (const d of KR_DISTRICTS) {
        if (d.unlock > 0 && starsBefore < d.unlock && k.stars >= d.unlock) {
          k.newUnlocks[d.id] = true;
          notices.push({ kind: 'unlock', district: d.name });
        }
      }
    }
    saveMeta();
    diag('kingdom-contribute', { district: def.id, put, seals: k.seals, stars: k.stars });
    syncSealDisplays();
    return notices;
  }

  /* ============================================================
     REWARD TRANSACTIONS — atomic, idempotent grants
     ============================================================ */
  function grantSeals(txId, amount, source) {
    const st = dailyState();
    if (!st.tx || typeof st.tx !== 'object') st.tx = {};
    if (st.tx[txId]) return null;                       // already granted — never twice
    st.tx[txId] = { amount, source, at: Date.now() };   // verify + create transaction
    const k = ensureKingdom();
    k.seals += amount;                                  // BANKED — never auto-spent
    k.totalSeals += amount;
    diag('daily-seal-grant', { tx: txId, amount, source });
    syncSealDisplays();
    return [];                                          // caller marks claimed + saveMeta()
  }

  /* ---- single seal-balance broadcast ----
     grantSeals and contributeSeals are the ONLY two mutation points for
     k.seals, and both end here: every currently mounted Royal Seal display
     repaints in the same interaction that changed the balance, so no screen
     ever needs a close/reopen to show the real number. Pure repaint — no
     state changes, no saves, no new listeners (the overlay re-render swaps
     innerHTML, which destroys old nodes and their handlers with them). */
  function syncSealDisplays() {
    if (!HAS_DOM) return;
    const k = ensureKingdom();
    // Adventurers' Board header counter (static element — cheap even when hidden)
    const bs = document.getElementById('boardSeals');
    if (bs) bs.textContent = (k.seals || 0).toLocaleString();
    // Board footer summary strip (spend badge + banked-seal line)
    if (state === 'daily') renderKingdomStrip();
    // Kingdom Restoration overlay: header pill, map "ready" markers,
    // contribution buttons and Max all derive from k.seals — full re-render
    const ov = document.getElementById('kingdomOverlay');
    if (ov && !ov.classList.contains('hidden')) renderKingdomOverlay();
  }

  /* ============================================================
     PLAYER PROFILE & DIFFICULTY BANDS
     ============================================================ */
  function playerProfile() {
    const bestWave = META.bestWave || 0;
    const level = (typeof playerLevelInfo === 'function') ? playerLevelInfo().level : 1;
    // recent decree completion adapts the band: struggling players step down
    const hist = dailyState().history || [];
    const recent = hist.slice(-7);
    let doneSum = 0, days = 0;
    for (const h of recent) { if (typeof h.done === 'number') { doneSum += h.done; days++; } }
    const completionRate = days > 0 ? doneSum / (days * 3) : 1;
    let bracket = bestWave >= 30 ? 'vet' : bestWave >= 15 ? 'adv' : bestWave >= 5 ? 'normal' : 'intro';
    if (completionRate < 0.4 && days >= 3) {
      const order = ['intro', 'normal', 'adv', 'vet'];
      bracket = order[Math.max(0, order.indexOf(bracket) - 1)];
    }
    return { bracket, bestWave, level, runs: META.runs || 0, completionRate, bestScore: META.bestScore || 0 };
  }

  /* ============================================================
     ROYAL DECREE TEMPLATES
     Categories: core (combat) · tac (tactical/mechanical) ·
     variety (modes & unusual play). Bands: [lo, hi, step].
     handlers map gameplay events to progress. maxMode templates
     track a best-value instead of accumulating.
     ============================================================ */
  const BANDS = { intro: 0, normal: 1, adv: 2, vet: 3 };
  function bandVal(tpl, bracket, rng) {
    const b = tpl.bands[bracket] || tpl.bands.normal;
    const lo = b[0], hi = b[1], step = b[2] || 1;
    const n = lo + Math.floor(rng() * ((hi - lo) / step + 1)) * step;
    return Math.min(hi, Math.max(lo, n));
  }
  const enemyName = t => (typeof ENEMIES !== 'undefined' && ENEMIES[t]) ? ENEMIES[t].name : t;

  function mkKillTpl(id, type, artFile, bands, minWave, weight) {
    return {
      id, cat: 'core', weight: weight || 1, enemy: type, mech: 'combat',
      icon: { src: ENEMY_ART(artFile), cls: 'decreeArt' },
      bands,
      text: n => `Defeat ${n} ${enemyName(type)}${n > 1 ? 's' : ''}`,
      valid: p => p.bestWave >= minWave,
      minutes: 8,
      handlers: { kill: d => (d.type === type ? 1 : 0) },
    };
  }

  const DECREE_TEMPLATES = [
    /* ---------------- CORE COMBAT ---------------- */
    { id: 'kill_any', cat: 'core', weight: 1.6, mech: 'combat',
      icon: { src: ENEMY_ART('enemy_soldier.png'), cls: 'decreeArt' },
      bands: { intro: [25, 50, 5], normal: [50, 100, 10], adv: [100, 175, 25], vet: [150, 250, 25] },
      text: n => `Defeat ${n} enemies`,
      valid: () => true, minutes: 12,
      handlers: { kill: () => 1 } },
    { id: 'reach_wave', cat: 'core', weight: 1.3, mech: 'combat', maxMode: true,
      icon: { file: 'icon_shield.png' },
      bands: { intro: [3, 5, 1], normal: [6, 10, 1], adv: [10, 15, 1], vet: [12, 20, 1] },
      text: n => `Reach wave ${n} in a single run`,
      valid: () => true, minutes: 12,
      handlers: { waveClear: d => d.wave },
      capTo: p => Math.max(3, Math.min(20, p.bestWave + 3)) },
    { id: 'clear_waves', cat: 'core', weight: 1.2, mech: 'combat',
      icon: { file: 'icon_upgrade.png' },
      bands: { intro: [3, 5, 1], normal: [5, 9, 1], adv: [8, 12, 1], vet: [10, 15, 1] },
      text: n => `Clear ${n} waves today`,
      valid: () => true, minutes: 14,
      handlers: { waveClear: () => 1 } },
    { id: 'kill_boss', cat: 'core', weight: 1, mech: 'combat', enemy: 'boss',
      icon: { src: ENEMY_ART('enemy_siege_captain.png'), cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 2, 1], vet: [1, 2, 1] },
      text: n => n > 1 ? `Defeat ${n} bosses` : 'Defeat a boss',
      valid: p => p.bestWave >= 8, minutes: 15,
      handlers: { kill: d => (d.boss ? 1 : 0) } },
    mkKillTpl('kill_soldiers', 'soldier', 'enemy_soldier.png',
      { intro: [10, 20, 5], normal: [20, 40, 5], adv: [35, 60, 5], vet: [45, 75, 5] }, 0, 1),
    mkKillTpl('kill_runners', 'runner', 'enemy_runner.png',
      { intro: [10, 20, 5], normal: [20, 40, 5], adv: [35, 60, 5], vet: [45, 75, 5] }, 0, 1),
    mkKillTpl('kill_shields', 'shield', 'enemy_shieldbearer.png',
      { intro: [4, 8, 2], normal: [8, 16, 2], adv: [14, 24, 2], vet: [18, 30, 2] }, 3, 0.9),
    mkKillTpl('kill_hammers', 'hammer', 'enemy_hammer_brute.png',
      { intro: [3, 6, 1], normal: [6, 12, 2], adv: [10, 18, 2], vet: [14, 24, 2] }, 4, 0.9),
    mkKillTpl('kill_bombers', 'bomber', 'enemy_bomb_carrier.png',
      { intro: [3, 6, 1], normal: [5, 10, 1], adv: [8, 15, 1], vet: [12, 20, 2] }, 5, 0.9),
    mkKillTpl('kill_knights', 'knight', 'enemy_heavy_knight.png',
      { intro: [2, 4, 1], normal: [3, 8, 1], adv: [6, 12, 2], vet: [10, 16, 2] }, 9, 0.9),
    { id: 'kill_elites', cat: 'core', weight: 0.8, mech: 'combat', enemy: 'elite',
      icon: { src: ENEMY_ART('enemy_heavy_knight.png'), cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [2, 3, 1], adv: [3, 5, 1], vet: [4, 8, 1] },
      text: n => `Defeat ${n} two-star Elite Guard${n > 1 ? 's' : ''}`,
      valid: p => p.bestWave >= 12, minutes: 15,
      handlers: { kill: d => (d.elite ? 1 : 0) } },
    { id: 'kill_siege_units', cat: 'core', weight: 0.7, mech: 'combat', enemy: 'siege',
      icon: { src: ENEMY_ART('enemy_bomb_cart.png'), cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 2, 1], vet: [1, 2, 1] },
      text: n => `Defeat ${n} siege ${n > 1 ? 'units' : 'unit'} (carts, rams or captains)`,
      valid: p => p.bestWave >= 10, minutes: 16,
      handlers: { kill: d => (d.siegeUnit ? 1 : 0) } },
    { id: 'kill_light', cat: 'core', weight: 1, mech: 'combat',
      icon: { src: ENEMY_ART('enemy_runner.png'), cls: 'decreeArt' },
      bands: { intro: [15, 30, 5], normal: [30, 60, 5], adv: [50, 90, 10], vet: [70, 120, 10] },
      text: n => `Defeat ${n} light foes (Runners, Soldiers & Climbers)`,
      valid: () => true, minutes: 10,
      handlers: { kill: d => (d.type === 'runner' || d.type === 'soldier' || d.type === 'climber' ? 1 : 0) } },
    { id: 'kill_armored', cat: 'core', weight: 1, mech: 'combat',
      icon: { src: ENEMY_ART('enemy_shieldbearer.png'), cls: 'decreeArt' },
      bands: { intro: [4, 8, 2], normal: [8, 18, 2], adv: [16, 28, 2], vet: [22, 36, 2] },
      text: n => `Defeat ${n} armored foes (Shieldbearers, Hammermen & Banner Carriers)`,
      valid: p => p.bestWave >= 3, minutes: 11,
      handlers: { kill: d => (d.type === 'shield' || d.type === 'hammer' || d.type === 'banner' ? 1 : 0) } },
    mkKillTpl('kill_climbers', 'climber', 'enemy_wall_climber.png',
      { intro: [3, 6, 1], normal: [5, 10, 1], adv: [8, 16, 2], vet: [12, 20, 2] }, 10, 0.8),

    /* ---------------- TACTICAL / MECHANICAL ---------------- */
    { id: 'convert_n', cat: 'tac', weight: 1.3, mech: 'convert',
      icon: { file: 'icon_convert.png' },
      bands: { intro: [1, 2, 1], normal: [2, 4, 1], adv: [4, 6, 1], vet: [5, 8, 1] },
      text: n => `Convert ${n} ${n > 1 ? 'enemies' : 'enemy'} into recruits`,
      valid: () => true, minutes: 12,
      handlers: { convert: () => 1 } },
    { id: 'bolt_n', cat: 'tac', weight: 1, mech: 'ability',
      icon: { file: 'icon_mage.png' },
      bands: { intro: [2, 3, 1], normal: [3, 6, 1], adv: [5, 8, 1], vet: [6, 10, 1] },
      text: n => `Cast Lightning Strike ${n} times`,
      valid: p => p.bestWave >= 3, minutes: 10,
      handlers: { ability: d => (d.id === 'bolt' ? 1 : 0) } },
    { id: 'impact_kills', cat: 'tac', weight: 1.1, mech: 'throwing',
      icon: { file: 'upgrade_junk_cannon.png' },
      bands: { intro: [15, 30, 5], normal: [35, 70, 5], adv: [70, 120, 10], vet: [100, 170, 10] },
      text: n => `Defeat ${n} enemies with throws and slams`,
      valid: () => true, minutes: 11,
      handlers: { kill: d => (d.impact ? 1 : 0) } },
    { id: 'billiard_kills', cat: 'tac', weight: 1, mech: 'throwing',
      icon: { file: 'upgrade_glue_trap_cauldron.png' },
      bands: { intro: [2, 4, 1], normal: [4, 8, 1], adv: [7, 12, 1], vet: [10, 16, 2] },
      text: n => `Defeat ${n} enemies by smashing foes into each other`,
      valid: () => true, minutes: 12,
      handlers: { kill: d => (d.byEnemy ? 1 : 0) } },
    { id: 'frost_n', cat: 'tac', weight: 1, mech: 'ability',
      icon: { src: 'assets/abilities/icons/ability_frost_attack.png', cls: 'decreeArt' },
      bands: { intro: [2, 3, 1], normal: [2, 5, 1], adv: [4, 7, 1], vet: [5, 8, 1] },
      text: n => `Use Frost Field ${n} times`,
      valid: p => p.bestWave >= 6, minutes: 11,
      handlers: { ability: d => (d.id === 'frost' ? 1 : 0) } },
    { id: 'aegis_n', cat: 'tac', weight: 0.9, mech: 'ability',
      icon: { src: 'assets/abilities/icons/ability_shield_burst.png', cls: 'decreeArt' },
      bands: { intro: [1, 2, 1], normal: [2, 3, 1], adv: [2, 4, 1], vet: [3, 5, 1] },
      text: n => `Use Shield Burst ${n} times`,
      valid: p => p.bestWave >= 8, minutes: 12,
      handlers: { ability: d => (d.id === 'aegis' ? 1 : 0) } },
    { id: 'bomb_kills', cat: 'tac', weight: 1, mech: 'ability',
      icon: { file: 'icon_bomb.png' },
      bands: { intro: [3, 6, 1], normal: [6, 14, 2], adv: [12, 20, 2], vet: [16, 28, 2] },
      text: n => `Defeat ${n} enemies with Bomb Workshop bombs`,
      valid: p => p.bestWave >= 5, minutes: 12,
      handlers: { kill: d => (d.src === 'bomb' ? 1 : 0) } },
    { id: 'assign_recruits', cat: 'tac', weight: 0.8, mech: 'convert',
      icon: { file: 'upgrade_conversion_barracks.png' },
      bands: { intro: [1, 1, 1], normal: [1, 2, 1], adv: [2, 3, 1], vet: [2, 4, 1] },
      text: n => `Assign ${n} recruit${n > 1 ? 's' : ''} to castle rooms`,
      valid: p => p.bestWave >= 3, minutes: 10,
      handlers: { recruitAssign: () => 1 } },
    { id: 'no_damage_wave', cat: 'tac', weight: 1, mech: 'defense',
      icon: { file: 'icon_shield.png' },
      bands: { intro: [1, 1, 1], normal: [1, 2, 1], adv: [2, 3, 1], vet: [2, 4, 1] },
      text: n => n > 1 ? `Clear ${n} waves without castle damage` : 'Clear a wave without any castle damage',
      valid: () => true, minutes: 10,
      handlers: { waveClear: (d, ctx) => (ctx.waveDamaged ? 0 : 1) } },
    { id: 'high_hp_wave', cat: 'tac', weight: 1, mech: 'defense',
      icon: { file: 'icon_repair.png' },
      bands: { intro: [1, 1, 1], normal: [1, 2, 1], adv: [2, 3, 1], vet: [3, 4, 1] },
      text: n => n > 1 ? `Clear ${n} waves (wave 4+) with the castle above 80% health` : 'Clear a wave (wave 4+) with the castle above 80% health',
      valid: () => true, minutes: 10,
      handlers: { waveClear: d => (d.wave >= 4 && d.hpFrac > 0.8 ? 1 : 0) } },
    { id: 'knight_intercept', cat: 'tac', weight: 0.9, mech: 'combat', enemy: 'knight',
      icon: { src: ENEMY_ART('enemy_heavy_knight.png'), cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 3, 1], adv: [3, 5, 1], vet: [4, 6, 1] },
      text: n => `Defeat ${n} Heavy Knight${n > 1 ? 's' : ''} before they reach the castle`,
      valid: p => p.bestWave >= 9, minutes: 13,
      handlers: { kill: d => (d.type === 'knight' && !d.reachedCastle ? 1 : 0) } },
    { id: 'build_rooms', cat: 'tac', weight: 1.1, mech: 'rooms',
      icon: { file: 'fix_mason_workshop.png' },
      bands: { intro: [2, 3, 1], normal: [3, 5, 1], adv: [4, 6, 1], vet: [5, 8, 1] },
      text: n => `Build or upgrade ${n} castle rooms`,
      valid: () => true, minutes: 10,
      handlers: { room: () => 1 } },
    { id: 'combo_reach', cat: 'tac', weight: 1, mech: 'combat', maxMode: true,
      icon: { file: 'icon_upgrade.png' },
      bands: { intro: [3, 4, 1], normal: [4, 6, 1], adv: [5, 8, 1], vet: [6, 10, 1] },
      text: n => `Reach a ×${n} combo`,
      valid: () => true, minutes: 8,
      handlers: { kill: d => d.combo } },
    { id: 'no_ability_wave', cat: 'tac', weight: 0.8, mech: 'restraint',
      icon: { file: 'icon_sound_off.png' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 2, 1], vet: [2, 3, 1] },
      text: n => n > 1 ? `Clear ${n} waves (wave 4+) without using any abilities` : 'Clear a wave (wave 4+) without using any abilities',
      valid: p => p.bestWave >= 5, minutes: 10,
      conflicts: ['bolt_n', 'frost_n', 'aegis_n', 'bomb_kills'],
      handlers: { waveClear: (d, ctx) => (d.wave >= 4 && ctx.abilitiesUsed === 0 ? 1 : 0) } },

    /* ---------------- VARIETY / MODES ---------------- */
    { id: 'siege_complete', cat: 'variety', weight: 1.5, mode: 'siege', mech: 'siege',
      icon: { src: SEAL_ICON_SRC, cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 1, 1], vet: [1, 1, 1] },
      text: () => 'Earn Bronze or better in today’s Daily Siege',
      valid: () => true, minutes: 6,
      handlers: { siegeTier: d => (d.tier >= 1 ? 1 : 0) } },
    { id: 'siege_silver', cat: 'variety', weight: 1, mode: 'siege', mech: 'siege',
      icon: { src: SEAL_ICON_SRC, cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 1, 1], vet: [1, 1, 1] },
      text: () => 'Earn Silver or better in today’s Daily Siege',
      valid: p => p.bracket !== 'intro', minutes: 8,
      conflicts: ['siege_complete', 'siege_attempt'],
      handlers: { siegeTier: d => (d.tier >= 2 ? 1 : 0) } },
    { id: 'siege_attempt', cat: 'variety', weight: 1.1, mode: 'siege', mech: 'siege',
      icon: { src: SEAL_ICON_SRC, cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 1, 1], vet: [1, 1, 1] },
      text: () => 'Take up arms in today’s Daily Siege',
      valid: () => true, minutes: 5,
      conflicts: ['siege_complete', 'siege_silver'],
      handlers: { siegeTier: () => 1 } },
    { id: 'score_run', cat: 'variety', weight: 1, mech: 'score', maxMode: true,
      icon: { src: STAR_SRC, cls: 'decreeArt' },
      bands: { intro: [2000, 4000, 500], normal: [6000, 15000, 1000], adv: [18000, 40000, 2000], vet: [40000, 90000, 5000] },
      text: n => `Score ${n.toLocaleString()} points in a single run`,
      valid: () => true, minutes: 12,
      handlers: { waveClear: d => d.score || 0 },
      capTo: p => Math.max(2000, Math.round((p.bestScore || 0) * 0.8) || 4000) },
    { id: 'star_earner', cat: 'variety', weight: 1, mech: 'score',
      icon: { src: STAR_SRC, cls: 'decreeArt' },
      bands: { intro: [1000, 3000, 500], normal: [4000, 10000, 1000], adv: [10000, 25000, 2500], vet: [20000, 50000, 5000] },
      text: n => `Earn ${n.toLocaleString()} stars today`,
      valid: () => true, minutes: 12,
      handlers: { stars: d => d.n || 0 } },
    { id: 'rico_attempt', cat: 'variety', weight: 1.2, mode: 'ricochet', mech: 'ricochet',
      icon: { src: 'assets/castle_ricochet/ui/ui_currency_coin_castle.png', cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 1, 1], vet: [1, 1, 1] },
      text: () => 'Complete a Castle Ricochet attempt',
      valid: () => true, minutes: 4,
      handlers: { ricochetAttempt: () => 1 } },
    { id: 'rico_sink', cat: 'variety', weight: 1.1, mode: 'ricochet', mech: 'ricochet',
      icon: { src: 'assets/castle_ricochet/ui/ui_currency_coin_castle.png', cls: 'decreeArt' },
      bands: { intro: [1, 1, 1], normal: [1, 2, 1], adv: [2, 3, 1], vet: [3, 3, 1] },
      text: n => `Sink ${n} ${n > 1 ? 'enemies' : 'enemy'} in Castle Ricochet`,
      valid: () => true, minutes: 6,
      conflicts: ['rico_attempt', 'rico_coins'],
      handlers: { ricochetAttempt: d => d.sunk } },
    { id: 'rico_coins', cat: 'variety', weight: 0.9, mode: 'ricochet', mech: 'ricochet',
      icon: { src: 'assets/castle_ricochet/ui/ui_currency_coin_castle.png', cls: 'decreeArt' },
      bands: { intro: [500, 500, 500], normal: [500, 1000, 500], adv: [1000, 1500, 500], vet: [1000, 1500, 500] },
      text: n => `Earn ${n.toLocaleString()} coins in Castle Ricochet today`,
      valid: () => true, minutes: 7,
      conflicts: ['rico_attempt', 'rico_sink'],
      handlers: { ricochetAttempt: d => d.coins } },
    { id: 'milestone_claim', cat: 'variety', weight: 0.8, mech: 'milestone',
      icon: { msArt: 'menu' },
      bands: { intro: [1, 1, 1], normal: [1, 1, 1], adv: [1, 1, 1], vet: [1, 1, 1] },
      text: () => 'Claim a Milestone reward',
      valid: () => {
        // only offered when a milestone is claimable or within close reach today
        try {
          if (typeof MILESTONE_CATS === 'undefined') return false;
          for (const cat of MILESTONE_CATS) {
            const t = activeMilestoneTier(cat);
            if (t && cat.stat() >= t.goal * 0.7) return true;
          }
        } catch (e) { return false; }
        return false;
      },
      minutes: 3,
      handlers: { milestone: () => 1 } },
    { id: 'kill_variety', cat: 'variety', weight: 1, mech: 'combat', maxMode: true,
      icon: { src: ENEMY_ART('enemy_banner_carrier.png'), cls: 'decreeArt' },
      bands: { intro: [3, 4, 1], normal: [4, 6, 1], adv: [6, 8, 1], vet: [7, 9, 1] },
      text: n => `Defeat ${n} different enemy types today`,
      valid: () => true, minutes: 10,
      handlers: { kill: (d, ctx) => { ctx.typesKilled[d.type] = true; return Object.keys(ctx.typesKilled).length; } } },
    { id: 'golden_kill', cat: 'variety', weight: 0.7, mech: 'combat',
      icon: { file: 'fix_gold_vault.png' },
      bands: { intro: [1, 1, 1], normal: [1, 2, 1], adv: [2, 3, 1], vet: [2, 4, 1] },
      text: n => `Defeat ${n} golden ${n > 1 ? 'enemies' : 'enemy'}`,
      valid: () => { try { return typeof owns === 'function' && owns('contract_chaos'); } catch (e) { return false; } },
      minutes: 12,
      handlers: { kill: d => (d.golden ? 1 : 0) } },
  ];
  const tplById = id => DECREE_TEMPLATES.find(t => t.id === id) || null;

  /* ---------------- decree generation ---------------- */
  function decreeSig(ids) { return ids.slice().sort().join('+'); }
  function pairKey(a, b) { return [a, b].sort().join('|'); }

  function generateDecrees(dayKey, profile, history, forcedSlotCat) {
    const rng = mulberry32(hashStr(dayKey + '|decrees|v' + GEN_VERSION + '|' + profile.bracket));
    const hist = history || [];
    const recent = n => hist.slice(-n);
    const usedWithin = (id, days) => recent(days).some(h => h.decrees && h.decrees.indexOf(id) >= 0);
    const targetWithin = (id, target, days) => recent(days).some(h => h.targets && h.targets[id] === target);
    const enemyYesterday = tag => { const y = hist[hist.length - 1]; return !!(y && y.enemies && y.enemies.indexOf(tag) >= 0); };
    const modeYesterday = m => { const y = hist[hist.length - 1]; return !!(y && y.modes && y.modes.indexOf(m) >= 0); };
    const mechCount7 = mech => { let c = 0; for (const h of recent(7)) { if (h.mechs) for (const m of h.mechs) if (m === mech) c++; } return c; };
    const pairUsed = (a, b, days) => recent(days).some(h => h.pairs && h.pairs.indexOf(pairKey(a, b)) >= 0);
    const sigUsed = (sig, days) => recent(days).some(h => h.sig === sig);

    const rejected = [];
    function candidatesFor(cat, chosen) {
      let pool = DECREE_TEMPLATES.filter(t => t.cat === cat);
      /* adaptive no-repeat window: small unlocked pools (new players) shrink
         the exclusion span so a day always has SEVERAL live candidates — a
         single-candidate day would lock the rotation into a fixed cycle and
         repeat full daily signatures */
      const validCount = pool.filter(t => { try { return t.valid(profile); } catch (e) { return false; } }).length;
      const tplWindow = Math.max(3, Math.min(7, validCount - 3));
      const filters = [
        ['locked', t => { try { return t.valid(profile); } catch (e) { return false; } }],
        ['dup-in-day', t => !chosen.some(c => c.tpl === t.id)],
        ['conflict', t => !chosen.some(c => {
          const ct = tplById(c.tpl);
          return (t.conflicts && t.conflicts.indexOf(c.tpl) >= 0) || (ct && ct.conflicts && ct.conflicts.indexOf(t.id) >= 0);
        })],
        ['same-enemy-in-day', t => !t.enemy || !chosen.some(c => tplById(c.tpl) && tplById(c.tpl).enemy === t.enemy)],
        ['tpl-recent', t => !usedWithin(t.id, tplWindow)],
        ['enemy-consecutive', t => !t.enemy || !enemyYesterday(t.enemy)],
        ['mech-overuse-7d', t => !t.mech || mechCount7(t.mech) < 2],
      ];
      // apply hard filters, but relax from the bottom if the pool starves
      // (a starved pool must still always produce a valid decree)
      for (let strict = filters.length; strict >= 2; strict--) {
        let p = pool;
        for (let i = 0; i < strict; i++) {
          const next = p.filter(filters[i][1]);
          if (next.length === 0 && i >= 2) { rejected.push({ filter: filters[i][0], cat, emptied: true }); break; }
          if (next.length === 0) { p = []; break; }
          p = next;
        }
        if (p.length > 0) return p;
      }
      return pool.filter(filters[0][1]).filter(filters[1][1]);
    }

    function noveltyScore(t) {
      let s = t.weight * 10;
      for (let back = 0; back < Math.min(30, hist.length); back++) {
        const h = hist[hist.length - 1 - back];
        if (h && h.decrees && h.decrees.indexOf(t.id) >= 0) s -= Math.max(0, 14 - back);   // recent use hurts
        if (h && h.mechs && t.mech && h.mechs.indexOf(t.mech) >= 0) s -= Math.max(0, 4 - back * 0.5);
      }
      if (t.mode && modeYesterday(t.mode)) s -= 8;   // soft: avoid the same mode two days running
      s += rng() * 6;   // deterministic day-seeded tiebreak
      return Math.max(0.5, s);
    }

    function pickTarget(t) {
      let n = bandVal(t, profile.bracket, rng);
      if (t.capTo) n = Math.min(n, t.capTo(profile));
      // do not repeat the same template+target within 14 days
      let guard = 6;
      while (targetWithin(t.id, n, 14) && guard-- > 0) {
        const b = t.bands[profile.bracket] || t.bands.normal;
        const step = b[2] || 1;
        n = Math.max(b[0], Math.min(b[1], n + (rng() < 0.5 ? -step : step)));
        if (t.capTo) n = Math.min(n, t.capTo(profile));
      }
      return n;
    }

    // slot structure: one core, one tactical, one variety — never 3 of a kind
    const slots = forcedSlotCat || DECREE_SLOTS.slice();
    let chosen = [];
    /* deep retry budget: the 60-day signature rule only holds if the picker is
       allowed to keep trying — with 16 attempts an unlucky seed shipped a
       repeat two months later. Generation runs once a day; attempts are free. */
    let outerGuard = 48;
    while (outerGuard-- > 0) {
      chosen = [];
      for (const cat of slots) {
        const pool = candidatesFor(cat, chosen);
        const pick = weightedPick(rng, pool, noveltyScore);
        if (!pick) continue;
        chosen.push({ tpl: pick.id, target: pickTarget(pick), progress: 0, done: false, claimed: false });
      }
      if (chosen.length < 3) continue;
      // pair (21d) and full-signature (60d) repetition checks
      const ids = chosen.map(c => c.tpl);
      const sig = decreeSig(ids);
      let bad = sigUsed(sig, 60);
      if (!bad) {
        for (let i = 0; i < ids.length && !bad; i++)
          for (let j = i + 1; j < ids.length && !bad; j++)
            if (pairUsed(ids[i], ids[j], 21)) bad = true;
      }
      if (!bad) break;
      rejected.push({ filter: bad ? 'pair-or-sig' : 'incomplete', emptied: false });
    }
    /* last-resort repair: a starved pool can hand the picker the same trio it
       has already run inside the 60-day window no matter how often it retries.
       Swap one slot at a time, in deterministic novelty order, until the day's
       signature is fresh again — cheaper and far more reliable than retrying
       the whole draw and hoping the seed cooperates. */
    if (chosen.length === 3 && sigUsed(decreeSig(chosen.map(c => c.tpl)), 60)) {
      const pairsBad = ids => {
        for (let a = 0; a < ids.length; a++)
          for (let b = a + 1; b < ids.length; b++)
            if (pairUsed(ids[a], ids[b], 21)) return true;
        return false;
      };
      /* pass 1 keeps the 21-day pair rule as well; pass 2 spends it, because a
         pair seen three weeks ago is a far smaller repetition than the whole
         day's trio coming back inside the same two months */
      let repaired = false;
      for (let pass = 0; pass < 2 && !repaired; pass++) {
        for (let i = 0; i < chosen.length && !repaired; i++) {
          const self = tplById(chosen[i].tpl);
          if (!self) continue;
          const others = chosen.filter((c, j) => j !== i);
          const alts = candidatesFor(self.cat, others).slice().sort((a, b) => noveltyScore(b) - noveltyScore(a));
          for (const alt of alts) {
            if (alt.id === chosen[i].tpl) continue;
            const ids = chosen.map((c, j) => (j === i ? alt.id : c.tpl));
            if (sigUsed(decreeSig(ids), 60)) continue;
            if (pass === 0 && pairsBad(ids)) continue;
            chosen[i] = { tpl: alt.id, target: pickTarget(alt), progress: 0, done: false, claimed: false };
            repaired = true;
            break;
          }
        }
      }
      if (!repaired) rejected.push({ filter: 'sig-unrepairable', emptied: true });
    }
    // absolute fallback: never ship fewer than 3 decrees
    let fillGuard = 10;
    while (chosen.length < 3 && fillGuard-- > 0) {
      const pool = DECREE_TEMPLATES.filter(t => {
        try { if (!t.valid(profile)) return false; } catch (e) { return false; }
        return !chosen.some(c => c.tpl === t.id);
      });
      const pick = weightedPick(rng, pool, noveltyScore);
      if (!pick) break;
      chosen.push({ tpl: pick.id, target: pickTarget(pick), progress: 0, done: false, claimed: false });
    }
    return { decrees: chosen, diag: { seed: dayKey, bracket: profile.bracket, rejected, sig: decreeSig(chosen.map(c => c.tpl)) } };
  }

  /* reroll: replace one incomplete decree with a fresh template of the
     same category, excluding everything currently on the board */
  function rerollDecree(idx) {
    const st = dailyState();
    const dec = st.decrees[idx];
    if (!dec || dec.done || dec.claimed || st.rerollUsed) return false;
    const tpl = tplById(dec.tpl);
    const profile = playerProfile();
    const rng = mulberry32(hashStr(st.dayKey + '|reroll|' + dec.tpl + '|v' + GEN_VERSION));
    const chosen = st.decrees.map(d => ({ tpl: d.tpl }));
    const hist = st.history || [];
    const pool = DECREE_TEMPLATES.filter(t =>
      t.cat === tpl.cat && t.id !== dec.tpl &&
      !chosen.some(c => c.tpl === t.id) &&
      !st.decrees.some((d, i) => {
        if (i === idx) return false;
        const dt = tplById(d.tpl);
        return (t.conflicts && t.conflicts.indexOf(d.tpl) >= 0) || (dt && dt.conflicts && dt.conflicts.indexOf(t.id) >= 0) ||
          (t.enemy && dt && dt.enemy === t.enemy);
      }) &&
      (function () { try { return t.valid(profile); } catch (e) { return false; } })() &&
      !hist.slice(-7).some(h => h.decrees && h.decrees.indexOf(t.id) >= 0)
    );
    const relaxed = pool.length ? pool : DECREE_TEMPLATES.filter(t =>
      t.cat === tpl.cat && t.id !== dec.tpl && !chosen.some(c => c.tpl === t.id) &&
      (function () { try { return t.valid(profile); } catch (e) { return false; } })());
    const pick = weightedPick(rng, relaxed, t => t.weight * 10 + rng() * 5);
    if (!pick) return false;
    st.decrees[idx] = { tpl: pick.id, target: bandVal(pick, profile.bracket, rng), progress: 0, done: false, claimed: false, rerolled: true };
    if (pick.capTo) st.decrees[idx].target = Math.min(st.decrees[idx].target, pick.capTo(profile));
    st.rerollUsed = true;
    saveMeta();
    diag('decree-reroll', { from: dec.tpl, to: pick.id });
    return true;
  }

  /* ============================================================
     DAILY SIEGE — generation
     ============================================================ */
  const THREAT = {
    runner: 1, soldier: 1.4, shield: 2.2, hammer: 2.8, bomber: 2.4, healer: 3.2,
    banner: 3.2, knight: 4.5, climber: 2.0, elite: 6,
    captain: 14, brute: 16, bannerlord: 15, cart: 15, ram: 12,
  };
  /* base stats mirrored from game.js ENEMIES (pure copies so the QA harness
     and the fairness simulation never depend on live game globals) */
  const SIM_ENEMY = {
    runner:  { hp: 20,  spd: 176, dps: 2.5 },
    soldier: { hp: 38,  spd: 84,  dps: 5 },
    shield:  { hp: 60,  spd: 52,  dps: 5 },
    hammer:  { hp: 72,  spd: 45,  dps: 24 },
    bomber:  { hp: 28,  spd: 84,  dps: 0, burst: 55 },
    healer:  { hp: 42,  spd: 57,  dps: 2, support: 0.12 },
    banner:  { hp: 62,  spd: 60,  dps: 4, support: 0.10 },
    knight:  { hp: 150, spd: 34,  dps: 15 },
    climber: { hp: 32,  spd: 136, dps: 7 },
    elite:   { hp: 190, spd: 49,  dps: 20 },
    captain: { hp: 550, spd: 30,  dps: 26 },
    brute:   { hp: 700, spd: 25,  dps: 60 },
    bannerlord: { hp: 620, spd: 33, dps: 24, support: 0.15 },
    cart:    { hp: 480, spd: 69,  dps: 0, burst: 200 },
    ram:     { hp: 460, spd: 33,  dps: 45 },
  };
  const ENEMY_HP_MULT = 2.0;              // mirrors ENEMY_HP_MULTIPLIER
  const FIELD_LEN = 885;                  // SPAWN_X - CASTLE_X

  const SIEGE_THEMES = [
    { id: 'swarm', name: 'Swarm Assault', desc: 'Endless light infantry at rapid pace.',
      core: ['runner', 'soldier', 'climber'], support: ['bomber', 'banner'], rooms: { archer: 3, bomb: 2.5, mage: 2 },
      minBracket: 'intro' },
    { id: 'heavy', name: 'Heavy Breakers', desc: 'Armored knights and brutes lead the assault.',
      core: ['knight', 'hammer', 'shield'], support: ['healer', 'soldier'], rooms: { wall: 2.5, mage: 2.5, barracks: 2, archer: 1.5 },
      minBracket: 'normal' },
    { id: 'siegeline', name: 'Siege Line', desc: 'Siege engines roll on the walls.',
      core: ['hammer', 'shield', 'soldier'], support: ['banner', 'knight'], boss: ['cart', 'ram', 'captain'],
      rooms: { archer: 2.5, bomb: 2.5, mason: 2 }, minBracket: 'adv' },
    { id: 'bombard', name: 'Bombardment', desc: 'Bomb carriers press the walls in waves.',
      core: ['bomber', 'runner', 'soldier'], support: ['shield', 'healer'], rooms: { archer: 3, bomb: 2, mason: 2 },
      minBracket: 'intro' },
    { id: 'elite', name: 'Elite Invasion', desc: 'Two-star elites stiffen every rank.',
      core: ['elite', 'soldier', 'shield'], support: ['healer', 'banner'], rooms: { mage: 2.5, archer: 2.5, wall: 2 },
      minBracket: 'adv' },
    { id: 'convert', name: 'Conversion Test', desc: 'Turn the horde against itself.',
      core: ['soldier', 'shield', 'hammer'], support: ['runner', 'healer'], rooms: { barracks: 3.5, wall: 2, archer: 2 },
      convertMax: 4, minBracket: 'normal' },
    { id: 'arcane', name: 'Arcane Storm', desc: 'Spellwork is the wall tonight.',
      core: ['runner', 'climber', 'soldier'], support: ['banner', 'bomber'], rooms: { mage: 3.5, wall: 2, mason: 1.5 },
      minBracket: 'intro' },
    { id: 'fortress', name: 'Fortress Stand', desc: 'Thin offense, thick walls — hold the line.',
      core: ['soldier', 'shield', 'hammer'], support: ['runner', 'knight'], rooms: { wall: 3, mason: 3, archer: 1.5 },
      lowOffense: true, minBracket: 'intro' },
    { id: 'mixed', name: 'Mixed Horde', desc: 'Every banner of the horde marches at once.',
      core: ['soldier', 'runner', 'shield', 'hammer'], support: ['healer', 'banner', 'bomber', 'climber'],
      rooms: { archer: 2, mage: 2, bomb: 2, mason: 1.5 }, minBracket: 'intro' },
    { id: 'bossclimax', name: 'Boss Climax', desc: 'The wave ends before a champion of the horde.',
      core: ['soldier', 'shield', 'hammer'], support: ['runner', 'healer'], boss: ['captain', 'brute', 'bannerlord', 'cart', 'ram'],
      rooms: { archer: 2.5, mage: 2.5, wall: 2 }, minBracket: 'adv' },
  ];
  const SIEGE_MODIFIERS = [
    { id: 'elite_surge', name: 'Elite Surge', desc: 'Two-star elites appear more often.', needs: 'adv' },
    { id: 'fleetfoot', name: 'Fleet Foot', desc: 'Light enemies move 20% faster.' },
    { id: 'ironhide', name: 'Iron Hide', desc: 'Heavy enemies have 25% more health.' },
    { id: 'early_siege', name: 'Early Thunder', desc: 'The heaviest threats arrive sooner.' },
    { id: 'quick_arts', name: 'Quickened Arts', desc: 'Ability cooldowns recover 15% faster.', boon: true },
    { id: 'battered_walls', name: 'Battered Walls', desc: 'The castle starts at 80% health.' },
    { id: 'zealous_recruits', name: 'Zealous Recruits', desc: 'Recruits fight with 50% more strength.', boon: true },
    { id: 'twin_fuses', name: 'Twin Fuses', desc: 'Bomb carriers arrive in pairs.' },
    { id: 'thin_ranks', name: 'Thin Ranks', desc: 'Fewer enemies — each far tougher.' },
    { id: 'flood_ranks', name: 'Flooded Ranks', desc: 'More enemies — each weaker.' },
  ];
  const MOD_CONFLICTS = { thin_ranks: ['flood_ranks'], flood_ranks: ['thin_ranks'] };
  const BRACKET_ORDER = ['intro', 'normal', 'adv', 'vet'];
  const brAtLeast = (a, b) => BRACKET_ORDER.indexOf(a) >= BRACKET_ORDER.indexOf(b);

  /* count/span/castle pass (2026-08 difficulty pass): a siege now fields ~35%
     more bodies over a much denser timeline (see SIEGE_PACING), so the field is
     busy instead of trickling. The fairness scaler answers the extra pressure by
     LOWERING enemy HP, which is the intended trade — a siege is won by handling
     many foes at once, not by chewing through HP sponges.
     The castle pool rose with it (~+45%): under the old pool the scaler had to
     buy survivability by shrinking enemy HP so far that a whole siege was over
     in ~60 seconds. A bigger pool buys DURATION, not safety — the wave arriving
     at the walls is strictly heavier than before at every bracket. */
  const SIEGE_BRACKET = {
    intro:  { budget: 8,  count: [32, 44], span: [105, 130], castle: 1150, fling: { cons: 16, avg: 30, strong: 52 } },
    normal: { budget: 11, count: [38, 54], span: [125, 155], castle: 1220, fling: { cons: 22, avg: 42, strong: 70 } },
    adv:    { budget: 14, count: [48, 68], span: [140, 175], castle: 1280, fling: { cons: 26, avg: 50, strong: 84 } },
    vet:    { budget: 17, count: [59, 78], span: [155, 195], castle: 1350, fling: { cons: 30, avg: 58, strong: 95 } },
  };

  /* ---------------- Daily Siege pacing ----------------
     Before this pass every spawn was scattered uniformly at random inside four
     long phase windows. That produced the three complaints this pass fixes:
     the opening foe could arrive 15s after the banner, mid-siege gaps ran past
     25s with an empty field, and the CLIMAX was the *quietest* stretch of the
     whole challenge (its share of the count was spread over the longest tail).

     The timeline is now built forward in GROUPS. Each stage owns a share of
     the span and a (larger) share of the count, so the spawn rate rises stage
     by stage; groups arrive together but never on the same instant, and no
     gap inside a stage may exceed that stage's maxGap.

     SIEGE ONLY. Normal Castle Fling waves keep their own scripted composition
     and ENEMY_SPAWN_RATE_MULTIPLIER in game.js — nothing here touches them. */
  const SIEGE_PACING = {
    firstSpawn: [1.0, 1.8],      // the opening group always lands in this window
    spanScale: 0.78,             // budget dial on the bracket span (see stage rate)
    squeezeFloor: 0.75,          // extra compression on very high difficulty days
    intra: [0.18, 0.5],          // spacing inside one group — readable, not simultaneous
    minGap: 1.2,                 // groups never collapse into one indistinct blob
    maxGap: 8,                   // hard backstop: no silent stretch beyond this
    bossAt: 0.78,                // champion lands INSIDE the climax, not after it
    /* count = share of the enemies. rate = spawn rate as a multiple of the
       bracket's own baseline (count / span), so every bracket escalates the
       same way while keeping its own budget. The group gap is derived —
       gap = groupSize / rate — which is why later stages both send MORE at
       once and send it SOONER. Weighted, the rates average ~1.6x baseline:
       that is the ~40% cut in spawn interval this pass is built around. */
    stages: [
      { name: 'Vanguard',      count: 0.12, group: [2, 3], rate: 1.20 },
      { name: 'Pressure',      count: 0.22, group: [3, 4], rate: 1.50 },
      { name: 'Mixed Assault', count: 0.30, group: [3, 5], rate: 1.90 },
      { name: 'Climax',        count: 0.36, group: [4, 6], rate: 2.50 },
    ],
    /* group composition: how often an extra member is pulled from a different
       speed class than the ones already in the group (fast + durable together),
       and how often a stage that can field climbers puts one on the wall while
       the ground group presses the gate */
    mixChance: 0.65,
    climberChance: [0, 0.3, 0.4, 0.45],
    lanes: 4,                    // spawn lanes a group spreads across
  };
  /* a siege should read as a set-piece, not a sprint: the scaler aims for at
     least this many simulated seconds at average skill before it settles for a
     shorter fight (see the two-pass search in generateSiege) */
  const MIN_CLEAR_TIME = 130;

  /* speed class is DERIVED from the mirrored stats so it can never drift */
  function speedClass(t) {
    const e = SIM_ENEMY[t];
    const s = e ? e.spd : 60;
    return s >= 120 ? 'fast' : s >= 55 ? 'mid' : 'heavy';
  }
  const ROOM_MAX = { archer: 5, mason: 5, mage: 5, bomb: 4, barracks: 4, wall: 5 };
  const OFFENSE_ROOMS = ['archer', 'bomb', 'mage'];

  /* pure copies of the room output formulas (base, non-treasury variants) */
  function roomDps(rooms) {
    let dps = 0;
    if (rooms.archer > 0) {
      const dmg = Math.round(10 * (1 + (rooms.archer - 1) * 0.45));
      const int = Math.max(0.35, 1.6 - rooms.archer * 0.22);
      dps += dmg / int;
    }
    if (rooms.bomb > 0) dps += ((60 + rooms.bomb * 30) * 2.2 * 0.9) / Math.max(8, 18 - rooms.bomb * 2);
    if (rooms.mage >= 1) dps += (85 * 0.8 * 2.3) / 12;
    return dps;
  }
  function loadoutPower(rooms) {
    let p = roomDps(rooms) * 1.0;
    p += (rooms.mason || 0) * 1.4 * 3;          // repair valued at ~3 dps-equivalent per hp/s
    p += (rooms.wall || 0) * 6;                 // hp + armor
    p += (rooms.barracks || 0) * 5;             // conversion leverage
    if (rooms.mage >= 2) p += 8;                // frost control
    if (rooms.mage >= 3) p += 10;               // shield burst
    return p;
  }

  function generateLoadout(rng, theme, bracket, history) {
    const budget = SIEGE_BRACKET[bracket].budget + rint(rng, -1, 1);
    const prefs = theme.rooms;
    const roomIds = Object.keys(ROOM_MAX);
    let attempts = 24;
    while (attempts-- > 0) {
      const count = rint(rng, 3, Math.min(5, roomIds.length));
      const picked = [];
      const pool = roomIds.slice();
      // theme-preferred rooms first, weighted
      while (picked.length < count && pool.length) {
        const pick = weightedPick(rng, pool, id => (prefs[id] || 0.6));
        picked.push(pick);
        pool.splice(pool.indexOf(pick), 1);
      }
      if (!picked.some(id => OFFENSE_ROOMS.indexOf(id) >= 0)) continue;   // must have real offense
      // distribute the level budget: theme's key room leads
      const rooms = {};
      for (const id of picked) rooms[id] = 1;
      let left = budget - picked.length;
      let guard = 60;
      while (left > 0 && guard-- > 0) {
        const up = weightedPick(rng, picked.filter(id => rooms[id] < ROOM_MAX[id]), id => (prefs[id] || 0.6));
        if (!up) break;
        rooms[up]++; left--;
      }
      if (theme.lowOffense) {
        // fortress stand: offense capped low, defense boosted
        for (const id of OFFENSE_ROOMS) if (rooms[id] > 2) { const spare = rooms[id] - 2; rooms[id] = 2; if (rooms.wall) rooms.wall = Math.min(ROOM_MAX.wall, rooms.wall + spare); }
      }
      if (theme.id === 'convert' && !rooms.barracks) rooms.barracks = 2;
      if (theme.id === 'arcane' && (!rooms.mage || rooms.mage < 3)) rooms.mage = 3;
      // a theme mandate may have added a room past the 5-room cap: drop the
      // least theme-relevant extra (never the mandate, never the last offense)
      while (Object.keys(rooms).length > 5) {
        const ids = Object.keys(rooms)
          .filter(id => !(theme.id === 'convert' && id === 'barracks') && !(theme.id === 'arcane' && id === 'mage'))
          .sort((a, b) => (prefs[a] || 0.6) - (prefs[b] || 0.6));
        let dropped = false;
        for (const id of ids) {
          const rest = Object.keys(rooms).filter(x => x !== id);
          if (rest.some(x => OFFENSE_ROOMS.indexOf(x) >= 0)) { delete rooms[id]; dropped = true; break; }
        }
        if (!dropped) break;
      }
      // ---- diversity checks against history ----
      const sig = Object.keys(rooms).sort().map(id => id + rooms[id]).join('.');
      const comboSig = Object.keys(rooms).sort().join('.');
      const recent = (history || []).slice(-30);
      const comboUsed14 = recent.slice(-14).some(h => h.siege && h.siege.combo === comboSig);
      const sigUsed30 = recent.some(h => h.siege && h.siege.loadout === sig);
      const y = recent[recent.length - 1];
      const topRoom = Object.keys(rooms).sort((a, b) => rooms[b] - rooms[a])[0];
      const topRepeats = !!(y && y.siege && y.siege.topRoom === topRoom);
      if (comboUsed14 || sigUsed30 || (topRepeats && attempts > 6)) continue;
      return { rooms, sig, comboSig, topRoom };
    }
    // fallback: simple balanced kit (still must never fail to produce)
    const rooms = { archer: 3, mason: 2, mage: 2 };
    return { rooms, sig: 'archer3.mage2.mason2', comboSig: 'archer.mage.mason', topRoom: 'archer' };
  }

  function pickModifiers(rng, theme, bracket, history) {
    const recent = (history || []).slice(-7);
    const usedRecently = id => recent.slice(-2).some(h => h.siege && h.siege.mods && h.siege.mods.indexOf(id) >= 0);
    const pool = SIEGE_MODIFIERS.filter(m => {
      if (m.needs && !brAtLeast(bracket, m.needs)) return false;
      if (m.id === 'twin_fuses' && theme.core.indexOf('bomber') < 0 && theme.support.indexOf('bomber') < 0) return false;
      if (m.id === 'zealous_recruits' && theme.id !== 'convert' && !theme.rooms.barracks) return false;
      if (m.id === 'battered_walls' && theme.lowOffense) return false;      // never stack fragile walls on low offense
      if (usedRecently(m.id)) return false;
      return true;
    });
    const n = rng() < 0.25 ? 0 : rng() < 0.7 ? 1 : 2;
    const mods = [];
    let guard = 12;
    while (mods.length < n && guard-- > 0 && pool.length) {
      const m = rpick(rng, pool);
      if (mods.indexOf(m.id) >= 0) continue;
      const conf = MOD_CONFLICTS[m.id] || [];
      if (mods.some(x => conf.indexOf(x) >= 0)) continue;
      mods.push(m.id);
    }
    return mods;
  }

  /* one long wave in four named stages, built forward in overlapping GROUPS.
     diff is the single difficulty scalar: up to 3.0 it raises enemy HP;
     beyond that it compresses the spawn timeline instead (denser assault) —
     swarm days get harder through pressure, not through absurd HP sponges.
     Pacing constants live in SIEGE_PACING; see the note there for what the
     old uniform-random phase windows got wrong. */
  function generateWave(rng, theme, mods, bracket, diff) {
    const B = SIEGE_BRACKET[bracket];
    const P = SIEGE_PACING;
    const hpScaleMult = Math.min(diff, 3);
    const squeeze = Math.max(P.squeezeFloor, Math.min(1, 3 / Math.max(diff, 0.001)));
    let count = rint(rng, B.count[0], B.count[1]);
    if (mods.indexOf('thin_ranks') >= 0) count = Math.round(count * 0.65);
    if (mods.indexOf('flood_ranks') >= 0) count = Math.round(count * 1.3);
    const nominalSpan = rint(rng, B.span[0], B.span[1]) * P.spanScale * squeeze;
    const pool = theme.core.concat(theme.support);
    const bracketPool = pool.filter(t => {
      if (t === 'elite' && !brAtLeast(bracket, 'adv')) return false;
      if ((t === 'knight' || t === 'healer' || t === 'banner') && bracket === 'intro') return false;
      return false || true;
    });
    /* stage mixes widen as the siege escalates: the vanguard is readable core
       infantry, the climax fields everything the theme and bracket allow */
    const stageMix = [
      theme.core.slice(0, 2),
      theme.core.concat(theme.support.slice(0, 1)),
      bracketPool,
      bracketPool,
    ];
    const hpMods = t => {
      let m = hpScaleMult;
      if (mods.indexOf('ironhide') >= 0 && (t === 'knight' || t === 'hammer' || t === 'shield' || t === 'elite')) m *= 1.25;
      if (mods.indexOf('thin_ranks') >= 0) m *= 1.35;
      if (mods.indexOf('flood_ranks') >= 0) m *= 0.75;
      return m;
    };
    const spdMods = t => {
      let m = 1;
      if (mods.indexOf('fleetfoot') >= 0 && (t === 'runner' || t === 'soldier' || t === 'climber' || t === 'bomber')) m *= 1.2;
      return m;
    };
    /* one group: a lead type, then members biased toward a DIFFERENT speed
       class so the player is sorting fast skirmishers from durable ranks
       instead of meeting one enemy kind at a time */
    const pickGroup = (mix, n, si) => {
      const out = [];
      const classes = {};
      const canClimb = mix.indexOf('climber') >= 0;
      if (canClimb && n > 1 && rng() < P.climberChance[si]) { out.push('climber'); classes.fast = true; }
      while (out.length < n) {
        let t;
        if (!out.length || rng() >= P.mixChance) t = rpick(rng, mix);
        else {
          const fresh = mix.filter(x => !classes[speedClass(x)]);
          t = rpick(rng, fresh.length ? fresh : mix);
        }
        if (mods.indexOf('elite_surge') >= 0 && brAtLeast(bracket, 'adv') && rng() < 0.12) t = 'elite';
        classes[speedClass(t)] = true;
        out.push(t);
      }
      return out;
    };

    const q = [];
    const phases = [];
    const baseRate = count / Math.max(1, nominalSpan);   // this bracket's own budget
    let t = P.firstSpawn[0] + rng() * (P.firstSpawn[1] - P.firstSpawn[0]);
    let spawned = 0;
    for (let si = 0; si < P.stages.length; si++) {
      const st = P.stages[si];
      phases.push({ name: st.name, at: Math.round(t * 10) / 10 });
      const last = si === P.stages.length - 1;
      const want = last ? Math.max(2, count - spawned) : Math.max(2, Math.round(count * st.count));
      const mix = (stageMix[si].filter(x => bracketPool.indexOf(x) >= 0).length ? stageMix[si].filter(x => bracketPool.indexOf(x) >= 0) : theme.core);
      // split this stage's share into groups
      const sizes = [];
      let left = want;
      while (left > 0) {
        const g = Math.min(left, rint(rng, st.group[0], st.group[1]));
        sizes.push(g);
        left -= g;
      }
      const rate = baseRate * st.rate;
      for (let gi = 0; gi < sizes.length; gi++) {
        const types = pickGroup(mix, sizes[gi], si);
        /* the gap a group EARNS: its own size at this stage's spawn rate, so a
           bigger group never means a longer silence than the stage allows */
        const gap = Math.max(P.minGap, Math.min(P.maxGap, sizes[gi] / rate));
        for (let mi = 0; mi < types.length; mi++) {
          const ty = types[mi];
          let delay = t + mi * (P.intra[0] + rng() * (P.intra[1] - P.intra[0]));
          if (mods.indexOf('early_siege') >= 0 && THREAT[ty] >= 4) delay = Math.max(P.firstSpawn[0], delay * 0.85);
          const entry = {
            type: ty, delay: Math.round(delay * 10) / 10,
            hpMult: hpMods(ty), spdMult: spdMods(ty),
            // spread the group over the walking band so nothing spawns stacked
            laneFrac: Math.round(((mi % P.lanes) / (P.lanes - 1)) * 100) / 100,
          };
          q.push(entry);
          spawned++;
          if (ty === 'bomber' && mods.indexOf('twin_fuses') >= 0) {
            q.push({ type: 'bomber', delay: Math.round((delay + 0.9) * 10) / 10, hpMult: hpMods(ty), spdMult: spdMods(ty), laneFrac: 1 - entry.laneFrac });
            spawned++;
          }
        }
        t += gap * (0.85 + rng() * 0.3);
      }
    }
    const span = Math.max(8, Math.round(q.reduce((a, s) => Math.max(a, s.delay), 0)));
    // optional boss climax — lands INSIDE the final stage so the champion is
    // fought while lighter groups keep arriving, never on an empty field
    let boss = null;
    if (theme.boss && brAtLeast(bracket, 'adv')) {
      boss = rpick(rng, theme.boss);
      // bosses appear late, at reduced strength scaled by bracket
      const bossHp = (bracket === 'vet' ? 0.85 : 0.6) * hpScaleMult;
      q.push({ type: boss, delay: Math.round(span * P.bossAt * 10) / 10, hpMult: bossHp, spdMult: 1, laneFrac: 0.5 });
    }
    q.sort((a, b) => a.delay - b.delay);
    return { queue: q, span, phases, boss, count: q.length };
  }

  /* ---------------- fairness simulation ----------------
     Deterministic timeline estimate: room DPS + skill-banded fling
     DPS clear enemies in arrival order; enemies alive past their
     walk time deal castle damage until killed. Three skill bands
     must land in the target windows or the challenge is rescaled. */
  function simulateSiege(cfg, skill) {
    const B = SIEGE_BRACKET[cfg.bracket];
    const fling = B.fling[skill];
    const mitigation = skill === 'cons' ? 1.0 : skill === 'avg' ? 0.62 : 0.38;
    let dps = roomDps(cfg.rooms) + fling;
    if (cfg.rooms.barracks >= 2) dps *= 1.06;                       // conversions remove threat
    const cdBoost = cfg.mods.indexOf('quick_arts') >= 0 ? 1.04 : 1;
    dps *= cdBoost;
    const repair = (cfg.rooms.mason || 0) * 1.4;
    const armor = (cfg.rooms.wall || 0);
    let castleHp = cfg.castleHp;
    if (cfg.mods.indexOf('battered_walls') >= 0) castleHp *= 0.8;
    const recruitBoost = cfg.mods.indexOf('zealous_recruits') >= 0 ? 1.5 : 1;
    let supportMult = 1;
    let totalThreat = 0;
    const foes = cfg.queue.map(s => {
      const e = SIM_ENEMY[s.type];
      totalThreat += THREAT[s.type] || 1;
      if (e.support) supportMult += e.support * 0.35;
      return {
        spawn: s.delay,
        hp: e.hp * ENEMY_HP_MULT * (s.hpMult || 1),
        walk: FIELD_LEN / (e.spd * (s.spdMult || 1)),
        dps: e.dps, burst: e.burst || 0,
        threat: THREAT[s.type] || 1,
      };
    });
    // frost + shield burst shave incoming damage
    let dmgShave = 1;
    if (cfg.rooms.mage >= 2) dmgShave *= 0.93;
    if (cfg.rooms.mage >= 3) dmgShave *= 0.90;
    if (cfg.rooms.barracks >= 1) dmgShave *= 1 - 0.02 * cfg.rooms.barracks * recruitBoost;
    let killEnd = 0, castleDmg = 0, killedThreat = 0, fallTime = -1, lastEnd = 0;
    for (const f of foes) {
      const hp = f.hp * supportMult;
      const start = Math.max(killEnd, f.spawn);
      killEnd = start + hp / dps;
      lastEnd = Math.max(lastEnd, killEnd);
      const contact = f.spawn + f.walk;
      if (killEnd > contact) {
        const exposed = killEnd - contact;
        castleDmg += (f.dps * exposed * 0.9 + f.burst * 0.55) * mitigation * dmgShave * Math.max(0.4, 1 - armor * 0.05);
      }
      const netAt = castleDmg - repair * killEnd;
      if (fallTime < 0 && netAt >= castleHp) fallTime = killEnd;
      if (fallTime < 0) killedThreat += f.threat;
    }
    const duration = Math.max(cfg.span + 12, lastEnd);
    const netDmg = Math.max(0, castleDmg - repair * duration * 0.8);
    const cleared = fallTime < 0 && netDmg < castleHp;
    return {
      cleared,
      remainFrac: cleared ? Math.max(0.02, (castleHp - netDmg) / castleHp) : 0,
      clearTime: duration,
      killedFrac: totalThreat > 0 ? Math.min(1, killedThreat / totalThreat) : 1,
      totalThreat,
    };
  }

  function generateSiege(dayKey, profile, history) {
    const bracket = profile.bracket;
    const rng = mulberry32(hashStr(dayKey + '|siege|v' + GEN_VERSION + '|' + bracket));
    const hist = history || [];
    const y = hist[hist.length - 1];
    const themeUsed = (id, days) => hist.slice(-days).filter(h => h.siege && h.siege.theme === id).length;
    const bossUsed7 = id => hist.slice(-7).some(h => h.siege && h.siege.boss === id);
    const rejections = [];
    let best = null;
    let bestEffort = null;   // passed FAIRNESS but failed a diversity check — far
                             // better than the hand-tuned fallback if we starve

    for (let attempt = 0; attempt < 40; attempt++) {
      const themes = SIEGE_THEMES.filter(t => brAtLeast(bracket, t.minBracket))
        .filter(t => !(y && y.siege && y.siege.theme === t.id))          // never consecutive
        .filter(t => themeUsed(t.id, 7) < 2);                            // ≤2 per week
      const theme = weightedPick(rng, themes.length ? themes : SIEGE_THEMES.filter(t => brAtLeast(bracket, t.minBracket)),
        t => 10 - themeUsed(t.id, 14) * 3 + rng() * 4);
      if (!theme) continue;
      const mods = pickModifiers(rng, theme, bracket, hist);
      const lo = generateLoadout(rng, theme, bracket, hist);
      // difficulty scaler: binary search an enemy-hp multiplier until all
      // three simulated skill bands land in their fairness windows. Daily
      // Siege foes are "siege-hardened" — multipliers well above the normal
      // wave scale are expected for a single set-piece wave.
      /* the denser 2026-08 timeline is answered by LOWER hp, so the search
         floor sits below the old 0.5 — enemies may end up at less than base
         game health, which is correct: the threat is the crowd, not the wall
         of hit points on any one foe */
      let hpMult = 1.6, ok = false, cfg = null, sims = null;
      const buildAt = m => {
        const wave = generateWave(mulberry32(hashStr(dayKey + '|wave|' + attempt + '|v' + GEN_VERSION)), theme, mods, bracket, m);
        return {
          id: dayKey + '#' + attempt, dayKey, bracket,
          theme: theme.id, themeName: theme.name, themeDesc: theme.desc,
          mods, rooms: lo.rooms, loadoutSig: lo.sig, comboSig: lo.comboSig, topRoom: lo.topRoom,
          castleHp: SIEGE_BRACKET[bracket].castle + (lo.rooms.wall || 0) * 80,
          startHpFrac: mods.indexOf('battered_walls') >= 0 ? 0.8 : 1,
          cdMult: mods.indexOf('quick_arts') >= 0 ? 0.85 : 1,
          convertMax: theme.convertMax || 1,
          recruitMult: mods.indexOf('zealous_recruits') >= 0 ? 1.5 : 1,
          queue: wave.queue, span: wave.span, phases: wave.phases, boss: wave.boss,
          genVersion: GEN_VERSION,
        };
      };
      /* target: average clears with 20–62% castle left inside ~5.5 min;
         strong comfortably; conservative reaches bronze often.
         MIN_CLEAR is the second pass only: the dense timeline lets the scaler
         buy safety by shaving enemy HP until a whole siege is over in a minute,
         which reads as trivial however busy the field was — so the first pass
         also treats "too short" as too easy and spends the surplus on tougher
         ranks. A bracket that cannot reach that length is still shipped by the
         second pass rather than dropped onto the flat fallback config. */
      for (let pass = 0; pass < 2 && !ok; pass++) {
        let loMul = 0.3, hiMul = 5.5;
        hpMult = 1.6;
        for (let iter = 0; iter < 13; iter++) {
          cfg = buildAt(hpMult);
          sims = { cons: simulateSiege(cfg, 'cons'), avg: simulateSiege(cfg, 'avg'), strong: simulateSiege(cfg, 'strong') };
          const tooHard = !sims.avg.cleared || sims.avg.remainFrac < 0.20 || sims.avg.clearTime > 330;
          const tooEasy = (sims.avg.remainFrac > 0.62 && sims.strong.remainFrac > 0.85) ||
            (pass === 0 && sims.avg.clearTime < MIN_CLEAR_TIME);
          if (tooHard) { hiMul = hpMult; hpMult = (loMul + hpMult) / 2; continue; }
          if (tooEasy) { loMul = hpMult; hpMult = (hiMul + hpMult) / 2; continue; }
          ok = true; break;
        }
      }
      if (!ok) { rejections.push({ attempt, theme: theme.id, why: 'unscalable' }); continue; }
      if (!sims.strong.cleared) { rejections.push({ attempt, theme: theme.id, why: 'strong-fails' }); continue; }
      if (sims.cons.killedFrac < 0.45) { rejections.push({ attempt, theme: theme.id, why: 'conservative-crushed' }); continue; }
      // scoring thresholds from the fairness-validated config
      const finalize = () => {
        let killScore = 0;
        for (const s of cfg.queue) killScore += Math.round((THREAT[s.type] || 1) * 100);
        const completionBonus = Math.round(killScore * 0.25);
        const hpBonusMax = Math.round(killScore * 0.20);
        const timeBonusMax = Math.round(killScore * 0.15);
        const parTime = Math.round(sims.avg.clearTime * 1.15);
        const goldHpFrac = Math.max(0.35, Math.min(0.9, sims.strong.remainFrac * 0.8));
        cfg.scoring = {
          killScore, completionBonus, hpBonusMax, timeBonusMax, parTime,
          bronzeFrac: SIEGE_BRONZE_FRAC,
          bronzeScore: Math.round(killScore * SIEGE_BRONZE_FRAC),
          goldScore: Math.round(killScore + completionBonus + hpBonusMax * goldHpFrac + timeBonusMax * 0.45),
        };
        cfg.simReport = {
          cons: sims.cons, avg: sims.avg, strong: sims.strong, hpMult,
          estMinutes: Math.round(sims.avg.clearTime / 60 * 10) / 10,
        };
        return cfg;
      };
      const sig = [cfg.theme, cfg.mods.join(','), cfg.loadoutSig, cfg.boss || '-', cfg.queue.length].join('~');
      cfg.sig = sig;
      const opening = cfg.queue.slice(0, 5).map(s => s.type).join(',');
      cfg.opening = opening;
      // diversity checks — a fair config that fails one is kept as bestEffort
      let divBad = null;
      if (cfg.boss && bossUsed7(cfg.boss)) divBad = 'boss-repeat';
      else if (hist.some(h => h.siege && h.siege.sig === sig)) divBad = 'sig-repeat';
      else if (y && y.siege && y.siege.opening === opening) divBad = 'opening-repeat';
      if (divBad) {
        rejections.push({ attempt, theme: theme.id, why: divBad });
        if (!bestEffort) bestEffort = finalize();
        continue;
      }
      best = finalize();
      break;
    }
    if (!best && bestEffort) {
      best = bestEffort;
      diag('siege-generation-best-effort', { dayKey });
    }
    if (!best) {
      // ultimate fallback — a hand-tuned safe config (should never trigger; QA verifies)
      const wave = generateWave(rng, SIEGE_THEMES[0], [], bracket, 0.9);
      best = {
        id: dayKey + '#fb', dayKey, bracket, theme: 'swarm', themeName: 'Swarm Assault',
        themeDesc: SIEGE_THEMES[0].desc, mods: [], rooms: { archer: 3, mason: 2, bomb: 2 },
        loadoutSig: 'fb', comboSig: 'archer.bomb.mason', topRoom: 'archer',
        castleHp: SIEGE_BRACKET[bracket].castle, startHpFrac: 1, cdMult: 1, convertMax: 1, recruitMult: 1,
        queue: wave.queue, span: wave.span, phases: wave.phases, boss: null, sig: 'fallback|' + dayKey,
        opening: '', genVersion: GEN_VERSION,
        scoring: { killScore: 4000, completionBonus: 1000, hpBonusMax: 800, timeBonusMax: 600, parTime: 240, bronzeFrac: SIEGE_BRONZE_FRAC, bronzeScore: 2800, goldScore: 5600 },
      };
      diag('siege-generation-fallback', { dayKey });
    }
    best.rejections = rejections.length;
    return { config: best, diag: { rejections, bracket } };
  }

  /* ============================================================
     PERSISTENT DAILY STATE
     ============================================================ */
  function dailyState() {
    if (!META.daily || typeof META.daily !== 'object') META.daily = {};
    const st = META.daily;
    if (!Array.isArray(st.history)) st.history = [];
    if (!st.tx || typeof st.tx !== 'object') st.tx = {};
    if (!Array.isArray(st.decrees)) st.decrees = [];
    return st;
  }
  function siegeRunActive() {
    return typeof G !== 'undefined' && G && G.siege && typeof state !== 'undefined' &&
      (state === 'playing' || state === 'paused' || state === 'settings' || state === 'shop' || state === 'howto' || state === 'legal');
  }

  function archiveDay(st) {
    if (!st.dayKey || !st.decrees.length) return;
    const doneCount = st.decrees.filter(d => d.claimed).length;
    const ids = st.decrees.map(d => d.tpl);
    const pairs = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push(pairKey(ids[i], ids[j]));
    const targets = {}, enemies = [], modes = [], mechs = [], cats = [];
    for (const d of st.decrees) {
      targets[d.tpl] = d.target;
      const t = tplById(d.tpl);
      if (t) {
        if (t.enemy) enemies.push(t.enemy);
        if (t.mode) modes.push(t.mode);
        if (t.mech) mechs.push(t.mech);
        cats.push(t.cat);
      }
    }
    const sg = st.siege && st.siege.config ? st.siege.config : null;
    st.history.push({
      day: st.dayKey, decrees: ids, pairs, targets, enemies, modes, mechs, cats,
      sig: decreeSig(ids), done: doneCount,
      siege: sg ? { theme: sg.theme, mods: sg.mods, loadout: sg.loadoutSig, combo: sg.comboSig, topRoom: sg.topRoom, sig: sg.sig, boss: sg.boss || null, opening: sg.opening || '' } : null,
    });
    while (st.history.length > HISTORY_DAYS) st.history.shift();
  }

  let lastGenDiag = null;
  function ensureDaily(force) {
    const st = dailyState();
    ensureKingdom();
    const now = Date.now();
    st.maxSeenTime = Math.max(st.maxSeenTime || 0, now);
    const today = localDayKey();
    const fresh = !(st.dayKey && today <= st.dayKey && st.decrees.length && st.siege && st.siege.config);
    /* A generator upgrade landing mid-day rebuilds TODAY'S SIEGE on the new
       rules rather than leaving the player a whole day of the old ones. Only
       the siege: decree rewards are keyed by slot+template in the tx ledger,
       so reshuffling live decrees could mint a second seal for work already
       paid for. Siege tiers are keyed by tier number alone and the record is
       carried across, so a rebuilt siege can never pay twice either. */
    if (!fresh && !force && st.genVersion !== GEN_VERSION) {
      if (siegeRunActive()) return false;
      const carry = st.siege;
      const rg = generateSiege(today, playerProfile(), st.history);
      st.siege = {
        config: rg.config,
        attempts: carry.attempts || 0, bestScore: carry.bestScore || 0,
        bestTier: carry.bestTier || 0, bestTime: carry.bestTime || 0,
        bestHp: carry.bestHp || 0, sealsGranted: carry.sealsGranted || 0,
      };
      st.genVersion = GEN_VERSION;
      saveMeta();
      diag('siege-regenerated', { day: today, gen: GEN_VERSION, theme: rg.config.theme });
      return true;
    }
    // clock-rollback / timezone protection: the daily key only moves forward
    if (!fresh && !force) return false;
    if (siegeRunActive()) return false;   // never swap the day out from under an active siege run
    if (st.dayKey && st.dayKey !== today) archiveDay(st);
    const profile = playerProfile();
    st.dayKey = today;
    st.genVersion = GEN_VERSION;
    st.bracket = profile.bracket;
    const dg = generateDecrees(today, profile, st.history);
    st.decrees = dg.decrees;
    st.decreeBonusClaimed = false;
    st.rerollUsed = false;
    const sg = generateSiege(today, profile, st.history);
    st.siege = {
      config: sg.config,
      attempts: 0, bestScore: 0, bestTier: 0, bestTime: 0, bestHp: 0, sealsGranted: 0,
    };
    // prune stale transactions (previous days can never be re-claimed anyway)
    const tx = {};
    for (const k of Object.keys(st.tx)) if (k.indexOf(today) === 0) tx[k] = st.tx[k];
    st.tx = tx;
    lastGenDiag = { decrees: dg.diag, siege: sg.diag };
    saveMeta();
    diag('daily-generated', { day: today, bracket: profile.bracket, decrees: st.decrees.map(d => d.tpl), theme: sg.config.theme });
    return true;
  }

  /* ============================================================
     GAMEPLAY EVENT ROUTING → decree progress + siege scoring
     ============================================================ */
  let runCtx = { waveDamaged: false, abilitiesUsed: 0, typesKilled: {} };
  let siegeRt = null;   // live siege attempt runtime

  function decreeProgressEvent(name, data) {
    const st = dailyState();
    if (!st.decrees.length) return;
    let changed = false, completed = null;
    st.decrees.forEach((dec, i) => {
      if (dec.done || dec.claimed) return;
      const tpl = tplById(dec.tpl);
      if (!tpl || !tpl.handlers || !tpl.handlers[name]) return;
      let v;
      try { v = tpl.handlers[name](data, runCtx); } catch (e) { v = 0; }
      if (!v || v <= 0) return;
      const before = dec.progress;
      if (tpl.maxMode) dec.progress = Math.max(dec.progress, Math.min(v, dec.target));
      else dec.progress = Math.min(dec.target, dec.progress + v);
      if (dec.progress !== before) changed = true;
      if (dec.progress >= dec.target && !dec.done) { dec.done = true; completed = i; }
    });
    if (completed !== null) {
      saveMeta();
      try { Sfx.wave(); } catch (e) {}
      diag('decree-complete', { tpl: st.decrees[completed].tpl });
    } else if (changed) {
      saveMetaSoon();
    }
    if (changed && HAS_DOM) {
      if (state === 'daily') renderBoard();
      refreshMenuBadge();
    }
  }

  function event(name, data) {
    data = data || {};
    // per-wave context bookkeeping
    if (name === 'waveStart') { runCtx = { waveDamaged: false, abilitiesUsed: 0, typesKilled: runCtx.typesKilled || {} }; }
    if (name === 'castleDamage') { runCtx.waveDamaged = true; return; }
    if (name === 'ability') runCtx.abilitiesUsed++;
    // live siege scoring
    if (siegeRt && data.inSiege) {
      if (name === 'kill') {
        const th = THREAT[data.type] || 1;
        siegeRt.threatKilled += th;
        siegeRt.kills++;
        let pts = Math.round(th * 100);
        if (data.elite) pts += 150;
        if (data.boss) pts += 500;
        if (data.golden) pts += 100;
        siegeRt.score += pts;
      }
      if (name === 'convert' && data.type) {
        siegeRt.threatKilled += THREAT[data.type] || 1;
        siegeRt.score += 150;
      }
    }
    // decree progress (siege kills count toward combat decrees; wave-scoped
    // decrees are unaffected because waveClear never fires inside a siege)
    decreeProgressEvent(name, data);
  }

  /* ============================================================
     DAILY SIEGE — runtime (start, score, finish, retry)
     ============================================================ */
  const TIER_NAMES = ['—', 'BRONZE', 'SILVER', 'GOLD'];

  function siegeState() { const st = dailyState(); return st.siege || null; }

  function startSiege() {
    ensureDaily();
    const sg = siegeState();
    if (!sg || !sg.config) return;
    const cfg = sg.config;
    sg.attempts++;
    saveMeta();
    newRun(0);
    G.siege = true;
    G.siegeCfg = cfg;
    G.rooms = { archer: 0, mason: 0, mage: 0, bomb: 0, barracks: 0, wall: 0 };
    for (const k of Object.keys(cfg.rooms)) G.rooms[k] = cfg.rooms[k];
    G.castleMax = Math.round(cfg.castleHp);
    G.castleHp = Math.round(cfg.castleHp * (cfg.startHpFrac || 1));
    G.siegeCdMult = cfg.cdMult || 1;
    G.siegeConvertMax = cfg.convertMax || 1;
    G.siegeRecruitMult = cfg.recruitMult || 1;
    G.gold = META.coins;          // HUD shows the untouched wallet
    siegeRt = {
      score: 0, kills: 0, threatKilled: 0,
      threatTotal: cfg.queue.reduce((a, s) => a + (THREAT[s.type] || 1), 0),
      phaseShown: {}, startedAt: Date.now(),
    };
    diag('siege-start', { day: cfg.dayKey, theme: cfg.theme, attempt: sg.attempts });
    try { Sfx.wave(); Sfx.bell(); } catch (e) {}
    startWave(1);
  }

  function buildSiegeQueue() {
    const sg = siegeState();
    if (!sg || !sg.config) return [];
    // fresh copies — the live queue is consumed by updateWaveSpawns
    return sg.config.queue.map(s => ({
      type: s.type, delay: s.delay, hpMult: s.hpMult, spdMult: s.spdMult,
      lane: s.lane, laneFrac: s.laneFrac,
    }));
  }

  /* phase banners via the shared floater system (checked from the 1s ticker) */
  function tickSiegePhases() {
    if (!siegeRt || typeof G === 'undefined' || !G || !G.siege || state !== 'playing') return;
    const cfg = G.siegeCfg;
    if (!cfg || !cfg.phases) return;
    for (const ph of cfg.phases) {
      if (G.waveT >= ph.at && !siegeRt.phaseShown[ph.name] && ph.at > 0) {
        siegeRt.phaseShown[ph.name] = true;
        try { floater(W / 2, 240, ph.name.toUpperCase() + '!', '#ffd77a', 24, 1.8); } catch (e) {}
      }
    }
  }

  function computeSiegeResult(cleared) {
    const cfg = G.siegeCfg, sc = cfg.scoring;
    const hpFrac = Math.max(0, G.castleHp / G.castleMax);
    const time = Math.round(G.time);
    let score = siegeRt.score;
    if (cleared) {
      score += sc.completionBonus;
      score += Math.round(sc.hpBonusMax * hpFrac);
      const par = sc.parTime;
      if (time < par * 1.7) score += Math.round(sc.timeBonusMax * Math.max(0, Math.min(1, (par * 1.7 - time) / (par * 0.7))));
    }
    const killedFrac = siegeRt.threatTotal > 0 ? siegeRt.threatKilled / siegeRt.threatTotal : 0;
    let tier = 0;
    if (cleared) tier = score >= sc.goldScore ? 3 : 2;
    else if (killedFrac >= sc.bronzeFrac || score >= sc.bronzeScore) tier = 1;
    return { score, tier, hpFrac, time, killedFrac, kills: siegeRt.kills, cleared };
  }

  function settleSiege(cleared) {
    const sg = siegeState();
    const res = computeSiegeResult(cleared);
    const prevBestTier = sg.bestTier || 0;
    const prevBestScore = sg.bestScore || 0;
    const newBestScore = res.score > (sg.bestScore || 0);
    sg.bestScore = Math.max(sg.bestScore || 0, res.score);
    sg.bestTier = Math.max(prevBestTier, res.tier);
    if (cleared) {
      sg.bestTime = sg.bestTime ? Math.min(sg.bestTime, res.time) : res.time;
      sg.bestHp = Math.max(sg.bestHp || 0, res.hpFrac);
    }
    // reward: only the improvement over the best already-rewarded tier,
    // one transaction per tier step so a crash can never double-grant
    let sealsNow = 0;
    const st = dailyState();
    let notices = [];
    for (let t = prevBestTier + 1; t <= res.tier; t++) {
      const txId = st.dayKey + '|siege|tier' + t;
      const got = grantSeals(txId, SEAL_REWARDS.perSiegeTier, 'siege');
      if (got) {
        sealsNow += SEAL_REWARDS.perSiegeTier;
        sg.sealsGranted = (sg.sealsGranted || 0) + SEAL_REWARDS.perSiegeTier;
        notices = notices.concat(got);
      }
    }
    saveMeta();   // atomic: tx + tier + seals in one write
    event('siegeTier', { tier: res.tier });
    diag('siege-result', { cleared, tier: res.tier, score: res.score, seals: sealsNow });
    return { res, sealsNow, prevBestTier, prevBestScore, newBestScore, notices };
  }

  function onSiegeCleared() {
    if (!G || !G.siege || !siegeRt) return;
    G.waveActive = false;
    try { releaseGrab(); } catch (e) {}
    const outcome = settleSiege(true);
    try { if (outcome.res.tier >= 3) { Sfx.wave(); Sfx.coin(); } else Sfx.wave(); } catch (e) {}
    showSiegeResult(outcome);
  }
  function onSiegeFailed() {
    if (!G || !G.siege || !siegeRt) return;
    G.waveActive = false;
    try { dropGrab(); } catch (e) {}
    try { Sfx.lose(); } catch (e) {}
    const outcome = settleSiege(false);
    showSiegeResult(outcome);
  }

  function showSiegeResult(outcome) {
    const res = outcome.res;
    const sg = siegeState();
    state = 'siegeResult';
    const img = f => 'assets/castle_ricochet/ui/' + f;
    $('siegeResultBanner').src = res.cleared ? img('ui_banner_victory.png') : img('ui_banner_game_over.png');
    $('siegeResultTitle').textContent = res.cleared ? 'SIEGE REPELLED' : 'THE WALLS ARE BREACHED';
    const tierEl = $('siegeResultTier');
    if (res.tier > 0) {
      let stars = '';
      for (let i = 0; i < res.tier; i++) stars += starImg('siegeTierStar');
      tierEl.innerHTML = stars + `<span class="siegeTierName">${TIER_NAMES[res.tier]}</span>` +
        (res.tier > outcome.prevBestTier ? ' <span class="siegeNewBest">NEW BEST!</span>' : '');
    } else {
      tierEl.innerHTML = '<span class="siegeTierName dimmed">No tier reached</span>';
    }
    const mins = Math.floor(res.time / 60), secs = res.time % 60;
    $('siegeResultStats').innerHTML =
      `<div class="siegeStatRow"><span>Score</span><b>${res.score.toLocaleString()}${outcome.newBestScore ? ' ✦ new best' : ''}</b></div>` +
      `<div class="siegeStatRow"><span>Enemies defeated</span><b>${res.kills}</b></div>` +
      `<div class="siegeStatRow"><span>Challenge progress</span><b>${Math.round(res.killedFrac * 100)}%</b></div>` +
      `<div class="siegeStatRow"><span>Castle health left</span><b>${Math.round(res.hpFrac * 100)}%</b></div>` +
      `<div class="siegeStatRow"><span>Time</span><b>${mins}:${secs < 10 ? '0' : ''}${secs}</b></div>` +
      `<div class="siegeStatRow"><span>Previous best</span><b>${outcome.prevBestTier > 0 ? TIER_NAMES[outcome.prevBestTier] + ' · ' + outcome.prevBestScore.toLocaleString() + ' pts' : '—'}</b></div>`;
    const sealsEl = $('siegeResultSeals');
    if (outcome.sealsNow > 0) {
      sealsEl.innerHTML = `${sealIco('ico big')} +${outcome.sealsNow} Royal Seal${outcome.sealsNow > 1 ? 's' : ''} earned!`;
      sealsEl.classList.remove('hidden');
    } else sealsEl.classList.add('hidden');
    const note = $('siegeResultNote');
    if (outcome.sealsNow === 0 && res.tier > 0 && res.tier <= outcome.prevBestTier) {
      note.textContent = 'Daily Siege reward already claimed at this tier. Beat a higher tier for more Royal Seals!';
      note.classList.remove('hidden');
    } else if (res.tier === 0) {
      note.textContent = res.cleared ? '' : 'Defeat at least 70% of the horde for Bronze. The same siege awaits — try again!';
      note.classList.toggle('hidden', !!res.cleared);
    } else {
      note.textContent = `Daily Siege Seals today: ${sg.sealsGranted || 0} / ${siegeMaxSeals()}`;
      note.classList.remove('hidden');
    }
    siegeRt = null;
    G.siege = false;      // combat over; the run shell is inert behind the panel
    showScreen('siegeResultScreen');
    renderKingdomNotices(outcome.notices);
    refreshMenuBadge();
  }

  function restartSiege() {
    // from the pause menu: abandon the attempt and immediately start anew
    if (!G || !G.siege) return;
    gameConfirm('Restart this Daily Siege attempt? Your current progress in the wave will be lost.',
      { title: 'Restart Daily Siege?', okText: 'Restart', cancelText: 'Keep Fighting' })
      .then(ok => {
        if (!ok || !G || !G.siege) return;
        siegeRt = null;
        startSiege();
      });
  }
  function abandonSiege() {
    if (!G || !G.siege) return;
    gameConfirm('Abandon this Daily Siege attempt? You can retry the same challenge any time today.',
      { title: 'Abandon Daily Siege?', okText: 'Abandon', cancelText: 'Keep Fighting', danger: true })
      .then(ok => {
        if (!ok || !G || !G.siege) return;
        siegeRt = null;
        G.siege = false;
        G.waveActive = false;
        openBoard('siege');
      });
  }
  function closeSiegeResult() { openBoard('siege'); }

  /* ============================================================
     UI — ADVENTURERS' BOARD
     ============================================================ */
  let boardTab = 'decrees';

  function claimableCount() {
    const st = dailyState();
    let n = st.decrees.filter(d => d.done && !d.claimed).length;
    if (st.decrees.length === 3 && st.decrees.every(d => d.claimed) && !st.decreeBonusClaimed) n++;
    return n;
  }
  function sealsStillAvailable() {
    const st = dailyState();
    let n = 0;
    for (const d of st.decrees) if (!d.claimed) n++;
    if (!st.decreeBonusClaimed) n += 2;
    n += 3 - Math.min(3, (st.siege && st.siege.bestTier) || 0);
    return n;
  }

  function refreshMenuBadge() {
    if (!HAS_DOM) return;
    const el = document.getElementById('menuDailyBadge');
    if (!el) return;
    const st = dailyState();
    const claimable = claimableCount();
    const doneCount = st.decrees.filter(d => d.claimed || d.done).length;
    const tier = (st.siege && st.siege.bestTier) || 0;
    const tierName = tier > 0 ? TIER_NAMES[tier].charAt(0) + TIER_NAMES[tier].slice(1).toLowerCase() : '';
    /* The menu entry is an icon button, so the badge is a count pip: it shows
       ONLY when something is claimable and is empty (hidden) otherwise. The
       day's progress summary that used to sit beside the old text button now
       rides along in the button's tooltip, so nothing is lost. */
    el.textContent = claimable > 0 ? String(claimable) : '';
    el.classList.toggle('dailyAlert', claimable > 0);
    const btn = document.getElementById('btnDaily');
    if (btn) {
      btn.setAttribute('data-tip', 'Adventurers’ Board — Royal Decrees ' + doneCount + '/3' +
        (tierName ? ' · Siege: ' + tierName : '') +
        (claimable > 0 ? ' · ' + claimable + ' ready to claim' : ''));
    }
  }

  function openBoard(tab) {
    ensureDaily();
    if (tab) boardTab = tab;
    state = 'daily';
    showScreen('dailyScreen');
    try { Sfx.ui(); } catch (e) {}
    renderBoard();
  }

  function renderBoard() {
    if (!HAS_DOM || state !== 'daily') return;
    const st = dailyState();
    const k = ensureKingdom();
    // header: current SPENDABLE seal balance + reset countdown
    $('boardSeals').textContent = (k.seals || 0).toLocaleString();
    updateResetLabel();
    // tabs
    $('tabDecrees').classList.toggle('activeTab', boardTab === 'decrees');
    $('tabSiege').classList.toggle('activeTab', boardTab === 'siege');
    const decClaims = st.decrees.filter(d => d.done && !d.claimed).length +
      ((st.decrees.length === 3 && st.decrees.every(d => d.claimed) && !st.decreeBonusClaimed) ? 1 : 0);
    $('tabDecreeBadge').textContent = decClaims > 0 ? `(${decClaims}!)` : '';
    const sg = st.siege || {};
    $('tabSiegeBadge').textContent = sg.bestTier > 0 ? TIER_NAMES[sg.bestTier] : '';
    $('decreePane').classList.toggle('hidden', boardTab !== 'decrees');
    $('siegePane').classList.toggle('hidden', boardTab !== 'siege');
    if (boardTab === 'decrees') renderDecreePane();
    else renderSiegePane();
    renderKingdomStrip();
  }

  /* every objective icon renders inside one fixed-size slot; --iscale only
     compensates for transparent padding baked into individual PNGs (the gold
     star art fills barely 58% of its canvas, so it gets a visual boost) */
  const DECREE_ICON_SCALE = {};
  DECREE_ICON_SCALE[STAR_SRC] = 1.3;
  function decreeIconHtml(tpl) {
    const ic = tpl.icon || {};
    let src = null;
    if (ic.msArt && typeof msArtSrc === 'function') src = msArtSrc(ic.msArt);
    else if (ic.src) src = ic.src;
    else if (ic.file) src = TRIM + ic.file;   // shared game.js constant (ui-trimmed pack)
    if (!src) src = krSrc(KR_ICON.scroll);
    const vs = DECREE_ICON_SCALE[src];
    return `<span class="decreeArtSlot"${vs ? ` style="--iscale:${vs}"` : ''}>` +
      `<img src="${src}" alt="" draggable="false"></span>`;
  }

  function renderDecreePane() {
    const st = dailyState();
    const row = $('decreeCards');
    row.innerHTML = '';
    st.decrees.forEach((dec, i) => {
      const tpl = tplById(dec.tpl);
      if (!tpl) return;
      const card = document.createElement('div');
      const stateCls = dec.claimed ? ' claimed' : dec.done ? ' claimable' : dec.progress > 0 ? ' progressing' : '';
      card.className = 'decreeCard' + stateCls;
      const pct = Math.min(100, Math.round(dec.progress / dec.target * 100));
      const catLabel = tpl.cat === 'core' ? 'Core Combat' : tpl.cat === 'tac' ? 'Tactical' : 'Variety';
      card.innerHTML =
        `<div class="decreeTop">${decreeIconHtml(tpl)}<span class="decreeCat">${catLabel}${dec.rerolled ? ' · rerolled' : ''}</span></div>` +
        `<div class="decreeText">${tpl.text(dec.target)}</div>` +
        `<div class="decreeProg"><div class="msBar"><div class="msFill" style="width:${pct}%"></div></div>` +
        `<span class="decreeCount">${dec.claimed ? 'Claimed' : `${Math.min(dec.progress, dec.target).toLocaleString()} / ${dec.target.toLocaleString()}`}</span></div>` +
        `<div class="decreeAction"></div>`;
      const action = card.querySelector('.decreeAction');
      if (dec.claimed) {
        action.innerHTML = `<span class="decreeDone">1 ${sealIco()} earned</span>`;
      } else if (dec.done) {
        const btn = document.createElement('button');
        btn.className = 'roomBtn decreeClaimBtn';
        btn.innerHTML = `Claim 1 ${sealIco()}`;
        btn.addEventListener('click', () => claimDecree(i, btn));
        action.appendChild(btn);
      } else {
        action.innerHTML = `<span class="decreeReward">Reward: 1 ${sealIco()}</span>`;
        if (!st.rerollUsed) {
          const rr = document.createElement('button');
          rr.className = 'bigBtn small ghost rerollBtn';
          rr.title = 'Replace this Decree (1 free per day)';
          rr.textContent = '↻ Reroll';
          rr.addEventListener('click', () => {
            gameConfirm('Replace this Royal Decree with a different one? Progress on it will be lost. You have one free reroll per day.',
              { title: 'Replace this Royal Decree?', okText: '↻ Replace', cancelText: 'Keep It' })
              .then(ok => { if (ok && rerollDecree(i)) { try { Sfx.ui(); } catch (e) {} renderBoard(); } });
          });
          action.appendChild(rr);
        }
      }
      row.appendChild(card);
    });
    // all-three completion bonus row
    const bonus = $('decreeBonusRow');
    const allClaimed = st.decrees.length === 3 && st.decrees.every(d => d.claimed);
    if (st.decreeBonusClaimed) {
      bonus.innerHTML = `<div class="decreeBonus done">${artHtml('icon_crown_gold.png', 'curIco')} All three Decrees honored — bonus ${SEAL_REWARDS.fullSetBonus} ${sealIco()} claimed!</div>`;
    } else if (allClaimed) {
      bonus.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'decreeBonus ready';
      wrap.innerHTML = `<span>All three Decrees complete!</span>`;
      const btn = document.createElement('button');
      btn.className = 'roomBtn decreeClaimBtn';
      btn.innerHTML = `Claim Bonus — ${SEAL_REWARDS.fullSetBonus} ${sealIco()}`;
      btn.addEventListener('click', () => claimDecreeBonus(btn));
      wrap.appendChild(btn);
      bonus.appendChild(wrap);
    } else {
      const claimedN = st.decrees.filter(d => d.claimed).length;
      bonus.innerHTML = `<div class="decreeBonus">Complete all three Decrees for a bonus of ${SEAL_REWARDS.fullSetBonus} ${sealIco()} — ${claimedN} / ${DECREE_SLOTS.length} claimed</div>`;
    }
  }

  let claimBusy = false;
  function claimDecree(idx, btn) {
    if (claimBusy) return;
    claimBusy = true;
    if (btn) btn.disabled = true;
    try {
      const st = dailyState();
      const dec = st.decrees[idx];
      if (!dec || !dec.done || dec.claimed) return;
      const txId = st.dayKey + '|decree|' + idx + '|' + dec.tpl;
      const notices = grantSeals(txId, SEAL_REWARDS.perDecree, 'decree');
      if (notices === null) { dec.claimed = true; saveMeta(); return; }   // tx replay after crash: reconcile flag only
      dec.claimed = true;
      saveMeta();          // tx + grant + claimed flag persist in one write
      try { Sfx.coin(); Sfx.convert(); } catch (e) {}
      renderBoard();
      refreshMenuBadge();
      renderKingdomNotices(notices);
      pulseSeal();
    } finally {
      claimBusy = false;
      if (btn) btn.disabled = false;
    }
  }
  function claimDecreeBonus(btn) {
    if (claimBusy) return;
    claimBusy = true;
    if (btn) btn.disabled = true;
    try {
      const st = dailyState();
      if (st.decreeBonusClaimed || st.decrees.length !== 3 || !st.decrees.every(d => d.claimed)) return;
      const txId = st.dayKey + '|decreeBonus';
      const notices = grantSeals(txId, SEAL_REWARDS.fullSetBonus, 'decree-bonus');
      if (notices === null) { st.decreeBonusClaimed = true; saveMeta(); return; }
      st.decreeBonusClaimed = true;
      saveMeta();
      try { Sfx.coin(); Sfx.wave(); } catch (e) {}
      renderBoard();
      refreshMenuBadge();
      renderKingdomNotices(notices);
      pulseSeal();
    } finally {
      claimBusy = false;
      if (btn) btn.disabled = false;
    }
  }
  function pulseSeal() {
    const el = document.getElementById('boardSeals');
    if (!el) return;
    const pill = el.parentNode;
    pill.classList.remove('sealPulse');
    void pill.offsetWidth;          // restart the CSS animation
    pill.classList.add('sealPulse');
  }

  /* per-room visual normalization: the trimmed room PNGs have very different
     aspect ratios (the Mage Tower is 0.61:1, the Barracks nearly square), so
     in one fixed slot their visible footprints diverge — --iscale evens the
     perceived area without cropping or distorting any sprite */
  const SIEGE_ROOM_SCALE = { archer: 1.08, mason: 1.02, mage: 1.16, bomb: 0.96, barracks: 0.96, wall: 0.98 };
  function renderSiegePane() {
    const st = dailyState();
    const sg = st.siege || {};
    const cfg = sg.config;
    const pane = $('siegePane');
    if (!cfg) { pane.innerHTML = '<p class="subtext">The siege horns are silent. Come back tomorrow!</p>'; return; }
    const roomCards = Object.keys(cfg.rooms).map(id => {
      const def = (typeof ROOMS !== 'undefined' && ROOMS[id]) || { name: id, art: null, icon: '' };
      const vs = SIEGE_ROOM_SCALE[id];
      const art = def.art ? artHtml(def.art, 'siegeRoomArt') : `<span class="siegeRoomArt">${def.icon}</span>`;
      return `<div class="siegeRoomCard"><span class="siegeRoomArtSlot"${vs ? ` style="--iscale:${vs}"` : ''}>${art}</span>` +
        `<div class="siegeRoomName">${def.name}</div><div class="siegeRoomLv">Level ${cfg.rooms[id]}</div></div>`;
    }).join('');
    const modRow = (m) =>
      `<div class="siegeModRow${m.boon ? ' boon' : ''}"><span class="siegeModBullet">${m.boon ? '✦' : '⚠'}</span>` +
      `<span class="siegeModTxt"><b>${m.name}</b> — ${m.desc}</span></div>`;
    const modRows = cfg.mods.length
      ? cfg.mods.map(id => { const m = SIEGE_MODIFIERS.find(x => x.id === id); return m ? modRow(m) : ''; }).join('')
      : modRow({ boon: true, name: 'No modifiers today', desc: 'a pure test of arms.' });
    const featured = [];
    for (const s of cfg.queue) { if (featured.indexOf(s.type) < 0 && featured.length < 5) featured.push(s.type); }
    const featuredTxt = featured.map(enemyName).join(' · ') + (cfg.boss ? ` · <b>${enemyName(cfg.boss)}</b>` : '');
    const tierRow = (n, name, req, active) => {
      let stars = '';
      for (let i = 0; i < n; i++) stars += starImg('siegeTierMini');
      return `<div class="siegeTierRow${active ? ' earned' : ''}">` +
        `<span class="siegeTierStarsCol">${stars}</span>` +
        `<span class="siegeTierLbl"><b>${name}</b> — ${req}</span>` +
        `<span class="siegeTierVal">${n} ${sealIco()}</span></div>`;
    };
    const hpPct = Math.round((cfg.startHpFrac || 1) * 100);
    pane.innerHTML =
      `<div class="siegeBriefGrid">` +
      `<div class="siegeBriefLeft">` +
      `<div class="siegeThemeName">${cfg.themeName}</div>` +
      `<div class="siegeThemeDesc">${cfg.themeDesc}</div>` +
      `<div class="siegeSection">Preset Castle Rooms</div>` +
      `<div class="siegeRoomRow">${roomCards}</div>` +
      `<div class="siegeSection">Modifiers</div><div class="siegeModList">${modRows}</div>` +
      `<div class="siegeFeatured"><b>Expected foes:</b> ${featuredTxt}</div>` +
      `<div class="siegeFeatured"><b>Castle:</b> ${Math.round(cfg.castleHp)} HP${hpPct < 100 ? ` (starts at ${hpPct}%)` : ''} · one long wave · rooms are locked during the siege</div>` +
      `</div>` +
      `<div class="siegeBriefRight">` +
      tierRow(1, 'Bronze', 'hold 70% of the line', sg.bestTier >= 1) +
      tierRow(2, 'Silver', 'repel the full siege', sg.bestTier >= 2) +
      tierRow(3, 'Gold', `score ${cfg.scoring.goldScore.toLocaleString()}+`, sg.bestTier >= 3) +
      `<div class="siegeBest">${sg.attempts > 0 ? `Best today: <b>${sg.bestTier > 0 ? TIER_NAMES[sg.bestTier] : '—'}</b> · ${(sg.bestScore || 0).toLocaleString()} pts · ${sg.attempts} attempt${sg.attempts > 1 ? 's' : ''}` : 'No attempts yet today.'}</div>` +
      `<div class="siegeSeals">Siege Seals today: <b>${sg.sealsGranted || 0} / 3</b></div>` +
      /* the start button and its note are ONE block in normal flow at the
         bottom of the Daily Siege column: the note can never detach from the
         button or drift over the shared Kingdom Restoration footer */
      `<div class="siegeActions">` +
      `<button id="btnSiegePlay" class="bigBtn gold siegePlayBtn"><img class="siegeBtnIco" src="${TRIM}icon_shield.png" alt="" draggable="false">${sg.attempts > 0 ? 'Retry the Siege' : 'Begin the Siege'}</button>` +
      `<div class="siegeRetryNote subtext">Retries face the exact same challenge. Only your best tier is rewarded.</div>` +
      `</div>` +
      `</div></div>`;
    /* A siege is ad-supported gameplay like any run, so it goes through the
       same required-interstitial gate (game.js). Without this, a player who
       owes a forced ad could dodge it indefinitely by playing only the Daily
       Siege. The helper is a no-op when nothing is owed. */
    $('btnSiegePlay').addEventListener('click', () => {
      try { Sfx.ui(); } catch (e) {}
      if (typeof gateEnterGameplay === 'function') gateEnterGameplay(startSiege);
      else startSiege();
    });
  }

  /* ---------------- kingdom strip (board footer summary) ---------------- */
  function renderKingdomStrip() {
    const k = ensureKingdom();
    const strip = $('kingdomStrip');
    if (!strip) return;
    const def = k.activeDistrict ? krDef(k.activeDistrict) : null;
    const allDone = KR_DISTRICTS.every(d => k.districts[d.id].complete);
    const spendBadge = k.seals > 0 ? `<span class="krSpendBadge">${sealIco('krStripSeal')} ${k.seals} to spend</span>` : '';
    /* the strip is one safe-area wrapper inside the footer frame:
       thumbnail | summary (title · bar · metadata) | prosperity total.
       The Back button is the footer grid's own fourth column. */
    const stars = `<div class="kingdomStars">${pstarImg('krStarIco')} ${k.stars}</div>`;
    if (def) {
      const ds = k.districts[def.id];
      const pct = krPct(def, ds);
      strip.innerHTML =
        `<img class="kingdomArt" src="${krStageArt(def, pct)}" alt="" draggable="false">` +
        `<div class="kingdomBody"><div class="kingdomName">Kingdom Restoration — ${def.name}</div>` +
        /* same view model as the project card: precise ratio for the fill,
           floored krPct for the stage art and stage label */
        `<div class="msBar"><div class="msFill" style="width:${krProgressPercent(ds.contributed, def.cost)}%"></div></div>` +
        `<div class="kingdomMeta"><span class="kingdomStat">${ds.contributed} / ${def.cost}` +
        `<span class="krIcoSlot">${sealIco('krStripSeal')}</span> · ${krStageFor(pct).label}</span>${spendBadge}</div></div>` +
        stars;
    } else if (allDone) {
      strip.innerHTML =
        `<img class="kingdomArt" src="${krSrc(KR_ICON.complete)}" alt="" draggable="false">` +
        `<div class="kingdomBody"><div class="kingdomName">Kingdom Restoration — the realm is whole!</div>` +
        `<div class="kingdomMeta"><span class="kingdomStat">Every district flourishes. Banked Seals: ${k.seals}` +
        `<span class="krIcoSlot">${sealIco('krStripSeal')}</span></span></div></div>` +
        stars;
    } else {
      strip.innerHTML =
        `<img class="kingdomArt" src="${krSrc(KR_ICON.project)}" alt="" draggable="false">` +
        `<div class="kingdomBody"><div class="kingdomName">Kingdom Restoration</div>` +
        `<div class="kingdomMeta"><span class="kingdomStat">No active project — open the Kingdom Map to choose a district.</span>${spendBadge}</div></div>` +
        stars;
    }
  }

  /* ---------------- kingdom overlay: map + district panel ---------------- */
  let krView = null;   // null = kingdom map · district id = project panel

  function openKingdomOverlay(districtId) {
    const k = ensureKingdom();
    /* entering the mode is a safe reconciliation point: it is user-driven,
       runs once per open, and the ledger makes it a no-op in the normal case.
       It also covers a save that was migrated while this screen was closed. */
    krReconcileRewards();
    krView = districtId || null;
    $('kingdomOverlay').classList.remove('hidden');
    renderKingdomOverlay();
    krRefreshCrownDisplays();
    /* one combined summary for any backfilled rewards — never nine stacked
       modals — shown through the existing celebration panel, then cleared */
    if (k.pendingRewardSummary && k.pendingRewardSummary.total > 0) {
      const s = k.pendingRewardSummary;
      delete k.pendingRewardSummary;
      saveMeta();
      renderKingdomNotices([{ kind: 'rewardSummary', kingdomCrowns: krNum(s.kingdomCrowns), total: krNum(s.total) }]);
    }
  }
  function closeKingdomOverlay() {
    krSetNoticeOpen(false);
    $('kingdomOverlay').classList.add('hidden');
    krView = null;
    if (state === 'daily') renderKingdomStrip();
  }
  /* Android hardware back inside the overlay: notice → panel → map → close */
  function kingdomBack() {
    if (!HAS_DOM) return false;
    const ov = $('kingdomOverlay');
    if (!ov || ov.classList.contains('hidden')) return false;
    const notice = document.getElementById('krNotice');
    if (notice && !notice.classList.contains('hidden')) { krSetNoticeOpen(false); return true; }
    if (krView) { krView = null; renderKingdomOverlay(); return true; }
    closeKingdomOverlay();
    return true;
  }

  function renderKingdomOverlay() {
    const k = ensureKingdom();
    const panel = $('kingdomPanel');
    const nextMs = KR_MILESTONES.find(m => k.stars < m.stars) || null;
    /* the meter frame sprite's interior is OPAQUE, so it is the track: it
       renders first (underneath), the fill is clipped to the sprite's inner
       well above it, then the cell dividers and the label. The metal border
       and the compass rose are never covered. Width is written by
       krPaintMeter after the panel is in the DOM. */
    const segs = KR_METER_SEGS.map(p => `<i class="krMeterSeg" style="left:${p}%"></i>`).join('');
    const header =
      `<div class="krHeader">` +
      `<h2 class="krTitle">${sealIco('hIco')} Kingdom Restoration</h2>` +
      `<span class="resource inline sealPill" title="Royal Seals ready to spend">${sealIco('resIcon')}<b>${k.seals}</b></span>` +
      `<div class="krMeter" title="Kingdom Prosperity">` +
      `<img class="krMeterFrame" src="${krSrc(KR_UI.meter)}" alt="" draggable="false">` +
      `<div class="krMeterTrough"><div class="krMeterFill krFill"></div>${segs}</div>` +
      `<span class="krMeterLabel">${k.stars} / ${KR_TOTAL_STARS}</span>` +
      `</div>` +
      `</div>`;
    /* the horizontal kingdom map is the mode: it stays visible (and tappable)
       even while a district's project panel is docked over the right edge */
    panel.innerHTML = header +
      `<div class="krBody${krView ? ' hasDock' : ''}">` +
      krMapHtml(k) +
      (krView ? krDistrictHtml(k, krView) : '') +
      `</div>` +
      (krView ? '' :
        `<div class="krHint subtext">Earn Royal Seals ${sealIco()} from Royal Decrees and the Daily Siege, then spend them here. Tap a district to begin its restoration.</div>`) +
      `<div class="krFootRow">` +
      (krView ? `<button id="krBackMap" class="bigBtn small">← Kingdom Map</button>` : '') +
      `<button id="btnKingdomClose" class="bigBtn small">← Back to the Board</button>` +
      `</div>`;
    if (nextMs) {
      const hint = panel.querySelector('.krMeter');
      if (hint) hint.title = `Kingdom Prosperity — next milestone: ${nextMs.name} at ${nextMs.stars} Stars`;
    }
    /* the panel is now in the DOM: paint both meters from canonical state.
       Every path that re-renders the overlay — opening it, save load, picking
       a district, making it active, contributing, crossing a checkpoint,
       finishing a district — lands here, so the fills are never stale. */
    updateKingdomProsperityMeter();
    if (krView) updateDistrictRestorationMeter(krView);
    krBindOverlay(k);
  }

  function krMapHtml(k) {
    let layers =
      `<img class="krLayer" src="${krSrc(KR_MAP_LAYERS.base)}" alt="" draggable="false">` +
      `<img class="krLayer" src="${krSrc(KR_MAP_LAYERS.water)}" alt="" draggable="false">`;
    /* prosperity milestone layers reveal as the kingdom recovers; the ruins
       overlay fades out once the gardens bloom */
    const roadsOn = KR_MILESTONES.some(m => m.layer === 'roads' && k.stars >= m.stars);
    const foliageOn = KR_MILESTONES.some(m => m.layer === 'foliage' && k.stars >= m.stars);
    const lightingOn = KR_MILESTONES.some(m => m.layer === 'lighting' && k.stars >= m.stars);
    if (roadsOn) layers += `<img class="krLayer" src="${krSrc(KR_MAP_LAYERS.roads)}" alt="" draggable="false">`;
    if (!foliageOn) layers += `<img class="krLayer krRuins" src="${krSrc(KR_MAP_LAYERS.ruins)}" alt="" draggable="false">`;
    if (foliageOn) layers += `<img class="krLayer" src="${krSrc(KR_MAP_LAYERS.foliage)}" alt="" draggable="false">`;
    if (lightingOn) layers += `<img class="krLayer krGlow" src="${krSrc(KR_MAP_LAYERS.lighting)}" alt="" draggable="false">`;
    /* districts live ON the map: each renders its current stage art at its
       ground anchor, so the whole kingdom visibly rebuilds from Ruined to
       Flourishing as checkpoints land. Markers/badges layer over the art. */
    let markers = '';
    for (const d of KR_DISTRICTS) {
      const ds = k.districts[d.id];
      const unlocked = krUnlocked(d, k);
      const active = k.activeDistrict === d.id;
      const pct = krPct(d, ds);
      const cp = krNextCheckpoint(ds);
      const ready = unlocked && !ds.complete && cp && k.seals > 0 &&
        k.seals >= krCpSeals(d, cp) - ds.contributed;
      const cls = 'krMarker' + (unlocked ? '' : ' locked') + (ds.complete ? ' complete' : '') +
        (active ? ' active' : '') + (k.newUnlocks[d.id] ? ' fresh' : '') + (ready ? ' ready' : '') +
        (krView === d.id ? ' viewing' : '') + (d.lblAnchor === 'top' ? ' lblTop' : '');
      /* the source PNGs share one icon set but marker widths differ per
         district, so overlay icons are normalized against a 13%-wide marker:
         every lock/badge/seal reads as the same on-map size */
      const norm = 13 / d.w;
      const lockW = (46 * norm).toFixed(1);
      const badgeW = (30 * norm).toFixed(1);
      let badge = '';
      if (ds.complete) badge = `<img class="krBadge" style="width:${badgeW}%" src="${krSrc(KR_ICON.complete)}" alt="Restored" draggable="false">`;
      else if (active) badge = `<img class="krBadge krWorker" style="width:${badgeW}%" src="${krSrc(KR_ICON.worker)}" alt="Under construction" draggable="false">`;
      else if (unlocked && ds.contributed > 0) badge = `<img class="krBadge krHammer" style="width:${badgeW}%" src="${krSrc(KR_ICON.hammer)}" alt="In progress" draggable="false">`;
      const sub = !unlocked ? `${d.unlock} ${pstarImg('krSubStar')}` : ds.complete ? 'Restored' : pct + '%';
      /* NO z-index on the marker itself: the marker must not become a
         stacking context, so its children can layer globally inside .krMap —
         site art by ground-line depth (--mz), labels above ALL art */
      markers +=
        `<div class="${cls}" style="left:${d.map[0]}%;top:${d.map[1]}%;width:${d.w}%;--mz:${10 + Math.round(d.map[1])}" data-d="${d.id}" role="button" tabindex="0">` +
        (k.newUnlocks[d.id] ? `<span class="krNew">NEW</span>` : '') +
        `<img class="krSiteArt" src="${krStageArt(d, pct)}" alt="${d.name}" draggable="false">` +
        (unlocked ? '' : `<img class="krLock" style="width:${lockW}%" src="${krSrc(KR_ICON.locked)}" alt="Locked" draggable="false">`) +
        badge +
        (ready ? `<img class="krReady" style="width:${(24 * norm).toFixed(1)}%" src="${krSrc(KR_ICON.seal)}" alt="Seals ready" draggable="false">` : '') +
        `<div class="krSiteLabel"><span class="krMarkerName">${d.name}</span><span class="krMarkerSub">${sub}</span></div>` +
        `</div>`;
    }
    return `<div class="krMapWrap"><div class="krMap" id="krMap">${layers}${markers}</div></div>`;
  }

  function krDistrictHtml(k, id) {
    const def = krDef(id);
    const ds = k.districts[id];
    const pct = krPct(def, ds);
    const stage = krStageFor(pct);
    const active = k.activeDistrict === id;
    const cp = krNextCheckpoint(ds);
    const maxPut = active ? krMaxContribution() : 0;
    /* checkpoint row: ALWAYS one column per checkpoint (four of them), each
       column stacking node / percentage / reward so the three bands line up
       across the row. State lives on the column, styling on its parts. */
    /* every checkpoint pays one stack of this district's permanent passive on
       top of its Prosperity Stars — the tooltips and the reward lines below
       all read that text from krPassiveText, never from a copied string */
    const perStack = krPassiveText(def.id, 1);
    const heldStacks = krPassiveStacks(k, def);
    const heldText = krPassiveText(def.id, heldStacks);
    let pips = '';
    for (const c of KR_CHECKPOINTS) {
      const done = !!ds.checkpoints[c.pct];
      const cur = !!(cp && cp.pct === c.pct);
      pips += `<div class="krPip ${done ? 'is-complete' : cur ? 'is-current' : 'is-future'}" title="${c.pct}% — ${c.stars} Prosperity Star${c.stars > 1 ? 's' : ''}${perStack ? ' · ' + perStack : ''}">` +
        `<span class="krPipNode"><img src="${krSrc(done ? KR_ICON.pipOn : KR_ICON.pipOff)}" alt="" draggable="false"></span>` +
        `<span class="krPipPct">${c.pct}%</span>` +
        `<span class="krPipStars">${c.stars}<span class="krIcoSlot">${pstarImg('krSubStar')}</span></span></div>`;
    }
    /* three regions inside the parchment: the reading rows (body), the always
       -visible contribution controls, and ONE reserved action slot that
       carries the button OR the status badge — so selecting a project never
       changes the card's geometry, and the controls can never be pushed out */
    let bodyExtra, controls, actionSlot;
    if (ds.complete) {
      bodyExtra =
        `<div class="krCompleteRow"><img class="krCompleteIco" src="${krSrc(KR_ICON.complete)}" alt="" draggable="false">` +
        `<div><b>Fully restored!</b><br>${heldText ? 'Kingdom bonus: <b>' + heldText + '</b>' : 'The ' + def.name + ' flourishes once more.'}</div></div>`;
      controls = '';
      actionSlot = `<div class="krActiveTag krDoneTag"><img src="${krSrc(KR_ICON.complete)}" alt="" draggable="false"><span>Restored</span></div>`;
    } else if (active) {
      const mk = n => `<button class="krBtn krContrib" data-n="${n}" ${maxPut <= 0 ? 'disabled' : ''}>` +
        `${n === 'max' ? 'Max' : '+' + n} ${sealIco('krBtnSeal')}</button>`;
      bodyExtra = k.seals <= 0 ? `<div class="krNoSeals">No Royal Seals banked — complete Decrees and the Daily Siege to earn more.</div>` : '';
      controls = `<div class="krBtnRow">${mk(1)}${mk(5)}${mk('max')}</div>`;
      actionSlot = `<div class="krActiveTag"><img src="${krSrc(KR_ICON.worker)}" alt="" draggable="false"><span>Active Project</span></div>`;
    } else {
      bodyExtra = `<div class="krNoSeals">Progress here is never lost.</div>`;
      controls = '';
      actionSlot = `<button id="krMakeActive" class="krBtn krSelect"><span class="krBtnLbl">Make Active Project</span></button>`;
    }
    /* next-checkpoint block: label line, cost line, reward line — each icon in
       its own fixed inline slot so nothing floats at a stray coordinate */
    const nextBlock = cp
      ? `<span class="krNextLbl">Next checkpoint:</span>` +
        `<span class="krNextLine"><b>${krStageFor(cp.pct).label}</b> at ${krCpSeals(def, cp)}<span class="krIcoSlot">${sealIco('krNextIco')}</span></span>` +
        `<span class="krNextLine">Reward: ${cp.stars}<span class="krIcoSlot">${pstarImg('krNextIco')}</span>${perStack ? ' · ' + perStack : ''}</span>`
      /* no checkpoint left means the district is Flourishing, and the
         completion row below already prints its kingdom bonus — printing it
         here as well would say the same thing twice in one card */
      : `<span class="krNextLbl">Every checkpoint claimed.</span>`;
    /* docked project panel: the parchment card sprite is a framed container.
       .krDock is ONE grid whose rows are pinned to the artwork by the
       --pc-* safe-area variables — banner band (title), parchment band
       (body + action). Nothing is placed with a one-off offset, and no
       content ever lands on the stone frame or the bottom plaque. */
    return `<div class="krDock">` +
      `<div class="krDockHead"><span class="krDockName">${def.name}</span></div>` +
      `<div class="krDockBody">` +
      `<div class="krDockStage">${stage.label} · ${pct}%</div>` +
      `<div class="krDesc">${def.desc}</div>` +
      `<div class="krPips">${pips}</div>` +
      /* full-district model: the numerator, the denominator, the stage
         percentage above and the fill all read ds.contributed / def.cost, so
         crossing a checkpoint keeps filling instead of resetting. The frame
         sprite's interior is opaque, so it is the track underneath. */
      `<div class="krBar">` +
      `<img class="krBarFrame" src="${krSrc(KR_UI.bar)}" alt="" draggable="false">` +
      `<div class="krBarTrough"><div class="krBarFill krFill"></div></div>` +
      `<span class="krBarLabel">${ds.contributed} / ${def.cost}</span></div>` +
      `<div class="krNextRow">${nextBlock}</div>` +
      bodyExtra +
      `</div>` +
      `<div class="krDockControls">${controls}</div>` +
      `<div class="krDockAction">${actionSlot}</div>` +
      `</div>`;
  }

  function krBindOverlay(k) {
    const panel = $('kingdomPanel');
    const close = panel.querySelector('#btnKingdomClose');
    if (close) close.addEventListener('click', () => { try { Sfx.ui(); } catch (e) {} closeKingdomOverlay(); });
    const backMap = panel.querySelector('#krBackMap');
    if (backMap) backMap.addEventListener('click', () => { try { Sfx.ui(); } catch (e) {} krView = null; renderKingdomOverlay(); });
    panel.querySelectorAll('.krMarker').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-d');
        const def = krDef(id);
        if (!def) return;
        if (!krUnlocked(def, k)) {
          try { Sfx.ui(); } catch (e) {}
          el.classList.remove('krDenied');
          void el.offsetWidth;
          el.classList.add('krDenied');
          return;
        }
        if (k.newUnlocks[id]) { delete k.newUnlocks[id]; saveMeta(); }
        try { Sfx.ui(); } catch (e) {}
        krView = id;
        renderKingdomOverlay();
      });
    });
    const makeActive = panel.querySelector('#krMakeActive');
    if (makeActive) makeActive.addEventListener('click', () => {
      /* switching focus never erases any district's contribution */
      k.activeDistrict = krView;
      saveMeta();
      try { Sfx.unlock(); } catch (e) {}
      renderKingdomOverlay();
    });
    panel.querySelectorAll('.krContrib').forEach(btn => {
      btn.addEventListener('click', () => {
        const nAttr = btn.getAttribute('data-n');
        const room = krMaxContribution();
        const amount = nAttr === 'max' ? room : Math.min(parseInt(nAttr, 10) || 0, room);
        if (amount <= 0) { try { Sfx.ui(); } catch (e) {} return; }
        /* contributeSeals ends in syncSealDisplays, which re-renders this
           overlay — counter, bars, pips, buttons and Max are already fresh */
        const notices = contributeSeals(amount);
        try { Sfx.coin(); } catch (e) {}
        krRefreshCrownDisplays();
        renderKingdomNotices(notices);
      });
    });
  }

  /* Crowns granted here land in META.crowns, the one balance every screen
     reads. The menu and Treasury headers rebuild their own markup when those
     screens open, so this only refreshes them in place if they already exist
     — no new display is introduced, and no layout is touched. */
  function krRefreshCrownDisplays() {
    if (!HAS_DOM) return;
    try {
      const menu = document.getElementById('menuCrowns');
      if (menu) menu.innerHTML = `(${META.crowns}${artHtml('icon_crown_gold.png', 'ico')})`;
      const meta = document.getElementById('metaCrowns');
      if (meta) meta.innerHTML = `${META.crowns}${artHtml('icon_crown_gold.png', 'ico')}`;
    } catch (e) {}
  }

  /* checkpoint / completion / milestone / unlock celebrations — themed panel
     with the approved restoration art (never emojis, never a stock alert) */
  function renderKingdomNotices(notices) {
    if (!HAS_DOM || !notices || !notices.length) return;
    const notice = document.getElementById('krNotice');
    const rowsEl = document.getElementById('krNoticeRows');
    const okBtn = document.getElementById('krNoticeOk');
    if (!notice || !rowsEl || !okBtn) return;
    const ico = p => `<img class="krNoticeIco" src="${krSrc(p)}" alt="" draggable="false">`;
    const rewardTxt = r => r.coins ? `+${r.coins.toLocaleString()} coins` : r.crowns ? `+${r.crowns} crowns` : '';
    /* the game's own Crown sprite — never an emoji or a stand-in glyph */
    const crownAmt = n => `${n.toLocaleString()} Crowns ${krCrownIco('krSubStar')}`;
    const rows = notices.map(n => {
      /* the restoration milestone row: district, the percentage reached, the
         permanent bonus THIS milestone paid, and the district's new running
         total. Both figures come from the notice, which read them out of the
         derived totals — the modal never computes a reward of its own, so
         re-opening it cannot re-award or re-count anything. */
      if (n.kind === 'checkpoint') return `${ico(krMedallion(n.pct))}<div>` +
        `<b class="krRewardHead">${n.district} — ${n.pct}% Complete</b>` +
        `<div class="krRewardLine">+${n.stars} Prosperity Star${n.stars > 1 ? 's' : ''} ${pstarImg('krSubStar')}</div>` +
        (n.gained ? `<div class="krRewardLine"><span class="krRewardLbl">Permanent Reward:</span> <b>${n.gained}</b></div>` : '') +
        (n.total ? `<div class="krRewardLine"><span class="krRewardLbl">Total Kingdom Bonus:</span> <b>${n.total}</b></div>` : '') +
        `</div>`;
      if (n.kind === 'complete') return `${ico(KR_ICON.complete)}<div><b>${n.district}</b> fully restored!</div>`;
      if (n.kind === 'kingdomCrowns') return `${ico(KR_ICON.complete)}<div><b>The Kingdom is Restored</b> — every district is now Flourishing.<br>Completion Reward: <b>${crownAmt(n.crowns)}</b></div>`;
      if (n.kind === 'rewardSummary') return `${ico(KR_ICON.complete)}<div><b>Kingdom Restoration Rewards</b><br>` +
        `Kingdom Completion: <b>${crownAmt(n.kingdomCrowns)}</b></div>`;
      if (n.kind === 'milestone') return `${ico(KR_ICON.scroll)}<div>Kingdom milestone — <b>${n.name}</b>: ${n.desc} <b>${rewardTxt(n.reward)}</b></div>`;
      if (n.kind === 'unlock') return `${ico(KR_ICON.marker)}<div>New district unlocked: <b>${n.district}</b>!</div>`;
      return '';
    }).filter(Boolean);
    if (!rows.length) return;
    rowsEl.innerHTML = rows.map(r => `<div class="krNoticeRow">${r}</div>`).join('');
    krSetNoticeOpen(true);
    okBtn.onclick = () => { try { Sfx.ui(); } catch (e) {} krSetNoticeOpen(false); };
    try { Sfx.wave(); } catch (e) {}
  }

  /* single owner of the celebration modal's open state: the backdrop blocks
     and dims everything beneath it, the screen root is inert while open,
     and keyboard/controller focus lands on the one primary action */
  function krSetNoticeOpen(open) {
    const notice = document.getElementById('krNotice');
    const ov = document.getElementById('kingdomOverlay');
    if (!notice) return;
    notice.classList.toggle('hidden', !open);
    if (ov) ov.classList.toggle('krModalOpen', open);
    const panel = document.getElementById('kingdomPanel');
    if (panel) panel.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (open) {
      const okBtn = document.getElementById('krNoticeOk');
      if (okBtn) { try { okBtn.focus(); } catch (e) {} }
    }
  }

  /* ---------------- reset countdown + midnight rollover ---------------- */
  function updateResetLabel() {
    const el = document.getElementById('boardReset');
    if (el) el.textContent = 'Daily Reset in ' + fmtCountdown(msUntilLocalMidnight());
  }
  function minuteTick() {
    // day rollover check (cheap; regenerates only when the local date advances)
    const st = dailyState();
    if (st.dayKey && localDayKey() > st.dayKey && !siegeRunActive()) {
      ensureDaily();
      if (HAS_DOM && state === 'daily') renderBoard();
      refreshMenuBadge();
    }
  }

  /* ============================================================
     DEV DIAGNOSTICS (never in production)
     ============================================================ */
  function devDiagnostics() {
    const st = dailyState();
    return {
      dayKey: st.dayKey, bracket: st.bracket, genVersion: st.genVersion,
      decrees: st.decrees, lastGen: lastGenDiag,
      siege: st.siege && st.siege.config ? {
        theme: st.siege.config.theme, mods: st.siege.config.mods, rooms: st.siege.config.rooms,
        enemies: st.siege.config.queue.length, span: st.siege.config.span,
        scoring: st.siege.config.scoring, sim: st.siege.config.simReport, sig: st.siege.config.sig,
        rejections: st.siege.config.rejections,
      } : null,
      history: st.history.slice(-10),
      kingdom: META.kingdom,
    };
  }

  /* ============================================================
     BOOT (browser only)
     ============================================================ */
  if (HAS_DOM) {
    // screens participate in the shared show/hide flow
    SCREENS.push('dailyScreen', 'siegeResultScreen');
    ensureDaily();
    /* one-time reward reconciliation for saves written before the completion
       Crowns existed. Runs once at boot, off any render path; the entitlement
       ledger makes every later boot a no-op. The Crowns are credited and saved
       here — the summary is only *presented* when the player next opens
       Kingdom Restoration, so the grant can never be lost to a closed app. */
    krReconcileRewards();
    $('btnDaily').addEventListener('click', () => { try { Sfx.unlock(); } catch (e) {} openBoard(); });
    $('btnDailyBack').addEventListener('click', () => { try { Sfx.ui(); } catch (e) {} openMenu(); });
    $('tabDecrees').addEventListener('click', () => { boardTab = 'decrees'; try { Sfx.ui(); } catch (e) {} renderBoard(); });
    $('tabSiege').addEventListener('click', () => { boardTab = 'siege'; try { Sfx.ui(); } catch (e) {} renderBoard(); });
    $('kingdomStrip').addEventListener('click', () => { try { Sfx.ui(); } catch (e) {} openKingdomOverlay(); });
    $('btnSiegeRetry').addEventListener('click', () => {
      try { Sfx.ui(); } catch (e) {}
      if (typeof gateEnterGameplay === 'function') gateEnterGameplay(startSiege);
      else startSiege();
    });
    $('btnSiegeHome').addEventListener('click', () => { try { Sfx.ui(); } catch (e) {} openBoard('siege'); });
    // 1s ticker: reset countdown, phase banners, midnight rollover
    setInterval(() => {
      if (state === 'daily') updateResetLabel();
      tickSiegePhases();
      minuteTick();
    }, 1000);
    refreshMenuBadge();
    if (!isProd()) window.CF_DAILY_DIAG = devDiagnostics;
  }

  /* ============================================================
     GUIDE VALUES — read-only snapshot of the reward configuration
     above, handed to How to Play so every number the guide prints
     is the same number the game grants. Pure data: calling this
     never touches META, the ledger or any daily state.
     ============================================================ */
  function guideValues() {
    const req = krRequiredDistricts();
    const kingdomCrowns = KR_REWARDS.kingdomCompletionCrowns;
    return {
      /* Royal Decrees */
      decreeCount: DECREE_SLOTS.length,
      decreeReward: SEAL_REWARDS.perDecree,
      decreeFullSetBonus: SEAL_REWARDS.fullSetBonus,
      decreeMaxSeals: decreeMaxSeals(),
      /* Daily Siege */
      siegeBronze: SEAL_REWARDS.perSiegeTier,
      siegeSilver: SEAL_REWARDS.perSiegeTier * 2,
      siegeGold: SEAL_REWARDS.perSiegeTier * SEAL_REWARDS.siegeTiers,
      siegeMaxSeals: siegeMaxSeals(),
      siegeBronzePct: Math.round(SIEGE_BRONZE_FRAC * 100),
      /* combined daily ceiling */
      dailyMaxSeals: decreeMaxSeals() + siegeMaxSeals(),
      /* Kingdom Restoration */
      stages: KR_STAGES.map(s => ({ pct: s.pct, label: s.label, icon: krSrc('progress-icons/icon_restoration_' + s.file + '.png') })),
      checkpoints: KR_CHECKPOINTS.map(c => ({ pct: c.pct, stars: c.stars })),
      districtStars: KR_DISTRICT_STARS,
      districts: KR_DISTRICTS.map(d => d.name),
      districtCount: KR_DISTRICTS.length,
      requiredDistrictCount: req.length,
      totalStars: KR_TOTAL_STARS,
      kingdomCrowns,
      /* the permanent district passives, one row per district: what a single
         checkpoint pays and what all four are worth. The guide, the tutorial
         and the reward popup all print these — no number is retyped. */
      passiveStackCount: KR_CHECKPOINTS.length,
      passives: KR_DISTRICTS.filter(d => KR_PASSIVES[d.id]).map(d => ({
        id: d.id, district: d.name,
        perMilestone: krPassiveText(d.id, 1),
        atFull: krPassiveText(d.id, KR_CHECKPOINTS.length),
      })),
      /* the live totals the player currently holds (read-only snapshot) */
      passiveTotals: KR_DISTRICTS.filter(d => KR_PASSIVES[d.id]).map(d => {
        const stacks = kingdomBonuses().stacks[d.id] || 0;
        return { id: d.id, district: d.name, stacks: stacks, total: krPassiveText(d.id, stacks) };
      }),
      medallionIcons: [25, 50, 75, 100].map(p => ({ pct: p, icon: krSrc(krMedallion(p)) })),
      /* sprite paths, so the guide never hard-codes an asset location */
      sealIcon: SEAL_ICON_SRC,
      starIcon: krSrc(KR_ICON.star),
      scrollIcon: krSrc(KR_ICON.scroll),
      hammerIcon: krSrc(KR_ICON.hammer),
      completeIcon: krSrc(KR_ICON.complete),
    };
  }

  /* ============================================================
     PUBLIC API (consumed by game.js / ricochet.js hooks + QA)
     ============================================================ */
  return {
    event,
    guideValues,
    /* THE permanent Kingdom Restoration passives, derived from the saved
       checkpoints on every read. game.js consumes this for castle HP, prices
       and damage; it is a pure snapshot, so calling it can never grant, save
       or double-apply anything. */
    kingdomBonuses,
    kingdomPassiveText: krPassiveText,
    isSiegeActive: () => !!(typeof G !== 'undefined' && G && G.siege),
    buildSiegeQueue,
    onSiegeCleared,
    onSiegeFailed,
    restartSiege,
    abandonSiege,
    closeSiegeResult,
    openBoard,
    refreshMenuBadge,
    ensureDaily,
    devDiagnostics,
    kingdomBack,
    /* consumed by the Adventurers' Board tutorial (tutorial.js) to restore
       the correct overlay view on BACK navigation — same functions the
       Board's own controls call, nothing new */
    openKingdomOverlay,
    closeKingdomOverlay,
    /* pure generation core — exercised directly by the QA harness */
    _gen: {
      generateDecrees, generateSiege, simulateSiege, generateWave, generateLoadout,
      localDayKey, hashStr, mulberry32,
      DECREE_TEMPLATES, SIEGE_THEMES, SIEGE_MODIFIERS, SIEGE_BRACKET, THREAT,
      roomDps, SIM_ENEMY, SIEGE_PACING,          // pacing report (scripts/siege-pacing.js)
      ensureKingdom, grantSeals, contributeSeals, krMaxContribution, dailyState,
      krReconcileRewards, krKingdomComplete, krGrantCrowns, krRequiredDistricts,
      krPassiveStacks, krPassiveText, kingdomBonuses, krMedallion,
      KR_DISTRICTS, KR_CHECKPOINTS, KR_MILESTONES, KR_REWARDS, KR_PASSIVES,
      SEAL_REWARDS, DECREE_SLOTS, SIEGE_BRONZE_FRAC,
      playerProfile, rerollDecree,
    },
  };
})();
