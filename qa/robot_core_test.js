/** Unit tests for Trend_Robot.html core (extracted, no DOM/network). */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "Trend_Robot.html"), "utf8");
const coreSrc = html.split('<script id="rcore">')[1].split("</script>")[0];
const tmp = path.join(__dirname, "_rcore_extract.js");
fs.writeFileSync(tmp, coreSrc);
const C = require(tmp);

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? "OK   " : "FAIL ") + label + (cond ? "" : " -> " + detail));
}
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;

// ---------- money math: $2 account (the hard case) ----------
{
  const m = C.moneyInit(2);
  check("$2: base 0.35 (min-stake floor)", m.base === 0.35, m.base);
  check("$2: cap 0.70 (small-floor beats 8%)", m.cap === 0.70, m.cap);
  check("$2: tp 0.10", m.tp === 0.1, m.tp);
  check("$2: sl 0.70 (floor beats 10%)", m.sl === 0.7, m.sl);
  check("$2: first stake 0.35", m.stake === 0.35, m.stake);

  C.moneyOnLose(m);
  check("$2: after loss1 stake 0.70 (doubling works)", m.stake === 0.7, m.stake);
  C.moneyOnLose(m);
  check("$2: after loss2 capped at 0.70", m.stake === 0.7 && m.streak === 2, JSON.stringify(m));

  C.moneyOnWin(m, 1.30);
  check("$2: win resets to 0.35 from live balance", m.stake === 0.35 && m.streak === 0, JSON.stringify(m));
}

// ---------- money math: $1,000 account (unchanged classic behavior) ----------
{
  const m = C.moneyInit(1000);
  check("$1000: base 20, cap 80, tp 50, sl 100",
    m.base === 20 && m.cap === 80 && m.tp === 50 && m.sl === 100, JSON.stringify(m));
  C.moneyOnLose(m); C.moneyOnLose(m);
  check("$1000: 20 -> 40 -> 80", m.stake === 80, m.stake);
  C.moneyOnLose(m);
  check("$1000: stays capped at 80", m.stake === 80, m.stake);
}

// ---------- guards ----------
{
  check("isBroke(0.34) true", C.isBroke(0.34) === true);
  check("isBroke(0.35) false", C.isBroke(0.35) === false);

  const m = C.moneyInit(2);
  C.moneyShrink(m, 0.50); // stake 0.35 -> affordable but 0.35 <= 0.50: no change
  check("shrink: no change when stake <= balance", m.stake === 0.35, m.stake);
  m.stake = 0.70;
  C.moneyShrink(m, 0.50);
  check("shrink: 0.70 stake with $0.50 balance -> 0.50", m.stake === 0.5, m.stake);
  m.stake = 0.70;
  C.moneyShrink(m, 0.20);
  check("shrink: never below min stake (0.20 < 0.35 -> unchanged)", m.stake === 0.7, m.stake);

  const s = C.moneyInit(2);
  check("tpHit at P/L +0.15", C.tpHit(s, 2.15) === true, C.sessionPl(s, 2.15));
  check("tpHit false at P/L +0.05", C.tpHit(s, 2.05) === false);
  check("slHit at P/L −0.70", C.slHit(s, 1.30) === true, C.sessionPl(s, 1.30));
  check("slHit false at P/L −0.69", C.slHit(s, 1.31) === false);
  check("sessionPl rounds to cents", C.sessionPl(s, 2.007) === 0.01, C.sessionPl(s, 2.007));
}

// ---------- pickSignal ----------
{
  const mk = (sym, passed, side, score) => ({
    symbol: sym, displayName: sym, score,
    ready: { side: passed ? side : (side || null), passed, checks: [] }
  });
  check("no rows -> null", C.pickSignal([]) === null);
  check("no 4/4 -> null", C.pickSignal([mk("A", 3, "CALL", 90), mk("B", 2, "PUT", 80)]) === null);

  const rows = [mk("A", 3, "CALL", 99), mk("B", 4, "PUT", 55), mk("C", 4, "CALL", 77)];
  const sig = C.pickSignal(rows);
  check("picks best-scoring 4/4 (C, score 77)",
    sig && sig.symbol === "C" && sig.side === "CALL" && sig.score === 77, JSON.stringify(sig));

  const one = C.pickSignal([mk("X", 4, "PUT", 41)]);
  check("single qualifier passes side through",
    one && one.symbol === "X" && one.side === "PUT", JSON.stringify(one));

  const noSide = [{ symbol: "Z", displayName: "Z", score: 100,
                    ready: { side: null, passed: 4, checks: [] } }];
  check("4/4 without side ignored", C.pickSignal(noSide) === null, JSON.stringify(C.pickSignal(noSide)));
}

// ---------- scanner mirror (sanity, same fixtures style as analyzer tests) ----------
{
  const now = 1790000040;
  const specs = [];
  let b = 100;
  for (let i = 0; i < 31; i++){ specs.push({ o: b, h: b + 2.3, l: b - 0.3, c: b + 2 }); b += 2; }
  specs[30] = { o: b, h: b + 1.8, l: b - 0.2, c: b + 1.5 };
  const candles = specs.map((s, i) => ({ epoch: now - (30 - i) * 60 - 30, open: s.o, high: s.h, low: s.l, close: s.c }));
  const liveClose = candles[30].close;
  const prices = Array.from({ length: 100 }, (_, i) => liveClose - (99 - i) * 0.15);
  const row = C.analyzeSymbol({ symbol: "R_10", displayName: "V10" }, candles, prices, now);
  check("robot scan: strong-up row qualifies 4/4 CALL",
    row.ready.passed === 4 && row.ready.side === "CALL", JSON.stringify(row.ready));
  const ranked = C.rankRows([row]);
  check("robot rank: score finite 0..100",
    ranked[0].score >= 0 && ranked[0].score <= 100 && isFinite(ranked[0].score), ranked[0].score);
  const sig = C.pickSignal(ranked);
  check("robot end-to-end: qualifier -> signal",
    sig && sig.symbol === "R_10" && sig.side === "CALL", JSON.stringify(sig));
}

// ---------- endpoint order ----------
check("robot endpoint[0] = current public WSS",
  C.CONFIG.endpoints[0].indexOf("api.derivws.com/trading/v1/options/ws/public") >= 0,
  C.CONFIG.endpoints[0]);

console.log(failures === 0 ? "\nALL ROBOT CORE TESTS PASSED ✓" : `\n${failures} FAILURES ✗`);
process.exit(failures === 0 ? 0 : 1);
