/** Unit tests for Best_Market_Analyzer.html core logic (extracted, no DOM). */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "Best_Market_Analyzer.html"), "utf8");
const coreSrc = html.split('<script id="core">')[1].split("</script>")[0];
const tmp = path.join(__dirname, "_core_extract.js");
fs.writeFileSync(tmp, coreSrc);
const core = require(tmp);

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? "OK   " : "FAIL ") + label + (cond ? "" : " -> " + detail));
}

const NOW = 1790000040; // aligned so last epoch can be "now - 30" (live)

/** build candle list: specs = [{o,h,l,c}] oldest→newest; live = last (epoch NOW-30) */
function buildCandles(specs) {
  const n = specs.length;
  return specs.map((s, i) => ({
    epoch: NOW - (n - 1 - i) * 60 - 30,
    open: s.o, high: s.h, low: s.l, close: s.c
  }));
}
function risingPrices(n, start, step) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// ---------- market builders ----------
function strongUp() {
  const specs = [];
  let b = 100;
  for (let i = 0; i < 31; i++) {          // 30 closed + live
    specs.push({ o: b, h: b + 2.3, l: b - 0.3, c: b + 2 });
    b += 2;
  }
  // live candle: green, on top
  specs[specs.length - 1] = { o: b, h: b + 1.8, l: b - 0.2, c: b + 1.5 };
  const candles = buildCandles(specs);
  const liveClose = candles[candles.length - 1].close;
  // 100 monotonically rising ticks ending exactly at the live close
  const prices = Array.from({ length: 100 }, (_, i) => liveClose - (99 - i) * 0.15);
  return { candles, prices };
}
function crash() {
  const specs = [];
  let b = 200;
  for (let i = 0; i < 31; i++) {
    specs.push({ o: b, h: b + 0.3, l: b - 2.3, c: b - 2 });
    b -= 2;
  }
  specs[specs.length - 1] = { o: b, h: b + 0.2, l: b - 1.8, c: b - 1.5 };
  const candles = buildCandles(specs);
  const liveClose = candles[candles.length - 1].close;
  const prices = Array.from({ length: 100 }, (_, i) => liveClose + (99 - i) * 0.15);
  return { candles, prices };
}
function choppy() {
  const specs = [];
  let base = 50;
  for (let i = 0; i < 31; i++) {
    const up = i % 2 === 0;
    const o = base, c = base + (up ? 0.2 : -0.2);
    specs.push({ o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c });
    base += (i % 3 === 0 ? 0.4 : -0.4); // sideways drift
  }
  const candles = buildCandles(specs);
  const prices = [];
  for (let i = 0; i < 100; i++) prices.push(50 + (i % 2 ? 0.5 : -0.5)); // zigzag
  return { candles, prices };
}
function flat() {
  const candles = buildCandles(Array.from({ length: 31 }, () => ({ o: 10, h: 10, l: 10, c: 10 })));
  return { candles, prices: Array(100).fill(10) };
}

// ---------- 1. strong-up metrics ----------
{
  const { candles, prices } = strongUp();
  const closed = candles.slice(0, -1).slice(-30);
  const m = core.computeMetrics(closed, prices);
  check("strong-up: trend 100%", Math.abs(m.trend - 100) < 1e-9, m.trend);
  check("strong-up: strength 100%", Math.abs(m.strong - 100) < 1e-9, m.strong);
  check("strong-up: efficiency ~100%", m.eff > 99, m.eff);
  check("strong-up: tickmom 100%", Math.abs(m.tickmom - 100) < 1e-9, m.tickmom);
  check("strong-up: range > 0", m.range > 0, m.range);
}

// ---------- 2. strong-up bot-ready: CALL 4/4 ----------
{
  const { candles, prices } = strongUp();
  const r = core.botReadyState(candles, prices, NOW, true);
  check("strong-up: side CALL", r.side === "CALL", JSON.stringify(r));
  check("strong-up: passed 4/4", r.passed === 4, JSON.stringify(r));
}

// ---------- 3. crash: PUT 4/4 ----------
{
  const { candles, prices } = crash();
  const r = core.botReadyState(candles, prices, NOW, true);
  check("crash: side PUT", r.side === "PUT", JSON.stringify(r));
  check("crash: passed 4/4", r.passed === 4, JSON.stringify(r));
}

// ---------- 4. choppy: low scores, not bot-ready ----------
{
  const { candles, prices } = choppy();
  const closed = candles.slice(0, -1).slice(-30);
  const m = core.computeMetrics(closed, prices);
  check("choppy: trend <= 50", m.trend <= 50 + 1e-9, m.trend);
  check("choppy: strength ~0", m.strong < 5, m.strong);
  const r = core.botReadyState(candles, prices, NOW, true);
  check("choppy: not 4/4", r.passed < 4, JSON.stringify(r));
}

// ---------- 5. flat: no NaN, guards hold ----------
{
  const { candles, prices } = flat();
  const m = core.computeMetrics(candles.slice(0, -1), prices);
  const all = Object.values(m).filter(v => typeof v === "number");
  check("flat: all metrics finite", all.every(v => isFinite(v)), JSON.stringify(m));
  check("flat: trend default 50 (no valid pairs)", m.trend === 50, m.trend);
  check("flat: tickmom 50 (no direction)", m.tickmom === 50, m.tickmom);
  const r = core.botReadyState(candles, prices, NOW, true);
  check("flat: side null (flat close)", r.side === null, JSON.stringify(r));
}

// ---------- 6. percentile ties ----------
{
  const p = core.percentileRanks([5, 5, 10]);
  check("percentile tie: [25,25,100]", p[0] === 25 && p[1] === 25 && p[2] === 100, JSON.stringify(p));
  const one = core.percentileRanks([7]);
  check("percentile single = 100", one[0] === 100, JSON.stringify(one));
}

// ---------- 7. rankRows ordering + score bounds ----------
{
  const up = strongUp(), ch = choppy(), cr = crash();
  const rows = [
    Object.assign(core.analyzeSymbol({ symbol: "A", displayName: "A" }, ch.candles, ch.prices, NOW)),
    Object.assign(core.analyzeSymbol({ symbol: "B", displayName: "B" }, up.candles, up.prices, NOW)),
    Object.assign(core.analyzeSymbol({ symbol: "C", displayName: "C" }, cr.candles, cr.prices, NOW)),
  ];
  const ranked = core.rankRows(rows);
  check("rank: strong-up first", ranked[0].symbol === "B", JSON.stringify(ranked.map(r => [r.symbol, r.score])));
  check("rank: choppy last", ranked[ranked.length - 1].symbol === "A", JSON.stringify(ranked.map(r => [r.symbol, r.score])));
  check("rank: scores within 0..100", ranked.every(r => r.score >= 0 && r.score <= 100 && isFinite(r.score)),
    JSON.stringify(ranked.map(r => r.score)));
}

// ---------- 8. analyzeSymbol isLive handling ----------
{
  const up = strongUp();
  const row = core.analyzeSymbol({ symbol: "X", displayName: "X" }, up.candles, up.prices, NOW);
  check("analyze: isLive detected", row.isLive === true, JSON.stringify({ isLive: row.isLive }));
  check("analyze: 30 closed candles used", row.closedCount === 30, row.closedCount);
  const stale = up.candles.map(c => ({ ...c, epoch: c.epoch - 3600 }));
  const row2 = core.analyzeSymbol({ symbol: "X", displayName: "X" }, stale, up.prices, NOW + 7200);
  check("analyze: all-closed series handled", row2.isLive === false && row2.closedCount === 30, JSON.stringify({ isLive: row2.isLive, n: row2.closedCount }));
}

// ---------- 9. parity gate (Even/Odd bot mirror) ----------
{
  const mk = ds => ds.map(d => "123." + d);   // price STRINGS; last char = digit

  const allEven = mk([2, 4, 6, 8, 0, 2, 4, 6, 8, 0, 2]);
  const p1 = core.parityState(allEven);
  check("parity: all-even -> ready Even 10/10",
    p1.ready && p1.side === "Even" && p1.agree === 10 && p1.anchorOK, JSON.stringify(p1));

  const allOdd = mk([1, 3, 5, 7, 9, 1, 3, 5, 7, 9, 3]);
  const p2 = core.parityState(allOdd);
  check("parity: all-odd -> ready Odd 10/10",
    p2.ready && p2.side === "Odd" && p2.agree === 10 && p2.anchorOK, JSON.stringify(p2));

  // trailing zero preserved in string: digit 0 -> Even (same as bot's pip-formatted list)
  const tz = mk([1, 3, 5, 7, 9, 1, 3, 5, 7, 9]).concat(["6012.30"]);
  const p3 = core.parityState(tz);
  check("parity: trailing-zero '6012.30' -> Even", p3.side === "Even", JSON.stringify(p3));

  // anchor mismatch: newest even, 11-back odd -> not ready despite agree 10
  const anch = ["123.1"].concat(mk([2, 4, 6, 8, 0, 2, 4, 6, 8, 2]));
  const p4 = core.parityState(anch);
  check("parity: anchor mismatch -> not ready",
    !p4.ready && p4.anchorOK === false && p4.agree === 10 && p4.side === "Even", JSON.stringify(p4));

  // exactly 6/10 with good anchor -> ready (bot's GTE 6)
  const mix6 = ["123.0", "123.1", "123.1", "123.1", "123.1",
                "123.2", "123.4", "123.6", "123.8", "123.0", "123.2"];
  const p5 = core.parityState(mix6);
  check("parity: agree 6/10 + anchor -> ready",
    p5.ready && p5.agree === 6 && p5.anchorOK && p5.side === "Even", JSON.stringify(p5));

  // 5/10 -> not ready
  const mix5 = ["123.0", "123.1", "123.1", "123.1", "123.1", "123.1",
                "123.2", "123.4", "123.6", "123.0", "123.2"];
  const p6 = core.parityState(mix5);
  check("parity: agree 5/10 -> not ready",
    !p6.ready && p6.agree === 5 && p6.anchorOK, JSON.stringify(p6));

  // too short
  const p7 = core.parityState(["123.4", "123.5"]);
  check("parity: <11 ticks -> guarded", !p7.ready && p7.note.length > 0, JSON.stringify(p7));

  // numeric fallback still yields a digit via String(n)
  const p8 = core.parityState([100.2, 100.4, 100.6, 100.8, 100.2, 100.4,
                               100.6, 100.8, 100.2, 100.4, 100.6]);
  check("parity: numeric prices work too",
    p8.ready && p8.side === "Even" && p8.agree === 10, JSON.stringify(p8));
}

console.log(failures === 0 ? "\nALL ANALYZER CORE TESTS PASSED ✓" : `\n${failures} FAILURES ✗`);
process.exit(failures === 0 ? 0 : 1);
