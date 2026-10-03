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

/* ---------- digit signals: Even/Odd parity + Matches/Differs ---------- */
const mkTicks = ds => ds.map(d => "100.00" + d);   // pip 0.001 → toFixed(3), last char = digit
// parity: XML bot rule (anchor 10 back + >=6/10 agreement)
const allEven = Array.from({ length: 120 }, (_, i) => (i % 5) * 2);
const p1 = C.parityState(mkTicks(allEven), 0.001);
ok("digit parity: all-even → ready Even, agree 10/10, anchor ok",
  p1.ready && p1.side === "Even" && p1.agree === 10 && p1.anchorOK === true, JSON.stringify(p1));
const anchorBad = Array.from({ length: 120 }, (_, i) => (i % 5) * 2);
anchorBad[109] = 1;   // digit 10 ticks back is odd while newest is even
const p2 = C.parityState(mkTicks(anchorBad), 0.001);
ok("digit parity: anchor mismatch → not ready (side still Even)",
  p2.ready === false && p2.anchorOK === false && p2.side === "Even", JSON.stringify(p2));
const weakAgree = Array.from({ length: 120 }, (_, i) => (i % 5) * 2);
[113, 114, 115, 116, 117, 118].forEach(i => { weakAgree[i] = 1; });  // last10: e e e o o o o o o e → agree 4
const p3 = C.parityState(mkTicks(weakAgree), 0.001);
ok("digit parity: agree 4/10 → not ready (anchor ok)",
  p3.ready === false && p3.anchorOK === true && p3.agree === 4, JSON.stringify(p3));
const p4 = C.parityState(mkTicks([2, 4, 6]), 0.001);
ok("digit parity: <11 ticks → need 11+ ticks", p4.ready === false && /need/.test(p4.note), JSON.stringify(p4));
const p5 = C.parityState(Array.from({ length: 20 }, () => "100.4"), 0.1);
ok("pip-aware digit: '100.4' @ pip 0.1 → 4 → Even ready",
  p5.ready && p5.side === "Even", JSON.stringify(p5));
ok("lastDigitOf/pipDecimals basics", C.lastDigitOf("500.7") === 7 && C.pipDecimals(0.001) === 3 && C.pipDecimals(0.5) === 0 && C.pipDecimals(0) === null, "");
// histogram
const uniform = Array.from({ length: 1000 }, (_, i) => i % 10);
const s1 = C.digitStatsOf(mkTicks(uniform), 0.001);
ok("digitStats: uniform n=1000, 100 each", s1.n === 1000 && s1.counts[0] === 100 && s1.hot.count === 100, JSON.stringify(s1.counts));
const skewed = uniform.slice();
for (let i = 0; i < 20; i++) skewed[i * 10] = 4;   // 20 zeros → fours: 0=80, 4=120
const s2 = C.digitStatsOf(mkTicks(skewed), 0.001);
ok("digitStats: hot 4 @ 12% / cold 0 @ 8%",
  s2.hot.digit === 4 && Math.abs(s2.hot.share - 0.12) < 1e-9 &&
  s2.cold.digit === 0 && Math.abs(s2.cold.share - 0.08) < 1e-9, JSON.stringify([s2.hot, s2.cold]));
// evaluateDigits: uniform → NO signals (no edge, no trade)
const e1 = C.evaluateDigits(mkTicks(uniform), 0.001, {});
ok("evaluateDigits: uniform ticks → zero signals (no edge)", e1.signals.length === 0 && e1.parity.ready === false, JSON.stringify(e1.signals));
// ready parity + hot 4 → DIGITEVEN + DIGITMATCH eligible; cold 8.2% diff pushed but EV-rejected at net 0.10
const dig = skewed.slice();
for (let k = 0; k < 12; k++) dig[988 + k] = [0, 2, 4, 6, 8, 0, 2, 4, 6, 8, 4, 4][k];
const e2 = C.evaluateDigits(mkTicks(dig), 0.001, {});
const eo = e2.signals.find(s => s.kind === "parity");
const mt = e2.signals.find(s => s.kind === "match");
ok("evaluateDigits: parity ready → DIGITEVEN eligible (net 0.95)",
  eo && eo.contract === "DIGITEVEN" && eo.side === "Even" && eo.eligible === true, JSON.stringify(eo));
ok("evaluateDigits: hot 4 → DIGITMATCH eligible, barrier digit 4",
  mt && mt.contract === "DIGITMATCH" && mt.digit === 4 && mt.eligible === true, JSON.stringify(mt));
const df = e2.signals.find(s => s.kind === "diff");
ok("evaluateDigits: cold diff at net 0.10 → pushed but NOT eligible (EV below floor)",
  df && df.digit === 0 && df.eligible === false, JSON.stringify(df));
ok("evaluateDigits: match EV outranks parity EV (why the robot picks M4)",
  mt.ev > eo.ev, JSON.stringify([mt.ev, eo.ev]));
// poor real-world payouts must fail the EV floor
const e3 = C.evaluateDigits(mkTicks(dig), 0.001, { netEO: 0.5, netMatch: 5 });
ok("evaluateDigits: poor payouts → every signal EV-rejected",
  e2.signals.length > 0 && e3.signals.every(s => s.eligible === false),
  JSON.stringify(e3.signals.map(s => [s.kind, s.ev])));
// sample floor: 20% hot digit in only 100 ticks → suppressed (n < digitMinN)
const small = skewed.slice(0, 100);
for (let i = 0; i < 20; i++) small[i * 5] = 4;   // 30% fours — but n=100
const e4 = C.evaluateDigits(mkTicks(small), 0.001, {});
ok("evaluateDigits: n<200 → no match/diff even at 30% share",
  !e4.signals.some(s => s.kind === "match" || s.kind === "diff"), JSON.stringify(e4.signals));
// custom minAgree respected
const e5 = C.evaluateDigits(mkTicks(allEven), 0.001, { minAgree: 8 });
ok("evaluateDigits: minAgree cfg respected", e5.parity.ready === true && e5.parity.agree === 10, JSON.stringify(e5.parity));

console.log(fails === 0 ? `\nICT ENGINE TEST PASSED ✓ (${passes} checks)` : `\n${fails} FAILURES ✗ (${passes} passed)`);
process.exit(fails === 0 ? 0 : 1);
