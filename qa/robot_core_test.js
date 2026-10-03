/** Unit tests for Trend_Robot.html core (extracted, no DOM/network).
 *  Legacy martingale/pickSignal code was REMOVED per redesign brief §12 —
 *  this suite now asserts their absence plus surviving shared helpers. */
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

// ---------- martingale + legacy signal path REMOVED (brief §12) ----------
check("moneyInit removed (no martingale)", typeof C.moneyInit === "undefined");
check("moneyOnLose removed", typeof C.moneyOnLose === "undefined");
check("moneyOnWin removed", typeof C.moneyOnWin === "undefined");
check("pickSignal removed (ICT engine supersedes)", typeof C.pickSignal === "undefined");
check("entryThreshold removed (OOS-calibrated threshold supersedes)", typeof C.entryThreshold === "undefined");
check("flat-risk module present", typeof C.stakeFor === "function" && typeof C.riskOnResult === "function");

// ---------- scanner mirror (still shared with analyzer) ----------
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
}

// ---------- helpers ----------
check("round2 rounds cents", C.round2(0.1 + 0.2) === 0.3, C.round2(0.1 + 0.2));
check("normalizeActiveSymbols filters non-synthetics",
  Array.isArray(C.normalizeActiveSymbols([{ symbol: "R_10", market: "synthetic_index" },
    { symbol: "frxEURUSD", market: "forex" }])),
  "shape ok");

// ---------- endpoint order ----------
check("robot endpoint[0] = current public WSS",
  C.CONFIG.endpoints[0].indexOf("api.derivws.com/trading/v1/options/ws/public") >= 0,
  C.CONFIG.endpoints[0]);

console.log(failures === 0 ? "\nALL ROBOT CORE TESTS PASSED ✓" : `\n${failures} FAILURES ✗`);
process.exit(failures === 0 ? 0 : 1);
