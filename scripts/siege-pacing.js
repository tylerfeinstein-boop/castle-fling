/* ============================================================
   DAILY SIEGE PACING REPORT  (node scripts/siege-pacing.js)
   Loads daily.js in the same sandbox the QA harness uses and
   measures the *pacing* of generated sieges — the numbers the
   fairness sim does not report: opening delay, spawn gaps,
   dead air (field empty), simultaneous enemy pressure, and how
   all of that escalates from the opening third to the final one.

   Kill model: identical to simulateSiege() — the wave's effective
   DPS (rooms + skill-banded fling) clears foes in arrival order,
   so "alive" here means spawned and not yet cleared by an average
   player. It is an estimate, not the renderer, but it is the same
   estimate the difficulty scaler is tuned against.
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
  vm.runInContext(src + '\n;globalThis.CastleDaily = CastleDaily;', sandbox, { filename: 'daily.js' });
  return sandbox;
}
function dayKeyFor(i) {
  const d = new Date(2026, 6, 1 + i);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const PROFILES = [
  { name: 'new player', bracket: 'intro', bestWave: 3, level: 2, runs: 4, completionRate: 1, bestScore: 2500 },
  { name: 'intermediate', bracket: 'normal', bestWave: 12, level: 14, runs: 40, completionRate: 1, bestScore: 30000 },
  { name: 'veteran', bracket: 'vet', bestWave: 42, level: 55, runs: 300, completionRate: 1, bestScore: 250000 },
];
const DAYS = Number(process.argv[2] || 30);
const SKILL = process.argv[3] || 'avg';

/* per-day pacing metrics from the config's own queue */
function pacing(gen, cfg, skill) {
  const B = gen.SIEGE_BRACKET[cfg.bracket];
  const dps = (function () {
    let d = gen.roomDps(cfg.rooms) + B.fling[skill];
    if (cfg.rooms.barracks >= 2) d *= 1.06;
    if (cfg.mods.indexOf('quick_arts') >= 0) d *= 1.04;
    return d;
  })();
  const q = cfg.queue.slice().sort((a, b) => a.delay - b.delay);
  // arrival-order clearing, exactly like simulateSiege
  let killEnd = 0;
  const lives = q.map(s => {
    const e = gen.SIM_ENEMY[s.type];
    const hp = e.hp * 2.0 * (s.hpMult || 1);
    const start = Math.max(killEnd, s.delay);
    killEnd = start + hp / dps;
    return { spawn: s.delay, die: killEnd, type: s.type };
  });
  const end = Math.max(cfg.span, lives.length ? lives[lives.length - 1].die : 0);
  const STEP = 0.25;
  let peak = 0, sumAlive = 0, samples = 0, dead = 0;
  const thirds = [[0, end / 3], [end / 3, end * 2 / 3], [end * 2 / 3, end]];
  const tStat = thirds.map(() => ({ peak: 0, sum: 0, n: 0, spawns: 0 }));
  for (let t = 0; t <= end; t += STEP) {
    let alive = 0;
    for (const l of lives) if (l.spawn <= t && l.die > t) alive++;
    peak = Math.max(peak, alive);
    sumAlive += alive; samples++;
    if (alive === 0 && t > q[0].delay && t < end - 1) dead += STEP;
    const ti = Math.min(2, Math.floor(t / (end / 3)));
    tStat[ti].peak = Math.max(tStat[ti].peak, alive);
    tStat[ti].sum += alive; tStat[ti].n++;
  }
  for (const s of q) {
    const ti = Math.min(2, Math.floor(s.delay / (end / 3)));
    tStat[ti].spawns++;
  }
  // gaps between consecutive spawn times (grouped: identical times = one group)
  const gaps = [];
  for (let i = 1; i < q.length; i++) { const g = q[i].delay - q[i - 1].delay; if (g > 0.001) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  // distinct enemy types alive at the same moment, sampled at peak pressure
  let maxTypes = 0;
  for (let t = 0; t <= end; t += 1) {
    const set = new Set();
    for (const l of lives) if (l.spawn <= t && l.die > t) set.add(l.type);
    maxTypes = Math.max(maxTypes, set.size);
  }
  return {
    first: q[0].delay, count: q.length, span: cfg.span, end,
    medGap: med, maxGap: gaps.length ? gaps[gaps.length - 1] : 0,
    dead, peak, avgAlive: sumAlive / Math.max(1, samples), maxTypes,
    thirds: tStat.map((s, i) => ({
      peak: s.peak, avg: s.sum / Math.max(1, s.n), spawns: s.spawns,
      rate: s.spawns / Math.max(0.001, (thirds[i][1] - thirds[i][0])) * 60,
    })),
  };
}

const agg = [];
for (const profile of PROFILES) {
  const sandbox = freshSandbox();
  const gen = sandbox.CastleDaily._gen;
  sandbox.META.bestWave = profile.bestWave;
  const history = [];
  const rows = [];
  for (let i = 0; i < DAYS; i++) {
    const day = dayKeyFor(i);
    const dg = gen.generateDecrees(day, profile, history);
    const cfg = gen.generateSiege(day, profile, history).config;
    rows.push(pacing(gen, cfg, SKILL));
    history.push({
      day, decrees: dg.decrees.map(d => d.tpl), pairs: [], targets: {}, enemies: [], modes: [], mechs: [], cats: [],
      sig: day, done: 3,
      siege: { theme: cfg.theme, mods: cfg.mods, loadout: cfg.loadoutSig, combo: cfg.comboSig, topRoom: cfg.topRoom, sig: cfg.sig, boss: cfg.boss || null, opening: cfg.opening || '' },
    });
    while (history.length > 60) history.shift();
  }
  const avg = k => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  const max = k => rows.reduce((a, r) => Math.max(a, r[k]), 0);
  const t = i => ({
    peak: rows.reduce((a, r) => a + r.thirds[i].peak, 0) / rows.length,
    avg: rows.reduce((a, r) => a + r.thirds[i].avg, 0) / rows.length,
    rate: rows.reduce((a, r) => a + r.thirds[i].rate, 0) / rows.length,
  });
  const o = {
    profile: profile.name, bracket: profile.bracket,
    first: avg('first'), firstWorst: max('first'), count: avg('count'), span: avg('span'), end: avg('end'),
    medGap: avg('medGap'), maxGap: avg('maxGap'), maxGapWorst: max('maxGap'),
    dead: avg('dead'), deadWorst: max('dead'), peak: avg('peak'), avgAlive: avg('avgAlive'), maxTypes: avg('maxTypes'),
    early: t(0), mid: t(1), late: t(2),
  };
  agg.push(o);
  const f = (n, d = 1) => n.toFixed(d);
  console.log(`\n=== ${o.profile} (${o.bracket}) — ${DAYS} days, ${SKILL} skill ===`);
  console.log(`  first spawn  : ${f(o.first)}s avg   (worst day ${f(o.firstWorst)}s)`);
  console.log(`  queue        : ${f(o.count)} foes over ${f(o.span)}s scripted / ${f(o.end)}s real`);
  console.log(`  spawn gaps   : median ${f(o.medGap, 2)}s   max ${f(o.maxGap)}s (worst day ${f(o.maxGapWorst)}s)`);
  console.log(`  empty field  : ${f(o.dead)}s avg   (worst day ${f(o.deadWorst)}s)`);
  console.log(`  simultaneous : avg ${f(o.avgAlive, 2)}   peak ${f(o.peak, 2)}   distinct types at once ${f(o.maxTypes, 2)}`);
  console.log(`  escalation   : early ${f(o.early.avg, 2)} alive / ${f(o.early.rate)} spawns-per-min  ->  mid ${f(o.mid.avg, 2)} / ${f(o.mid.rate)}  ->  late ${f(o.late.avg, 2)} / ${f(o.late.rate)}`);
  console.log(`  peak by third: ${f(o.early.peak, 2)} -> ${f(o.mid.peak, 2)} -> ${f(o.late.peak, 2)}`);
}

if (process.env.SIEGE_PACING_JSON) fs.writeFileSync(process.env.SIEGE_PACING_JSON, JSON.stringify(agg, null, 2));
