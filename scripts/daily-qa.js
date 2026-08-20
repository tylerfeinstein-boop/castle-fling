/* ============================================================
   DAILY SYSTEMS QA HARNESS  (node scripts/daily-qa.js)
   Loads daily.js in a sandbox (no DOM, no game globals) and
   simulates 60 consecutive generated days for three player
   profiles, asserting every anti-repetition / fairness /
   reward-safety invariant from the design spec.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function freshSandbox() {
  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, isFinite, parseInt, parseFloat,
    META: { bestWave: 0, runs: 0, crowns: 0, coins: 0, daily: null, kingdom: null },
    saveMeta() {}, saveMetaSoon() {},
    addGold(n) { sandbox.META.coins += n; },
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'daily.js'), 'utf8');
  // top-level const stays lexical in a vm script: export it onto the context
  vm.runInContext(src + '\n;globalThis.CastleDaily = CastleDaily;', sandbox, { filename: 'daily.js' });
  return sandbox;
}

let failures = 0, checks = 0;
function assert(cond, label) {
  checks++;
  if (!cond) { failures++; console.error('  FAIL: ' + label); }
}

function dayKeyFor(i) {
  const d = new Date(2026, 6, 1 + i);   // 2026-07-01 + i, local
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* mirror of archiveDay(): the history entry shape the generators consume */
function historyEntry(gen, day, decrees, siegeCfg) {
  const ids = decrees.map(d => d.tpl);
  const pairs = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]].sort().join('|'));
  const targets = {}, enemies = [], modes = [], mechs = [], cats = [];
  for (const d of decrees) {
    targets[d.tpl] = d.target;
    const t = gen.DECREE_TEMPLATES.find(x => x.id === d.tpl);
    if (t) { if (t.enemy) enemies.push(t.enemy); if (t.mode) modes.push(t.mode); if (t.mech) mechs.push(t.mech); cats.push(t.cat); }
  }
  return {
    day, decrees: ids, pairs, targets, enemies, modes, mechs, cats,
    sig: ids.slice().sort().join('+'), done: 3,
    siege: siegeCfg ? { theme: siegeCfg.theme, mods: siegeCfg.mods, loadout: siegeCfg.loadoutSig, combo: siegeCfg.comboSig, topRoom: siegeCfg.topRoom, sig: siegeCfg.sig, boss: siegeCfg.boss || null, opening: siegeCfg.opening || '' } : null,
  };
}

const PROFILES = [
  { name: 'new player', bracket: 'intro', bestWave: 3, level: 2, runs: 4, completionRate: 1, bestScore: 2500 },
  { name: 'intermediate', bracket: 'normal', bestWave: 12, level: 14, runs: 40, completionRate: 1, bestScore: 30000 },
  { name: 'veteran', bracket: 'vet', bestWave: 42, level: 55, runs: 300, completionRate: 1, bestScore: 250000 },
];
const ROOM_MAX = { archer: 5, mason: 5, mage: 5, bomb: 4, barracks: 4, wall: 5 };
const DAYS = 60;

for (const profile of PROFILES) {
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  console.log(`\n=== Profile: ${profile.name} (${profile.bracket}) — ${DAYS} days ===`);
  sandbox.META.bestWave = profile.bestWave;
  const history = [];
  const templatesSeen = new Set();
  const themesSeen = new Set(), combosSeen = new Set(), roomsFeatured = new Set();
  const sigsSeen = new Map(), siegeSigs = new Map();
  let siegeFallbacks = 0;

  for (let i = 0; i < DAYS; i++) {
    const day = dayKeyFor(i);
    const dg = gen.generateDecrees(day, profile, history);
    const sg = gen.generateSiege(day, profile, history);
    const decrees = dg.decrees, cfg = sg.config;

    /* ---- decree invariants ---- */
    assert(decrees.length === 3, `${day}: exactly 3 decrees (got ${decrees.length})`);
    const ids = decrees.map(d => d.tpl);
    assert(new Set(ids).size === 3, `${day}: no duplicate decree in one day (${ids})`);
    const cats = ids.map(id => gen.DECREE_TEMPLATES.find(t => t.id === id).cat);
    assert(new Set(cats).size >= 2, `${day}: not all decrees share one category (${cats})`);
    for (const dec of decrees) {
      const t = gen.DECREE_TEMPLATES.find(x => x.id === dec.tpl);
      templatesSeen.add(dec.tpl);
      assert(t.valid(profile), `${day}: ${dec.tpl} valid for profile (locked-content check)`);
      const band = t.bands[profile.bracket] || t.bands.normal;
      assert(dec.target >= band[0] && dec.target <= band[1], `${day}: ${dec.tpl} target ${dec.target} within band [${band[0]},${band[1]}]`);
      // contradiction check
      if (t.conflicts) for (const c of t.conflicts) assert(ids.indexOf(c) < 0, `${day}: ${dec.tpl} conflicts with ${c} in same day`);
    }
    // enemy duplication inside one day
    const enemies = ids.map(id => gen.DECREE_TEMPLATES.find(t => t.id === id).enemy).filter(Boolean);
    assert(new Set(enemies).size === enemies.length, `${day}: no two decrees target the same enemy`);
    // template repetition window (mirrors the generator's adaptive rule:
    // 7 days, shrinking only when a small unlocked pool cannot sustain it)
    for (const id of ids) {
      const t = gen.DECREE_TEMPLATES.find(x => x.id === id);
      const validCount = gen.DECREE_TEMPLATES.filter(x => x.cat === t.cat && (function () { try { return x.valid(profile); } catch (e) { return false; } })()).length;
      const win = Math.max(3, Math.min(7, validCount - 3));
      const recent = history.slice(-win);
      assert(!recent.some(h => h.decrees.indexOf(id) >= 0), `${day}: template ${id} not repeated within ${win} days`);
    }
    // full-set signature repetition (60 days)
    const sig = ids.slice().sort().join('+');
    assert(!sigsSeen.has(sig), `${day}: full decree signature unique across ${DAYS} days (${sig} first seen ${sigsSeen.get(sig)})`);
    sigsSeen.set(sig, day);

    /* ---- siege invariants ---- */
    assert(!!cfg && cfg.queue.length > 0, `${day}: siege config generated`);
    if (cfg.sig === 'fallback') siegeFallbacks++;
    const y = history[history.length - 1];
    if (y && y.siege) assert(cfg.theme !== y.siege.theme, `${day}: siege theme not repeated on consecutive days (${cfg.theme})`);
    const themeCount7 = history.slice(-7).filter(h => h.siege && h.siege.theme === cfg.theme).length;
    assert(themeCount7 <= 2, `${day}: theme ${cfg.theme} at most 2x within 7 days`);
    assert(!siegeSigs.has(cfg.sig), `${day}: siege signature unique (${cfg.sig})`);
    siegeSigs.set(cfg.sig, day);
    const roomIds = Object.keys(cfg.rooms);
    assert(roomIds.length >= 3 && roomIds.length <= 5, `${day}: 3-5 preset rooms (got ${roomIds.length})`);
    assert(roomIds.some(r => ['archer', 'bomb', 'mage'].indexOf(r) >= 0), `${day}: loadout includes real offense`);
    for (const r of roomIds) assert(cfg.rooms[r] >= 1 && cfg.rooms[r] <= ROOM_MAX[r], `${day}: room ${r} level ${cfg.rooms[r]} within limits`);
    const comboUsed14 = history.slice(-14).some(h => h.siege && h.siege.combo === cfg.comboSig);
    assert(!comboUsed14, `${day}: exact room combination not repeated within 14 days (${cfg.comboSig})`);
    if (cfg.boss) {
      const bossUsed7 = history.slice(-7).some(h => h.siege && h.siege.boss === cfg.boss);
      assert(!bossUsed7, `${day}: boss ${cfg.boss} not repeated within 7 days`);
    }
    if (y && y.siege && cfg.opening) assert(cfg.opening !== y.siege.opening, `${day}: opening enemy group differs from yesterday`);
    // fairness: rerun the sim on the final config
    const cons = gen.simulateSiege(cfg, 'cons'), avg = gen.simulateSiege(cfg, 'avg'), strong = gen.simulateSiege(cfg, 'strong');
    assert(avg.cleared, `${day}: average play clears the siege (Silver reachable)`);
    assert(strong.cleared, `${day}: strong play clears the siege (Gold reachable)`);
    assert(cons.killedFrac >= 0.45, `${day}: conservative play is not crushed instantly (killed ${Math.round(cons.killedFrac * 100)}%)`);
    assert(!(avg.remainFrac > 0.95 && strong.remainFrac > 0.97), `${day}: siege is not trivial`);
    assert(cfg.scoring.goldScore > cfg.scoring.bronzeScore, `${day}: gold threshold above bronze`);
    /* duration window re-based by the 2026-08 pacing pass: the same enemy
       budget now arrives roughly twice as fast, so a strong loadout can put a
       whole siege away inside a minute. The floor guards against a siege that
       is over before it reads as one; length is no longer the difficulty knob,
       simultaneous pressure is (asserted below). */
    const estMin = avg.clearTime / 60;
    assert(estMin >= 1.0 && estMin <= 7, `${day}: estimated duration ${estMin.toFixed(1)}min in a sane window`);

    /* ---- siege PACING invariants (2026-08 difficulty pass) ----
       These are the properties the pass exists to guarantee: the challenge
       starts at once, never goes quiet, arrives in overlapping groups, and
       escalates from the opening stage to the climax. */
    const q = cfg.queue.slice().sort((a, b) => a.delay - b.delay);
    assert(q[0].delay <= 2.0, `${day}: first enemy spawns within 2s (got ${q[0].delay}s)`);
    let worstGap = 0;
    for (let k = 1; k < q.length; k++) worstGap = Math.max(worstGap, q[k].delay - q[k - 1].delay);
    assert(worstGap <= 8.5, `${day}: no silent gap over 8.5s in the spawn queue (worst ${worstGap.toFixed(1)}s)`);
    // groups: several foes must share each arrival moment
    let clustered = 0;
    for (let k = 1; k < q.length; k++) if (q[k].delay - q[k - 1].delay <= 0.75) clustered++;
    assert(clustered / q.length >= 0.4, `${day}: enemies arrive in groups (${Math.round(clustered / q.length * 100)}% clustered)`);
    // escalation: the final quarter of the timeline out-spawns the first
    const span = q[q.length - 1].delay;
    const inWindow = (a, b) => q.filter(s => s.delay >= span * a && s.delay < span * b).length;
    const openRate = inWindow(0, 0.25) / Math.max(1, span * 0.25);
    const endRate = inWindow(0.75, 1.001) / Math.max(1, span * 0.25);
    assert(endRate > openRate * 1.25, `${day}: the climax out-spawns the opening (${openRate.toFixed(2)}/s -> ${endRate.toFixed(2)}/s)`);
    // readability: a group never lands as one indistinguishable instant
    let sameInstant = 0;
    for (let k = 1; k < q.length; k++) if (q[k].delay === q[k - 1].delay) sameInstant++;
    assert(sameInstant / q.length < 0.15, `${day}: spawns are staggered, not simultaneous (${sameInstant} exact ties)`);
    // every entry must be placeable on the field
    for (const sEntry of q) {
      assert(sEntry.delay >= 0 && isFinite(sEntry.delay), `${day}: spawn delay is a real, non-negative time`);
      if (sEntry.laneFrac !== undefined) assert(sEntry.laneFrac >= 0 && sEntry.laneFrac <= 1, `${day}: laneFrac ${sEntry.laneFrac} inside the walking band`);
      assert(sEntry.hpMult > 0 && sEntry.spdMult > 0, `${day}: spawn multipliers are positive`);
    }

    themesSeen.add(cfg.theme);
    combosSeen.add(cfg.comboSig);
    for (const r of roomIds) roomsFeatured.add(r);
    history.push(historyEntry(gen, day, decrees, cfg));
    while (history.length > 60) history.shift();
  }

  /* ---- long-run coverage ---- */
  const eligible = gen.DECREE_TEMPLATES.filter(t => { try { return t.valid(profile); } catch (e) { return false; } });
  const coverage = eligible.filter(t => templatesSeen.has(t.id)).length / eligible.length;
  assert(coverage >= 0.75, `template coverage over ${DAYS} days is broad (${Math.round(coverage * 100)}% of ${eligible.length})`);
  const eligibleThemes = gen.SIEGE_THEMES.filter(t => {
    const order = ['intro', 'normal', 'adv', 'vet'];
    return order.indexOf(profile.bracket) >= order.indexOf(t.minBracket);
  });
  assert(themesSeen.size >= Math.min(eligibleThemes.length, 5), `theme rotation broad (${themesSeen.size} themes seen)`);
  assert(roomsFeatured.size === 6, `every room featured across the period (${roomsFeatured.size}/6)`);
  assert(siegeFallbacks === 0, `no fallback siege configs were needed (${siegeFallbacks})`);
  console.log(`  templates: ${templatesSeen.size}/${eligible.length} · themes: ${themesSeen.size} · combos: ${combosSeen.size} · fallbacks: ${siegeFallbacks}`);
}

/* ============================================================
   REWARD SAFETY — transaction ledger + kingdom restoration model
   ============================================================ */
console.log('\n=== Reward safety ===');
{
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  const st = gen.dailyState();
  st.dayKey = '2026-07-25';
  const k = gen.ensureKingdom();

  // decree claims: 3 × 1 + bonus 2 — all BANKED, never auto-spent
  assert(gen.grantSeals('2026-07-25|decree|0|kill_any', 1, 'decree') !== null, 'decree 1 grants');
  assert(gen.grantSeals('2026-07-25|decree|0|kill_any', 1, 'decree') === null, 'decree 1 REPLAY blocked');
  gen.grantSeals('2026-07-25|decree|1|convert_n', 1, 'decree');
  gen.grantSeals('2026-07-25|decree|2|rico_sink', 1, 'decree');
  gen.grantSeals('2026-07-25|decreeBonus', 2, 'decree-bonus');
  assert(gen.grantSeals('2026-07-25|decreeBonus', 2, 'decree-bonus') === null, 'bonus REPLAY blocked');
  assert(k.totalSeals === 5, `decrees award exactly 5 seals max (got ${k.totalSeals})`);

  // siege tiers: bronze → silver → gold = 3 total, one per tier step
  gen.grantSeals('2026-07-25|siege|tier1', 1, 'siege');
  gen.grantSeals('2026-07-25|siege|tier2', 1, 'siege');
  gen.grantSeals('2026-07-25|siege|tier3', 1, 'siege');
  assert(gen.grantSeals('2026-07-25|siege|tier3', 1, 'siege') === null, 'gold tier REPLAY blocked');
  assert(k.totalSeals === 8, `full day awards exactly 8 seals (got ${k.totalSeals})`);
  assert(k.seals === 8, `all granted seals are banked and spendable (got ${k.seals})`);
  const anyContrib = gen.KR_DISTRICTS.some(d => k.districts[d.id].contributed > 0);
  assert(!anyContrib, 'no district received seals automatically');

  // contributions require an explicit active project
  assert(k.activeDistrict === null, 'no active district by default');
  assert(gen.krMaxContribution() === 0, 'no active district → nothing to contribute');
  assert(gen.contributeSeals(5).length === 0 && k.seals === 8, 'contribution without active project spends nothing');

  // royal_keep: cost 24 → 25% checkpoint at 6 seals; contributions cap there
  k.activeDistrict = 'royal_keep';
  assert(gen.krMaxContribution() === 6, `max contribution caps at the next checkpoint (got ${gen.krMaxContribution()})`);
  gen.contributeSeals(3);   // partial
  const keep = k.districts.royal_keep;
  assert(keep.contributed === 3 && k.seals === 5, `partial contribution persists (${keep.contributed} in, ${k.seals} banked)`);
  assert(k.stars === 0 && !keep.checkpoints[25], 'no checkpoint reward before the boundary');
  let notices = gen.contributeSeals(99);   // clamped to the checkpoint boundary
  assert(keep.contributed === 6 && k.seals === 2, `oversized contribution clamped to checkpoint (${keep.contributed} in, ${k.seals} banked)`);
  assert(keep.checkpoints[25] === true && k.stars === 1, `25% checkpoint awards exactly 1 star once (got ${k.stars})`);
  assert(notices.some(n => n.kind === 'checkpoint' && n.pct === 25), 'checkpoint notice emitted');

  // overspend impossible: only the banked balance can move
  notices = gen.contributeSeals(99);
  assert(keep.contributed === 8 && k.seals === 0, `spend capped by the bank (${keep.contributed} in, ${k.seals} banked)`);

  // finish the district (QA tops the bank up directly): stars 1+1+2+3 = 7,
  // each checkpoint pays exactly once, completion clears the active project
  k.seals = 100;
  for (let i = 0; i < 8 && !keep.complete; i++) notices = gen.contributeSeals(99);
  assert(keep.complete === true, 'district completes at 100%');
  assert(k.stars === 7, `checkpoint stars total 1/1/2/3 = 7 (got ${k.stars})`);
  assert(k.activeDistrict === null, 'completed district is no longer the active project');
  assert(k.seals === 100 - 16, `exactly the district cost was spent (banked ${k.seals})`);
  assert(gen.contributeSeals(5).length === 0 && k.seals === 84, 'no further spend into a complete district');

  // prosperity milestones paid exactly once at their thresholds (2★ coins, 7★ crowns)
  assert(sandbox.META.coins === 200, `2-star milestone paid 200 coins once (got ${sandbox.META.coins})`);
  assert(k.milestonesClaimed.m2 === true && k.milestonesClaimed.m7 === true, 'milestone claim flags recorded');
  /* crowns here = the 7★ kingdom milestone (15) and NOTHING else: restoring a
     district pays Prosperity Stars and its permanent passive, never crowns */
  assert(sandbox.META.crowns === 15,
    `7-star milestone paid 15 crowns once, and the district completion paid none (got ${sandbox.META.crowns})`);

  // unlock gating: 7 stars opens outer_walls (2★) and barracks (5★), not blacksmith (9★)
  const stars = k.stars;
  const unlocked = gen.KR_DISTRICTS.filter(d => stars >= d.unlock).map(d => d.id);
  assert(unlocked.indexOf('outer_walls') >= 0 && unlocked.indexOf('barracks') >= 0, 'earned stars unlock the next districts');
  assert(unlocked.indexOf('blacksmith_quarter') < 0, 'later districts stay locked until their threshold');

  // switching the active project never erases contribution
  k.activeDistrict = 'outer_walls';
  gen.contributeSeals(4);
  k.activeDistrict = 'barracks';
  assert(k.districts.outer_walls.contributed === 4, 'switching focus preserves partial contribution');

  // config sanity: every unlock threshold is reachable from earlier districts
  let reachable = 0;
  for (const d of gen.KR_DISTRICTS) {
    assert(d.unlock <= reachable, `${d.id} unlock ${d.unlock}★ reachable with ${reachable}★ from earlier districts`);
    reachable += gen.KR_CHECKPOINTS.reduce((a, c) => a + c.stars, 0);
    assert(d.cost % 4 === 0, `${d.id} cost ${d.cost} divisible by 4 (whole-seal checkpoints)`);
  }
}

/* ============================================================
   RESTORATION MILESTONE REWARDS — permanent district passives
   Every district checkpoint (25/50/75/100%) pays its Prosperity Stars AND
   one stack of that district's permanent passive. No district milestone
   pays coins or Crowns any more; only the whole-kingdom entitlement does.
   Passives are DERIVED from the saved checkpoints on every read, so these
   tests assert the totals are right without anything ever being granted.
   ============================================================ */
console.log('\n=== Kingdom Restoration milestone passives ===');

/* drive a district from its current state to 100% the way the UI does:
   top the bank up and contribute, one checkpoint boundary at a time */
function finishDistrict(gen, k, id) {
  k.activeDistrict = id;
  let notices = [];
  for (let i = 0; i < 8 && !k.districts[id].complete; i++) {
    k.seals = 500;
    notices = notices.concat(gen.contributeSeals(999));
  }
  return notices;
}
const DIST_TX = id => 'kingdom_restoration:' + id + ':completion_crowns';
const KINGDOM_TX = 'kingdom_restoration:entire_kingdom:completion_crowns';
const near = (a, b) => Math.abs(a - b) < 1e-9;

{
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  const R = gen.KR_REWARDS;
  const k = gen.ensureKingdom();

  assert(R.districtCompletionCrowns === undefined, 'the per-district completion Crown reward no longer exists');
  assert(R.kingdomCompletionCrowns === 1000, `kingdom reward still configured at 1000 (got ${R.kingdomCompletionCrowns})`);
  assert(gen.krRequiredDistricts().length === 8, `all eight districts required for kingdom completion (got ${gen.krRequiredDistricts().length})`);
  assert(gen.KR_CHECKPOINTS.length === 4, 'four restoration milestones per district');
  for (const d of gen.KR_DISTRICTS) assert(!!gen.KR_PASSIVES[d.id], `${d.id} has a passive configured`);

  // --- a fresh kingdom holds no bonus at all ---
  const zero = gen.kingdomBonuses();
  assert(zero.castleHp === 0 && zero.treasuryDiscount === 0 && zero.roomDiscount === 0,
    'a fresh kingdom grants no HP and no discounts');
  assert(zero.archerDamage === 1 && zero.allyDamage === 1 && zero.throwDamage === 1 &&
    zero.mageDamage === 1 && zero.coinGain === 1, 'a fresh kingdom leaves every multiplier at 1');

  // --- Royal Keep: one stack of Treasury discount per milestone ---
  k.activeDistrict = 'royal_keep';
  const keep = k.districts.royal_keep;
  const wantDisc = [0.025, 0.05, 0.075, 0.1];
  const pcts = [25, 50, 75, 100];
  for (let i = 0; i < pcts.length; i++) {
    k.seals = 500;
    const notices = gen.contributeSeals(999);
    const pct = pcts[i];
    assert(keep.checkpoints[pct] === true, `royal_keep reaches the ${pct}% checkpoint`);
    assert(sandbox.META.crowns === 0 || pct === 100, `${pct}% checkpoint grants no completion crowns (crowns ${sandbox.META.crowns})`);
    assert(!k.tx[DIST_TX('royal_keep')], `${pct}% checkpoint records no district Crown transaction`);
    assert(gen.krPassiveStacks(k, gen.KR_DISTRICTS.find(d => d.id === 'royal_keep')) === i + 1,
      `royal_keep holds ${i + 1} stacks after ${pct}%`);
    assert(near(gen.kingdomBonuses().treasuryDiscount, wantDisc[i]),
      `${pct}% -> ${wantDisc[i] * 100}% treasury discount (got ${gen.kingdomBonuses().treasuryDiscount})`);
    // the popup row carries this milestone's bonus AND the running total
    const cpn = notices.find(n => n.kind === 'checkpoint');
    assert(!!cpn && cpn.pct === pct, `${pct}% emits a checkpoint notice`);
    assert(cpn.gained === '2.5% discount on Royal Treasury prices',
      `${pct}% notice states the bonus earned at this milestone (got "${cpn.gained}")`);
    assert(cpn.total === (wantDisc[i] * 100) + '% discount on Royal Treasury prices',
      `${pct}% notice states the new cumulative total (got "${cpn.total}")`);
    assert(!notices.some(n => n.kind === 'districtCrowns'), `${pct}% emits no crown notice`);
  }
  assert(keep.complete === true, 'royal_keep completes at 100%');
  assert(k.stars === 7, `100% still pays its Prosperity Stars (stars ${k.stars})`);
  assert(sandbox.META.crowns === 15, `only the 7-star kingdom milestone paid crowns (got ${sandbox.META.crowns})`);
  assert(!k.tx[KINGDOM_TX], 'no kingdom transaction after a single district');

  // --- replays cannot pay twice, and cannot move the derived totals ---
  const settledDisc = gen.kingdomBonuses().treasuryDiscount;
  const settledCrowns = sandbox.META.crowns;
  gen.krReconcileRewards();
  gen.ensureKingdom();
  gen.kingdomBonuses(); gen.kingdomBonuses();
  assert(gen.contributeSeals(99).length === 0, 'a complete district accepts no further contribution');
  assert(near(gen.kingdomBonuses().treasuryDiscount, settledDisc), 'reopening/reconciling cannot re-stack a passive');
  assert(sandbox.META.crowns === settledCrowns, `reopening/reconciling grants nothing extra (got ${sandbox.META.crowns})`);

  // --- the whole kingdom: every passive at its configured maximum ---
  const rest = gen.KR_DISTRICTS.filter(d => d.id !== 'royal_keep');
  for (let i = 0; i < rest.length - 1; i++) finishDistrict(gen, k, rest[i].id);
  assert(!gen.krKingdomComplete(k), 'seven of eight districts is not a restored kingdom');
  assert(!k.tx[KINGDOM_TX], 'kingdom reward withheld while one district is unfinished');
  const last = rest[rest.length - 1];
  const before = sandbox.META.crowns;
  const finalNotices = finishDistrict(gen, k, last.id);
  assert(gen.krKingdomComplete(k), 'all eight districts complete the kingdom');
  assert(sandbox.META.crowns - before === 1000 + 100,
    `final district pays only the 1000 kingdom reward (plus the 56-star milestone's 100) — delta ${sandbox.META.crowns - before}`);
  assert(!finalNotices.some(n => n.kind === 'districtCrowns'), 'no district crown notice is ever emitted');
  assert(finalNotices.some(n => n.kind === 'kingdomCrowns'), 'the kingdom reward notice is emitted');

  const full = gen.kingdomBonuses();
  assert(full.castleHp === 100, `Outer Walls maxes at +100 castle HP (got ${full.castleHp})`);
  assert(near(full.treasuryDiscount, 0.1), `Royal Keep maxes at 10% treasury discount (got ${full.treasuryDiscount})`);
  assert(near(full.roomDiscount, 0.1), `Market Square maxes at 10% room discount (got ${full.roomDiscount})`);
  assert(near(full.archerDamage, 1.1), `Barracks maxes at +10% archer damage (got ${full.archerDamage})`);
  assert(near(full.allyDamage, 1.1), `Adventurers' Guild maxes at +10% ally damage (got ${full.allyDamage})`);
  assert(near(full.throwDamage, 1.1), `Blacksmith Quarter maxes at +10% throwing damage (got ${full.throwDamage})`);
  assert(near(full.mageDamage, 1.05), `Mage District maxes at +5% mage damage (got ${full.mageDamage})`);
  assert(near(full.coinGain, 1.05), `Festival Grounds maxes at +5% coins (got ${full.coinGain})`);
  for (const d of gen.KR_DISTRICTS) assert(full.stacks[d.id] === 4, `${d.id} holds all four stacks`);

  // --- the ONLY restoration crown transaction is the kingdom one ---
  let restoration = 0;
  for (const key of Object.keys(k.tx)) restoration += k.tx[key].amount;
  assert(restoration === 1000, `restoration crowns total 1000 (got ${restoration})`);
  assert(Object.keys(k.tx).length === 1, `exactly 1 restoration transaction exists (got ${Object.keys(k.tx).length})`);
  const settled = sandbox.META.crowns;
  gen.krReconcileRewards();
  gen.krReconcileRewards();
  assert(sandbox.META.crowns === settled, 'repeat reconciliation of a finished kingdom grants nothing');
}

/* ---- reward text: exact wording and rounding for every district ---- */
{
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  const T = gen.krPassiveText;
  assert(T('outer_walls', 1) === '+25 Maximum Castle HP', `outer walls x1 (got "${T('outer_walls', 1)}")`);
  assert(T('outer_walls', 2) === '+50 Maximum Castle HP', `outer walls x2 (got "${T('outer_walls', 2)}")`);
  assert(T('outer_walls', 4) === '+100 Maximum Castle HP', `outer walls x4 (got "${T('outer_walls', 4)}")`);
  assert(T('royal_keep', 2) === '5% discount on Royal Treasury prices', `royal keep x2 (got "${T('royal_keep', 2)}")`);
  assert(T('royal_keep', 4) === '10% discount on Royal Treasury prices', `royal keep x4 (got "${T('royal_keep', 4)}")`);
  assert(T('market_square', 3) === '7.5% discount on Castle Room prices', `market square x3 (got "${T('market_square', 3)}")`);
  assert(T('barracks', 3) === '+7.5% Archer Tower damage', `barracks x3 (got "${T('barracks', 3)}")`);
  assert(T('adventurers_guild', 4) === '+10% allied unit damage', `guild x4 (got "${T('adventurers_guild', 4)}")`);
  assert(T('blacksmith_quarter', 1) === '+2.5% throwing damage', `blacksmith x1 (got "${T('blacksmith_quarter', 1)}")`);
  assert(T('mage_district', 3) === '+3.75% mage damage', `mage x3 (got "${T('mage_district', 3)}")`);
  assert(T('festival_grounds', 4) === '+5% coins earned', `festival x4 (got "${T('festival_grounds', 4)}")`);
  assert(T('outer_walls', 0) === '', 'zero stacks prints nothing');

  const icons = sandbox.CastleDaily.guideValues().medallionIcons.map(m => m.icon);
  assert(icons.length === 4, 'four completion medallions are published');
  assert(icons[0].indexOf('icon_completion_25.png') >= 0 && icons[3].indexOf('icon_completion_100.png') >= 0,
    'the medallion set is the new completion art');
  assert(new Set(icons).size === 4, 'each milestone has its own distinct medallion');
  for (const p of [25, 50, 75, 100]) assert(gen.krMedallion(p).indexOf('icon_completion_' + p + '.png') >= 0,
    `${p}% selects icon_completion_${p}.png`);
  assert(gen.krMedallion(99).indexOf('icon_completion_75.png') >= 0, 'an off-grid percentage falls back to the nearest lower medallion');
}

/* ---- existing players: passives are DERIVED from saved progress ---- */
{
  // a v2 save written long before passives existed: four districts already
  // Flourishing, one part-way, no reward ledger at all
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  const done = { contributed: 24, complete: true, checkpoints: { 25: true, 50: true, 75: true, 100: true } };
  sandbox.META.kingdom = {
    v: 2, seals: 4, totalSeals: 40, stars: 28, migratedStars: 0,
    districts: {
      royal_keep: JSON.parse(JSON.stringify(done)),
      outer_walls: JSON.parse(JSON.stringify(done)),
      barracks: JSON.parse(JSON.stringify(done)),
      blacksmith_quarter: JSON.parse(JSON.stringify(done)),
      market_square: { contributed: 28, complete: false, checkpoints: { 25: true, 50: true } },
    },
    activeDistrict: 'market_square', milestonesClaimed: { m2: true, m7: true, m14: true, m21: true }, newUnlocks: {},
  };
  const k = gen.ensureKingdom();
  const snapshot = JSON.stringify(k.districts);
  const crownsBefore = sandbox.META.crowns;

  const b = gen.kingdomBonuses();
  assert(b.castleHp === 100, `a finished Outer Walls already pays +100 HP (got ${b.castleHp})`);
  assert(near(b.treasuryDiscount, 0.1), `a finished Royal Keep already pays 10% off (got ${b.treasuryDiscount})`);
  assert(near(b.archerDamage, 1.1), `a finished Barracks already pays +10% archer damage (got ${b.archerDamage})`);
  assert(near(b.throwDamage, 1.1), `a finished Blacksmith Quarter already pays +10% throwing damage (got ${b.throwDamage})`);
  assert(near(b.roomDiscount, 0.05), `a half-restored Market Square pays 5% off rooms (got ${b.roomDiscount})`);
  assert(b.stacks.market_square === 2, `a half-restored district holds exactly 2 stacks (got ${b.stacks.market_square})`);
  assert(near(b.allyDamage, 1) && near(b.mageDamage, 1) && near(b.coinGain, 1),
    'untouched districts pay nothing');
  assert(JSON.stringify(k.districts) === snapshot, 'reading the passives moves no district stage, checkpoint or contribution');
  assert(sandbox.META.crowns === crownsBefore, 'reading the passives grants no coins or crowns');
  assert(Object.keys(k.tx).length === 0, 'reading the passives writes no ledger entry');

  // the old per-district crowns are NOT re-awarded to this player
  const res = gen.krReconcileRewards();
  assert(res.total === 0 && sandbox.META.crowns === crownsBefore, 'no old district crowns are awarded again');
  assert(!k.tx[DIST_TX('royal_keep')], 'no district completion transaction is written');
  assert(!k.tx[KINGDOM_TX], 'an unfinished kingdom is never backfilled');
  assert(!k.pendingRewardSummary, 'no summary is queued when nothing was awarded');
  assert(k.seals === 4 && k.stars === 28, 'reconciliation preserves banked seals and prosperity stars');
  assert(k.activeDistrict === 'market_square', 'reconciliation preserves the active project');

  // repeated loads are stable in every direction
  for (let i = 0; i < 5; i++) { gen.ensureKingdom(); gen.krReconcileRewards(); }
  const after = gen.kingdomBonuses();
  assert(after.castleHp === 100 && near(after.roomDiscount, 0.05) && sandbox.META.crowns === crownsBefore,
    'five reloads change no passive and no balance');
}
{
  // checkpoint flags lost to an interrupted write: the contributed Seals
  // still say which milestones were passed, so the stacks survive
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  sandbox.META.kingdom = {
    v: 2, seals: 0, totalSeals: 0, stars: 0, migratedStars: 0,
    districts: { outer_walls: { contributed: 24, complete: false, checkpoints: {} } },   // 24 of 32 = 75%
    activeDistrict: null, milestonesClaimed: {}, newUnlocks: {},
  };
  gen.ensureKingdom();
  assert(gen.kingdomBonuses().castleHp === 75, `75% of Outer Walls with no flags still pays +75 HP (got ${gen.kingdomBonuses().castleHp})`);
}
{
  // a fully restored kingdom that predates the kingdom reward still gets it,
  // exactly once, and no district crowns alongside it
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  const districts = {};
  for (const d of gen.KR_DISTRICTS) districts[d.id] = { contributed: d.cost, complete: true, checkpoints: { 25: true, 50: true, 75: true, 100: true } };
  sandbox.META.kingdom = {
    v: 2, seals: 0, totalSeals: 416, stars: 56, migratedStars: 0,
    districts, activeDistrict: null, milestonesClaimed: {}, newUnlocks: {},
  };
  const k = gen.ensureKingdom();
  const res = gen.krReconcileRewards();
  assert(res.kingdomCrowns === 1000 && res.total === 1000, `a fully restored kingdom backfills 1000 crowns (got ${res.total})`);
  assert(sandbox.META.crowns === 1000, `backfilled balance is 1000 (got ${sandbox.META.crowns})`);
  assert(Object.keys(k.tx).length === 1, `only the kingdom transaction is written (got ${Object.keys(k.tx).length})`);
  assert(!!k.pendingRewardSummary && k.pendingRewardSummary.total === 1000, 'ONE combined summary is queued');
  gen.krReconcileRewards();
  gen.krReconcileRewards();
  assert(sandbox.META.crowns === 1000, `subsequent loads grant zero (got ${sandbox.META.crowns})`);
  const b = gen.kingdomBonuses();
  assert(b.castleHp === 100 && near(b.coinGain, 1.05), 'the same save already holds every passive at maximum');
}
{
  // crash safety: the grant is saved before any presentation, so a kill
  // between the grant and the modal loses nothing and duplicates nothing
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  const k = gen.ensureKingdom();
  finishDistrict(gen, k, 'royal_keep');
  const ledger = JSON.stringify(k.tx), crowns = sandbox.META.crowns;
  const disc = gen.kingdomBonuses().treasuryDiscount;
  // "app killed here" — the next launch re-runs ensureKingdom + reconcile
  const reload = JSON.parse(JSON.stringify(sandbox.META));
  sandbox.META.kingdom = reload.kingdom;
  sandbox.META.crowns = reload.crowns;
  gen.ensureKingdom();
  gen.krReconcileRewards();
  assert(sandbox.META.crowns === crowns, `reload after a completion keeps the balance (got ${sandbox.META.crowns})`);
  assert(JSON.stringify(sandbox.META.kingdom.tx) === ledger, 'reload leaves the entitlement ledger untouched');
  assert(near(gen.kingdomBonuses().treasuryDiscount, disc), 'reload keeps the passive at exactly one set of stacks');
}

/* ============================================================
   SAVE MIGRATION — old placeholder saves keep every earned value
   ============================================================ */
console.log('\n=== Kingdom save migration ===');
{
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  // a pre-rebuild placeholder save: banked seals, lifetime total, 4 stars,
  // auto-contributed fake projects, old improvement claims
  sandbox.META.kingdom = {
    seals: 3, totalSeals: 11, stars: 4,
    projects: { watchtower: { contributed: 30, complete: true, checkpoints: { 25: true, 50: true, 75: true, 100: true } },
                granary: { contributed: 5, complete: false, checkpoints: {} } },
    activeProject: 'granary',
    improvementsClaimed: { s1: true, s4: true },
  };
  const k = gen.ensureKingdom();
  assert(k.v === 2, 'schema migrated to v2');
  assert(k.seals === 3, `spendable balance preserved (got ${k.seals})`);
  assert(k.totalSeals === 11, `lifetime total preserved (got ${k.totalSeals})`);
  assert(k.stars === 4 && k.migratedStars === 4, `prosperity stars preserved and marked migrated (got ${k.stars}/${k.migratedStars})`);
  assert(!!k.legacyPlaceholder && k.legacyPlaceholder.projects.watchtower.contributed === 30, 'old project data snapshotted, never erased');
  assert(k.districts.royal_keep.contributed === 0, 'fake projects are NOT mapped onto real districts');
  assert(k.milestonesClaimed.m2 === true, 'milestones at/below migrated stars marked claimed');
  assert(sandbox.META.coins === 0 && sandbox.META.crowns === 0, 'migration itself grants no rewards');
  assert(k.activeDistrict === null, 'old fake active project does not carry over');
  // idempotent: running ensure again changes nothing
  const before = JSON.stringify(k);
  gen.ensureKingdom();
  assert(JSON.stringify(sandbox.META.kingdom) === before, 'migration is idempotent');
}

/* ============================================================
   DAILY KEY — forward-only acceptance
   ============================================================ */
console.log('\n=== Daily key rules ===');
{
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  assert(gen.localDayKey(new Date(2026, 0, 5).getTime()) === '2026-01-05', 'day key format YYYY-MM-DD');
  assert('2026-07-24' < '2026-07-25', 'ISO string ordering supports forward-only comparison');
  // determinism: same day + profile + history ⇒ identical content
  const p = { bracket: 'normal', bestWave: 12, level: 10, runs: 30, completionRate: 1 };
  const a = gen.generateDecrees('2026-07-25', p, []);
  const b = gen.generateDecrees('2026-07-25', p, []);
  assert(JSON.stringify(a.decrees) === JSON.stringify(b.decrees), 'decree generation is deterministic for a day');
  const sa = gen.generateSiege('2026-07-25', p, []);
  const sb = gen.generateSiege('2026-07-25', p, []);
  assert(JSON.stringify(sa.config.queue) === JSON.stringify(sb.config.queue), 'siege generation is deterministic for a day');
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
