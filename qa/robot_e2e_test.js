/**
 * End-to-end robot test: boots Trend_Robot.html against a scripted mock Deriv
 * backend and drives the FULL flow through the real UI handlers.
 * Scenario 1 (classic token): Connect -> direct authorize -> account switch
 *   -> 4/4 signal -> proposal -> buy -> settle -> TP -> auto-disarm -> STOP.
 * Scenario 2 (pat_ token): skips direct mode, REST accounts -> OTP -> same
 *   trading flow on the pre-authenticated OTP socket.
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

/* ---- fixtures: R_10 = strong uptrend (4/4 CALL), R_50 = flat (never qualifies) ---- */
function candlesR10() {
  const now = Math.floor(Date.now() / 1000);
  const specs = [];
  let b = 100;
  for (let i = 0; i < 31; i++) { specs.push({ o: b, h: b + 2.3, l: b - 0.3, c: b + 2 }); b += 2; }
  specs[30] = { o: b, h: b + 1.8, l: b - 0.2, c: b + 1.5 };
  return specs.map((s, i) => ({ epoch: now - (30 - i) * 60 - 30, open: s.o, high: s.h, low: s.l, close: s.c }));
}
function pricesR10() {
  const c = candlesR10();
  const live = c[30].close;
  return Array.from({ length: 100 }, (_, i) => live - (99 - i) * 0.15);
}
function candlesFlat() {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: 31 }, (_, i) => ({ epoch: now - (30 - i) * 60 - 30, open: 500, high: 500.5, low: 499.5, close: 500 }));
}
function pricesFlat() {
  return Array.from({ length: 100 }, (_, i) => 500 + (i % 2 ? 0.01 : -0.01));
}

/* ---- mock Deriv WebSocket (new-platform schema) ---- */
function makeMockWS() {
  return class MockWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this._bal = 2.34;
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
      if (m.ticks_history != null && m.style === "candles")
        return withRid({ candles: m.ticks_history === "R_50" ? candlesFlat() : candlesR10() });
      if (m.ticks_history != null && m.style === "ticks")
        return withRid({ history: { prices: m.ticks_history === "R_50" ? pricesFlat() : pricesR10() } });
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
        const ok = m.underlying_symbol === "R_10" && m.duration_unit === "t" && m.duration === 5 && m.currency === "USD";
        if (!ok) return withRid({ msg_type: "proposal", error: { code: "InputValidationFailed", message: "unexpected proposal fields: " + JSON.stringify(m) } });
        return withRid({ msg_type: "proposal", proposal: { id: "32d2ec97-f568-6f7f-38c8-b1fda4275f32", ask_price: 0.35, payout: 0.61 } });
      }
      if (m.buy != null) {
        const ok = typeof m.buy === "string" && m.buy.length >= 32 && String(m.price) === "0.35";
        if (!ok) return withRid({ msg_type: "buy", error: { code: "InputValidationFailed", message: "bad buy: " + JSON.stringify(m) } });
        this._bal = r2(this._bal - 0.35);
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "balance", balance: { balance: this._bal, currency: "USD" } }) });
        }, 10);
        return withRid({ msg_type: "buy", buy: { contract_id: 987654, buy_price: 0.35, payout: 0.61 } });
      }
      if (m.proposal_open_contract != null) {
        const ridSave = rid;
        withRid({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 987654, is_sold: 0, status: "open" } });
        setTimeout(() => {
          this._bal = r2(this._bal + 0.62);
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "balance", balance: { balance: this._bal, currency: "USD" } }) });
          if (this.onmessage) this.onmessage({ data: JSON.stringify({ msg_type: "proposal_open_contract", proposal_open_contract: { contract_id: 987654, is_sold: 1, status: "won", profit: 0.62 }, req_id: ridSave }) });
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

/* ---- DOM stubs + sandbox factory ---- */
function mkEl() {
  return {
    style: {}, value: "", innerHTML: "", textContent: "", className: "",
    disabled: false, scrollTop: 0, scrollHeight: 0, _handlers: {},
    classList: { add() {}, remove() {} },
    addEventListener(t, f) { this._handlers[t] = f; }
  };
}
const MockWS = makeMockWS();
function buildSandbox() {
  const els = {};
  const store = {};
  const sandbox = {
    console,
    document: { getElementById: id => (els[id] = els[id] || mkEl()), hidden: false },
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
  els.inpDur = mkEl(); els.inpDur.value = "5";
  els.inpCd = mkEl(); els.inpCd.value = "20";
  els.inpSweep = mkEl(); els.inpSweep.value = "2500";
  els.inpMinScore = mkEl(); els.inpMinScore.value = "90";
  els.inpToken = mkEl();
  els.inpApp = mkEl(); els.inpApp.value = "1089";
  els.selAcct = mkEl(); els.selAcct.value = "demo";
  return { els, store };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tradeFlow(els, tag) {
  const log = els.log.innerHTML;
  check(tag + ": signal on R_10", /SIGNAL: Volatility 10 Index \(R_10\) CALL 4\/4/.test(log), log.slice(-600));
  check(tag + ": proposal ok", /Proposal ok — price 0\.35/.test(log), log.slice(-600));
  check(tag + ": OPEN #987654", /OPEN #987654/.test(log), log.slice(-600));
  check(tag + ": settlement WON", /WON #987654/.test(log), log.slice(-600));
  check(tag + ": TP disarm banner", /Take-profit/.test(els.banner.innerHTML), els.banner.innerHTML);
}

(async () => {
  /* ================= Scenario 1: classic token, direct authorize ================= */
  console.log("--- scenario 1: direct authorize (classic token)");
  const s1 = buildSandbox();
  s1.els.inpToken.value = TOKEN;
  await s1.els.btnScan._handlers.click();
  await sleep(250);
  check("s1: scanning 2 markets", /Watching 2 Volatility/.test(s1.els.log.innerHTML), "");
  await s1.els.btnArm._handlers.click();
  await sleep(400);
  check("s1: direct token mode used", /Direct token mode/.test(s1.els.log.innerHTML), s1.els.log.innerHTML.slice(-400));
  check("s1: switched to VRT777", /Authorized: VRT777 · USD · demo/.test(s1.els.log.innerHTML), "");
  check("s1: armed", s1.els.modePill.textContent !== "DISARMED" && !/Could not arm/.test(s1.els.banner.innerHTML),
    s1.els.modePill.textContent);
  await sleep(500);
  await tradeFlow(s1.els, "s1");
  check("s1: stats 1 win", s1.els.stTW.textContent === "1 (1/0)", s1.els.stTW.textContent);
  // STOP cleans up timers/sockets for this scenario
  s1.els.btnStop._handlers.click();
  check("s1: STOP works", s1.els.modePill.textContent === "STOPPED", s1.els.modePill.textContent);

  /* ================= Scenario 2: pat_ token -> REST OTP ================= */
  console.log("--- scenario 2: pat_ token -> REST OTP");
  const s2 = buildSandbox();
  s2.els.inpToken.value = PAT;
  await s2.els.btnScan._handlers.click();
  await sleep(250);
  await s2.els.btnArm._handlers.click();
  await sleep(500);
  const l2 = s2.els.log.innerHTML;
  check("s2: PAT detected (no doomed direct attempt)", /PAT detected — direct WS mode doesn't accept PATs/.test(l2),
    l2.slice(-500));
  check("s2: no direct-mode failure noise", !/Direct authorize failed/.test(l2), l2.slice(-500));
  check("s2: REST OTP session opened", /OTP ok — opening authenticated session \(demo, account VRT123\)/.test(l2),
    l2.slice(-500));
  check("s2: balance read", /Balance: \$2\.34/.test(l2), l2.slice(-500));
  const acctReq = (mockFetch.seen || []).find(r => /\/trading\/v1\/options\/accounts$/.test(r.u));
  check("s2: REST accounts call sent Bearer PAT + Deriv-App-ID",
    acctReq && /^Bearer pat_/.test(acctReq.headers.Authorization || "") &&
    (acctReq.headers["Deriv-App-ID"] || "") === "1089",
    JSON.stringify(acctReq && { auth: String(acctReq.headers.Authorization || "").slice(0, 12),
                                 app: acctReq.headers["Deriv-App-ID"] }));
  check("s2: armed", s2.els.modePill.textContent !== "DISARMED" && !/Could not arm/.test(s2.els.banner.innerHTML),
    s2.els.modePill.textContent + " | " + s2.els.banner.innerHTML);
  await sleep(500);
  await tradeFlow(s2.els, "s2");

  console.log(failures === 0 ? "\nROBOT E2E TEST PASSED ✓" : `\n${failures} FAILURES ✗`);
  process.exit(failures === 0 ? 0 : 1);
})();
