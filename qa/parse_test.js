/**
 * Independent QA: parse a Deriv Bot strategy XML with real Blockly 12,
 * using stub blocks that mirror the official deriv-com/trading-bot-template
 * definitions (fields, inputs, statement names verified from that repo).
 */
const fs = require("fs");
const Blockly = require("blockly/core");
require("blockly/blocks");

const path = require("path");
const TARGET = process.argv[2] || path.join(__dirname, "..", "Deriv_V10_Streak_Scaling_Bot.xml");

// ---- capture warnings/errors ----
const warnings = [];
const errors = [];
const origWarn = console.warn;
const origErr = console.error;
console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
console.error = (...a) => { errors.push(a.map(String).join(" ")); };

// ---- helpers to define stub blocks ----
function def(type, spec) {
  Blockly.Blocks[type] = {
    init() {
      if (spec.stmts) for (const s of spec.stmts) this.appendStatementInput(s).setCheck(null);
      if (spec.fields) {
        let input = this.appendDummyInput();
        for (const f of spec.fields) {
          if (spec.varFields && spec.varFields.includes(f)) {
            input.appendField(new Blockly.FieldVariable("stake"), f);
          } else {
            input.appendField(new Blockly.FieldTextInput(""), f);
          }
        }
      }
      if (spec.values) for (const v of spec.values) this.appendValueInput(v).setCheck(null);
      if (spec.out) this.setOutput(true, null);
      if (spec.prev) this.setPreviousStatement(true, null);
      if (spec.next) this.setNextStatement(true, null);
      if (spec.top) { this.setPreviousStatement(false, null); this.setNextStatement(false, null); }
    },
    // accept and ignore mutations (e.g. tradeoptions barrier flags)
    domToMutation() {},
    mutationToDom() { return null; },
  };
}

// trade parameters family (verified against official Trade Definition blocks)
def("trade_definition", { stmts: ["TRADE_OPTIONS", "INITIALIZATION", "SUBMARKET"], top: true });
def("trade_definition_market", { fields: ["MARKET_LIST", "SUBMARKET_LIST", "SYMBOL_LIST"], prev: true, next: true });
def("trade_definition_tradetype", { fields: ["TRADETYPECAT_LIST", "TRADETYPE_LIST"], prev: true, next: true });
def("trade_definition_contracttype", { fields: ["TYPE_LIST"], prev: true, next: true });
def("trade_definition_candleinterval", { fields: ["CANDLEINTERVAL_LIST"], prev: true, next: true });
def("trade_definition_restartbuysell", { fields: ["TIME_MACHINE_ENABLED"], prev: true, next: true });
def("trade_definition_restartonerror", { fields: ["RESTARTONERROR"], prev: true, next: true });
def("trade_definition_tradeoptions", { fields: ["DURATIONTYPE_LIST", "CURRENCY_LIST"], values: ["DURATION", "AMOUNT"], prev: true, next: true });

// main workspace blocks
def("before_purchase", { stmts: ["BEFOREPURCHASE_STACK"], top: true });
def("after_purchase", { stmts: ["AFTERPURCHASE_STACK"], top: true });
def("during_purchase", { stmts: ["DURING_PURCHASE_STACK"], top: true });
def("tick_analysis", { stmts: ["TICKANALYSIS_STACK"], top: true });
def("purchase", { fields: ["PURCHASE_LIST"], prev: true });
def("trade_again", { prev: true });
def("contract_check_result", { fields: ["CHECK_RESULT"], out: true });
def("balance", { fields: ["BALANCE_TYPE"], out: true });
def("total_profit", { out: true });
def("read_ohlc", { fields: ["OHLCFIELD_LIST", "CANDLEINTERVAL_LIST"], values: ["CANDLEINDEX"], out: true });
def("notify", { fields: ["NOTIFICATION_TYPE", "NOTIFICATION_SOUND"], values: ["MESSAGE"], prev: true, next: true });
def("text_statement", { values: ["TEXT"], prev: true, next: true });
def("math_number_positive", { fields: ["NUM"], out: true });
def("tick", { out: true });
def("ticks", { out: true });
// Deriv's lists_getIndex: fields MODE + WHERE, inputs VALUE + AT (overrides stock Blockly block)
Blockly.Blocks.lists_getIndex = {
  init() {
    this.appendValueInput("VALUE").setCheck(null).appendField("in list");
    this.appendDummyInput().appendField(new Blockly.FieldTextInput("GET"), "MODE")
                          .appendField(new Blockly.FieldTextInput("FROM_END"), "WHERE");
    this.appendValueInput("AT");
    this.setOutput(true, null);
  },
  domToMutation() {},
};

// Deriv's text_join is a STATEMENT block (overrides Blockly's value-form one)
Blockly.Blocks.text_join = {
  init() {
    this.appendDummyInput().appendField(new Blockly.FieldVariable("msg"), "VARIABLE");
    this.appendStatementInput("STACK").setCheck(null);
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
  },
};

// Workaround: Blockly 12.5.1's compressed variables_set/math_change fail jsonInit
// (fails even on an empty workspace). Recreate them imperatively.
Blockly.Blocks.variables_set = {
  init() {
    this.appendValueInput("VALUE").appendField(new Blockly.FieldVariable("stake"), "VAR");
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
  },
};
Blockly.Blocks.math_change = {
  init() {
    this.appendValueInput("DELTA").appendField(new Blockly.FieldVariable("stake"), "VAR");
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
  },
};

// ---- parse ----
const xmlText = fs.readFileSync(TARGET, "utf-8");
let workspace, blockCount = null, parseError = null;
try {
  workspace = new Blockly.Workspace();
  const dom = Blockly.utils.xml.textToDom(xmlText);
  Blockly.Xml.domToWorkspace(dom, workspace);
  blockCount = workspace.getAllBlocks(false).length;
} catch (e) {
  parseError = e;
}

console.warn = origWarn;
console.error = origErr;

const name = TARGET.split("/").pop();
console.log(`\n=== Parse test: ${name} ===`);
if (parseError) {
  console.log("PARSE: THREW ->", parseError.message); console.log(parseError.stack.split("\n").slice(0,8).join("\n"));
} else {
  console.log("PARSE: OK, blocks in workspace =", blockCount);
}
console.log("warnings:", warnings.length);
warnings.slice(0, 15).forEach(w => console.log("  W:", w.slice(0, 160)));
console.log("errors:", errors.length);
errors.slice(0, 15).forEach(e => console.log("  E:", e.slice(0, 160)));

// variable sanity from workspace
if (workspace) {
  const vars = workspace.getAllVariables().map(v => v.name);
  console.log("variables declared:", vars.join(", "));
}
