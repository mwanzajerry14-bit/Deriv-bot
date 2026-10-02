/**
 * Browser-simulation smoke test for Trend_Robot.html.
 * Loads BOTH inline scripts into a vm sandbox with DOM stubs — catches the
 * class of bugs Node-only core tests miss (e.g. window.CORE_R never exported).
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

function mkEl() {
  return {
    style: {}, value: "", innerHTML: "", textContent: "", className: "",
    disabled: false, scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {} },
    _handlers: {},
    addEventListener(type, fn) { this._handlers[type] = fn; }
  };
}

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
  fetch: () => Promise.reject(new Error("no-network-in-test")),
  WebSocket: function () { throw new Error("no-websocket-in-test"); }
};
sandbox.window = sandbox; // window.X assignments land on the sandbox global
vm.createContext(sandbox);

let loadError = null;
try {
  vm.runInContext(coreSrc, sandbox, { filename: "rcore.js" });
  vm.runInContext(appSrc, sandbox, { filename: "rapp.js" });
} catch (e) {
  loadError = e;
}

check("both scripts load without throwing", loadError === null, loadError && loadError.stack);
check("window.CORE_R exported", sandbox.window.CORE_R && typeof sandbox.window.CORE_R === "object",
  String(sandbox.window.CORE_R));

const need = ["CONFIG", "pickSignal", "entryThreshold", "moneyInit", "moneyOnWin", "moneyOnLose", "moneyShrink",
  "isBroke", "tpHit", "slHit", "sessionPl", "analyzeSymbol", "rankRows",
  "normalizeActiveSymbols", "round2", "botReadyState"];
if (sandbox.window.CORE_R) {
  const missing = need.filter(k => typeof sandbox.window.CORE_R[k] !== "function" && k !== "CONFIG");
  check("CORE_R has every method the app calls", missing.length === 0, JSON.stringify(missing));
  check("CORE_R.CONFIG present", !!sandbox.window.CORE_R.CONFIG && Array.isArray(sandbox.window.CORE_R.CONFIG.endpoints));
  check("endpoint[0] = current public WSS",
    String(sandbox.window.CORE_R.CONFIG && sandbox.window.CORE_R.CONFIG.endpoints[0]).includes("api.derivws.com"),
    String(sandbox.window.CORE_R.CONFIG && sandbox.window.CORE_R.CONFIG.endpoints[0]));
} else {
  check("CORE_R has every method the app calls", false, "CORE_R missing");
  check("CORE_R.CONFIG present", false, "CORE_R missing");
  check("endpoint[0] = current public WSS", false, "CORE_R missing");
}

// wire-level: press Connect & scan. With no network, it must fail with the
// NETWORK error ("all endpoints failed"), never a JS-reference error — that
// distinction is exactly the bug this test guards against.
const click = els.btnScan && els.btnScan._handlers && els.btnScan._handlers.click;
check("Connect & scan handler registered", typeof click === "function");
if (typeof click === "function") {
  click(); // async handler; rejection path sets banner synchronously via await catch? -> microtask
}

Promise.resolve().then(() => new Promise(r => setTimeout(r, 50))).then(() => {
  const banner = els.banner ? els.banner.innerHTML : "";
  const status = els.status ? els.status.textContent : "";
  const failedClean = /all endpoints failed|no-websocket-in-test/.test(banner + status);
  const refErr = /reading 'CONFIG'|CORE_R/.test(banner + status);
  check("scan attempt fails at NETWORK layer (no reference errors)", failedClean && !refErr,
    "banner=" + banner.slice(0, 200) + " | status=" + status.slice(0, 120));

  console.log(failures === 0 ? "\nROBOT SMOKE TEST PASSED ✓" : `\n${failures} FAILURES ✗`);
  process.exit(failures === 0 ? 0 : 1);
});
