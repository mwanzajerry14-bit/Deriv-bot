/**
 * ICT/SMC/CRT engine + flat-risk + backtest unit tests (Trend_Robot.html rcore).
 * Fixture = parameter-proven market story:
 *   19h steady climb → full down-hour (hard retrace) → recovery hour above the
 *   peak → cooling hour → flat filler + pad + shallow dip (sweep key Pz) →
 *   chunky bounce (5m/15m BOS) → long shallow retrace → final bar sweeps Pz
 *   and closes strong (displacement + CRT). All 13 checks must light up CALL.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "Trend_Robot.html"), "utf8");
const coreSrc = html.split('<script id="rcore">')[1].split("</script>")[0];
const sandbox = { module: { exports: {} }, console, window: {} };
vm.createContext(sandbox);
vm.runInContext(coreSrc, sandbox, { filename: "rcore.js" });
const C = sandbox.window.CORE_R;

let fails = 0, passes = 0;
function ok(label, cond, detail) {
  if (cond) passes++; else { fails++; console.log("FAIL " + label + " -> " + detail); }
}
function eq(label, got, want) { ok(label, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want)); }

/* ---------- fixture (hour-aligned epochs → stable HTF buckets) ---------- */
const T0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3600 * 72;
function bar(i, o, h, l, c) { return { epoch: T0 + i * 60, open: o, high: h, low: l, close: c }; }
function buildFixture() {
  const p = { n1: 1140, step: 0.55, red: 0.3, hard: 0.45, recAbove: 1, cool: 0.003,
              nd: 2, dip: 0.18, nb: 4, bounce: 0.35, nr: 12, ret: 0.6, body: 1.3 };
  const out = []; let px = 100, idx = 0;
  const push = (d, w) => {
    const o = px, c = px + d;
    const h = Math.max(o, c) + (d < 0 ? 0.04 : (w || 0.12));
    const l = Math.min(o, c) - (d < 0 ? (w || 0.12) : Math.max(0.06, (w || 0.12) - 0.06));
    out.push(bar(idx++, o, h, l, c)); px = c;
  };
  for (let i = 0; i < p.n1; i++) push((i % 7) === 6 ? -p.red : p.step);
  for (let i = 0; i < 60; i++) push(-p.hard, 0.1);                       // hour 19: down
  const recStep = ((60 * p.hard) + p.recAbove) / 60;
  for (let i = 0; i < 60; i++) push(recStep, 0.1);                       // hour 20: recovery → pivot
  for (let i = 0; i < 60; i++) push(-p.cool, 0.1);                       // hour 21: cooling
  const F = 58 - p.nd;                                                   // hour 22: filler+pad+dip = 60
  for (let i = 0; i < F; i++) push(0, 0.02);
  for (let i = 0; i < 2; i++) push(0.05, 0.05);
  for (let i = 0; i < p.nd; i++) push(-p.dip, 0.2);
  const Pz = px - 0.2;                                                   // dip bottom = sweep key
  for (let i = 0; i < p.nb; i++) push(p.bounce, 0.15);                   // BOS
  for (let i = 0; i < p.nr; i++) push(-p.ret / p.nr, 0.5);               // shallow retrace
  const o = px, l = Pz - 0.05, c = o + p.body;
  out.push(bar(idx++, o, c + 0.12, l, c));                               // sweep + displacement
  return out;
}
function mtfOf(c1) {
  const agg = C.agg1m;
  const c15 = agg(c1, 900);
  return {
    c1: c1.slice(-80),
    c5: agg(c1, 300).slice(-60),
    c15: c15.slice(-40),
    c1h: agg(c1, 3600).slice(-50),
    ref15: c15.length >= 2 ? c15[c15.length - 2] : null
  };
}

const NET = 0.886;
const cfg = { threshold: 11, evMin: 0.02, wrEstimate: 0.55 };

/* ---------- exports ---------- */
["atrOf","swingsOf","structureOf","dealingRange","zoneAt","lastFVG","displacementAt",
 "sweepNear","crtOf","regimeOf","chaseBlock","momentumOf","htfBiasOf","evaluateICT",
 "MIN_STAKE","riskInit","stakeFor","riskClock","riskCanTrade","riskOnResult","riskResume",
 "agg1m","metricsOf","splitChrono","sweepThreshold","monteCarlo","backtestRun"
].forEach(k => ok("export " + k, typeof C[k] === "function" || k === "MIN_STAKE", typeof C[k]));

/* ---------- fixture sanity ---------- */
const bars = buildFixture();
eq("fixture bar count (55 filler)", bars.length, 1140 + 60 + 60 + 60 + (58 - 2) + 2 + 2 + 4 + 12 + 1);
ok("fixture epochs hour-aligned", bars.every((b, i) => i === 0 || b.epoch === bars[0].epoch + i * 60), "misaligned");
const atr = C.atrOf(bars, 14);
ok("atrOf positive", atr > 0, atr);

/* zigzag for swingsOf (strict ±2 pivots need strictly alternating highs/lows) */
const zig = [];
for (let i = 0; i < 40; i++) {
  const h = 100 + (5 - Math.abs(((i + 2) % 10) - 5));   // peak every 10 bars
  zig.push({ epoch: T0 + i * 60, open: h - 0.5, high: h, low: h - 2, close: h - 0.5 });
}
ok("swingsOf finds pivots on zigzag", C.swingsOf(zig, 2).length >= 4, C.swingsOf(zig, 2).length);

const mtf = mtfOf(bars);
ok("mtf c1h ≥15 bars", mtf.c1h.length >= 15, mtf.c1h.length);
eq("1h structure bias", C.structureOf(mtf.c1h).bias, "bull");
eq("15m structure bias", C.structureOf(mtf.c15).bias, "bull");
eq("HTF bias bull", C.htfBiasOf(mtf.c1h, mtf.c15), "bull");
const st5 = C.structureOf(mtf.c5);
eq("5m structure bias bull", st5.bias, "bull");
ok("5m lastEvent bull", st5.lastEvent && st5.lastEvent.dir === "bull", JSON.stringify(st5.lastEvent));

const regime = C.regimeOf(mtf.c1, 60);
ok("regime not choppy", regime.type !== "choppy", JSON.stringify(regime));
ok("regime rangePct>0.02", regime.rangePct > 0.02, regime.rangePct);

const keyLo = Math.min(...mtf.c1.slice(-60, -1).map(x => x.low));
const k1 = mtf.c1[mtf.c1.length - 1];
ok("sweep: final wick below prior key", k1.low < keyLo && k1.close > keyLo,
   JSON.stringify({ low: k1.low, close: k1.close, keyLo }));
const crt = C.crtOf(mtf.ref15, mtf.c1, 25);
ok("crt bull", crt && crt.bull, JSON.stringify(crt && { bull: crt.bull, refLow: crt.ref && crt.ref.low }));
ok("displacement on final bar", C.displacementAt(mtf.c1, mtf.c1.length - 1) === true, "false");
const mom = C.momentumOf(mtf.c1);
ok("momentum bull (20-bar)", mom.bull, JSON.stringify(mom));
eq("chase clean when sweep just happened", C.chaseBlock(mtf.c1, "CALL", true).length, 0);
ok("lastFVG shape", (v => v === null || typeof v === "object")(C.lastFVG(mtf.c1)), String(C.lastFVG(mtf.c1)));
const dr = C.dealingRange(mtf.c1, 40);
ok("dealingRange sane", dr.hi > dr.lo && dr.eq === (dr.hi + dr.lo) / 2, JSON.stringify(dr));
eq("zoneAt discount", C.zoneAt(dr, dr.lo), "discount");
eq("zoneAt premium", C.zoneAt(dr, dr.hi), "premium");

/* ---------- evaluateICT: fixture MUST qualify as CALL at 13/13 ---------- */
const ev = C.evaluateICT(mtf, NET, cfg);
eq("picked side CALL", ev.side, "CALL");
ok("eligible", ev.eligible === true, JSON.stringify({ blocked: ev.blocked, score: ev.score }));
ok("critical checks true", ev.checks && ev.checks.htf && ev.checks.sweep && ev.checks.bosChoch && ev.checks.crt,
   JSON.stringify(ev.checks));
eq("score 13/13", ev.score, 13);
ok("EV ≥ evMin", ev.ev >= 0.02, ev.ev);
eq("all nine checks true", Object.values(ev.checks).filter(Boolean).length, 9);

/* flat data never qualifies */
const flat = [];
for (let i = 0; i < 400; i++) flat.push(bar(i, 500, 500.5, 499.5, 500 + (i % 2 ? 0.1 : -0.1)));
const evFlat = C.evaluateICT(mtfOf(flat), NET, cfg);
ok("flat never eligible", evFlat.eligible === false, JSON.stringify(evFlat));
ok("flat blocked reasons", evFlat.blocked.length > 0, "[]");

/* threshold gate */
const evStrict = C.evaluateICT(mtf, NET, { threshold: 14, evMin: 0.02, wrEstimate: 0.55 });
ok("score<14 blocks", evStrict.eligible === false && evStrict.blocked.some(b => /score/.test(b)),
   JSON.stringify(evStrict.blocked));

/* payout/EV gate */
const evPoor = C.evaluateICT(mtf, 0.4, { threshold: 11, evMin: 0.02, wrEstimate: 0.55 });
ok("low payout → ev block", evPoor.eligible === false && evPoor.blocked.some(b => /ev/.test(b)),
   JSON.stringify(evPoor.blocked));

/* ---------- risk module: flat stake, locks, no martingale ---------- */
const r = C.riskInit(1000, { riskPct: 0.75, dailyLossPct: 3, dailyProfitPct: 5, maxConsec: 3, maxSession: 20, cooldownSec: 30, smallMaxPct: 2 });
r.dayKey = new Date().toDateString(); r.dayStartBal = 1000;
let sf = C.stakeFor(1000, r);
ok("stake 0.75% of 1000", sf.ok && sf.stake === 7.5, JSON.stringify(sf));
C.riskOnResult(r, -7.5, Date.now());
eq("consec 1", r.consecLosses, 1);
sf = C.stakeFor(1000, r);
eq("stake flat after loss (never increases)", sf.stake, 7.5);
C.riskOnResult(r, -7.5, Date.now());
eq("3rd consecutive loss → stop", C.riskOnResult(r, -7.5, Date.now()), "consec_loss");
eq("riskCanTrade blocked", C.riskCanTrade(r, Date.now()).reason, "consec_loss");
C.riskResume(r);
eq("resume clears stop", C.riskCanTrade(r, Date.now() + 60000).ok, true);

const r2 = C.riskInit(1000, { dailyLossPct: 3, maxConsec: 99 });
r2.dayKey = new Date().toDateString(); r2.dayStartBal = 1000;
eq("daily loss lock", C.riskOnResult(r2, -31, Date.now()), "daily_loss");

const r3 = C.riskInit(1000, { dailyProfitPct: 5, maxConsec: 99, dailyLossPct: 50 });
r3.dayKey = new Date().toDateString(); r3.dayStartBal = 1000;
eq("daily profit lock", C.riskOnResult(r3, 51, Date.now()), "daily_profit");

const rS = C.riskInit(10, { riskPct: 0.75, smallMaxPct: 2 });
sf = C.stakeFor(10, rS);
ok("bal 10: min stake would be 3.5% > 2% → DO NOT TRADE", sf.ok === false && /DO NOT TRADE/.test(sf.reason), JSON.stringify(sf));
const rM = C.riskInit(50, { riskPct: 0.75, smallMaxPct: 2 });
sf = C.stakeFor(50, rM);
ok("bal 50: raw 0.38 ≥ min floor", sf.ok && sf.stake === 0.38, JSON.stringify(sf));
const rF = C.riskInit(40, { riskPct: 0.75, smallMaxPct: 2 });
sf = C.stakeFor(40, rF);
ok("bal 40: raw 0.30 < min, 0.875% ≤ 2% → floor 0.35", sf.ok && sf.stake === 0.35, JSON.stringify(sf));
eq("MIN_STAKE", C.MIN_STAKE, 0.35);

const r4 = C.riskInit(1000, { dailyLossPct: 3 });
r4.dayKey = "yesterday"; r4.stopped = "daily_loss"; r4.dayStartBal = 1000;
C.riskClock(r4, 1000, Date.now());
eq("riskClock new day clears daily locks", r4.stopped, null);

/* session cap */
const r5 = C.riskInit(1000, { maxSession: 2, maxConsec: 99, dailyLossPct: 99 });
r5.dayKey = new Date().toDateString(); r5.dayStartBal = 1000;
C.riskOnResult(r5, 1, Date.now()); C.riskOnResult(r5, 1, Date.now());
eq("session cap stops", C.riskOnResult(r5, 1, Date.now()), "session_cap");

/* ---------- backtest metrics ---------- */
const tr = [
  { win: true, pnl: 7.5 }, { win: false, pnl: -7.5 }, { win: true, pnl: 7.5 },
  { win: false, pnl: -7.5 }, { win: true, pnl: 7.5 }
];
const mm = C.metricsOf(tr, NET, 1000);
eq("metrics n", mm.n, 5);
ok("metrics wr 0.6", Math.abs(mm.wr - 0.6) < 1e-9, mm.wr);
ok("breakeven = 1/(1+net)", Math.abs(mm.breakeven - 1 / 1.886) < 1e-9, mm.breakeven);
ok("edge = wr − breakeven", Math.abs(mm.edge - (0.6 - 1 / 1.886)) < 1e-9, mm.edge);
ok("PF finite positive", mm.pf > 0 && isFinite(mm.pf), mm.pf);

const arr = Array.from({ length: 10 }, (_, i) => ({ i }));
const sp = C.splitChrono(arr, 0.6, 0.2);
eq("split train", sp.train.length, 6);
eq("split val", sp.val.length, 2);
eq("split oos", sp.oos.length, 2);
eq("split chronological head", sp.train[0].i, 0);
eq("split chronological oos first", sp.oos[0].i, 8);

const fake = [];
for (let s = 8; s <= 13; s++)
  for (let k = 0; k < 12; k++) fake.push({ score: s, win: s >= 11 ? 1 : 0, pnl: s >= 11 ? 1 : -1 });
const sweep = C.sweepThreshold(fake, NET, [8, 9, 10, 11, 12, 13], 12);
ok("sweep returns threshold + metrics", sweep && sweep.threshold && sweep.metrics, JSON.stringify(sweep));
eq("sweep best = 11 (only profitable tier)", sweep.threshold, 11);

const mc = C.monteCarlo(tr, NET, 1000, 400, 42);
ok("MC fields numeric", [mc.pctProfitable, mc.finalP10, mc.finalP50, mc.finalP90, mc.ddP50, mc.ddP90]
  .every(v => typeof v === "number"), JSON.stringify(mc));
const mc2 = C.monteCarlo(tr, NET, 1000, 400, 42);
eq("MC seeded deterministic", mc.finalP50, mc2.finalP50);
eq("MC all-win = 100% profitable", C.monteCarlo(Array.from({ length: 10 }, () => ({ win: true, pnl: 7.5 })), NET, 1000, 200, 7).pctProfitable, 1);

/* ---------- backtestRun over the fixture ----------
   backtest needs ≥1 bar AFTER entry for the exit (candle-close proxy), so the
   pattern bar gets two trailing bars here (live/e2e keep the pattern last). */
const trail = Array.from({ length: 2 }, (_, i) => {
  const b = bars[bars.length - 1];
  return { epoch: b.epoch + 60 * (i + 1), open: b.close, high: b.close + 0.2, low: b.close - 0.1, close: b.close + 0.2 };
});
const btBars = bars.concat(trail);
const trades = C.backtestRun({
  c1m: btBars, net: NET, expiryMin: 1, stake: 7.5, symbol: "R_TEST",
  cfg: { threshold: 11, evMin: 0.02, wrEstimate: 0.55, backtestCooldownBars: 1 }
});
ok("backtestRun finds the fixture setup", trades.length >= 1, trades.length);
if (trades.length) {
  const t = trades[trades.length - 1];
  ok("trade shape", t.score >= 11 && typeof t.win === "boolean" && t.pnl !== undefined, JSON.stringify(t));
  ok("trade pnl = ±stake×net", t.win ? Math.abs(t.pnl - 7.5 * NET) < 0.02 : Math.abs(t.pnl + 7.5) < 0.02, JSON.stringify(t));
}
const btFlat = C.backtestRun({ c1m: flat, net: NET, expiryMin: 1, stake: 7.5, cfg: { threshold: 11 } });
eq("backtest on flat = 0 trades (NO TRADE default)", btFlat.length, 0);

console.log(fails === 0 ? `\nICT ENGINE TEST PASSED ✓ (${passes} checks)` : `\n${fails} FAILURES ✗ (${passes} passed)`);
process.exit(fails === 0 ? 0 : 1);
