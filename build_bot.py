#!/usr/bin/env python3
"""Generate a Deriv Bot (bot.deriv.com) strategy XML: V10 streak-scaling bot.

Strategy (per user choices):
  - Market:        Volatility 10 Index (R_10), Rise/Fall, both directions
  - Entry signal:  direction of the last closed 1-minute candle (close > open -> Call, else Put)
  - Cooldown:      10 ticks between trades
  - Duration:      5 ticks
  - Sizing:        stake = 2% of balance; x2 after each consecutive loss,
                   capped at 8% of balance; reset to 2% (recomputed from
                   current balance) on a win
  - Session limits: take-profit = +5% of start balance, stop-loss = -10%
All block types / fields verified against deriv-com/trading-bot-template.
"""
import random
import string
from xml.sax.saxutils import escape

random.seed(20260928)
_used = set()


def rid(n=20):
    alphabet = string.ascii_letters + string.digits
    while True:
        s = "".join(random.choice(alphabet) for _ in range(n))
        if s not in _used:
            _used.add(s)
            return s


# ---------- XML helpers ----------
def F(name, val, vid=None):
    extra = f' id="{vid}" variabletype=""' if vid is not None else ""
    return f'<field name="{name}"{extra}>{escape(str(val))}</field>'


def V(name, inner):
    return f'<value name="{name}">{inner}</value>'


def S(name, inner):
    return f'<statement name="{name}">{inner}</statement>'


def NEXT(inner):
    return f"<next>{inner}</next>"


def B(t, inner="", attrs=""):
    return f'<block type="{t}" id="{rid()}"{attrs}>{inner}</block>'


def SH(t, inner=""):
    return f'<shadow type="{t}" id="{rid()}">{inner}</shadow>'


def chain(blocks):
    """Wire statement blocks: each block contains <next> with the following block,
    nested before its closing tag (correct Blockly XML shape)."""
    if not blocks:
        return ""
    out = blocks[-1]
    for b in reversed(blocks[:-1]):
        idx = b.rfind("</block>")
        out = b[:idx] + NEXT(out) + b[idx:]
    return out


# ---------- leaf builders ----------
def num(v):
    return B("math_number", F("NUM", v))


def pnum(v):
    return B("math_number_positive", F("NUM", v))


def get(name, vid):
    return B("variables_get", F("VAR", name, vid))


def setv(name, vid, value):
    return B("variables_set", F("VAR", name, vid) + V("VALUE", value))


def arith(op, a, b):
    return B("math_arithmetic", F("OP", op) + V("A", a) + V("B", b))


def compare(op, a, b):
    return B("logic_compare", F("OP", op) + V("A", a) + V("B", b))


def iff(cond, do, els=None):
    mut = '<mutation else="1"/>' if els is not None else ""
    body = mut + V("IF0", cond) + S("DO0", do)
    if els is not None:
        body += S("ELSE", els)
    return B("controls_if", body)


def balance():
    return B("balance", F("BALANCE_TYPE", "NUM"))


def total_profit():
    return B("total_profit")


def round2(expr):
    """round(expr * 100) / 100  ->  2 decimal places."""
    scaled = arith("MULTIPLY", expr, num(100))
    return arith("DIVIDE", B("math_round", F("OP", "ROUND") + V("NUM", scaled)), num(100))


def read_ohlc(field, idx=1):
    return B(
        "read_ohlc",
        F("OHLCFIELD_LIST", field)
        + F("CANDLEINTERVAL_LIST", "60")
        + V("CANDLEINDEX", SH("math_number", F("NUM", str(idx)))),
    )


def tick_price():
    """Current (latest) tick price."""
    return B("tick")


def tick_back(n):
    """Tick price n positions from the end of the last-1000-ticks list (1 = newest)."""
    return B(
        "lists_getIndex",
        '<mutation statement="false" at="true"/>'
        + F("MODE", "GET")
        + F("WHERE", "FROM_END")
        + V("VALUE", B("ticks"))
        + V("AT", num(n)),
    )


def and_all(conds):
    """Fold boolean conditions into left-associated ANDs."""
    expr = conds[0]
    for c in conds[1:]:
        expr = B("logic_operation", F("OP", "AND") + V("A", expr) + V("B", c))
    return expr


def notify(etype, sound, message_block):
    return B(
        "notify",
        F("NOTIFICATION_TYPE", etype)
        + F("NOTIFICATION_SOUND", sound)
        + V("MESSAGE", message_block),
    )


class X:
    """Wrapper marking a raw XML fragment (block) vs a literal string."""
    def __init__(self, s):
        self.s = s


def text_join(var_name, var_vid, parts):
    """Statement-form text_join: set var to join of text_statement parts."""
    stmts = []
    for p in parts:
        content = SH("text", F("TEXT", p)) if isinstance(p, str) else p.s
        stmts.append(B("text_statement", V("TEXT", content)))
    return B(
        "text_join",
        F("VARIABLE", var_name, var_vid) + S("STACK", chain(stmts)),
    )


def notify_var(etype, sound, var_name, var_vid):
    return notify(etype, sound, get(var_name, var_vid))


# ---------- variables ----------
VAR_NAMES = [
    "stake",
    "bal",
    "base_stake",
    "cap_stake",
    "streak",
    "take_profit",
    "stop_loss",
    "wait",
    "cooldown",
    "msg",
]
VID = {n: rid(20) for n in VAR_NAMES}

# ---------- trade definition ----------
market = B(
    "trade_definition_market",
    F("MARKET_LIST", "synthetic_index")
    + F("SUBMARKET_LIST", "random_index")
    + F("SYMBOL_LIST", "R_10")
    + NEXT(
        B(
            "trade_definition_tradetype",
            F("TRADETYPECAT_LIST", "callput")
            + F("TRADETYPE_LIST", "callput")
            + NEXT(
                B(
                    "trade_definition_contracttype",
                    F("TYPE_LIST", "both")
                    + NEXT(
                        B(
                            "trade_definition_candleinterval",
                            F("CANDLEINTERVAL_LIST", "60")
                            + NEXT(
                                B(
                                    "trade_definition_restartbuysell",
                                    F("TIME_MACHINE_ENABLED", "FALSE")
                                    + NEXT(
                                        B(
                                            "trade_definition_restartonerror",
                                            F("RESTARTONERROR", "TRUE"),
                                        )
                                    ),
                                )
                            ),
                        )
                    ),
                )
            ),
        )
    ),
    ' deletable="false" movable="false"',
)

# INITIALIZATION chain
init = chain(
    [
        setv("bal", VID["bal"], balance()),
        iff(
            compare("LTE", get("bal", VID["bal"]), num(0)),
            setv("bal", VID["bal"], num(100)),
        ),
        setv("base_stake", VID["base_stake"], round2(arith("MULTIPLY", get("bal", VID["bal"]), num(0.02)))),
        iff(
            compare("LT", get("base_stake", VID["base_stake"]), num(0.35)),
            setv("base_stake", VID["base_stake"], num(0.35)),
        ),
        setv("cap_stake", VID["cap_stake"], round2(arith("MULTIPLY", get("bal", VID["bal"]), num(0.08)))),
        iff(
            compare("LT", get("cap_stake", VID["cap_stake"]), num(0.35)),
            setv("cap_stake", VID["cap_stake"], num(0.35)),
        ),
        setv("stake", VID["stake"], get("base_stake", VID["base_stake"])),
        setv("streak", VID["streak"], num(0)),
        setv("wait", VID["wait"], num(0)),
        setv("cooldown", VID["cooldown"], num(10)),
        setv(
            "take_profit",
            VID["take_profit"],
            arith("MULTIPLY", get("bal", VID["bal"]), num(0.05)),
        ),
        setv(
            "stop_loss",
            VID["stop_loss"],
            arith("MULTIPLY", get("bal", VID["bal"]), num(0.10)),
        ),
        text_join(
            "msg",
            VID["msg"],
            [
                "▶ Bot started — market scan armed (trend, momentum, strength, tick-stream; 4/4 to trade). Balance:",
                X(get("bal", VID["bal"])),
                "| Take-profit:",
                X(get("take_profit", VID["take_profit"])),
                "| Stop-loss:",
                X(get("stop_loss", VID["stop_loss"])),
            ],
        ),
        notify_var("info", "announcement", "msg", VID["msg"]),
    ]
)

trade_options = B(
    "trade_definition_tradeoptions",
    '<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="false"/>'
    + F("DURATIONTYPE_LIST", "t")
    + F("CURRENCY_LIST", "USD")
    + V("DURATION", SH("math_number_positive", F("NUM", "5")))
    + V("AMOUNT", SH("math_number_positive", F("NUM", "1")) + get("stake", VID["stake"])),
)

trade_definition = B(
    "trade_definition",
    S("TRADE_OPTIONS", market)
    + S("INITIALIZATION", init)
    + S("SUBMARKET", trade_options),
    ' x="0" y="0"',
)

# ---------- before purchase: market scan gate ----------
# Deriv candle indexing (verified in Ticks.js getOhlcFromEnd + ticks_service.js):
#   index 1 = LAST element of the series = the LIVE (forming) 1-min candle
#   index 2 = the last CLOSED 1-min candle
# Scanner (side decided by the last CLOSED candle; all 4 checks must pass):
#   side   - last closed candle closed green/red          (close[2] vs open[2])
#   1. live agrees  - the live minute is still on the same side (close[1] vs open[1])
#   2. held beyond  - current tick beyond the last closed candle's close (tick vs close[2])
#   3. strength     - last CLOSED candle body >= 30% of its range (strong, no doji)
#   4. tick stream  - net move over the last 10 ticks agrees with the side
purchase_call = B("purchase", F("PURCHASE_LIST", "CALL"))
purchase_put = B("purchase", F("PURCHASE_LIST", "PUT"))

def scan(up: bool):
    c2o = read_ohlc("open", 2)
    c2c = read_ohlc("close", 2)
    c2h = read_ohlc("high", 2)
    c2l = read_ohlc("low", 2)
    if up:
        return and_all([
            compare("GT", read_ohlc("close", 1), read_ohlc("open", 1)),                   # 1. live candle agrees
            compare("GT", tick_price(), c2c),                                             # 2. held above last close
            compare("GTE", arith("MINUS", c2c, c2o),
                    arith("MULTIPLY", arith("MINUS", c2h, c2l), num(0.3))),               # 3. strength of closed candle
            compare("GT", tick_back(1), tick_back(10)),                                   # 4. tick stream rising
        ])
    return and_all([
        compare("LT", read_ohlc("close", 1), read_ohlc("open", 1)),                       # 1. live candle agrees
        compare("LT", tick_price(), c2c),                                                 # 2. held below last close
        compare("GTE", arith("MINUS", c2o, c2c),
                arith("MULTIPLY", arith("MINUS", c2h, c2l), num(0.3))),                   # 3. strength of closed candle
        compare("LT", tick_back(1), tick_back(10)),                                       # 4. tick stream falling
    ])

direction_if = iff(
    compare("GT", read_ohlc("close", 2), read_ohlc("open", 2)),
    iff(scan(up=True), purchase_call),
    iff(scan(up=False), purchase_put),
)

gate = iff(compare("LTE", get("wait", VID["wait"]), num(0)), direction_if)

before_purchase = B(
    "before_purchase",
    S("BEFOREPURCHASE_STACK", gate),
    ' x="0" y="760"',
)

# ---------- after purchase ----------
win_branch = chain(
    [
        setv("bal", VID["bal"], balance()),
        setv(
            "base_stake",
            VID["base_stake"],
            round2(arith("MULTIPLY", get("bal", VID["bal"]), num(0.02))),
        ),
        iff(
            compare("LT", get("base_stake", VID["base_stake"]), num(0.35)),
            setv("base_stake", VID["base_stake"], num(0.35)),
        ),
        setv(
            "cap_stake",
            VID["cap_stake"],
            round2(arith("MULTIPLY", get("bal", VID["bal"]), num(0.08))),
        ),
        iff(
            compare("LT", get("cap_stake", VID["cap_stake"]), num(0.35)),
            setv("cap_stake", VID["cap_stake"], num(0.35)),
        ),
        setv("stake", VID["stake"], get("base_stake", VID["base_stake"])),
        setv("streak", VID["streak"], num(0)),
    ]
)

lose_branch = chain(
    [
        setv(
            "streak",
            VID["streak"],
            arith("ADD", get("streak", VID["streak"]), num(1)),
        ),
        setv(
            "stake",
            VID["stake"],
            arith("MULTIPLY", get("stake", VID["stake"]), num(2)),
        ),
        iff(
            compare("GT", get("stake", VID["stake"]), get("cap_stake", VID["cap_stake"])),
            setv("stake", VID["stake"], get("cap_stake", VID["cap_stake"])),
        ),
    ]
)

result_if = iff(
    B("contract_check_result", F("CHECK_RESULT", "win")),
    win_branch,
    lose_branch,
)

sl_check = iff(
    compare(
        "LTE",
        total_profit(),
        B("math_single", F("OP", "NEG") + V("NUM", get("stop_loss", VID["stop_loss"]))),
    ),
    notify("error", "severe-error", B("text", F("TEXT", "🛑 Stop-loss limit hit — session closed. Check the Journal for final P/L."))),
    B("trade_again"),
)

tp_check = iff(
    compare("GTE", total_profit(), get("take_profit", VID["take_profit"])),
    notify("success", "earned-money", B("text", F("TEXT", "🎯 Take-profit target reached — session closed. Check the Journal for final P/L."))),
    sl_check,
)

after_purchase = B(
    "after_purchase",
    S(
        "AFTERPURCHASE_STACK",
        chain(
            [
                setv("wait", VID["wait"], get("cooldown", VID["cooldown"])),
                result_if,
                text_join(
                    "msg",
                    VID["msg"],
                    [
                        "✅ Trade closed — streak:",
                        X(get("streak", VID["streak"])),
                        "| next stake:",
                        X(get("stake", VID["stake"])),
                        "| session P/L:",
                        X(total_profit()),
                    ],
                ),
                notify_var("info", "silent", "msg", VID["msg"]),
                tp_check,
            ]
        ),
    ),
    ' x="960" y="0"',
)

# ---------- tick analysis ----------
tick_analysis = B(
    "tick_analysis",
    S(
        "TICKANALYSIS_STACK",
        B("math_change", F("VAR", "wait", VID["wait"]) + V("DELTA", SH("math_number", F("NUM", "-1")))),
    ),
    ' x="0" y="1400"',
)

# ---------- assemble ----------
variables = "".join(
    f'<variable type="" id="{VID[n]}" islocal="false" iscloud="false">{n}</variable>'
    for n in VAR_NAMES
)

tops = [trade_definition, after_purchase, before_purchase, tick_analysis]
body = "\n  ".join(tops)

xml = (
    '<?xml version="1.0" ?>\n'
    '<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">\n'
    f"  <variables>{variables}</variables>\n"
    f"  {body}\n"
    "</xml>\n"
)

# Safety net: Blockly requires globally unique block/shadow ids. If a generated
# sub-expression string is reused in two places, give each occurrence its own id
# (semantics unchanged: they become separate, identical blocks in the workspace).
import re as _re
_seen_ids = set()
def _uniq(m):
    whole, idv = m.group(0), m.group(1)
    if idv in _seen_ids:
        new_id = rid(20)
        whole = whole.replace(f'id="{idv}"', f'id="{new_id}"', 1)
        _seen_ids.add(new_id)
    else:
        _seen_ids.add(idv)
    return whole
xml = _re.sub(r'<(?:block|shadow)\b[^>]*?\bid="([^"]+)"', _uniq, xml)

out = __file__.replace("build_bot.py", "Deriv_V10_Streak_Scaling_Bot.xml")
with open(out, "w", encoding="utf-8") as f:
    f.write(xml)
print("wrote", out, len(xml), "bytes")
