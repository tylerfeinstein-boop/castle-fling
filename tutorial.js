'use strict';
/* ============================================================
   CASTLE FLING — core-game tutorial

   ONE interactive tutorial, TWO entry points.

   Both the first-run auto-launch and the How to Play replay call
   begin() with the same step table, the same practice battlefield,
   the same success conditions and the same cleanup. The only thing
   the entry point changes is how completion is recorded and which
   screen the player is handed back to. There is deliberately no
   "reading-only" variant any more: every launch grabs, flings,
   slams, casts, builds a real Castle Room and upgrades it.

   Presentation is the Castle Ricochet tutorial's, unchanged:
   the same panel (dark fill + gold frame), the same Georgia ramp,
   the same pulsing gold rings, the same Sfx.ui() nav click. Battle
   steps paint on the canvas exactly as before; the Castle Rooms
   steps paint the identical panel in the DOM (#tutOverlay), because
   the real rooms screen is a DOM screen that sits above the canvas.
   Same colours, same type, same pills, same dots — one system.

   Isolation: begin() swaps the live run for a throwaway practice
   run (G.tutorial) and flips game.js' `tutSandbox` gate, so coins,
   crowns, seals, kills, waves, decrees, sieges and room levels that
   happen in here can never reach the save. teardown() puts the real
   run, screen and input state back.

   Loaded AFTER game.js: reuses Castle Fling's canvas, save (META /
   saveMeta), Sfx, Layout, showScreen, newRun and the run state.
   Compat: no ?. / ?? anywhere (Android 7 WebView parse rules).
   ============================================================ */
const CastleFlingTutorial = (() => {

  const VERSION = 2;           // v2 = the unified interactive tutorial
  const FALLBACK_MS = 12000;   // interactive step: CONTINUE unlocks after this
  const NAV_LOCK_MS = 260;     // rapid tapping can never skip two steps
  const ENTER_MS = 190;        // panel entrance (rise + fade)
  const TUT_COINS = 2400;      // practice wallet: Archer Tower build + upgrade
  const TUT_ROOM = 'archer';   // the guided room (offensive, instantly readable)

  /* ---- visual constants: identical values to ricochet.js drawTutorial ---- */
  const PANEL_FILL = 'rgba(16,14,20,.88)';
  const PANEL_EDGE = 'rgba(201,169,74,.9)';
  const TITLE_COL = '#ffd77a';
  const TEXT_COL = '#ffe9b0';
  const SUB_COL = '#c9b98f';
  const DONE_COL = '#9fe0a8';
  const GOLD_RING = 'rgba(255,214,74,.95)';
  const WARN_RING = 'rgba(255,120,90,.95)';
  const PILL_FILL = 'rgba(14,12,18,.82)';     // the Ricochet aim-hint pill
  const PILL_EDGE = 'rgba(201,169,74,.75)';
  const GOLD_A = '#d9a838';                   // .bigBtn.gold gradient stops
  const GOLD_B = '#9a6d1a';
  const GOLD_INK = '#2a1c05';

  /* ---- type ramp ----
     Sizes are world px, so the canvas' own scale carries them; the panel is
     never scaled by one blanket transform. On small landscape phones the
     world is squeezed hard (1280 → ~640 CSS px), so the ramp itself steps up
     just enough that no line ever lands under roughly 13 CSS px. The panel
     box is measured from the wrapped result, so it grows with the type. */
  function fs(k) {
    const s = Layout.scale || 1;                    // world px -> CSS px
    const m = clamp(0.6 / Math.max(0.4, s), 1, 1.35) * (k || 1);
    return {
      title: Math.round(27 * m),
      body: Math.round(23 * m),
      btn: Math.round(19 * m),
      sub: Math.round(16 * m),
      line: Math.round(30 * m),
      pad: Math.round(46 * m),                      // footer button height
    };
  }

  /* ============================================================
     STEP TABLE — one sequence, every launch

     place:  predefined placement class (top | bottom | center | left |
             right | auto) — never per-step pixel coordinates.
     focus:  what the pulsing ring points at (battle steps).
     dom:    step is painted over the REAL Castle Rooms screen.
     target: DOM spotlight target for a dom step.
     need:   required player action; the step will not advance without it
             (except through the deliberate stalled-CONTINUE fallback).
     auto:   success itself moves the tutorial on (the action changed screen).
     live:   reading page that lets the battle keep running underneath.
     ============================================================ */
  const STEPS = [
    {
      id: 'welcome',
      title: 'WELCOME TO CASTLE FLING',
      text: 'Defend your castle from the invading horde. Grab enemies, fling them away, and survive each wave.',
      place: 'top', focus: 'castle',
    },
    {
      id: 'grab',
      title: 'GRAB THE ENEMY',
      text: 'Press and hold anywhere on the enemy’s body to grab them.',
      place: 'top', focus: 'dummy', need: 'enemyGrabbed',
      hint: 'Anywhere on the soldier works — not one tiny point.',
      doneHint: 'Got them! Tap NEXT to continue.',
    },
    {
      id: 'fling',
      title: 'FLING THEM AWAY',
      text: 'Drag to build your throw, then release to fling the enemy. Strong throws deal more damage and keep enemies away from the castle.',
      place: 'top', focus: 'dummy', need: 'enemyFlung',
      hint: 'Grab the soldier, swing, and let go.',
      doneHint: 'Good throw! Tap NEXT to continue.',
    },
    {
      id: 'impact',
      title: 'TURN ENEMIES INTO WEAPONS',
      text: 'Fling enemies into the ground, the castle walls, or into each other. The faster the impact, the more damage it deals.',
      place: 'top', focus: 'dummies', need: 'enemyImpact',
      hint: 'Slam a soldier down hard — or straight into the other one.',
      doneHint: 'That is the idea. Tap NEXT to continue.',
    },
    {
      id: 'castle',
      title: 'PROTECT YOUR CASTLE',
      text: 'Enemies damage the castle when they reach it. If castle health reaches zero, the run ends.',
      place: 'bottom', focus: 'hp',
    },
    {
      id: 'ability',
      title: 'USE YOUR ABILITIES',
      text: 'Tap an ability when it is ready, then tap a target. After use, it must recharge before it can be used again.',
      place: 'top', focus: 'ability', need: 'abilityActivated',
      hint: 'Tap the glowing ability, then tap a soldier.',
      doneHint: 'It is recharging now — watch the button. Tap NEXT.',
    },
    /* ---------------- Castle Rooms: the real screen ---------------- */
    {
      id: 'roomsOpen',
      title: 'BUILD YOUR DEFENSES',
      text: 'After each wave, choose Castle Rooms to strengthen your castle. Each card shows the room, what it does, and what it costs.',
      dom: true, place: 'auto', target: 'list',
    },
    {
      id: 'roomSelect',
      title: 'CHOOSE A CASTLE ROOM',
      text: 'Each room provides a different advantage. Select the highlighted Archer Tower to inspect it.',
      dom: true, place: 'auto', target: 'card', need: 'roomSelected',
      hint: 'Tap the Archer Tower card.',
      doneHint: 'That is the room. Tap NEXT to continue.',
    },
    {
      id: 'roomBuild',
      title: 'BUILD THE ROOM',
      text: 'Tap Build to add this room to your castle.',
      dom: true, place: 'auto', target: 'btn', need: 'roomBuilt',
      hint: 'Tap Build — these practice coins are on the house.',
      doneHint: 'Archer Tower built. Tap NEXT to continue.',
    },
    {
      id: 'roomEffect',
      title: 'ROOMS FIGHT WITH YOU',
      text: 'Built rooms support your castle automatically during waves. Different rooms attack, defend, repair, recruit or unlock abilities.',
      dom: true, place: 'auto', target: 'card',
    },
    {
      id: 'roomUpgrade',
      title: 'UPGRADE YOUR ROOM',
      text: 'Upgrade rooms to make their effects stronger. A room must be built before it can be upgraded.',
      dom: true, place: 'auto', target: 'btn', need: 'roomUpgraded',
      hint: 'Tap Upgrade on the Archer Tower.',
      doneHint: 'Upgraded. Tap NEXT to continue.',
    },
    {
      id: 'roomLevel',
      title: 'ROOM UPGRADED',
      text: 'Your Archer Tower is now Level 2 — it fires faster and hits harder. Higher-level rooms provide stronger effects.',
      dom: true, place: 'auto', target: 'lvl',
    },
    {
      id: 'nextWave',
      title: 'PREPARE FOR THE NEXT WAVE',
      text: 'When your defenses are ready, begin the next wave.',
      dom: true, place: 'auto', target: '#btnNextWave', need: 'nextWavePressed', auto: true,
      hint: 'Tap Next Wave.',
    },
    {
      id: 'waves',
      title: 'SURVIVE THE HORDE',
      text: 'Each wave grows more dangerous. Bosses arrive every ten waves, so strengthen your castle before they appear. Your Archer Tower is already firing.',
      place: 'bottom', focus: 'wave', live: true, noBack: true,
    },
    {
      id: 'smart',
      title: 'FIGHT SMART',
      text: 'Drop a weakened foe in the glowing circle to recruit it — one conversion per wave. Room combinations, recruits and ability timing can turn a hard wave in your favour.',
      place: 'top', focus: 'convert',
    },
    {
      id: 'finish',
      title: 'DEFEND THE KINGDOM',
      text: 'You are ready. Fling the horde, upgrade your castle, and see how many waves you can survive.',
      place: 'center',
    },
  ];

  /* ---------------- save state ---------------- */
  /* Lives under META.tutorials.castleFling. The Castle Ricochet flag
     (META.ricochet.tutorialCompleted) is never read or written here.
     Only three fields are ever persisted — completed, skipped, version.
     Per-step progress is session state and is thrown away on close, so a
     replay always replays every step. */
  function store() {
    if (!META.tutorials || typeof META.tutorials !== 'object') META.tutorials = {};
    const t = META.tutorials;
    if (!t.castleFling || typeof t.castleFling !== 'object') {
      t.castleFling = { completed: false, skipped: false, version: VERSION };
    }
    const cf = t.castleFling;
    if (typeof cf.completed !== 'boolean') cf.completed = false;
    if (typeof cf.skipped !== 'boolean') cf.skipped = false;
    /* a v1 save is left exactly as it is: a player who already finished the
       old tutorial is NOT sent through it again, they replay from How to
       Play if they want the new one */
    if (typeof cf.version !== 'number') cf.version = cf.completed ? 1 : VERSION;
    return cf;
  }

  /* ---------------- session ---------------- */
  let T = null;            // active session, or null
  let suppress = false;    // re-entrancy guard around our own showScreen()
  let lastStepId = null;

  /* A session owns the practice run it created. If anything else replaces G
     (a crash-recovery path, a stray startRun) the session is dropped in place
     rather than "restored" onto a run it does not own. */
  function checkStale() {
    if (!T) return;
    if (typeof G === 'undefined' || !G || T.g !== G) { forceDown(); }
  }

  const cur = () => T.steps[T.i];
  const roomLv = key => (typeof G !== 'undefined' && G && G.rooms ? G.rooms[key] : 0);

  function needOf(st) { return T && st.need ? st.need : null; }
  function textOf(st) { return typeof st.text === 'function' ? st.text() : st.text; }
  /* is the step's own surface on screen right now? */
  function stepVisible(st) { return st.dom ? state === 'build' : state === 'playing'; }

  /* ---------------- gameplay gates (called from game.js) ---------------- */
  /* A reading page freezes the run exactly like a pause: update() is skipped,
     so nothing walks, spawns, cools down or reaches the walls while the
     player reads. Interactive pages — and the deliberately live wave page —
     let physics run so the game feels identical to the real thing. */
  function holdsGameplay() {
    checkStale();
    if (!T || state !== 'playing') return false;
    const st = cur();
    if (st.dom) return true;                 // mid transition to the rooms screen
    return !needOf(st) && !st.live;
  }
  function blocksAbility() { return holdsGameplay(); }
  /* the tutorial owns its practice waves: the field is intentionally emptied
     between steps, which must never read as a cleared wave */
  function blocksWaveEnd() { checkStale(); return !!T; }
  /* explanation pages must never cost the player their castle */
  function shieldsCastle() { checkStale(); return !!T; }
  function isActive() { checkStale(); return !!T; }

  /* ---------------- tutorial enemies ---------------- */
  /* Standing practice dummies: normal wave-1 soldiers with their walk speed
     removed and their HP pinned out of reach, so they can be grabbed, flung
     and slammed for real feedback but can never die and never reach the
     walls. Normal enemy statistics are untouched — only these instances. */
  const DUMMY_MARKS = [[900, 622], [1085, 596]];
  function spawnDummy(x, gy) {
    const e = makeEnemy('soldier', 1);
    e.x = x; e.gy = clamp(gy, GROUND_TOP, GROUND_BOT); e.y = e.gy;
    e.spd = 0;
    e.hp = 999999; e.maxhp = 999999;
    e.tutorial = true;
    e.noReward = true;
    G.enemies.push(e);
    return e;
  }
  function resetDummies() {
    if (typeof G === 'undefined' || !G) return;
    G.enemies.length = 0;
    G.arrows.length = 0; G.bombs.length = 0; G.corpses.length = 0;
    G.particles.length = 0; G.floaters.length = 0; G.slowFields.length = 0;
    P.grabbed.length = 0;
    for (const m of DUMMY_MARKS) spawnDummy(m[0], m[1]);
  }
  /* A reading page freezes the world, so a dummy still airborne from the
     practice fling would hang in mid-air behind the panel. Every non-
     interactive page puts them back on their feet at their marks first. */
  function settleDummies() {
    if (typeof G === 'undefined' || !G || !G.enemies) return;
    let n = 0;
    for (const e of G.enemies) {
      if (!e.tutorial) continue;
      if (e.state === 'grab') { n++; continue; }        // still in hand: leave it there
      const mark = DUMMY_MARKS[Math.min(n, DUMMY_MARKS.length - 1)];
      e.state = 'walk';
      e.vx = 0; e.vy = 0;
      e.spinA = 0; e.spinDir = 0; e.bounces = 0; e.peakY = undefined;
      e.stunT = 0; e.slowT = 0; e.hp = e.maxhp;
      e.trail.length = 0;
      e.x = mark[0]; e.gy = clamp(mark[1], GROUND_TOP, GROUND_BOT); e.y = e.gy;
      n++;
    }
  }

  /* ============================================================
     THE PRACTICE RUN (isolated state)
     ============================================================ */
  function visibleScreen() {
    for (const s of SCREENS) {
      const el = $(s);
      if (el && !el.classList.contains('hidden')) return s;
    }
    return null;                                        // live gameplay
  }

  /* Build a throwaway run and hand the game over to it. Nothing here writes
     to META: game.js' tutSandbox gate turns every persistence chokepoint
     (addGold, spendGold, dailyEvent, lifetime kill counters) into a no-op
     for as long as the flag is up. */
  function makeSandbox() {
    const prev = {
      g: (typeof G !== 'undefined' ? G : null),
      state: state,
      screen: visibleScreen(),
      pauseHidden: $('pauseBtn').classList.contains('hidden'),
    };
    tutSandbox = true;                                  // gate FIRST, then mutate
    P.grabbed.length = 0;
    P.targeting = null;
    newRun(0);                                          // a real run object, Stonekeep
    G.tutorial = true;
    G.nightmare = false;                                // practice is never Nightmare
    G.gold = TUT_COINS;                                 // practice coins, not META.coins
    G.wave = 1;
    G.waveActive = true;
    G.rooms.mage = 1;                                   // one real, unlocked ability
    G.spawnQueue.length = 0;
    G.banner = null; G.bannerT = 0;
    rebuildAbilities();
    resetDummies();
    /* the pause menu could restart or abandon a run that is not really
       running — the tutorial's own SKIP is the way out */
    $('pauseBtn').classList.add('hidden');
    suppress = true;
    try { state = 'playing'; showScreen(null); } finally { suppress = false; }
    uiDirty = true;
    return prev;
  }

  /* ---------------- open / close ---------------- */
  function begin(entry) {
    checkStale();
    if (T) return false;                                // never stack two sessions
    /* a Castle Ricochet attempt owns the canvas — never fight it for the frame */
    if (typeof CastleRicochet !== 'undefined' && CastleRicochet.isActive()) return false;
    const prev = makeSandbox();
    T = {
      entry: entry, steps: STEPS.slice(), i: 0, t: 0, enter: 0,
      navAt: 0, pressT: 0, pressed: null,
      hit: {},                                          // step id -> satisfied (session only)
      stepAt: performance.now(),
      btns: [], prev: prev,
      g: G,
    };
    lastStepId = null;
    hideDom();
    CrashDiagnostics.record('fling-tutorial-open', { entry, version: VERSION, steps: T.steps.length });
    return true;
  }

  /* first run of the core game — mirrors Castle Ricochet, which arms its
     tutorial on the first attempt and never again once completed */
  function startAuto() {
    checkStale();
    if (typeof G === 'undefined' || !G || G.siege) return false;
    if (state !== 'playing') return false;
    if (store().completed) return false;
    return begin('first');
  }

  /* replay from How to Play — the SAME tutorial, start to finish */
  function openReplay() {
    checkStale();
    if (T) return false;
    return begin('replay');
  }

  /* Give the game back exactly what it had: the real run, the real screen,
     clean input, no tutorial furniture anywhere. */
  function teardown() {
    if (!T) return;
    const prev = T.prev;
    T = null;
    lastStepId = null;
    releaseDomLocks();
    hideDom();
    tutSandbox = false;                                 // sandbox gate down
    P.grabbed.length = 0;
    P.targeting = null;
    G = prev.g;
    state = prev.state;
    if (prev.pauseHidden) $('pauseBtn').classList.add('hidden');
    else $('pauseBtn').classList.remove('hidden');
    if (G) { rebuildAbilities(); uiDirty = true; }
    suppress = true;
    try { showScreen(prev.screen); } finally { suppress = false; }
    if (G && state === 'playing') updateHUD();
  }

  /* the session's run vanished under us (crash recovery, an external
     startRun): drop everything we own without touching the new run */
  function forceDown() {
    if (!T) return;
    T = null;
    lastStepId = null;
    releaseDomLocks();
    hideDom();
    tutSandbox = false;
  }

  function finish(skipped) {
    if (!T) return;
    const entry = T.entry, step = T.i;
    const cf = store();
    /* FIRST-TIME launch records the outcome. A REPLAY never overwrites an
       existing flag — it only fills one in for a player who somehow reached
       the replay without the first-run tutorial ever completing. */
    if (entry === 'first' || !cf.completed) {
      cf.completed = true;
      cf.skipped = !!skipped;
      cf.version = VERSION;
      cf.completedAt = Date.now();
      saveMeta();
    }
    CrashDiagnostics.record('fling-tutorial-done', { entry, skipped: !!skipped, step });
    teardown();
  }

  /* leaving without finishing (the run underneath disappeared): clean up but
     leave the flag alone so a first-time player still gets the tutorial */
  function abort() {
    if (!T) return;
    CrashDiagnostics.record('fling-tutorial-abort', { entry: T.entry, step: T.i });
    teardown();
  }

  /* every screen transition funnels through game.js showScreen() */
  function onScreenChange(id) {
    if (!T || suppress) return;
    /* the tutorial drives exactly two surfaces: live gameplay and the real
       Castle Rooms screen. Anything else means something took the game
       away from us (menu, game over, a mode switch) — stand down. */
    if (id === null || id === 'buildScreen') return;
    abort();
  }

  /* ---------------- navigation ---------------- */
  function navReady() {
    const now = performance.now();
    if (now - T.navAt < NAV_LOCK_MS) return false;
    T.navAt = now;
    return true;
  }
  function goto(i) {
    T.i = clamp(i, 0, T.steps.length - 1);
    T.t = 0; T.enter = 0; T.stepAt = performance.now();
  }
  function next() {
    if (!T || !navReady()) return;
    Sfx.ui();
    if (T.i >= T.steps.length - 1) { finish(false); return; }
    goto(T.i + 1);
  }
  function back() {
    if (!T || !navReady()) return;
    if (T.i <= 0 || cur().noBack) return;
    Sfx.ui();
    goto(T.i - 1);
  }
  function skip() {
    if (!T || !navReady()) return;
    Sfx.ui();
    finish(true);
  }

  /* ---------------- interactive success ---------------- */
  /* The ONLY way an interactive step is satisfied: a centralized gameplay
     event (game.js → tutEvent) whose payload matches this step, or a state
     check proving the required outcome already holds. Events are delivered
     synchronously from gameplay, so nothing can be replayed from an earlier
     session, and each step only ever consumes its own event name. */
  function event(name, data) {
    if (!T) return;
    const st = cur();
    if (T.hit[st.id]) return;                           // one-shot per step
    if (needOf(st) !== name) return;                    // no cross-step credit
    const d = data || {};
    if (name === 'roomSelected' && d.room !== TUT_ROOM) return;
    if (name === 'roomBuilt' && (d.room !== TUT_ROOM || d.lv !== 1)) return;
    if (name === 'roomUpgraded' && (d.room !== TUT_ROOM || d.lv < 2)) return;
    T.hit[st.id] = true;
    if (st.auto) next();                                // the action changed screen
  }

  /* re-entering a step whose outcome already happened (the player used BACK)
     must not demand an impossible repeat */
  function alreadySatisfied(st) {
    if (st.need === 'roomBuilt') return roomLv(TUT_ROOM) >= 1;
    if (st.need === 'roomUpgraded') return roomLv(TUT_ROOM) >= 2;
    return false;
  }

  function stepEntered(st) {
    if (!T) return;
    if (alreadySatisfied(st)) T.hit[st.id] = true;
    /* move the game to the surface this step is about */
    if (st.dom) {
      if (state !== 'build') {
        suppress = true;
        try { showBuildScreen(); } finally { suppress = false; }
      }
      return;
    }
    releaseDomLocks();
    hideDom();
    if (state === 'build') {                            // BACK out of the rooms steps
      suppress = true;
      try { state = 'playing'; showScreen(null); } finally { suppress = false; }
      uiDirty = true;
    }
    /* the wave page is the payoff for building the tower: a fresh, safe
       practice field with the real archers firing on it */
    if (st.id === 'waves') { G.spawnQueue.length = 0; resetDummies(); return; }
    /* Every battle step starts from a clean field: the dummies are put back on
       their marks, upright and unhurt. Without this, a soldier still airborne
       from the previous step's throw would land during the NEXT step and
       satisfy it with no new player action (and would hang in mid-air behind
       a reading page). Anything still in the player's hand is left there. */
    settleDummies();
  }

  /* ---------------- per-frame ---------------- */
  function tick(dt) {
    checkStale();
    if (!T) return;
    const st = cur();
    if (lastStepId !== st.id) { lastStepId = st.id; stepEntered(st); }
    if (!stepVisible(st)) { hideDom(); return; }         // paused / mid transition
    T.t += dt;
    T.enter = Math.min(1, T.enter + dt * 1000 / ENTER_MS);
    if (T.pressT > 0) T.pressT = Math.max(0, T.pressT - dt);
  }

  /* ---------------- shared step presentation state ---------------- */
  function stalledNow() { return performance.now() - T.stepAt > FALLBACK_MS; }
  function navState(st) {
    const need = needOf(st);
    const done = !!T.hit[st.id];
    const stalled = !!need && !done && stalledNow();
    const last = T.i >= T.steps.length - 1;
    return {
      need, done, stalled, last,
      nextLabel: last ? 'PLAY ▶' : (stalled ? 'CONTINUE →' : 'NEXT →'),
      nextOn: !need || done || stalled,
      hint: !need ? '' : done ? (st.doneHint || 'Tap NEXT to continue.')
        : stalled ? ((st.hint || '') + '  (or tap CONTINUE)') : (st.hint || ''),
      backOn: T.i > 0 && !st.noBack,
    };
  }

  /* ---------------- geometry helpers ---------------- */
  const ease = q => 1 - Math.pow(1 - q, 3);

  function wrap(text, maxW) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  /* a live DOM control (health bar, ability button, wave counter) mapped into
     world coordinates — reads the RENDERED rect, so the ring follows the
     control through every responsive/safe-area/ui-scale change */
  function domRect(id) {
    const el = $(id);
    if (!el) return null;
    const hud = $('hud');
    if (hud && hud.classList.contains('hidden')) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const c = canvas.getBoundingClientRect();
    if (!c.width || !c.height) return null;
    const sx = W / c.width, sy = H / c.height;
    return { x: (r.left - c.left) * sx, y: (r.top - c.top) * sy, w: r.width * sx, h: r.height * sy };
  }

  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /* ---------------- highlights (same treatment as Castle Ricochet) ---------------- */
  function ring(x, y, r, color) {
    const pulse = 1 + Math.sin(performance.now() / 220) * 0.08;
    ctx.strokeStyle = color; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(x, y, r * pulse, 0, TAU); ctx.stroke();
  }
  function ringRect(rc, color) {
    const pad = 11 + Math.sin(performance.now() / 220) * 3;
    /* HUD controls sit hard against the safe-area edges: keep the whole ring
       inside the visible world instead of letting it clip off-screen */
    const topL = Layout.cropTopL || 0;
    const x0 = Math.max(5, rc.x - pad), y0 = Math.max(topL + 5, rc.y - pad);
    const x1 = Math.min(W - 5, rc.x + rc.w + pad), y1 = Math.min(H - 5, rc.y + rc.h + pad);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.strokeStyle = color; ctx.lineWidth = 5;
    roundRectPath(x0, y0, x1 - x0, y1 - y0, 14);
    ctx.stroke();
  }
  function demoArrow(x, y) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-Math.PI / 3.2);
    ctx.strokeStyle = 'rgba(255,214,74,.9)'; ctx.lineWidth = 9; ctx.lineCap = 'round';
    const l = 110 + Math.sin(performance.now() / 300) * 45;
    ctx.beginPath(); ctx.moveTo(34, 0); ctx.lineTo(l, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(l + 24, 0); ctx.lineTo(l - 6, -14); ctx.lineTo(l - 6, 14); ctx.closePath();
    ctx.fillStyle = 'rgba(255,214,74,.9)'; ctx.fill();
    ctx.lineCap = 'butt';
    ctx.restore();
  }

  function drawFocus(st) {
    const f = st.focus;
    if (!f) return;
    /* the stronghold occupies x 0..430, y 100..720 — this ring hugs it and
       still clears the top/bottom edges of the 1280×720 world */
    if (f === 'castle') { ring(240, 432, 200, GOLD_RING); return; }
    if (f === 'convert') { if (typeof CONVERT !== 'undefined') ring(CONVERT.x, CONVERT.y, CONVERT.r + 24, GOLD_RING); return; }
    if (f === 'dummy' || f === 'dummies') {
      let n = 0;
      if (typeof G !== 'undefined' && G && G.enemies) {
        for (const e of G.enemies) {
          if (!e.tutorial) continue;
          const h = e.def.dispH || e.r * 3;
          ring(e.x, e.y - h / 2, h * 0.62, n === 0 ? GOLD_RING : WARN_RING);
          if (st.id === 'fling' && n === 0 && e.state !== 'grab') demoArrow(e.x, e.y - h / 2);
          n++;
          if (f === 'dummy') break;
        }
      }
      return;
    }
    if (f === 'hp') { const r = domRect('castleBarWrap'); if (r) ringRect(r, GOLD_RING); return; }
    if (f === 'ability') {
      /* one specific, unlocked ability button — never a locked slot */
      const a = (typeof G !== 'undefined' && G && G.abilities.length) ? G.abilities[0] : null;
      const r = a ? domRect('ab_' + a.id) : domRect('abilityBar');
      if (r && r.w > 4) ringRect(r, GOLD_RING);
      return;
    }
    if (f === 'wave') { const r = domRect('hudTopCenter'); if (r) ringRect(r, GOLD_RING); return; }
  }

  /* ---------------- canvas panel layout ----------------
     The canvas panel obeys the same rule as the DOM panel: it is measured from
     its wrapped text and it never runs past what the player can actually see.
     "Visible" is not H — full-bleed crops the top of the world on every screen
     wider than 16:9 (a 20:9 phone loses ~144 world px), so the band is
     [cropTopL, H]. If a step cannot fit that band the whole ramp shrinks
     together, exactly like --tut-fit on the DOM panel. */
  const CANVAS_FIT_MIN = 0.68;
  function measurePanel(st, side, k) {
    const F = fs(k);
    const padX = Math.round(F.body * 1.13);
    const pw = side ? Math.min(620, Math.max(360, W * 0.48)) : Math.min(880, W - 72);
    ctx.font = 'bold ' + F.body + 'px Georgia';
    const lines = wrap(textOf(st), pw - padX * 2);
    const hintH = needOf(st) ? F.sub + 12 : 0;
    const ph = 30 + F.title + 12 + lines.length * F.line + hintH + 14 + F.pad + 16;
    return { F, padX, w: pw, h: ph, lines };
  }
  function layout(st) {
    const topL = Layout.cropTopL || 0;
    const side = st.place === 'left' || st.place === 'right';
    const avail = H - topL - 20;
    let k = 1, b = measurePanel(st, side, k);
    while (b.h > avail && k > CANVAS_FIT_MIN) {
      k = Math.max(CANVAS_FIT_MIN, Math.round((k - 0.04) * 100) / 100);
      b = measurePanel(st, side, k);
    }
    const pw = b.w, ph = b.h;
    let x = (W - pw) / 2, y;
    if (st.place === 'top') y = topL + 74;
    else if (st.place === 'bottom') y = H - ph - 22;
    else if (st.place === 'center') y = topL + (H - topL - ph) / 2;
    else { y = topL + (H - topL - ph) / 2; x = st.place === 'left' ? 40 : W - pw - 40; }
    /* the box must always stay fully inside the visible game area */
    y = clamp(y, topL + 10, Math.max(topL + 10, H - ph - 10));
    x = clamp(x, 10, Math.max(10, W - pw - 10));
    return { x, y, w: pw, h: ph, lines: b.lines, padX: b.padX, F: b.F };
  }

  function pill(label, x, y, h, primary, enabled, id, box) {
    const F = box.F;
    ctx.font = 'bold ' + F.btn + 'px Georgia';
    const w = Math.max(F.btn * 5, ctx.measureText(label).width + F.btn * 2);
    const rc = { id, x: x, y: y, w, h };
    const down = T.pressed === id && T.pressT > 0;
    ctx.save();
    if (down) ctx.translate(0, 2);
    ctx.globalAlpha = enabled ? 1 : 0.42;
    if (primary) {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, GOLD_A); g.addColorStop(1, GOLD_B);
      ctx.fillStyle = g; ctx.strokeStyle = TEXT_COL;
    } else {
      ctx.fillStyle = PILL_FILL; ctx.strokeStyle = PILL_EDGE;
    }
    ctx.lineWidth = primary ? 3 : 2;
    roundRectPath(x, y, w, h, h / 2);
    ctx.fill(); ctx.stroke();
    if (down) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill(); }
    ctx.fillStyle = primary ? GOLD_INK : TEXT_COL;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
    ctx.restore();
    if (enabled) T.btns.push(rc);
    return w;
  }

  /* F comes from the panel, not fs(): on a shrunk panel a full-scale counter
     would be the one thing in the footer that did not come down with it */
  function drawDots(cx, cy, n, at, maxW, F) {
    const gap = 17, r = 5;
    if (n * gap > maxW) {                      // no room: the Ricochet step counter instead
      ctx.font = F.sub + 'px Georgia';
      ctx.fillStyle = SUB_COL; ctx.textAlign = 'center';
      ctx.fillText((at + 1) + ' / ' + n, cx, cy + 5);
      ctx.textAlign = 'left';
      return;
    }
    const x0 = cx - (n - 1) * gap / 2;
    for (let i = 0; i < n; i++) {
      ctx.beginPath(); ctx.arc(x0 + i * gap, cy, r, 0, TAU);
      if (i === at) { ctx.fillStyle = TITLE_COL; ctx.fill(); }
      else if (i < at) { ctx.fillStyle = 'rgba(201,169,74,.55)'; ctx.fill(); }
      else { ctx.strokeStyle = 'rgba(201,169,74,.45)'; ctx.lineWidth = 2; ctx.stroke(); }
    }
  }

  /* ---------------- draw ---------------- */
  function draw() {
    checkStale();
    if (!T) return;
    const st = cur();
    if (!stepVisible(st)) return;
    if (st.dom) { paintDom(st); return; }

    const N = navState(st);
    const box = layout(st);
    const F = box.F;
    T.btns = [];

    ctx.save();
    drawFocus(st);

    /* panel entrance: short rise + fade (matches the Ricochet panel weight) */
    const q = ease(clamp(T.enter, 0, 1));
    ctx.globalAlpha = q;
    ctx.translate(0, (1 - q) * 16);

    ctx.fillStyle = PANEL_FILL;
    ctx.strokeStyle = PANEL_EDGE; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fill(); ctx.stroke();

    const cx = box.x + box.w / 2;
    ctx.textAlign = 'center';
    ctx.font = 'bold ' + F.title + 'px Georgia';
    ctx.fillStyle = TITLE_COL;
    ctx.fillText(st.title, cx, box.y + 30 + F.title * 0.82);

    ctx.font = 'bold ' + F.body + 'px Georgia';
    ctx.fillStyle = TEXT_COL;
    let ty = box.y + 30 + F.title + 12 + F.body * 0.82;
    for (const l of box.lines) { ctx.fillText(l, cx, ty); ty += F.line; }

    /* interactive instruction line (never a wall of text: one short line) */
    if (N.need) {
      ctx.font = F.sub + 'px Georgia';
      ctx.fillStyle = N.done ? DONE_COL : SUB_COL;
      ctx.fillText(N.hint, cx, ty + 2);
    }
    ctx.textAlign = 'left';

    /* ---- footer: Back · progress · Skip · Next ---- */
    const bh = F.pad;
    const gap = Math.round(F.btn * 0.55);
    const by = box.y + box.h - 16 - bh;
    let leftX = box.x + box.padX;
    if (N.backOn) leftX += pill('← BACK', leftX, by, bh, false, true, 'back', box) + gap;
    const measure = txt => { ctx.font = 'bold ' + F.btn + 'px Georgia'; return Math.max(F.btn * 5, ctx.measureText(txt).width + F.btn * 2); };
    const rightX = box.x + box.w - box.padX - measure(N.nextLabel);
    pill(N.nextLabel, rightX, by, bh, true, N.nextOn, 'next', box);
    let skipRight = rightX;
    if (!N.last) {
      skipRight = rightX - gap - measure('SKIP');
      pill('SKIP', skipRight, by, bh, false, true, 'skip', box);
    }
    const midL = leftX, midR = skipRight - gap;
    if (midR - midL > 40) drawDots((midL + midR) / 2, by + bh / 2, T.steps.length, T.i, midR - midL - 12, F);

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ============================================================
     DOM OVERLAY — the same panel over the real Castle Rooms screen

     The rooms screen is a DOM screen stacked above the canvas, so the
     canvas panel cannot reach it. This paints the identical treatment in
     the DOM: same fill and gold frame, same Georgia ramp, same colours,
     same gold pills, same dots, same entrance. The spotlight, ring and
     pointer are positioned from the target's LIVE getBoundingClientRect
     every frame, so they stay locked to the control through responsive
     regrids, rotation, safe-area changes and re-renders of the room list.
     ============================================================ */
  const dom = {};                 // cached element handles
  let domShown = false;
  let domPaintedStep = null;      // avoid re-writing text every frame
  let domPaintedHint = null;
  let domPaintedNav = null;

  function domEls() {
    if (dom.root) return dom.root;
    dom.root = $('tutOverlay');
    if (!dom.root) return null;
    dom.safe = $('tutSafe');
    dom.spot = $('tutSpot');
    dom.arrow = $('tutArrow');
    dom.box = $('tutBox');
    dom.body = $('tutBody');
    dom.title = $('tutTitle');
    dom.text = $('tutText');
    dom.hint = $('tutHint');
    dom.dots = $('tutDots');
    dom.back = $('tutBack');
    dom.skip = $('tutSkip');
    dom.next = $('tutNext');
    return dom.root;
  }

  function hideDom() {
    if (!domShown) return;
    const root = domEls();
    domShown = false;
    domPaintedStep = null;
    if (root) { root.classList.add('hidden'); root.classList.remove('dimAll'); }
  }

  /* target resolution — always the REAL rendered control */
  function targetEl(st) {
    const t = st.target;
    if (!t) return null;
    if (t === 'list') return $('roomList');
    const card = document.querySelector('#roomList .roomCard[data-room="' + TUT_ROOM + '"]');
    if (t === 'card') return card;
    if (t === 'btn') return card ? card.querySelector('.roomBtn') : null;
    if (t === 'lvl') return card ? card.querySelector('.roomLvl') : null;
    return document.querySelector(t);
  }

  /* Which controls this step allows, and which are visibly de-emphasized.
     Re-applied every frame because renderBuild() rebuilds the card DOM after
     every build and upgrade. */
  function applyDomLocks(st) {
    const bs = $('buildScreen');
    if (bs) bs.classList.add('tutBuildLock');
    const nw = $('btnNextWave');
    if (nw) nw.classList.toggle('tutHold', st.id !== 'nextWave');
    const focusRoom = st.target === 'card' || st.target === 'btn' || st.target === 'lvl';
    const liveBtn = st.id === 'roomBuild' || st.id === 'roomUpgrade';
    const cards = document.querySelectorAll('#roomList .roomCard');
    for (const c of cards) {
      const isT = c.dataset.room === TUT_ROOM;
      c.classList.toggle('tutTarget', isT && focusRoom);
      c.classList.toggle('tutDim', !isT && focusRoom);
      /* the Build/Upgrade button is only live on the step that asks for it —
         so one press can never satisfy two steps at once */
      c.classList.toggle('tutNoBtn', !(liveBtn && isT));
      c.classList.toggle('tutPick', isT && st.id === 'roomSelect');
    }
  }
  function releaseDomLocks() {
    const bs = $('buildScreen');
    if (bs) bs.classList.remove('tutBuildLock');
    const nw = $('btnNextWave');
    if (nw) nw.classList.remove('tutHold');
    const cards = document.querySelectorAll('#roomList .roomCard');
    for (const c of cards) c.classList.remove('tutTarget', 'tutDim', 'tutNoBtn', 'tutPick');
  }

  /* ---- the visible game area, measured (never window.innerHeight) ----
     window.innerWidth/Height is the raw window: on Android it still counts the
     status/navigation bars and it does not move with the URL bar, so a panel
     clamped against it lands under the system chrome or off the bottom edge.
     #tutSafe resolves 100dvh minus the safe-area insets for us; the result is
     intersected with the game container so a letterboxed canvas cannot push
     the panel into the surrounding black bars either. Re-read every frame, so
     resize, rotation and safe-area changes are picked up with no listener. */
  const MARGIN = 12;         // clear gap kept between panel and viewport edge
  const GAP = 12;            // clear gap kept between panel and spotlight
  const MIN_BOX_H = 92;      // below this the panel stops being readable
  const MIN_BOX_W = 190;

  function viewRect() {
    let r = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const probe = dom.safe;
    if (probe) {
      const b = probe.getBoundingClientRect();
      if (b.width > 40 && b.height > 40) r = { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    const gc = $('gameContainer');
    if (gc) {
      const g = gc.getBoundingClientRect();
      const x0 = Math.max(r.x, g.left), y0 = Math.max(r.y, g.top);
      const x1 = Math.min(r.x + r.w, g.right), y1 = Math.min(r.y + r.h, g.bottom);
      if (x1 - x0 > 40 && y1 - y0 > 40) r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return r;
  }

  /* the padded spotlight box for an element, clipped to the visible area, or
     null if it has not rendered (or has been scrolled out of sight) */
  function spotRect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return null;
    const V = viewRect();
    const pad = 8;
    const x0 = Math.max(V.x, r.left - pad), y0 = Math.max(V.y, r.top - pad);
    const x1 = Math.min(V.x + V.w, r.right + pad), y1 = Math.min(V.y + V.h, r.bottom + pad);
    if (x1 - x0 <= 2 || y1 - y0 <= 2) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* Cap the panel. The cap is only ever the height the panel actually needs —
     the panel does not scroll, so a cap below its content would cut the step
     in half. See fitInto() for how that height is made to fit. */
  let sizedW = null, sizedH = null;
  function sizeBox(maxW, maxH) {
    const w = Math.round(Math.max(MIN_BOX_W, maxW));
    const h = Math.round(Math.max(MIN_BOX_H, maxH));
    if (w === sizedW && h === sizedH) return;
    sizedW = w; sizedH = h;
    dom.box.style.maxWidth = w + 'px';
    dom.box.style.maxHeight = h + 'px';
  }

  /* ---- one panel, always whole ----
     Every step has to be readable in one look on every screen, so nothing here
     is allowed to clip and nothing scrolls. Two levers, in this order:
       1. a READING step (no control to tap under the spotlight) may sit on top
          of the spotlight, anchored to the viewport edge, which buys it the
          whole safe height instead of the leftover gap beside the highlight;
       2. --tut-fit shrinks type, padding and pill height together until the
          panel's natural height fits the space placement settled on.
     A step that asks for a tap never takes lever 1 — the control it names has
     to stay uncovered — so on a short screen it takes lever 2 alone. */
  const FIT_MIN = 0.68;      // below this the panel stops being readable
  const FIT_STEP = 0.04;
  let appliedFit = null;
  function setFit(f) {
    if (f === appliedFit) return;
    appliedFit = f;
    dom.box.style.setProperty('--tut-fit', String(f));
  }
  /* the height the panel WANTS at the current fit: uncapped, so it reports the
     content height rather than whatever cap the last frame happened to leave */
  function naturalH(maxW) {
    const b = dom.box;
    b.style.maxHeight = 'none';
    b.style.maxWidth = Math.round(Math.max(MIN_BOX_W, maxW)) + 'px';
    /* ceil, not offsetHeight: a cap rounded DOWN off a fractional layout
       height shaves the last line by a pixel, and this panel never clips */
    const h = Math.ceil(b.getBoundingClientRect().height);
    sizedW = sizedH = null;                 // written behind sizeBox's back
    return h;
  }
  /* shrink until the whole step fits maxH, and report the height it settled
     on. Keyed and cached: placement runs every frame, this must not re-measure
     every frame. Caps are quantised so a 1px spotlight jitter cannot thrash it. */
  /* the panel's full-scale size, cached the same way — placement needs it every
     frame to decide which sides fit, and re-measuring it every frame would mean
     a forced layout (and a fit flip-flop) on every frame of every step */
  let natKey = '', natVal = { w: 0, h: 0 };
  function naturalSize(maxW, key) {
    const k = key + '|' + Math.round(maxW);
    if (k === natKey) return natVal;
    setFit(1);
    const h = naturalH(maxW);
    natVal = { w: dom.box.offsetWidth, h: h };
    natKey = k;
    return natVal;
  }
  let fitKey = '', fitVal = 1, fitH = 0;
  function fitInto(maxW, maxH, key) {
    const k = key + '|' + Math.round(maxW) + '|' + Math.round(maxH);
    if (k === fitKey) { setFit(fitVal); return fitH; }
    let f = 1;
    setFit(f);
    let h = naturalH(maxW);
    while (h > maxH && f > FIT_MIN) {
      f = Math.max(FIT_MIN, Math.round((f - FIT_STEP) * 100) / 100);
      setFit(f);
      h = naturalH(maxW);
    }
    fitKey = k; fitVal = f; fitH = h;
    return h;
  }
  /* everything that can change the measured height inside one step */
  function contentKey(st) {
    return (st && st.id) + '|' + dom.text.innerHTML.length + '|' + dom.title.textContent.length +
      '|' + dom.hint.textContent.length + '|' + (dom.hint.classList.contains('hidden') ? 0 : 1) +
      '|' + dom.next.textContent + '|' + (dom.back.classList.contains('hidden') ? 0 : 1) +
      /* dots vs the "7 / 21" counter changes how the nav row wraps, and that
         changes the panel's height — syncDots() flips it AFTER placement, so
         without it here the next frame would reuse a height that no longer
         matches what is on screen */
      '|' + (dom.dots.classList.contains('count') ? 1 : 0) +
      '|' + (dom.skip.classList.contains('hidden') ? 0 : 1);
  }
  const quant = v => Math.max(0, Math.floor(v / 4) * 4);

  /* can the panel sit fully clear of this spotlight on any side? Measured at
     full scale — a panel already shrunk by an earlier step would say yes to a
     gap the step at hand cannot actually use. */
  function fitsBeside(rect, st) {
    const V = viewRect();
    const nat = naturalSize(quant(V.w - MARGIN * 2), contentKey(st));
    const bw = nat.w, bh = nat.h;
    return ((V.y + V.h - MARGIN) - (rect.y + rect.h + GAP) >= bh) ||
      ((rect.y - GAP) - (V.y + MARGIN) >= bh) ||
      ((V.x + V.w - MARGIN) - (rect.x + rect.w + GAP) >= bw) ||
      ((rect.x - GAP) - (V.x + MARGIN) >= bw);
  }

  /* Place the panel on the side of the spotlight with the most room, sized to
     that gap, then clamp it fully inside the measured viewport. Sizes come
     from offsetWidth/offsetHeight — the LAYOUT box — so the entrance
     animation's transform can never feed a wrong number back into placement.
     Runs every frame, which is what makes it survive resize and rotation. */
  function placeBox(rect, st) {
    const box = dom.box;
    const V = viewRect();
    const prefer = st && st.place;
    const key = contentKey(st);
    const availW = quant(V.w - MARGIN * 2), availH = quant(V.h - MARGIN * 2);
    let x, y;

    if (!rect) {                                        // no target: centered-safe
      box.dataset.dir = 'none';
      const bh0 = fitInto(availW, availH, key);
      sizeBox(availW, bh0);
      const bw0 = box.offsetWidth;
      box.style.left = Math.round(V.x + (V.w - bw0) / 2) + 'px';
      box.style.top = Math.round(V.y + (V.h - bh0) / 2) + 'px';
      return null;
    }

    /* room left on each side of the spotlight, inside the safe viewport */
    const room = {
      bottom: quant((V.y + V.h - MARGIN) - (rect.y + rect.h + GAP)),
      top: quant((rect.y - GAP) - (V.y + MARGIN)),
      right: quant((V.x + V.w - MARGIN) - (rect.x + rect.w + GAP)),
      left: quant((rect.x - GAP) - (V.x + MARGIN)),
    };

    /* the NATURAL size at full scale is what decides which sides fit — never
       the size a previous frame's cap left the panel at */
    const nat = naturalSize(availW, key);
    const natH = nat.h, natW = nat.w;
    const fits = d => (d === 'bottom' || d === 'top')
      ? room[d] >= natH
      : (room[d] >= natW && availH >= natH);

    let dir = (prefer && prefer !== 'auto' && room[prefer] !== undefined && fits(prefer)) ? prefer : null;
    if (!dir) {
      /* vertical first (the panel is wide), then horizontal */
      if (fits('bottom')) dir = 'bottom';
      else if (fits('top')) dir = 'top';
      else if (fits('right')) dir = 'right';
      else if (fits('left')) dir = 'left';
      /* nothing fits at the natural size: take the biggest gap */
      else {
        const best = Math.max(room.bottom, room.top, room.right, room.left);
        dir = best === room.bottom ? 'bottom' : best === room.top ? 'top'
          : best === room.right ? 'right' : 'left';
      }
    }

    /* lever 1 — a reading step with no gap big enough stops fighting for the
       gap and takes the whole safe height, sitting over the spotlight from the
       viewport edge. A step that asks for a tap keeps its control clear. */
    const overlay = !fits(dir) && !needOf(st);
    let capW, capH;
    if (dir === 'bottom' || dir === 'top') { capW = availW; capH = overlay ? availH : Math.min(availH, room[dir]); }
    else { capW = overlay ? availW : Math.min(availW, room[dir]); capH = availH; }

    /* lever 2 — shrink into whatever that came to. The cap handed to sizeBox is
       the FITTED height, never the gap: the panel is never shorter than the
       step it is showing, so nothing is ever cut off. */
    const bh = fitInto(capW, capH, key);
    sizeBox(capW, bh);
    const bw = box.offsetWidth;

    if (overlay) {
      if (dir === 'bottom') { x = rect.x + rect.w / 2 - bw / 2; y = V.y + V.h - MARGIN - bh; }
      else if (dir === 'top') { x = rect.x + rect.w / 2 - bw / 2; y = V.y + MARGIN; }
      else if (dir === 'right') { x = V.x + V.w - MARGIN - bw; y = rect.y + rect.h / 2 - bh / 2; }
      else { x = V.x + MARGIN; y = rect.y + rect.h / 2 - bh / 2; }
    }
    else if (dir === 'bottom') { x = rect.x + rect.w / 2 - bw / 2; y = rect.y + rect.h + GAP; }
    else if (dir === 'top') { x = rect.x + rect.w / 2 - bw / 2; y = rect.y - bh - GAP; }
    else if (dir === 'right') { x = rect.x + rect.w + GAP; y = rect.y + rect.h / 2 - bh / 2; }
    else { x = rect.x - bw - GAP; y = rect.y + rect.h / 2 - bh / 2; }

    x = clamp(x, V.x + MARGIN, Math.max(V.x + MARGIN, V.x + V.w - bw - MARGIN));
    y = clamp(y, V.y + MARGIN, Math.max(V.y + MARGIN, V.y + V.h - bh - MARGIN));
    box.dataset.dir = dir;
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
    return dir;
  }

  /* the animated pointer: sits between the panel and the spotlight, aimed at
     the control. Pure CSS shape — no glyph, no emoji, no placeholder art. */
  function placeArrow(rect, dir) {
    const a = dom.arrow;
    if (!rect || !dir || dir === 'none') { a.classList.add('hidden'); return; }
    a.classList.remove('hidden');
    a.dataset.dir = dir;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const off = 6;
    if (dir === 'bottom') { a.style.left = cx + 'px'; a.style.top = (rect.y + rect.h + off) + 'px'; }
    else if (dir === 'top') { a.style.left = cx + 'px'; a.style.top = (rect.y - off) + 'px'; }
    else if (dir === 'right') { a.style.left = (rect.x + rect.w + off) + 'px'; a.style.top = cy + 'px'; }
    else { a.style.left = (rect.x - off) + 'px'; a.style.top = cy + 'px'; }
  }

  /* Progress: same count and same states as the canvas footer. The canvas
     falls back to a "7 / 16" counter when one dot per step will not fit, and
     so does this — sixteen dots plus BACK, SKIP and NEXT is wider than the
     panel, and a nav row that overflows loses NEXT to the panel's clip. */
  const DOT_W = 9, DOT_GAP = 7;
  function writeDots(count) {
    dom.dots.classList.toggle('count', !!count);
    if (count) { dom.dots.textContent = (T.i + 1) + ' / ' + T.steps.length; return; }
    let html = '';
    for (let i = 0; i < T.steps.length; i++) {
      html += '<i class="tutDot' + (i === T.i ? ' at' : i < T.i ? ' past' : '') + '"></i>';
    }
    dom.dots.innerHTML = html;
  }
  /* #tutDots is flex: 1 1 0, so its width is the leftover space in the row and
     does NOT depend on which form is showing — the test cannot oscillate */
  function syncDots() {
    const avail = dom.dots.clientWidth;
    if (avail <= 0) return;
    const n = T.steps.length;
    const count = n * DOT_W + (n - 1) * DOT_GAP > avail;
    if (count !== dom.dots.classList.contains('count')) writeDots(count);
  }

  function paintDom(st) {
    const root = domEls();
    if (!root) return;
    applyDomLocks(st);
    const N = navState(st);

    if (!domShown) {
      domShown = true;
      root.classList.remove('hidden');
      /* restart the entrance animation on every step change */
      dom.box.classList.remove('tutRise');
      void dom.box.offsetWidth;
      dom.box.classList.add('tutRise');
    }
    if (domPaintedStep !== st.id) {
      domPaintedStep = st.id;
      /* null, not '': a step with no hint must still clear the previous
         step's hint line, and '' would compare equal and skip the write */
      domPaintedHint = null;
      domPaintedNav = null;
      dom.title.textContent = st.title;
      dom.text.textContent = textOf(st);
      dom.box.classList.remove('tutRise');
      void dom.box.offsetWidth;
      dom.box.classList.add('tutRise');
      writeDots(dom.dots.classList.contains('count'));
      dom.skip.classList.toggle('hidden', N.last);
    }
    if (domPaintedHint !== N.hint) {
      domPaintedHint = N.hint;
      dom.hint.textContent = N.hint;
      dom.hint.classList.toggle('hidden', !N.hint);
      dom.hint.classList.toggle('done', N.done);
    }
    const navKey = N.nextLabel + '|' + (N.nextOn ? '1' : '0') + '|' + (N.backOn ? '1' : '0');
    if (domPaintedNav !== navKey) {
      domPaintedNav = navKey;
      dom.next.textContent = N.nextLabel;
      dom.next.disabled = !N.nextOn;
      dom.back.classList.toggle('hidden', !N.backOn);
    }

    /* ---- spotlight + pointer, from the live rendered bounds ---- */
    let el = targetEl(st);
    let rect = spotRect(el);
    /* The room-grid overview is the one target big enough to leave no side
       clear on a short landscape phone. If the panel cannot fit beside the
       whole grid, spotlight the first card instead — the panel must never sit
       on top of the room cards. */
    if (rect && st.target === 'list' && !fitsBeside(rect, st) && el.querySelector) {
      const first = el.querySelector('.roomCard');
      const alt = spotRect(first);
      if (alt) { el = first; rect = alt; }
    }
    if (rect) {
      dom.spot.classList.remove('hidden');
      dom.spot.style.left = Math.round(rect.x) + 'px';
      dom.spot.style.top = Math.round(rect.y) + 'px';
      dom.spot.style.width = Math.round(rect.w) + 'px';
      dom.spot.style.height = Math.round(rect.h) + 'px';
    } else {
      dom.spot.classList.add('hidden');
    }
    /* the spotlight's own box-shadow IS the dim; with no target to spotlight
       (a control that has not rendered yet) the overlay carries it instead */
    root.classList.toggle('dimAll', !rect);
    const dir = placeBox(rect, st);
    /* after the panel has its final width: pick dots or the counter, then let
       the next frame re-place at whatever height that settled on */
    syncDots();
    placeArrow(rect, dir);
  }

  /* ---------------- input ---------------- */
  function hitBtn(x, y) {
    for (const b of T.btns) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    return null;
  }
  /* returns true when the tutorial consumed the press (canvas steps only —
     the rooms steps are ordinary DOM buttons) */
  function pointerDown(x, y) {
    checkStale();
    if (!T) return false;
    const st = cur();
    if (st.dom || state !== 'playing') return false;
    const b = hitBtn(x, y);
    if (b) {
      T.pressed = b.id; T.pressT = 0.12;
      if (b.id === 'back') back();
      else if (b.id === 'skip') skip();
      else next();
      return true;
    }
    /* reading page: a tap anywhere continues, exactly like Castle Ricochet.
       Interactive pages let the press through to the battlefield. */
    if (!needOf(st) && !st.live) { next(); return true; }
    return false;
  }

  /* keyboard: desktop parity with the on-screen pills */
  function handleKey(ev) {
    checkStale();
    if (!T) return false;
    const st = cur();
    if (!stepVisible(st)) return false;
    const k = ev.key;
    if (k === 'Escape') { skip(); return true; }
    if (k === 'p' || k === 'P') return true;            // no pausing a practice run
    if (k === 'ArrowLeft' || k === 'Backspace') { back(); return true; }
    if (k === 'ArrowRight' || k === 'Enter') {
      if (navState(st).nextOn) next();
      return true;
    }
    return false;
  }

  /* Android hardware back: closes the tutorial before anything else leaves a
     screen. It deliberately bypasses the nav lock — a hardware press is not a
     rapid-tap hazard, and swallowing it would leave the player pressing back
     with nothing happening. */
  function handleBack() {
    checkStale();
    if (!T) return false;
    Sfx.ui();
    finish(true);
    return true;
  }

  /* ---------------- wiring ---------------- */
  function init() {
    /* How to Play → Tutorials. Both buttons live there and nowhere else. */
    const fling = $('btnTutorialFling');
    if (fling) {
      fling.addEventListener('click', () => {
        Sfx.unlock(); Sfx.ui();
        if (openReplay()) return;
        /* only reason it can refuse: a Castle Ricochet attempt owns the canvas */
        const label = fling.querySelector('.btnLabel');
        if (!label || fling.dataset.busy === '1') return;
        const was = label.textContent;
        fling.dataset.busy = '1';
        label.textContent = 'Finish your Ricochet attempt first';
        setTimeout(() => { label.textContent = was; fling.dataset.busy = '0'; }, 2400);
      });
    }
    /* Castle Ricochet's tutorial is part of an attempt, so its button keeps
       the behaviour it has always had: it re-arms the Ricochet flag and plays
       on the next attempt. Nothing about that tutorial is changed here. */
    const rico = $('btnTutorialRicochet');
    if (rico) {
      const label = rico.querySelector('.btnLabel');
      let revert = null;
      rico.addEventListener('click', () => {
        Sfx.ui();
        if (typeof CastleRicochet !== 'undefined') CastleRicochet.replayTutorialNextAttempt();
        if (!label) return;
        label.textContent = 'Plays on your next attempt';
        if (revert) clearTimeout(revert);
        revert = setTimeout(() => { label.textContent = 'Castle Ricochet Tutorial'; revert = null; }, 2400);
      });
    }
    /* the DOM panel's pills route through the same nav as the canvas pills,
       wired exactly once so no listener can ever stack */
    if (domEls()) {
      dom.back.addEventListener('click', () => back());
      dom.skip.addEventListener('click', () => skip());
      dom.next.addEventListener('click', () => next());
    }
  }

  const api = {
    init, startAuto, openReplay, isActive,
    tick, draw, event, pointerDown, handleKey, handleBack, onScreenChange,
    holdsGameplay, blocksAbility, blocksWaveEnd, shieldsCastle,
    abort,
    isCompleted: () => store().completed,
  };

  /* ---- development-only controls (never present in production builds) ---- */
  if (!(window.BUILD_CONFIG && BUILD_CONFIG.isProduction)) {
    api._test = {
      STEPS, VERSION, TUT_ROOM,
      reset() { const c = store(); c.completed = false; c.skipped = false; delete c.completedAt; c.version = VERSION; saveMeta(); return c; },
      complete() { const c = store(); c.completed = true; c.skipped = false; c.version = VERSION; saveMeta(); return c; },
      stateOf() { return store(); },
      replay(step) { openReplay(); if (T && step !== undefined) goto(step); return T ? T.steps.length : 0; },
      first(step) { begin('first'); if (T && step !== undefined) goto(step); return T ? T.steps.length : 0; },
      goto(step) { if (T) goto(step); },
      stepId() { return T ? cur().id : null; },
      hits() { return T ? T.hit : null; },
      fire(name, data) { event(name, data); },
      placement(p) { if (T) cur().place = p; },   // exercise every placement class
      close() { abort(); },
      session() { return T; },
    };
    window.CF_TUT = api._test;
  }
  return api;
})();

CastleFlingTutorial.init();

/* ============================================================
   CASTLE FLING — Adventurers' Board tutorial

   The THIRD tutorial, built from the same system as the two above.
   Every step is a DOM step: the Adventurers' Board, the Daily Siege
   brief and the Kingdom Restoration overlay are all DOM screens, so
   the whole tutorial paints the SAME #tutOverlay panel the Castle
   Rooms steps use — same fill and gold frame, same Georgia ramp,
   same colours, same gold pills, same dots, same spotlight, same
   pointer, same rise, same Sfx.ui() nav click. One system.

   Isolation: begin() swaps META.daily and META.kingdom for deep
   sandbox copies and swaps the global saveMeta / saveMetaSoon for
   no-ops, so NOTHING that happens in here — the practice reroll,
   the practice Seal contribution, a midnight rollover, a stray
   render-side write — can ever reach the disk or the real balances.
   teardown() puts the real objects and the real save path back and
   repaints the Board from canonical state.

   Every reward number in the step text is read live from
   CastleDaily.guideValues(), the same snapshot How to Play prints,
   so the tutorial can never drift from what the game actually pays.

   Loaded AFTER game.js and daily.js. Compat: no ?. / ?? anywhere
   (Android 7 WebView parse rules).
   ============================================================ */
const CastleBoardTutorial = (() => {

  const VERSION = 1;           // first release of the Board tutorial
  const FALLBACK_MS = 12000;   // interactive step: CONTINUE unlocks after this
  const NAV_LOCK_MS = 260;     // rapid tapping can never skip two steps
  const TUT_DISTRICT = 'royal_keep';   // the guided district (always unlocked)
  const TUT_SEALS = 12;        // practice Seals banked into the sandbox
  const DAILY = () => (typeof CastleDaily !== 'undefined' ? CastleDaily : null);

  /* live reward configuration — the same numbers the game grants */
  function gv() { return CastleDaily.guideValues(); }
  const numWord = n =>
    (n >= 0 && n <= 10) ? ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] : String(n);

  /* approved sprites only — resolved from guideValues / the shared icon
     constants, never a hard-coded emoji or glyph stand-in */
  const ico = (src, alt) => `<img class="btIco" src="${src}" alt="${alt || ''}" draggable="false">`;
  /* The loop diagram ends where the restoration rewards actually land: the
     permanent kingdom bonuses each district milestone pays into the core
     game. Its last icon is the 100% completion medallion, read from
     guideValues() like every other sprite here, so the chain follows the
     reward configuration instead of naming a payout of its own. Row COUNT is
     deliberately unchanged — the tutorial panel is sized to fit without
     scrolling (--tut-fit), and an extra row is what would break that. */
  function chainHtml() {
    const v = gv();
    const medals = v.medallionIcons || [];
    const finalMedal = medals.length ? medals[medals.length - 1].icon : v.starIcon;
    const shield = (typeof TRIM !== 'undefined') ? ico(TRIM + 'icon_shield.png', '') : '';
    const row = (icons, label) => `<span class="btChainRow">${icons}<span>${label}</span></span>`;
    const arrow = '<span class="btChainArrow">&#8595;</span>';
    return '<span class="btChain">' +
      row(ico(v.scrollIcon) + shield, 'Royal Decrees + Daily Siege') + arrow +
      row(ico(v.sealIcon, 'Royal Seals'), 'Royal Seals') + arrow +
      row(ico(v.hammerIcon), 'District Restoration') + arrow +
      row(ico(v.starIcon, 'Prosperity Stars'), 'Prosperity Stars') + arrow +
      row(ico(v.starIcon), 'Kingdom Prosperity') + arrow +
      row(ico(finalMedal, 'Completion medallion'), 'Permanent Kingdom Bonuses') +
      '</span>';
  }

  /* ============================================================
     STEP TABLE — one sequence, every launch

     surface: which live surface the step needs (siege | decrees |
              map | district). Enforced on entry, so BACK always
              lands on the right tab / overlay view.
     target:  spotlight selector (string), fallback chain (array)
              or targetAll (union of every match).
     allow:   selectors the input gate lets through this step.
     need:    state predicate — the step is satisfied by the live
              state itself, never by a timer.
     auto:    success itself moves the tutorial on.
     ============================================================ */
  const STEPS = [
    {
      id: 'welcome',
      title: 'WELCOME TO THE ADVENTURERS’ BOARD',
      text: 'The Adventurers’ Board is your hub for daily challenges and rebuilding the kingdom. Complete Royal Decrees and Daily Siege challenges to earn Royal Seals.',
      surface: 'siege', target: '#dailyScreen .boardTitleRow', place: 'bottom',
    },
    {
      id: 'reset',
      title: 'NEW CHALLENGES EACH DAY',
      text: 'Royal Decrees and the Daily Siege refresh each day. This timer counts down to the next daily reset at local midnight.',
      surface: 'siege', target: '#boardReset', place: 'bottom',
    },
    {
      id: 'decreesTab',
      title: 'ROYAL DECREES',
      text: 'Royal Decrees are daily objectives completed through normal Castle Fling activities.',
      surface: 'siege', target: '#tabDecrees', place: 'bottom',
      allow: ['#tabDecrees'], need: 'decreesTab',
      hint: 'Tap the Royal Decrees tab.',
      doneHint: 'These are today’s Decrees. Tap NEXT to continue.',
    },
    {
      id: 'decreeCards',
      title: 'THREE DAILY OBJECTIVES',
      text: () => `You receive ${numWord(gv().decreeCount)} Decrees each day. Objectives may involve enemies, waves, abilities, conversions, Castle Ricochet, the Daily Siege or other game actions. Progress counts during play and is saved, and each Decree has its own requirement.`,
      surface: 'decrees', target: '#decreeCards', place: 'auto',
    },
    {
      id: 'decreeReward',
      title: 'EARN ROYAL SEALS',
      text: () => `Each completed Decree awards ${gv().decreeReward} Royal Seal${gv().decreeReward > 1 ? 's' : ''}. Once an objective is met, its reward is claimed right on the card.`,
      surface: 'decrees', target: ['#decreeCards .decreeCard .decreeAction', '#decreeCards .decreeCard'], place: 'auto',
    },
    {
      id: 'decreeBonus',
      title: 'COMPLETE ALL THREE',
      text: () => {
        const v = gv();
        return `Complete and claim all ${numWord(v.decreeCount)} Decrees to earn ${v.decreeFullSetBonus} additional Royal Seals — ${v.decreeReward} per Decree plus the bonus, up to ${v.decreeMaxSeals} Royal Seals from Decrees in one day.`;
      },
      surface: 'decrees', target: '#decreeBonusRow', place: 'top',
    },
    {
      id: 'reroll',
      title: 'ONE FREE REROLL',
      text: 'You may replace one incomplete Decree each day — progress on the replaced Decree is lost, and completed or claimed Decrees cannot be rerolled. Try it here: this practice board is thrown away when the tutorial ends.',
      surface: 'decrees', target: ['#decreeCards .decreeCard:first-child .rerollBtn', '#decreeCards .decreeCard:first-child'], place: 'auto',
      allow: ['#decreeCards .decreeCard:first-child .rerollBtn'], need: 'reroll',
      hint: 'Tap the highlighted Reroll button, then confirm.',
      doneHint: 'The Decree changed — your real Decrees and your real reroll are untouched. Tap NEXT.',
    },
    {
      id: 'siegeTab',
      title: 'DAILY SIEGE',
      text: 'The Daily Siege is a fixed challenge that uses Castle Fling’s normal grabbing and flinging gameplay.',
      surface: 'decrees', target: '#tabSiege', place: 'bottom',
      allow: ['#tabSiege'], need: 'siegeTab',
      hint: 'Tap the Daily Siege tab.',
      doneHint: 'This is today’s siege. Tap NEXT to continue.',
    },
    {
      id: 'siegeBrief',
      title: 'MASTER THE LOADOUT',
      text: 'Daily Siege gives you preset Castle Rooms, preset room levels, a fixed enemy assault and daily modifiers — you cannot buy, sell or upgrade rooms during the challenge. It is one long wave: retries face the same setup, so you can practice and improve. Your best result is tracked.',
      surface: 'siege', target: '.siegeBriefLeft', place: 'right',
    },
    {
      id: 'siegeTiers',
      title: 'IMPROVE YOUR BEST TIER',
      text: () => {
        const v = gv();
        return `Bronze awards ${v.siegeBronze} Royal Seal, Silver ${v.siegeSilver} in total, and Gold ${v.siegeGold} in total. Improving your result grants only the difference over your previous best tier — at most ${v.siegeMaxSeals} Seals from the Daily Siege per day.`;
      },
      surface: 'siege', targetAll: '#siegePane .siegeTierRow', place: 'left',
    },
    {
      id: 'seals',
      title: 'ROYAL SEALS',
      text: () => {
        const v = gv();
        return `Royal Seals are earned from Royal Decrees (up to ${v.decreeMaxSeals}) and the Daily Siege (up to ${v.siegeMaxSeals}) — up to ${v.dailyMaxSeals} in one day when you complete every objective and reach the best Siege tier. They are banked here until you choose where to contribute them.`;
      },
      surface: 'siege', target: '#dailyScreen .boardMeta .sealPill', place: 'bottom',
    },
    {
      id: 'kingdom',
      title: 'REBUILD THE KINGDOM',
      text: 'Royal Seals are stored in your balance until you choose where to contribute them.',
      surface: 'siege', target: '#kingdomStrip', place: 'top',
      allow: ['#kingdomStrip'], need: 'kingdomOpen', auto: true,
      hint: 'Tap the Kingdom Restoration summary to open the Kingdom Map.',
    },
    {
      id: 'map',
      title: 'CHOOSE A DISTRICT',
      text: () => `The kingdom contains ${numWord(gv().districtCount)} districts that can be restored over time. Unlocked districts may be inspected, and one district can be selected as your active restoration project.`,
      surface: 'map', target: `#kingdomPanel .krMarker[data-d="${TUT_DISTRICT}"]`, place: 'auto',
      allow: [`#kingdomPanel .krMarker[data-d="${TUT_DISTRICT}"]`], need: 'pickDistrict',
      hint: 'Tap the Royal Keep.',
      doneHint: 'The district’s project card is open. Tap NEXT to continue.',
    },
    {
      id: 'active',
      title: 'ACTIVE RESTORATION PROJECT',
      text: 'Royal Seals are contributed to your active project — one project at a time. Changing projects never erases progress already made in another district, and Seals are never spent automatically.',
      surface: 'district', target: '#kingdomPanel .krDockAction', place: 'left',
    },
    {
      id: 'contribute',
      title: 'CONTRIBUTE ROYAL SEALS',
      text: 'Choose how many Royal Seals to contribute: 1, 5, or the maximum currently available. The game will never contribute more than your balance or more than the district still needs.',
      surface: 'district', target: '#kingdomPanel .krBtnRow', place: 'left',
      allow: ['#kingdomPanel .krContrib[data-n="1"]'], need: 'contribute',
      hint: 'Tap +1 to contribute a practice Seal.',
      doneHint: 'Progress! These practice Seals vanish when the tutorial ends. Tap NEXT.',
    },
    {
      id: 'checkpoints',
      title: 'RESTORATION CHECKPOINTS',
      text: () => {
        const st = gv().stages;
        const names = st.map(s => s.label + (s.pct > 0 ? ' (' + s.pct + '%)' : ''));
        return `Districts progress through ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. Checkpoints are reached in order, and progress toward them is never lost.`;
      },
      surface: 'district', target: '#kingdomPanel .krPips', place: 'left',
    },
    {
      id: 'stars',
      title: 'PROSPERITY STARS',
      text: () => {
        const cps = gv().checkpoints;
        const parts = cps.map(c => `${c.stars} at ${c.pct}%`);
        return `Restoration checkpoints award permanent Prosperity Stars — ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}. Prosperity Stars measure the kingdom’s recovery and help unlock new districts. They are not currency: they are never spent and never lost.`;
      },
      surface: 'district', target: '#kingdomPanel .krMeter', place: 'bottom',
    },
    {
      id: 'districtReward',
      title: 'FULLY RESTORE A DISTRICT',
      text: () => {
        const v = gv();
        return `Every checkpoint — 25%, 50%, 75% and 100% — awards Prosperity Stars AND one stack of that district’s permanent kingdom bonus. The ${v.passiveStackCount} stacks add together, so reaching Flourishing at 100% means the district is paying its full bonus to every run from then on. Each stack is earned once and kept forever.`;
      },
      surface: 'district', target: '#kingdomPanel .krPips .krPip:last-child', place: 'left',
    },
    {
      id: 'kingdomReward',
      title: 'RESTORE THE ENTIRE KINGDOM',
      text: () => {
        const v = gv();
        return `Fully restore all ${numWord(v.requiredDistrictCount)} districts to earn an additional ${v.kingdomCrowns.toLocaleString()} Crowns, granted once. The final district can award its own last bonus stack and the kingdom reward together.`;
      },
      surface: 'district', target: '#kingdomPanel .krMeter', place: 'bottom',
    },
    {
      id: 'loop',
      title: 'THE RESTORATION LOOP',
      html: () =>
        '<span class="btLead">Complete Royal Decrees and the Daily Siege to earn Royal Seals. Contribute them to restore districts, earn Prosperity Stars, unlock more of the kingdom, and build up permanent bonuses that strengthen every run.</span>' +
        chainHtml(),
      surface: 'district', place: 'center',
    },
    {
      id: 'done',
      title: 'THE BOARD AWAITS',
      text: 'Return each day for new Decrees, a new Daily Siege, and more chances to rebuild the kingdom.',
      surface: 'district', place: 'center',
    },
  ];

  /* ---------------- save state ---------------- */
  /* Lives under META.tutorials.adventurersBoard — the same three persisted
     fields as the Castle Fling flag (completed / skipped / version), plus
     promptDismissed for the optional first-open offer. The other tutorials'
     flags are never read or written here. */
  function store() {
    if (!META.tutorials || typeof META.tutorials !== 'object') META.tutorials = {};
    const t = META.tutorials;
    if (!t.adventurersBoard || typeof t.adventurersBoard !== 'object') {
      t.adventurersBoard = { completed: false, skipped: false, version: VERSION, promptDismissed: false };
    }
    const ab = t.adventurersBoard;
    if (typeof ab.completed !== 'boolean') ab.completed = false;
    if (typeof ab.skipped !== 'boolean') ab.skipped = false;
    if (typeof ab.version !== 'number') ab.version = VERSION;
    if (typeof ab.promptDismissed !== 'boolean') ab.promptDismissed = false;
    return ab;
  }

  /* ---------------- session ---------------- */
  let T = null;            // active session, or null
  let suppress = false;    // re-entrancy guard around our own screen moves
  let lastStepId = null;
  let promptOpen = false;  // the first-open offer dialog is showing

  const cur = () => T.steps[T.i];
  const isHidden = id => { const el = $(id); return !el || el.classList.contains('hidden'); };
  function visibleScreen() {
    for (const s of SCREENS) {
      const el = $(s);
      if (el && !el.classList.contains('hidden')) return s;
    }
    return null;
  }
  function textOf(st) { return typeof st.text === 'function' ? st.text() : (st.text || ''); }

  /* ============================================================
     THE SANDBOX (isolated state)

     A deep copy of META.daily / META.kingdom becomes the live state
     for the duration; the real objects wait untouched in T.prev.
     saveMeta and saveMetaSoon are swapped for no-ops FIRST, so no
     code path — ours or the Board's own — can write the sandbox to
     disk. The curated values guarantee the demos are safe: the +1
     contribution can never cross a checkpoint, so no Prosperity
     Star, milestone, unlock, or Crown grant can ever fire.
     ============================================================ */
  const noop = () => {};

  function makeSandbox() {
    /* flush anything real that is pending BEFORE the save path is gated */
    saveMeta();
    const prev = {
      daily: META.daily,
      kingdom: META.kingdom,
      screen: visibleScreen(),
      state: state,
      crowns: META.crowns,
      coins: META.coins,
      saveMeta: window.saveMeta,
      saveMetaSoon: window.saveMetaSoon,
    };
    /* gate FIRST, then swap in the copies */
    window.saveMeta = noop;
    window.saveMetaSoon = noop;
    tutSandbox = true;                 // shields addGold / dailyEvent, like the Fling tutorial
    const sd = JSON.parse(JSON.stringify(prev.daily || {}));
    const sk = JSON.parse(JSON.stringify(prev.kingdom || {}));
    /* ---- curate the practice Board ----
       Fresh-looking Decrees (one mid-progress so the reroll warning is real),
       the free reroll available, a clean Siege slate, and a mid-restoration
       Royal Keep with practice Seals banked. */
    if (Array.isArray(sd.decrees)) {
      for (let i = 0; i < sd.decrees.length; i++) {
        const d = sd.decrees[i];
        d.done = false; d.claimed = false;
        delete d.rerolled;
        d.progress = i === 0 ? Math.max(1, Math.floor(d.target * 0.4)) : 0;
      }
    }
    sd.decreeBonusClaimed = false;
    sd.rerollUsed = false;
    if (sd.siege) {
      sd.siege.attempts = 0; sd.siege.bestScore = 0; sd.siege.bestTier = 0;
      sd.siege.bestTime = 0; sd.siege.bestHp = 0; sd.siege.sealsGranted = 0;
    }
    if (!sk.districts || typeof sk.districts !== 'object') sk.districts = {};
    sk.seals = TUT_SEALS;
    sk.activeDistrict = TUT_DISTRICT;
    sk.newUnlocks = {};
    /* 2 of 24 contributed: the +1 demo lands at 3, safely short of the 25%
       checkpoint at 6 — no Stars, no milestone, no unlock can fire */
    sk.districts[TUT_DISTRICT] = { contributed: 2, complete: false, checkpoints: {} };
    /* a not-yet-presented backfill summary belongs to the REAL overlay open,
       not to the tutorial's — the original in T.prev still carries it */
    delete sk.pendingRewardSummary;
    META.daily = sd;
    META.kingdom = sk;
    return prev;
  }

  /* ---------------- input gate ----------------
     One capture-phase gate owns every tap while the tutorial is open:
     the tutorial's own pills, the themed confirm dialog and the current
     step's live target pass through; everything else is swallowed. This
     is what guarantees no real claim, siege start, back-out or purchase
     can happen mid-tutorial. */
  let gateOn = false;
  function gateEvent(ev) {
    if (!T) return;
    const t = ev.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('#tutOverlay')) return;             // BACK / SKIP / NEXT pills
    if (t.closest('#confirmModal')) return;           // the reroll confirmation
    if (t.closest('#krNotice')) return;               // a modal must never be tap-locked
    const st = cur();
    const allow = st && st.allow ? st.allow : [];
    for (let i = 0; i < allow.length; i++) {
      if (t.closest(allow[i])) return;                // the step's own target
    }
    ev.stopPropagation();
    ev.preventDefault();
  }
  function attachGate() {
    if (gateOn) return;
    gateOn = true;
    document.addEventListener('pointerdown', gateEvent, true);
    document.addEventListener('click', gateEvent, true);
  }
  function detachGate() {
    if (!gateOn) return;
    gateOn = false;
    document.removeEventListener('pointerdown', gateEvent, true);
    document.removeEventListener('click', gateEvent, true);
  }

  /* ---------------- open / close ---------------- */
  function begin(entry) {
    if (T) return false;
    /* never fight another tutorial or a Ricochet attempt for the screen */
    if (typeof CastleRicochet !== 'undefined' && CastleRicochet.isActive()) return false;
    if (typeof CastleFlingTutorial !== 'undefined' && CastleFlingTutorial.isActive()) return false;
    if (state !== 'menu' && state !== 'howto' && state !== 'daily') return false;
    const daily = DAILY();
    if (!daily) return false;
    daily.ensureDaily();               // today's real content must exist first
    const rd = META.daily;
    if (!rd || !Array.isArray(rd.decrees) || rd.decrees.length < 3 || !rd.siege || !rd.siege.config) return false;
    const prev = makeSandbox();
    T = {
      entry: entry, steps: STEPS.slice(), i: 0,
      hit: {},                         // step id -> satisfied (session only)
      base: {},                        // per-step baselines (contribution demo)
      stepAt: performance.now(), navAt: 0,
      prev: prev,
    };
    lastStepId = null;
    attachGate();
    hideDom();
    suppress = true;
    try {
      if (daily.closeKingdomOverlay) daily.closeKingdomOverlay();
      daily.openBoard('siege');        // the tour starts on the Siege tab: step 3 taps Decrees
    } finally { suppress = false; }
    CrashDiagnostics.record('board-tutorial-open', { entry, version: VERSION, steps: T.steps.length });
    return true;
  }

  /* replay from How to Play — the SAME tutorial, start to finish */
  function openReplay() { return begin('replay'); }

  /* Give the game back exactly what it had: the real daily / kingdom state,
     the real save path, the real screen, clean input. */
  function teardown() {
    if (!T) return;
    const prev = T.prev;
    T = null;
    lastStepId = null;
    detachGate();
    hideDom();
    /* real save path back FIRST, then the real objects */
    window.saveMeta = prev.saveMeta;
    window.saveMetaSoon = prev.saveMetaSoon;
    tutSandbox = false;
    META.daily = prev.daily;
    META.kingdom = prev.kingdom;
    /* the sandbox can never touch these balances; if anything slipped
       through, put it back and leave a diagnostic trail */
    if (META.crowns !== prev.crowns) {
      CrashDiagnostics.record('board-tutorial-crown-drift', { from: prev.crowns, to: META.crowns });
      META.crowns = prev.crowns;
    }
    if (META.coins !== prev.coins) {
      CrashDiagnostics.record('board-tutorial-coin-drift', { from: prev.coins, to: META.coins });
      META.coins = prev.coins;
    }
    const daily = DAILY();
    suppress = true;
    try {
      if (daily && daily.closeKingdomOverlay) daily.closeKingdomOverlay();
      if (prev.screen === 'dailyScreen') {
        if (daily) daily.openBoard('decrees');  // repaint the REAL Board at its default tab
      } else {
        state = prev.state;
        showScreen(prev.screen);
      }
    } finally { suppress = false; }
    if (daily) daily.refreshMenuBadge();
  }

  function finish(skipped) {
    if (!T) return;
    const entry = T.entry, step = T.i;
    teardown();                        // real state and real saveMeta back first
    const ab = store();
    /* FIRST-TIME launch records the outcome; a REPLAY never overwrites an
       existing flag — the same rule the Castle Fling tutorial follows */
    if (entry === 'first' || !ab.completed) {
      ab.completed = true;
      ab.skipped = !!skipped;
      ab.version = VERSION;
      ab.completedAt = Date.now();
      saveMeta();
    }
    CrashDiagnostics.record('board-tutorial-done', { entry, skipped: !!skipped, step });
  }

  /* leaving without finishing (screen taken away): clean up, leave the flag
     alone so a first-time player is offered the tutorial again */
  function abort() {
    if (!T) return;
    CrashDiagnostics.record('board-tutorial-abort', { entry: T.entry, step: T.i });
    teardown();
  }

  /* every screen transition funnels through game.js showScreen() */
  function onScreenChange(id) {
    if (suppress) return;
    if (T) {
      /* the tutorial owns exactly one surface: the Adventurers' Board.
         Anything else means something took the screen away — stand down. */
      if (id !== 'dailyScreen') abort();
      return;
    }
    maybeOfferFirstRun(id);
  }

  /* ---- optional first-open offer ----
     The first time the Board is shown, the themed confirm dialog offers the
     tour once. Declining is remembered; the tutorial stays available from
     How to Play either way. Never re-offered after completion. */
  function maybeOfferFirstRun(id) {
    if (id !== 'dailyScreen' || promptOpen) return;
    if (typeof state === 'undefined' || state !== 'daily') return;
    if (typeof gameConfirm !== 'function') return;
    if (typeof CastleRicochet !== 'undefined' && CastleRicochet.isActive()) return;
    if (typeof CastleFlingTutorial !== 'undefined' && CastleFlingTutorial.isActive()) return;
    const ab = store();
    if (ab.completed || ab.promptDismissed) return;
    promptOpen = true;
    gameConfirm('New to the Adventurers’ Board? Take the guided tour — Royal Decrees, the Daily Siege and Kingdom Restoration, explained step by step.',
      { title: 'Adventurers’ Board Tutorial', okText: 'Begin Tutorial', cancelText: 'Not Now' })
      .then(ok => {
        promptOpen = false;
        if (ok) { begin('first'); return; }
        const s = store();
        s.promptDismissed = true;
        saveMeta();
      });
  }

  /* ---------------- navigation ---------------- */
  function navReady() {
    const now = performance.now();
    if (now - T.navAt < NAV_LOCK_MS) return false;
    T.navAt = now;
    return true;
  }
  function goto(i) {
    T.i = clamp(i, 0, T.steps.length - 1);
    T.stepAt = performance.now();
  }
  function next() {
    if (!T || !navReady()) return;
    Sfx.ui();
    if (T.i >= T.steps.length - 1) { finish(false); return; }
    goto(T.i + 1);
  }
  function back() {
    if (!T || !navReady()) return;
    if (T.i <= 0 || cur().noBack) return;
    Sfx.ui();
    goto(T.i - 1);
  }
  function skip() {
    if (!T || !navReady()) return;
    Sfx.ui();
    finish(true);
  }

  /* ---------------- interactive success ----------------
     Pure state predicates, re-evaluated every frame: a step is satisfied
     when the live sandbox / DOM state proves the required outcome holds.
     Nothing advances on a timer, and BACK re-checks the truth on entry. */
  const SAT = {
    decreesTab: () => !isHidden('decreePane'),
    siegeTab: () => !isHidden('siegePane'),
    reroll: () => !!(META.daily && META.daily.rerollUsed),
    kingdomOpen: () => !isHidden('kingdomOverlay'),
    pickDistrict: () => !!document.querySelector('#kingdomPanel .krMarker.viewing[data-d="' + TUT_DISTRICT + '"]'),
    contribute: () => {
      const k = META.kingdom;
      const ds = k && k.districts ? k.districts[TUT_DISTRICT] : null;
      return !!(ds && typeof T.base.contrib === 'number' && ds.contributed > T.base.contrib);
    },
  };
  function stepSatisfied(st) {
    const fn = st.need ? SAT[st.need] : null;
    if (!fn) return false;
    try { return !!fn(); } catch (e) { return false; }
  }

  /* move the Board to the surface this step is about (used on entry, so
     BACK always restores the right tab and overlay view) */
  function enforceSurface(st) {
    const daily = DAILY();
    if (!daily) return;
    const want = st.surface;
    const ovOpen = !isHidden('kingdomOverlay');
    suppress = true;
    try {
      if (want === 'map') {
        /* any overlay view will do: BACK from the district step keeps the
           project card open, which the map step counts as satisfied */
        if (!ovOpen && daily.openKingdomOverlay) daily.openKingdomOverlay();
      } else if (want === 'district') {
        const viewing = document.querySelector('#kingdomPanel .krMarker.viewing[data-d="' + TUT_DISTRICT + '"]');
        if ((!ovOpen || !viewing) && daily.openKingdomOverlay) daily.openKingdomOverlay(TUT_DISTRICT);
      } else {
        if (ovOpen && daily.closeKingdomOverlay) daily.closeKingdomOverlay();
        if (want === 'decrees' && isHidden('decreePane')) daily.openBoard('decrees');
        else if (want === 'siege' && isHidden('siegePane')) daily.openBoard('siege');
      }
    } finally { suppress = false; }
  }

  function stepEntered(st) {
    if (!T) return;
    enforceSurface(st);
    /* baselines for the contribution demo: satisfied only by NEW progress */
    if (st.need === 'contribute') {
      const k = META.kingdom;
      const ds = k && k.districts ? k.districts[TUT_DISTRICT] : null;
      T.base.contrib = ds ? ds.contributed : 0;
    }
    /* re-derive the truth instead of trusting an old one-shot: an auto step
       re-entered via BACK must wait for its action again, and a completed
       outcome (the reroll) stays satisfied without demanding a repeat */
    T.hit[st.id] = stepSatisfied(st);
  }

  /* ---------------- per-frame ---------------- */
  function tick(dt) {
    if (!T) return;
    /* the Board is the tutorial's only surface; if the game state moved off
       it (a path the gate does not cover), stand down cleanly */
    if (typeof state === 'undefined' || state !== 'daily') { abort(); return; }
    const st = cur();
    if (lastStepId !== st.id) { lastStepId = st.id; stepEntered(st); }
    if (st.need && !T.hit[st.id] && stepSatisfied(st)) T.hit[st.id] = true;
    /* the action itself moves the tutorial on; retried until the nav lock
       clears, so a fast tap can never leave the step stuck */
    if (st.auto && T.hit[st.id] && stepSatisfied(st)) next();
  }

  /* ---------------- shared step presentation state ---------------- */
  function navState(st) {
    const need = !!st.need;
    const done = !!T.hit[st.id];
    const stalled = need && !done && (performance.now() - T.stepAt > FALLBACK_MS);
    const last = T.i >= T.steps.length - 1;
    return {
      need, done, stalled, last,
      nextLabel: last ? 'FINISH ✓' : (stalled ? 'CONTINUE →' : 'NEXT →'),
      nextOn: !need || done || stalled,
      hint: !need ? '' : done ? (st.doneHint || 'Tap NEXT to continue.')
        : stalled ? ((st.hint || '') + '  (or tap CONTINUE)') : (st.hint || ''),
      backOn: T.i > 0 && !st.noBack,
    };
  }

  /* ============================================================
     DOM PANEL — the same #tutOverlay treatment, over the Board

     Identical machinery to the Castle Fling tutorial's DOM steps:
     the spotlight, pointer and panel are positioned every frame
     from the target's LIVE getBoundingClientRect, so they stay
     locked to the control through responsive regrids, rotation,
     safe-area changes and Board re-renders.
     ============================================================ */
  const dom = {};
  let domShown = false;
  let domPaintedStep = null;
  let domPaintedHint = null;
  let domPaintedNav = null;

  function domEls() {
    if (dom.root) return dom.root;
    dom.root = $('tutOverlay');
    if (!dom.root) return null;
    dom.safe = $('tutSafe');
    dom.spot = $('tutSpot');
    dom.arrow = $('tutArrow');
    dom.box = $('tutBox');
    dom.body = $('tutBody');
    dom.title = $('tutTitle');
    dom.text = $('tutText');
    dom.hint = $('tutHint');
    dom.dots = $('tutDots');
    dom.back = $('tutBack');
    dom.skip = $('tutSkip');
    dom.next = $('tutNext');
    return dom.root;
  }

  function hideDom() {
    if (!domShown) return;
    const root = domEls();
    domShown = false;
    domPaintedStep = null;
    if (root) { root.classList.add('hidden'); root.classList.remove('dimAll'); }
  }

  /* target resolution — always the REAL rendered control. A string is one
     selector; an array is a fallback chain (the reroll button disappears
     once used, so its card takes over as the anchor). */
  function targetEl(st) {
    if (!st.target) return null;
    const list = Array.isArray(st.target) ? st.target : [st.target];
    for (let i = 0; i < list.length; i++) {
      const el = document.querySelector(list[i]);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) return el;
      }
    }
    return null;
  }

  const MARGIN = 12;
  const GAP = 12;
  const MIN_BOX_H = 92;
  const MIN_BOX_W = 190;

  function viewRect() {
    let r = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const probe = dom.safe;
    if (probe) {
      const b = probe.getBoundingClientRect();
      if (b.width > 40 && b.height > 40) r = { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    const gc = $('gameContainer');
    if (gc) {
      const g = gc.getBoundingClientRect();
      const x0 = Math.max(r.x, g.left), y0 = Math.max(r.y, g.top);
      const x1 = Math.min(r.x + r.w, g.right), y1 = Math.min(r.y + r.h, g.bottom);
      if (x1 - x0 > 40 && y1 - y0 > 40) r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return r;
  }

  function clipRect(x0, y0, x1, y1) {
    const V = viewRect();
    const a = Math.max(V.x, x0), b = Math.max(V.y, y0);
    const c = Math.min(V.x + V.w, x1), d = Math.min(V.y + V.h, y1);
    if (c - a <= 2 || d - b <= 2) return null;
    return { x: a, y: b, w: c - a, h: d - b };
  }

  function spotRect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return null;
    const pad = 8;
    return clipRect(r.left - pad, r.top - pad, r.right + pad, r.bottom + pad);
  }

  /* union spotlight: one box around every match (the three Siege tier rows) */
  function unionSpotRect(sel) {
    const els = document.querySelectorAll(sel);
    if (!els.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) continue;
      any = true;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    if (!any) return null;
    const pad = 8;
    return clipRect(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  }

  function targetRect(st) {
    if (st.targetAll) return unionSpotRect(st.targetAll);
    return spotRect(targetEl(st));
  }

  let sizedW = null, sizedH = null;
  function sizeBox(maxW, maxH) {
    const w = Math.round(Math.max(MIN_BOX_W, maxW));
    const h = Math.round(Math.max(MIN_BOX_H, maxH));
    if (w === sizedW && h === sizedH) return;
    sizedW = w; sizedH = h;
    dom.box.style.maxWidth = w + 'px';
    dom.box.style.maxHeight = h + 'px';
  }

  /* ---- one panel, always whole ----
     The board tutorial runs on the busiest screen in the game, so this is where
     the leftover gap beside a spotlight runs out first. Same two levers as the
     Castle Rooms tutorial: a reading step may take the whole safe height and
     sit over its spotlight, and --tut-fit shrinks the panel into whatever
     placement settled on. Nothing here scrolls and nothing is ever cut off. */
  const FIT_MIN = 0.68;
  const FIT_STEP = 0.04;
  let appliedFit = null;
  function setFit(f) {
    if (f === appliedFit) return;
    appliedFit = f;
    dom.box.style.setProperty('--tut-fit', String(f));
  }
  function naturalH(maxW) {
    const b = dom.box;
    b.style.maxHeight = 'none';
    b.style.maxWidth = Math.round(Math.max(MIN_BOX_W, maxW)) + 'px';
    /* ceil, not offsetHeight: a cap rounded DOWN off a fractional layout
       height shaves the last line by a pixel, and this panel never clips */
    const h = Math.ceil(b.getBoundingClientRect().height);
    sizedW = sizedH = null;
    return h;
  }
  /* the panel's full-scale size, cached the same way — placement needs it every
     frame to decide which sides fit, and re-measuring it every frame would mean
     a forced layout (and a fit flip-flop) on every frame of every step */
  let natKey = '', natVal = { w: 0, h: 0 };
  function naturalSize(maxW, key) {
    const k = key + '|' + Math.round(maxW);
    if (k === natKey) return natVal;
    setFit(1);
    const h = naturalH(maxW);
    natVal = { w: dom.box.offsetWidth, h: h };
    natKey = k;
    return natVal;
  }
  let fitKey = '', fitVal = 1, fitH = 0;
  function fitInto(maxW, maxH, key) {
    const k = key + '|' + Math.round(maxW) + '|' + Math.round(maxH);
    if (k === fitKey) { setFit(fitVal); return fitH; }
    let f = 1;
    setFit(f);
    let h = naturalH(maxW);
    while (h > maxH && f > FIT_MIN) {
      f = Math.max(FIT_MIN, Math.round((f - FIT_STEP) * 100) / 100);
      setFit(f);
      h = naturalH(maxW);
    }
    fitKey = k; fitVal = f; fitH = h;
    return h;
  }
  function contentKey(st) {
    return (st && st.id) + '|' + dom.text.innerHTML.length + '|' + dom.title.textContent.length +
      '|' + dom.hint.textContent.length + '|' + (dom.hint.classList.contains('hidden') ? 0 : 1) +
      '|' + dom.next.textContent + '|' + (dom.back.classList.contains('hidden') ? 0 : 1) +
      /* dots vs the "7 / 21" counter changes how the nav row wraps, and that
         changes the panel's height — syncDots() flips it AFTER placement, so
         without it here the next frame would reuse a height that no longer
         matches what is on screen */
      '|' + (dom.dots.classList.contains('count') ? 1 : 0) +
      '|' + (dom.skip.classList.contains('hidden') ? 0 : 1);
  }
  const quant = v => Math.max(0, Math.floor(v / 4) * 4);

  function placeBox(rect, st) {
    const box = dom.box;
    const V = viewRect();
    const prefer = st && st.place;
    const key = contentKey(st);
    const availW = quant(V.w - MARGIN * 2), availH = quant(V.h - MARGIN * 2);
    let x, y;

    if (!rect) {
      box.dataset.dir = 'none';
      const bh0 = fitInto(availW, availH, key);
      sizeBox(availW, bh0);
      const bw0 = box.offsetWidth;
      box.style.left = Math.round(V.x + (V.w - bw0) / 2) + 'px';
      box.style.top = Math.round(V.y + (V.h - bh0) / 2) + 'px';
      return null;
    }

    const room = {
      bottom: quant((V.y + V.h - MARGIN) - (rect.y + rect.h + GAP)),
      top: quant((rect.y - GAP) - (V.y + MARGIN)),
      right: quant((V.x + V.w - MARGIN) - (rect.x + rect.w + GAP)),
      left: quant((rect.x - GAP) - (V.x + MARGIN)),
    };

    const nat = naturalSize(availW, key);
    const natH = nat.h, natW = nat.w;
    const fits = d => (d === 'bottom' || d === 'top')
      ? room[d] >= natH
      : (room[d] >= natW && availH >= natH);

    let dir = (prefer && prefer !== 'auto' && prefer !== 'center' && room[prefer] !== undefined && fits(prefer)) ? prefer : null;
    if (!dir) {
      if (fits('bottom')) dir = 'bottom';
      else if (fits('top')) dir = 'top';
      else if (fits('right')) dir = 'right';
      else if (fits('left')) dir = 'left';
      else {
        const best = Math.max(room.bottom, room.top, room.right, room.left);
        dir = best === room.bottom ? 'bottom' : best === room.top ? 'top'
          : best === room.right ? 'right' : 'left';
      }
    }

    /* lever 1: reading steps may cover the spotlight, tap steps never may */
    const overlay = !fits(dir) && !st.need;
    let capW, capH;
    if (dir === 'bottom' || dir === 'top') { capW = availW; capH = overlay ? availH : Math.min(availH, room[dir]); }
    else { capW = overlay ? availW : Math.min(availW, room[dir]); capH = availH; }

    /* lever 2: the cap is the FITTED height, so the panel always holds the
       whole step even when that means overhanging the gap it was aiming for */
    const bh = fitInto(capW, capH, key);
    sizeBox(capW, bh);
    const bw = box.offsetWidth;

    if (overlay) {
      if (dir === 'bottom') { x = rect.x + rect.w / 2 - bw / 2; y = V.y + V.h - MARGIN - bh; }
      else if (dir === 'top') { x = rect.x + rect.w / 2 - bw / 2; y = V.y + MARGIN; }
      else if (dir === 'right') { x = V.x + V.w - MARGIN - bw; y = rect.y + rect.h / 2 - bh / 2; }
      else { x = V.x + MARGIN; y = rect.y + rect.h / 2 - bh / 2; }
    }
    else if (dir === 'bottom') { x = rect.x + rect.w / 2 - bw / 2; y = rect.y + rect.h + GAP; }
    else if (dir === 'top') { x = rect.x + rect.w / 2 - bw / 2; y = rect.y - bh - GAP; }
    else if (dir === 'right') { x = rect.x + rect.w + GAP; y = rect.y + rect.h / 2 - bh / 2; }
    else { x = rect.x - bw - GAP; y = rect.y + rect.h / 2 - bh / 2; }

    x = clamp(x, V.x + MARGIN, Math.max(V.x + MARGIN, V.x + V.w - bw - MARGIN));
    y = clamp(y, V.y + MARGIN, Math.max(V.y + MARGIN, V.y + V.h - bh - MARGIN));
    box.dataset.dir = dir;
    box.style.left = Math.round(x) + 'px';
    box.style.top = Math.round(y) + 'px';
    return dir;
  }

  function placeArrow(rect, dir) {
    const a = dom.arrow;
    if (!rect || !dir || dir === 'none') { a.classList.add('hidden'); return; }
    a.classList.remove('hidden');
    a.dataset.dir = dir;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const off = 6;
    if (dir === 'bottom') { a.style.left = cx + 'px'; a.style.top = (rect.y + rect.h + off) + 'px'; }
    else if (dir === 'top') { a.style.left = cx + 'px'; a.style.top = (rect.y - off) + 'px'; }
    else if (dir === 'right') { a.style.left = (rect.x + rect.w + off) + 'px'; a.style.top = cy + 'px'; }
    else { a.style.left = (rect.x - off) + 'px'; a.style.top = cy + 'px'; }
  }

  const DOT_W = 9, DOT_GAP = 7;
  function writeDots(count) {
    dom.dots.classList.toggle('count', !!count);
    if (count) { dom.dots.textContent = (T.i + 1) + ' / ' + T.steps.length; return; }
    let html = '';
    for (let i = 0; i < T.steps.length; i++) {
      html += '<i class="tutDot' + (i === T.i ? ' at' : i < T.i ? ' past' : '') + '"></i>';
    }
    dom.dots.innerHTML = html;
  }
  function syncDots() {
    const avail = dom.dots.clientWidth;
    if (avail <= 0) return;
    const n = T.steps.length;
    const count = n * DOT_W + (n - 1) * DOT_GAP > avail;
    if (count !== dom.dots.classList.contains('count')) writeDots(count);
  }

  function paintDom(st) {
    const root = domEls();
    if (!root) return;
    const N = navState(st);

    if (!domShown) {
      domShown = true;
      root.classList.remove('hidden');
      dom.box.classList.remove('tutRise');
      void dom.box.offsetWidth;
      dom.box.classList.add('tutRise');
    }
    if (domPaintedStep !== st.id) {
      domPaintedStep = st.id;
      domPaintedHint = null;
      domPaintedNav = null;
      dom.title.textContent = st.title;
      /* the loop-summary step draws its progression chain from approved
         sprites; every other step is plain text */
      if (st.html) dom.text.innerHTML = typeof st.html === 'function' ? st.html() : st.html;
      else dom.text.textContent = textOf(st);
      dom.box.classList.remove('tutRise');
      void dom.box.offsetWidth;
      dom.box.classList.add('tutRise');
      writeDots(dom.dots.classList.contains('count'));
      dom.skip.classList.toggle('hidden', N.last);
    }
    if (domPaintedHint !== N.hint) {
      domPaintedHint = N.hint;
      dom.hint.textContent = N.hint;
      dom.hint.classList.toggle('hidden', !N.hint);
      dom.hint.classList.toggle('done', N.done);
    }
    const navKey = N.nextLabel + '|' + (N.nextOn ? '1' : '0') + '|' + (N.backOn ? '1' : '0');
    if (domPaintedNav !== navKey) {
      domPaintedNav = navKey;
      dom.next.textContent = N.nextLabel;
      dom.next.disabled = !N.nextOn;
      dom.back.classList.toggle('hidden', !N.backOn);
    }

    /* ---- spotlight + pointer, from the live rendered bounds ---- */
    const rect = targetRect(st);
    if (rect) {
      dom.spot.classList.remove('hidden');
      dom.spot.style.left = Math.round(rect.x) + 'px';
      dom.spot.style.top = Math.round(rect.y) + 'px';
      dom.spot.style.width = Math.round(rect.w) + 'px';
      dom.spot.style.height = Math.round(rect.h) + 'px';
    } else {
      dom.spot.classList.add('hidden');
    }
    root.classList.toggle('dimAll', !rect);
    const dir = placeBox(rect, st);
    syncDots();
    placeArrow(rect, dir);
  }

  function draw() {
    if (!T) return;
    if (typeof state === 'undefined' || state !== 'daily') return;
    paintDom(cur());
  }

  /* ---------------- input ---------------- */
  /* keyboard: desktop parity with the on-screen pills */
  function handleKey(ev) {
    if (!T) return false;
    /* the themed confirm dialog owns the keyboard while it is open */
    if (!isHidden('confirmModal')) return false;
    const k = ev.key;
    if (k === 'Escape') { skip(); return true; }
    if (k === 'ArrowLeft' || k === 'Backspace') { back(); return true; }
    if (k === 'ArrowRight' || k === 'Enter') {
      if (navState(cur()).nextOn) next();
      return true;
    }
    return false;
  }

  /* Android hardware back: same convention as the Castle Fling tutorial —
     it closes the tutorial (recorded like SKIP) before anything else can
     leave the screen, deliberately bypassing the nav lock */
  function handleBack() {
    if (!T) return false;
    Sfx.ui();
    finish(true);
    return true;
  }

  /* ---------------- wiring ---------------- */
  function init() {
    /* How to Play → Tutorials: the one and only replay button */
    const btn = $('btnTutorialBoard');
    if (btn) {
      btn.addEventListener('click', () => {
        Sfx.unlock(); Sfx.ui();
        if (openReplay()) return;
        /* only reason it can refuse: another attempt or tutorial owns the screen */
        const label = btn.querySelector('.btnLabel');
        if (!label || btn.dataset.busy === '1') return;
        const was = label.textContent;
        btn.dataset.busy = '1';
        label.textContent = 'Finish your current attempt first';
        setTimeout(() => { label.textContent = was; btn.dataset.busy = '0'; }, 2400);
      });
    }
    /* the SAME panel pills the other tutorials use, wired exactly once; every
       handler is guarded by this module's own session, so the two tutorial
       controllers can never respond to one another's presses */
    if (domEls()) {
      dom.back.addEventListener('click', () => back());
      dom.skip.addEventListener('click', () => skip());
      dom.next.addEventListener('click', () => next());
    }
  }

  const api = {
    init, openReplay,
    isActive: () => !!T,
    tick, draw, handleKey, handleBack, onScreenChange,
    abort,
    isCompleted: () => store().completed,
  };

  /* ---- development-only controls (never present in production builds) ---- */
  if (!(window.BUILD_CONFIG && BUILD_CONFIG.isProduction)) {
    api._test = {
      STEPS, VERSION, TUT_DISTRICT,
      reset() { const c = store(); c.completed = false; c.skipped = false; c.promptDismissed = false; delete c.completedAt; c.version = VERSION; saveMeta(); return c; },
      complete() { const c = store(); c.completed = true; c.skipped = false; c.version = VERSION; saveMeta(); return c; },
      stateOf() { return store(); },
      replay(step) { openReplay(); if (T && step !== undefined) goto(step); return T ? T.steps.length : 0; },
      first(step) { begin('first'); if (T && step !== undefined) goto(step); return T ? T.steps.length : 0; },
      goto(step) { if (T) goto(step); },
      stepId() { return T ? cur().id : null; },
      hits() { return T ? T.hit : null; },
      close() { abort(); },
      session() { return T; },
      sandbox() { return T ? { daily: META.daily, kingdom: META.kingdom } : null; },
    };
    window.CF_BOARD_TUT = api._test;
  }
  return api;
})();

CastleBoardTutorial.init();
