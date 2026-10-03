/**
 * End-to-end robot test (redesign edition): boots Trend_Robot.html against a
 * scripted mock Deriv backend and drives the FULL flow through real UI handlers.
 * Fixtures are ICT-qualified: R_10 ends with a sweep+BOS+displacement pattern
 * that scores 13/13 and must trade; R_50 is flat and must NEVER trade.
 * Scenario 1 (classic token): Scan -> direct authorize -> account switch ->
 *   SETUP (score 13/13) -> proposal (1m, real payout EV gate) -> buy -> settle
 *   -> flat stake stats (no martingale) -> trade-log persisted -> STOP.
 * Scenario 2 (pat_ token): skips direct mode, REST accounts -> OTP -> same flow.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "Trend_Robot.html"), "utf8");
const coreSrc = html.split('<script id="rcore">')[1].split("</script>")[0];
const appSrc = html.split('<script id="rapp">')[1].split("</script>")[0];

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log((cond ? "OK   " : "FAIL ") + label + (cond ? "" : " -> " + detail));
}

const TOKEN = "e2eTestToken1234567890";
const PAT = "pat_e2etest0123456789abcdef0123456789abcdef0123456789abcdef";
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
const NET = 0.886; // probe-measured payout net (0.66/0.35 − 1)

/* ---- ICT-qualified fixture (same story as qa/ict_engine_test.js) ---- */
const T0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3600 * 72;
function bar(i, o, h, l, c) { return { epoch: T0 + i * 60, open: o, high: h, low: l, close: c }; }
function candlesR10() {
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
  for (let i = 0; i < 60; i++) push(-p.hard, 0.1);
  const recStep = ((60 * p.hard) + p.recAbove) / 60;
  for (let i = 0; i < 60; i++) push(recStep, 0.1);
  for (let i = 0; i < 60; i++) push(-p.cool, 0.1);
  const F = 58 - p.nd;
  for (let i = 0; i < F; i++) push(0, 0.02);
  for (let i = 0; i < 2; i++) push(0.05, 0.05);
  for (let i = 0; i < p.nd; i++) push(-p.dip, 0.2);
  const Pz = px - 0.2;
  for (let i = 0; i < p.nb; i++) push(p.bounce, 0.15);
  for (let i = 0; i < p.nr; i++) push(-p.ret / p.nr, 0.5);
  const o = px, l = Pz - 0.05, c = o + p.body;
  out.push(bar(idx++, o, c + 0.12, l, c));
  return out;
}
function candlesFlat() {
  return Array.from({ length: 1397 }, (_, i) =>
    ({ epoch: T0 + i * 60, open: 500, high: 500.5, low: 499.5, close: 500 }));
}
const FIX = { R_10: candlesR10(), R_50: candlesFlat() };

/* page ticks_history candles (count caps at 1000 → app paginates via end=epoch) */
function pageCandles(sym, end) {
  const all = FIX[sym] || [];
  const maxEnd = end === "latest" || end == null ? Infinity : Number(end);
  const eligible = all.filter(c => c.epoch <= maxEnd);
  return eligible.slice(-1000);
}

/* ---- digit tick fixtures for the Digits strategy scenario ---- */
function uniformDigits(){ return Array.from({ length: 1000 }, (_, i) => i % 10); }
function evenRunDigits(){
  const a = uniformDigits();
  for (let i = 0; i < 20; i++) a[i * 10] = 4;                                   // hot 4 → ~12% of 1000
  for (let k = 0; k < 12; k++) a[988 + k] = [0, 2, 4, 6, 8, 0, 2, 4, 6, 8, 4, 4][k]; // last 12 even → parity ready Even
  return a;
}
const priceFor = (sym, d) => sym === "R_10" ? "100.00" + d : "100.000" + d;   // 3- vs 4-decimal pips

/* ---- mock Deriv WebSocket ---- */
function makeMockWS() {
  return class MockWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this._bal = 1000;
      setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen({}); }, 0);
    }
    send(str) {
      let m; try { m = JSON.parse(str); } catch (e) { return; }
      const rid = m.req_id;
      const reply = obj => setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }, 0);
      const withRid = obj => reply(rid != null ? Object.assign({}, obj, { req_id: rid }) : obj);
      if (m.ping != null) return reply({ msg_type: "ping" });
      if (m.active_symbols != null) return withRid({ active_symbols: [
        { symbol: "R_10", display_name: "Volatility 10 Index", market: "synthetic_index", pip_size: 3 },
        { symbol: "R_50", display_name: "Volatility 50 Index", market: "synthetic_index", pip_size: 4 }
      ]});
      if (m.ticks_history != null && m.style === "candles" && m.granularity === 60){
        MockWS.counts = MockWS.counts || {};
        MockWS.counts[m.ticks_history] = (MockWS.counts[m.ticks_history] || 0) + 1;
        // injected failure: R_50 history always times out → exercises deferred-log + backoff path
        if (m.ticks_history === "R_50")
          return withRid({ error: { code: "RateLimit", message: "timeout: simulated history failure" } });
        return withRid({ candles: pageCandles(m.ticks_history, m.end) });
      }
      if (m.ticks_history != null && m.style === "candles")
        return withRid({ candles: pageCandles(m.ticks_history, m.end).slice(0, 80) });
      if (m.ticks_history != null && m.style === "ticks"){
        MockWS.counts = MockWS.counts || {};
        MockWS.counts["ticks:" + m.ticks_history] = (MockWS.counts["ticks:" + m.ticks_history] || 0) + 1;
        const digits = m.ticks_history === "R_10" ? evenRunDigits() : uniformDigits();
        return withRid({ history: { prices: digits.map(d => priceFor(m.ticks_history, d)) } });
      }
      if (m.authorize != null) {
        if (m.authorize !== TOKEN)
          return withRid({ msg_type: "authorize", error: { code: "InvalidToken", message: "Your token has expired or is invalid." } });
        const list = [
          { loginid: "VRT777", currency: "USD", balance: this._bal, is_virtual: true },
          { loginid: "CR123", currency: "USD", balance: 150.5, is_virtual: false }
        ];
        let active;
        if (m.loginid === "VRT777") active = list[0];
        else active = list[1]; // default active = REAL, demo selection must switch
        return withRid({ msg_type: "authorize", authorize: Object.assign({ account_list: list }, active) });
      }
      if (m.balance != null) {
        if (m.subscribe) setTimeout(() => { if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "balance", balance: { balance: this._bal, currency: "USD" } }) }); }, 5);
        return withRid({ msg_type: "balance", balance: { balance: this._bal, currency: "USD" } });
      }
      if (m.proposal != null) {
        MockWS.lastProposal = m;
        const DIG = ["DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"];
        if (DIG.indexOf(m.contract_type) >= 0) {
          // digit contract: tick duration, barrier required for match/diff
          const needsBarrier = m.contract_type === "DIGITMATCH" || m.contract_type === "DIGITDIFF";
          const ok = m.underlying_symbol === "R_10" && m.duration_unit === "t" &&
                     Number(m.duration) >= 1 && Number(m.duration) <= 10 && m.currency === "USD" &&
                     Number(m.amount) > 0 &&
                     (!needsBarrier || /^[0-9]$/.test(String(m.barrier)));
          if (!ok) return withRid({ msg_type: "proposal", error: { code: "InputValidationFailed", message: "unexpected digit proposal: " + JSON.stringify(m) } });
          const dPrice = Number(m.amount);
          const dNet = (m.contract_type === "DIGITEVEN" || m.contract_type === "DIGITODD") ? 0.95
                     : (m.contract_type === "DIGITMATCH" ? 8.5 : 0.10);
          this._digNet = dNet;
          return withRid({ msg_type: "proposal", proposal: { id: "32d2ec97-f568-6f7f-38c8-b1fda4275f32", ask_price: dPrice, payout: r2(dPrice * (1 + dNet)) } });
        }
        // redesign contract: minute expiries, USD, price = stake, net payout 0.886
        const ok = m.underlying_symbol === "R_10" && m.duration_unit === "m" &&
                   [1, 2, 3, 5, 10].indexOf(Number(m.duration)) >= 0 && m.currency === "USD" &&
                   Number(m.amount) > 0;
        if (!ok) return withRid({ msg_type: "proposal", error: { code: "InputValidationFailed", message: "unexpected proposal fields: " + JSON.stringify(m) } });
        const price = Number(m.amount);
        const payout = r2(price * (1 + NET));
        return withRid({ msg_type: "proposal", proposal: { id: "32d2ec97-f568-6f7f-38c8-b1fda4275f32", ask_price: price, payout } });
      }
      if (m.buy != null) {
        const price = Number(m.price);
        const ok = typeof m.buy === "string" && m.buy.length >= 32 && price > 0 && Math.abs(price - 7.5) < 0.001;
        if (!ok) return withRid({ msg_type: "buy", error: { code: "InputValidationFailed", message: "bad buy: " + JSON.stringify(m) } });
        const netNow = this._digNet != null ? this._digNet : NET;
        this._bal = r2(this._bal - price);
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "balance", balance: { balance: this._bal, currency: "USD" } }) });
        }, 10);
        return withRid({ msg_type: "buy", buy: { contract_id: 987654, buy_price: price, payout: r2(price * (1 + netNow)) } });
      }
      if (m.proposal_open_contract != null) {
        const ridSave = rid;
        const netP = this._digNet != null ? this._digNet : NET;
        withRid({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 987654, is_sold: 0, status: "open" } });
        setTimeout(() => {
          const payout = r2(7.5 * (1 + netP));
          this._bal = r2(this._bal + payout);
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "balance", balance: { balance: this._bal, currency: "USD" } }) });
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 987654, is_sold: 1, status: "won", profit: r2(7.5 * netP) }, req_id: ridSave }) });
        }, 20);
        return;
      }
      return withRid({ msg_type: "unknown", echo_req: m });
    }
    close() { this.readyState = 3; }
  };
}

/* ---- mock REST fetch for the PAT/OTP scenario ---- */
function mockFetch(url, opts) {
  const u = String(url);
  const method = (opts && opts.method) || "GET";
  mockFetch.seen = (mockFetch.seen || []).concat([{ u, headers: (opts && opts.headers) || {} }]);
  const resp = (obj, status) => ({ ok: (status || 200) < 400, status: status || 200,
    text: async () => JSON.stringify(obj) });
  if (method === "GET" && /\/trading\/v1\/options\/accounts$/.test(u)) {
    const auth = String((opts.headers || {}).Authorization || "");
    if (!auth.startsWith("Bearer ")) return resp({ errors: [{ message: "Missing authorization header" }] }, 401);
    return resp({ data: { accounts: [
      { id: "VRT123", account_type: "demo", currency: "USD" },
      { id: "CR999", account_type: "real", currency: "USD" }
    ]}});
  }
  if (method === "POST" && /\/accounts\/VRT123\/otp$/.test(u))
    return resp({ data: { url: "wss://mock-otp-session.example/otp?abc123" } });
  return resp({ errors: [{ message: "unexpected REST call: " + u }] }, 404);
}

/* ---- DOM stubs + sandbox factory (browser-accurate id contract) ---- */
function mkEl() {
  return {
    style: {}, value: "", innerHTML: "", textContent: "", className: "",
    disabled: false, scrollTop: 0, scrollHeight: 0, _handlers: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { this._handlers[t] = f; }
  };
}
const MockWS = makeMockWS();
const htmlIds = new Set([...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(m => m[1]));
function buildSandbox() {
  MockWS.counts = {};   // per-scenario request counters
  MockWS.lastProposal = null;
  const els = {};
  const store = {};
  const sandbox = {
    console,
    document: {
      getElementById: id => {
        if (!htmlIds.has(id)) return null;
        return (els[id] = els[id] || mkEl());
      },
      hidden: false
    },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    URL, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: mockFetch,
    WebSocket: MockWS
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: "rcore.js" });
  vm.runInContext(appSrc, sandbox, { filename: "rapp.js" });
  els.inpToken = mkEl();
  els.inpApp = mkEl(); els.inpApp.value = "1089";
  els.selAcct = mkEl(); els.selAcct.value = "demo";
  return { els, store };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tradeFlow(els, tag) {
  const log = els.log.innerHTML;
  check(tag + ": ICT setup on R_10 (score 13/13)",
    /SETUP: Volatility 10 Index \(R_10\) CALL · score 13\/13/.test(log), log.slice(-700));
  check(tag + ": regime shown", /· trending ·/.test(log), log.slice(-700));
  check(tag + ": minute expiry in setup", /\(1m\)/.test(log), log.slice(-700));
  check(tag + ": proposal ok at stake 7.50", /Proposal ok — price 7\.5/.test(log), log.slice(-700));
  check(tag + ": OPEN #987654", /OPEN #987654/.test(log), log.slice(-700));
  check(tag + ": settlement WON with day P/L",
    /WON #987654 · \+\$6\.65 · day P\/L \+\$6\.65 · consec 0/.test(log),
    log.slice(-700));
  check(tag + ": only one contract opened", (log.match(/OPEN #987654/g) || []).length === 1, log.slice(-700));
  check(tag + ": no TP/SL disarm banner", !/Take-profit|Stop-loss/.test(els.banner.innerHTML), els.banner.innerHTML);
}

(async () => {
  /* ================= Scenario 1: classic token, direct authorize ================= */
  console.log("--- scenario 1: direct authorize (classic token)");
  const s1 = buildSandbox();
  s1.els.inpToken.value = TOKEN;
  await s1.els.btnScan._handlers.click();
  await sleep(400);
  check("s1: scan started", /Public scan running/.test(s1.els.log.innerHTML), s1.els.log.innerHTML.slice(-400));
  // history-failure injection (R_50): aggregated deferred log + backoff, no per-sweep hammering
  check("s1: injected failure aggregated into one deferred log line",
    /History deferred: 1\/2 symbol\(s\) failed — backoff active \(R_50\)/.test(s1.els.log.innerHTML),
    s1.els.log.innerHTML.slice(-500));
  check("s1: no reconnect on partial failure", !/reconnecting/i.test(s1.els.log.innerHTML), "");
  const c1 = (MockWS.counts || {}).R_50 || 0;
  check("s1: failed symbol fetched exactly once (backoff, not every sweep)", c1 === 1, String(c1));
  await s1.els.btnScan._handlers.click();          // rescan must NOT re-request a backed-off symbol
  await sleep(300);
  const c2 = (MockWS.counts || {}).R_50 || 0;
  check("s1: backoff survives rescan (R_50 still 1 fetch)", c2 === 1, String(c2));
  check("s1: no new deferred line after rescan (backed-off symbol not retried)",
    (s1.els.log.innerHTML.match(/History deferred/g) || []).length === 0,
    String((s1.els.log.innerHTML.match(/History deferred/g) || []).length));
  await s1.els.btnArm._handlers.click();
  await sleep(600);
  check("s1: direct token mode used", /Direct token mode/.test(s1.els.log.innerHTML), s1.els.log.innerHTML.slice(-400));
  check("s1: switched to VRT777", /Authorized: VRT777 · USD · demo/.test(s1.els.log.innerHTML), "");
  check("s1: balance read $1000", /Balance: \$1000\.00/.test(s1.els.log.innerHTML), s1.els.log.innerHTML.slice(-400));
  check("s1: armed with flat-risk copy",
    /ARMED — flat 0\.75%\/trade, will buy the first setup scoring ≥11/.test(s1.els.log.innerHTML),
    s1.els.log.innerHTML.slice(-400));
  check("s1: armed", s1.els.modePill.textContent !== "DISARMED" && !/Could not arm/.test(s1.els.banner.innerHTML),
    s1.els.modePill.textContent);
  await sleep(700);
  await tradeFlow(s1.els, "s1");
  check("s1: stats 1 win", s1.els.stTW.textContent === "1 (1/0)", s1.els.stTW.textContent);
  check("s1: next stake = flat 0.75% of new balance ($7.55, not doubled)",
    s1.els.stStake.textContent === "$7.55", s1.els.stStake.textContent);
  check("s1: day P/L +$6.65", s1.els.stPl.textContent === "+$6.65", s1.els.stPl.textContent);
  check("s1: still ARMED after win (no bogus TP disarm)", s1.els.modePill.textContent === "ARMED",
    s1.els.modePill.textContent);
  check("s1: trade log persisted", /"symbol":"R_10"/.test(s1.store.dr_robot_log || "") &&
    /"won":true/.test(s1.store.dr_robot_log || ""), (s1.store.dr_robot_log || "").slice(0, 200));
  s1.els.btnStop._handlers.click();
  check("s1: STOP works", s1.els.modePill.textContent === "STOPPED", s1.els.modePill.textContent);

  /* ================= Scenario 2: pat_ token -> REST OTP ================= */
  console.log("--- scenario 2: pat_ token -> REST OTP");
  const s2 = buildSandbox();
  s2.els.inpToken.value = PAT;
  await s2.els.btnScan._handlers.click();
  await sleep(400);
  await s2.els.btnArm._handlers.click();
  await sleep(700);
  const l2 = s2.els.log.innerHTML;
  check("s2: PAT detected (no doomed direct attempt)", /PAT detected — direct WS mode doesn't accept PATs/.test(l2),
    l2.slice(-500));
  check("s2: no direct-mode failure noise", !/Direct authorize failed/.test(l2), l2.slice(-500));
  check("s2: REST OTP session opened", /OTP ok — opening authenticated session \(demo, account VRT123\)/.test(l2),
    l2.slice(-500));
  check("s2: balance read", /Balance: \$1000\.00/.test(l2), l2.slice(-500));
  const acctReq = (mockFetch.seen || []).find(r => /\/trading\/v1\/options\/accounts$/.test(r.u));
  check("s2: REST accounts call Bearer PAT + Deriv-App-ID",
    acctReq && /^Bearer pat_/.test(acctReq.headers.Authorization || "") &&
    (acctReq.headers["Deriv-App-ID"] || "") === "1089",
    JSON.stringify(acctReq && { auth: String(acctReq.headers.Authorization || "").slice(0, 12),
                                 app: acctReq.headers["Deriv-App-ID"] }));
  check("s2: armed", s2.els.modePill.textContent !== "DISARMED" && !/Could not arm/.test(s2.els.banner.innerHTML),
    s2.els.modePill.textContent + " | " + s2.els.banner.innerHTML);
  await sleep(700);
  await tradeFlow(s2.els, "s2");
  s2.els.btnStop._handlers.click();   // stop scenario 2 — an armed zombie would re-propose during s3
  check("s2: STOP works", s2.els.modePill.textContent === "STOPPED", s2.els.modePill.textContent);

  // ---------- scenario 3: Digits strategy (Even/Odd + Matches/Differs) ----------
  console.log("\n--- scenario 3: digits mode (parity + match signal)");
  const s3 = buildSandbox();
  s3.els.selStrategy = mkEl();
  s3.els.selStrategy.value = "digits";
  s3.els.inpToken.value = TOKEN;
  await s3.els.btnScan._handlers.click();
  await sleep(500);
  check("s3: digits mode fetches ticks only (no candle requests)",
    ((MockWS.counts || {})["ticks:R_10"] || 0) === 1 &&
    ((MockWS.counts || {})["ticks:R_50"] || 0) === 1 &&
    !((MockWS.counts || {}).R_10), JSON.stringify(MockWS.counts));
  await s3.els.btnArm._handlers.click();
  await sleep(700);
  const l3 = s3.els.log.innerHTML;
  check("s3: ARMED digits copy (parity ≥6/10 + match/diff shares)",
    /ARMED — flat 0\.75%\/trade, digit signals \(parity ≥6\/10 \+ match\/diff shares\) gated by the real-payout EV\./.test(l3),
    l3.slice(-450));
  check("s3: match setup on R_10 (hot digit 4, 5t)",
    /SETUP: Volatility 10 Index \(R_10\) match 4 \([0-9.]+%\) · EV≈[0-9.]+ → stake \$7\.50 \(5t\)/.test(l3),
    l3.slice(-700));
  check("s3: R_50 (uniform digits) never set up", !/SETUP:.*R_50/.test(l3), l3.slice(-700));
  const prop3 = MockWS.lastProposal;
  check("s3: proposal = DIGITMATCH, barrier 4, 5 ticks, USD",
    prop3 && prop3.contract_type === "DIGITMATCH" && String(prop3.barrier) === "4" &&
    prop3.duration_unit === "t" && Number(prop3.duration) === 5 && prop3.currency === "USD",
    JSON.stringify(prop3));
  check("s3: OPEN digit contract label", /OPEN #987654 · Matches 4 R_10/.test(l3), l3.slice(-500));
  check("s3: settlement pays the match payout (+$63.75 on 8.5 net)",
    /WON #987654 · \+\$63\.75 · day P\/L \+\$63\.75 · consec 0/.test(l3), l3.slice(-500));
  check("s3: exactly one contract opened", (l3.match(/OPEN #987654/g) || []).length === 1, "");
  check("s3: digit win respects the +5% daily profit lock",
    /Daily profit lock/.test(s3.els.banner.innerHTML), s3.els.banner.innerHTML);
  check("s3: session stopped (SCANNING + RESUME offered)",
    s3.els.modePill.textContent === "SCANNING" && s3.els.btnResume.style.display === "",
    s3.els.modePill.textContent + " resume=" + s3.els.btnResume.style.display);
  check("s3: stats 1 win recorded", s3.els.stTW.textContent === "1 (1/0)", s3.els.stTW.textContent);

  console.log(failures === 0 ? "\nROBOT E2E TEST PASSED ✓" : `\n${failures} FAILURES ✗`);
  process.exit(failures === 0 ? 0 : 1);
})();
