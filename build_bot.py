#!/usr/bin/env python3
"""Generate Deriv Bot (bot.deriv.com) strategy XMLs: V10 streak-scaling bots.

Two variants are written, sharing all money management:

  1. Deriv_V10_Streak_Scaling_Bot.xml   — Rise/Fall
     Market:  Volatility 10 Index (R_10), contract side from a 4-check
     trend scanner (side = last CLOSED 1-min candle; live candle agrees,
     tick held beyond the close, body >= 30% of range, tick stream agrees).

  2. Deriv_V10_EvenOdd_Bot.xml          — Even/Odd (digit contracts)
     Market:  Volatility 10 Index (R_10), parity from a parity-streak
     scanner: last tick's parity == parity 10 ticks back (digit FROM_END 11)
     AND >= 6 of the last 10 ticks share the last tick's parity -> buy the
     last tick's parity (Even if last digit even, else Odd).

Shared spec (both variants):
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


def ternary(cond, a, b):
    return B("logic_ternary", V("IF", cond) + V("THEN", a) + V("ELSE", b))


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


def list_back(list_block, n):
    """Item n positions from the end of a list (1 = newest)."""
    return B(
        "lists_getIndex",
        '<mutation statement="false" at="true"/>'
        + F("MODE", "GET")
        + F("WHERE", "FROM_END")
        + V("VALUE", list_block)
        + V("AT", num(n)),
    )


def tick_back(n):
    """Tick price n positions from the end of the last-1000-ticks list (1 = newest)."""
    return list_back(B("ticks"), n)


def digit_back(n):
    """Last digit n positions from the end of the last-1000-ticks list (1 = newest).
    Uses Deriv's `lastDigitList` (Bot.getLastDigitList — pip-accurate digits)."""
    return list_back(B("lastDigitList"), n)


def is_even(expr):
    """Deriv math_number_property: '<expr> is even' (Boolean output)."""
    return B("math_number_property", V("NUMBER_TO_CHECK", expr) + F("PROPERTY", "EVEN"))


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
BASE_VARS = [
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
    "broke",
]

# ---------- trade definition ----------
def market_block(mode):
    if mode == "rise_fall":
        tradetype = F("TRADETYPECAT_LIST", "callput") + F("TRADETYPE_LIST", "callput")
    elif mode == "evenodd":
        tradetype = F("TRADETYPECAT_LIST", "digits") + F("TRADETYPE_LIST", "evenodd")
    else:
        raise ValueError(mode)
    return B(
        "trade_definition_market",
        F("MARKET_LIST", "synthetic_index")
        + F("SUBMARKET_LIST", "random_index")
        + F("SYMBOL_LIST", "R_10")
        + NEXT(
            B(
                "trade_definition_tradetype",
                tradetype
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


def init_chain(mode, VID):
    # INITIALIZATION chain
    start_text = (
        "▶ Bot started — market scan armed (trend, momentum, strength, tick-stream; 4/4 to trade). Balance:"
        if mode == "rise_fall"
        else "▶ Even/Odd bot started — parity scan armed (anchor 10 ticks back + 6/10 agreement; 2/2 to trade). Balance:"
    )
    return chain(
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
            # floor 0.70 (= 2 x min stake) so one doubling step always fits, even on a $2 account
            iff(
                compare("LT", get("cap_stake", VID["cap_stake"]), num(0.70)),
                setv("cap_stake", VID["cap_stake"], num(0.70)),
            ),
            setv("stake", VID["stake"], get("base_stake", VID["base_stake"])),
            setv("streak", VID["streak"], num(0)),
            setv("wait", VID["wait"], num(0)),
            setv("cooldown", VID["cooldown"], num(10)),
            setv("broke", VID["broke"], num(0)),
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
            # floor 0.70 so stop-loss can absorb at least two losses (0.35 then 0.70) on tiny accounts
            iff(
                compare("LT", get("stop_loss", VID["stop_loss"]), num(0.70)),
                setv("stop_loss", VID["stop_loss"], num(0.70)),
            ),
            text_join(
                "msg",
                VID["msg"],
                [
                    start_text,
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


def trade_options_block(VID):
    return B(
        "trade_definition_tradeoptions",
        '<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="false"/>'
        + F("DURATIONTYPE_LIST", "t")
        + F("CURRENCY_LIST", "USD")
        + V("DURATION", SH("math_number_positive", F("NUM", "5")))
        + V("AMOUNT", SH("math_number_positive", F("NUM", "1")) + get("stake", VID["stake"])),
    )


# ---------- before purchase: market scan gate ----------
# Deriv candle indexing (verified in Ticks.js getOhlcFromEnd + ticks_service.js):
#   index 1 = LAST element of the series = the LIVE (forming) 1-min candle
#   index 2 = the last CLOSED 1-min candle
# Rise/Fall scanner (side decided by the last CLOSED candle; all 4 checks must pass):
#   side   - last closed candle closed green/red          (close[2] vs open[2])
#   1. live agrees  - the live minute is still on the same side (close[1] vs open[1])
#   2. held beyond  - current tick beyond the last closed candle's close (tick vs close[2])
#   3. strength     - last CLOSED candle body >= 30% of its range (strong, no doji)
#   4. tick stream  - net move over the last 10 ticks agrees with the side
# Even/Odd scanner (parity-streak; both checks must pass):
#   anchor    - parity of newest digit (FROM_END 1) == parity of digit 10 ticks back (FROM_END 11)
#   agreement - >= 6 of the last 10 digits share the newest tick's parity
#   -> purchase Even if newest digit is even, else Odd
purchase_call = B("purchase", F("PURCHASE_LIST", "CALL"))
purchase_put = B("purchase", F("PURCHASE_LIST", "PUT"))
purchase_even = B("purchase", F("PURCHASE_LIST", "DIGITEVEN"))
purchase_odd = B("purchase", F("PURCHASE_LIST", "DIGITODD"))


def scan_trend(up: bool):
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


def parity_conditions(VID):
    """anchor + agreement, using the even_side variable set just before."""
    anchor = compare("EQ", get("even_side", VID["even_side"]), is_even(digit_back(11)))
    terms = []
    for i in range(1, 11):
        terms.append(
            ternary(
                compare("EQ", is_even(digit_back(i)), get("even_side", VID["even_side"])),
                num(1),
                num(0),
            )
        )
    agree = terms[0]
    for t in terms[1:]:
        agree = arith("ADD", agree, t)
    return and_all([anchor, compare("GTE", agree, num(6))])


def before_purchase_block(mode, VID):
    if mode == "rise_fall":
        body = iff(
            compare("GT", read_ohlc("close", 2), read_ohlc("open", 2)),
            iff(scan_trend(up=True), purchase_call),
            iff(scan_trend(up=False), purchase_put),
        )
    else:
        even_odd_if = iff(
            get("even_side", VID["even_side"]),
            purchase_even,
            purchase_odd,
        )
        body = chain(
            [
                setv("even_side", VID["even_side"], is_even(digit_back(1))),
                iff(parity_conditions(VID), even_odd_if),
            ]
        )

    # --- small-account protection (e.g. a $2 balance) ---
    # 1) If the balance can no longer cover the MINIMUM stake ($0.35), stop
    #    cleanly once (notify) instead of retrying an unaffordable order forever.
    # 2) If the balance can't cover the next escalated stake but is still
    #    >= $0.35, shrink the stake to what's affordable — never place an
    #    order the account can't pay for.
    # 3) Only trade when: cooldown expired, not broke, and balance >= stake.
    broke_guard = iff(
        and_all([
            compare("EQ", get("broke", VID["broke"]), num(0)),
            compare("LT", balance(), num(0.35)),
        ]),
        chain(
            [
                setv("broke", VID["broke"], num(1)),
                notify(
                    "error",
                    "severe-error",
                    B(
                        "text",
                        F(
                            "TEXT",
                            "⛔ Balance is below the $0.35 minimum stake — bot is idle. Top up, then press Run again.",
                        ),
                    ),
                ),
            ]
        ),
    )
    shrink_stake = iff(
        and_all([
            compare("EQ", get("broke", VID["broke"]), num(0)),
            compare("GTE", balance(), num(0.35)),
            compare("LT", balance(), get("stake", VID["stake"])),
        ]),
        setv("stake", VID["stake"], round2(balance())),
    )
    gate = iff(
        and_all([
            compare("LTE", get("wait", VID["wait"]), num(0)),
            compare("EQ", get("broke", VID["broke"]), num(0)),
            compare("GTE", balance(), get("stake", VID["stake"])),
        ]),
        body,
    )
    stack = chain([broke_guard, shrink_stake, gate])
    return B(
        "before_purchase",
        S("BEFOREPURCHASE_STACK", stack),
        ' x="0" y="760"',
    )


# ---------- after purchase ----------
def after_purchase_block(VID):
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
                compare("LT", get("cap_stake", VID["cap_stake"]), num(0.70)),
                setv("cap_stake", VID["cap_stake"], num(0.70)),
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

    return B(
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
def tick_analysis_block(VID):
    return B(
        "tick_analysis",
        S(
            "TICKANALYSIS_STACK",
            B("math_change", F("VAR", "wait", VID["wait"]) + V("DELTA", SH("math_number", F("NUM", "-1")))),
        ),
        ' x="0" y="1400"',
    )


# ---------- assemble ----------
def build(mode):
    var_names = list(BASE_VARS)
    if mode == "evenodd":
        var_names.append("even_side")
    VID = {n: rid(20) for n in var_names}

    market = market_block(mode)
    init = init_chain(mode, VID)
    trade_options = trade_options_block(VID)
    trade_definition = B(
        "trade_definition",
        S("TRADE_OPTIONS", market)
        + S("INITIALIZATION", init)
        + S("SUBMARKET", trade_options),
        ' x="0" y="0"',
    )
    before_purchase = before_purchase_block(mode, VID)
    after_purchase = after_purchase_block(VID)
    tick_analysis = tick_analysis_block(VID)

    variables = "".join(
        f'<variable type="" id="{rid(20)}" islocal="false" iscloud="false">{n}</variable>'
        for n in var_names
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
    seen_ids = set()

    def _uniq(m):
        whole, idv = m.group(0), m.group(1)
        if idv in seen_ids:
            new_id = rid(20)
            whole = whole.replace(f'id="{idv}"', f'id="{new_id}"', 1)
            seen_ids.add(new_id)
        else:
            seen_ids.add(idv)
        return whole

    return _re.sub(r'<(?:block|shadow)\b[^>]*?\bid="([^"]+)"', _uniq, xml)


import os
HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUTS = {
    "rise_fall": "Deriv_V10_Streak_Scaling_Bot.xml",
    "evenodd": "Deriv_V10_EvenOdd_Bot.xml",
}

if __name__ == "__main__":
    for mode, fname in OUTPUTS.items():
        xml = build(mode)
        out = os.path.join(HERE, fname)
        with open(out, "w", encoding="utf-8") as f:
            f.write(xml)
        print("wrote", out, len(xml), "bytes")
