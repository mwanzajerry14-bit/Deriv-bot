/**
 * End-to-end robot test: boots Trend_Robot.html against a scripted mock Deriv
 * WebSocket and drives the FULL flow through the real UI handlers:
 *   Connect & scan -> sweep -> Arm -> direct authorize -> account switch
 *   -> 4/4 signal -> proposal (underlying_symbol) -> buy (token+price)
 *   -> settlement -> balance refresh -> TP hit -> auto-disarm.
 * This is the regression net for the new-platform auth + trading schema.
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

/* ---- mock Deriv socket speaking the new-platform schema ---- */
function makeMockWS() {
  return class MockWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this._bal = 2.34;
      this.sawAuthorizeSwitch = null;
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
        if (m.loginid === "VRT777") { this.sawAuthorizeSwitch = m.loginid; active = list[0]; }
        else active = list[1]; // default active = REAL, so demo selection must switch
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
        const ridSave = rid;
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

/* ---- DOM stubs ---- */
function mkEl() {
  return {
    style: {}, value: "", innerHTML: "", textContent: "", className: "",
    disabled: false, scrollTop: 0, scrollHeight: 0, _handlers: {},
    classList: { add() {}, remove() {} },
    addEventListener(t, f) { this._handlers[t] = f; }
  };
}
const els = {};
const store = {};
const MockWS = makeMockWS();
const sandbox = {
  console,
  document: { getElementById: id => (els[id] = els[id] || mkEl()), hidden: false },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  URL, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => Promise.reject(new Error("no-network-in-test")),
  WebSocket: MockWS
};
sandbox.window = sandbox;
vm.createContext(sandbox);

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    vm.runInContext(coreSrc, sandbox, { filename: "rcore.js" });
    vm.runInContext(appSrc, sandbox, { filename: "rapp.js" });
  } catch (e) {
    check("scripts load", false, e.stack);
    process.exit(1);
  }
  check("scripts load", true);
  check("window.CORE_R exported", !!sandbox.window.CORE_R);

  // defaults from the real HTML inputs
  els.inpDur = els.inpDur || mkEl(); els.inpDur.value = "5";
  els.inpCd = els.inpCd || mkEl(); els.inpCd.value = "20";
  els.inpSweep = els.inpSweep || mkEl(); els.inpSweep.value = "5000";
  els.inpToken = els.inpToken || mkEl(); els.inpToken.value = TOKEN;
  els.inpApp = els.inpApp || mkEl(); els.inpApp.value = "1089";
  els.selAcct = els.selAcct || mkEl(); els.selAcct.value = "demo";
  els.inpMinScore = els.inpMinScore || mkEl(); els.inpMinScore.value = "90";

  // 1) Connect & scan
  await els.btnScan._handlers.click();
  await sleep(250);
  check("scan: watching 2 Volatility indices", /Watching 2 Volatility/.test(els.log.innerHTML), els.log.innerHTML.slice(-300));
  check("scan: mode SCANNING", els.modePill.textContent === "SCANNING", els.modePill.textContent);
  check("scan: R_10 qualifies 4/4 CALL", /CALL 4\/4/.test(els.tableArea.innerHTML), "");

  // 2) Arm -> direct authorize (active=CR123 must switch to VRT777 for demo)
  await els.btnArm._handlers.click();
  await sleep(400);
  const log = els.log.innerHTML;
  check("auth: direct token mode used", /Direct token mode/.test(log), log.slice(-500));
  check("auth: switched to demo account VRT777", /Authorized: VRT777 · USD · demo/.test(log), log.slice(-500));
  check("auth: no Invalid application error", !/Invalid application/.test(els.banner.innerHTML), els.banner.innerHTML);
  // full arm->trade->TP can complete within this window (mock is instant); the
  // deterministic proof of arming is: not DISARMED and no arm-failure banner
  check("auth: armed successfully", els.modePill.textContent !== "DISARMED" && !/Could not arm/.test(els.banner.innerHTML),
    els.modePill.textContent + " | " + els.banner.innerHTML);
  check("token saved to localStorage", store.dr_robot_token === TOKEN);

  // 3) trade: proposal->buy->settle->TP
  await sleep(500);
  const L = els.log.innerHTML;
  check("trade: signal on R_10", /SIGNAL: Volatility 10 Index \(R_10\) CALL 4\/4/.test(L), L.slice(-700));
  check("trade: proposal ok", /Proposal ok — price 0\.35/.test(L), L.slice(-700));
  check("trade: OPEN #987654", /OPEN #987654/.test(L), L.slice(-700));
  check("trade: settlement WON logged", /WON #987654/.test(L), L.slice(-700));
  check("stats: 1 trade 1 win", els.stTW.textContent === "1 (1/0)", els.stTW.textContent);

  // 4) TP (+$0.27 ≥ $0.12 on $2.34 start) closes the session
  check("tp: banner shows take-profit", /Take-profit/.test(els.banner.innerHTML), els.banner.innerHTML);
  check("tp: disarmed to SCANNING", els.modePill.textContent === "SCANNING", els.modePill.textContent);
  check("tp: balance reflects settlement ($2.61)", /2\.61/.test(els.stBal.textContent), els.stBal.textContent);

  console.log(failures === 0 ? "\nROBOT E2E TEST PASSED ✓" : `\n${failures} FAILURES ✗`);
  process.exit(failures === 0 ? 0 : 1);
})();
