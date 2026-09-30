#!/usr/bin/env python3
"""Structural + semantic validation for the generated Deriv bot XMLs.

Usage: python3 validate_xml.py [file ...]   (defaults to both generated bots)
"""
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter

NS = "{http://www.w3.org/1999/xhtml}"

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("  FAIL:", msg)
    return cond


def local(tag):
    return tag.split("}")[-1]


def load(path):
    tree = ET.parse(path)  # raises on malformed XML
    root = tree.getroot()
    blocks = root.iter(NS + "block")
    return tree, root, list(root.iter(NS + "block"))


def field_map(blk):
    return {f.get("name"): (f.text or "") for f in blk.findall(NS + "field")}


def all_fields(root, name):
    return [f for f in root.iter(NS + "field") if f.get("name") == name]


def text_of_fields(root, name):
    return [(f.text or "") for f in all_fields(root, name)]


def find_block_by_type(blocks, btype):
    return [b for b in blocks if b.get("type") == btype]


def validate_common(path, tree, root, blocks):
    print(f"\n=== validate {path.split('/')[-1]} ===")
    # unique ids
    ids = [b.get("id") for b in blocks] + [s.get("id") for s in root.iter(NS + "shadow")]
    dupes = [i for i, c in Counter(ids).items() if c > 1]
    check(not dupes, f"duplicate ids: {dupes[:5]}")
    check(all(ids), "missing id on some block/shadow")

    # required tops
    for t in ("trade_definition", "after_purchase", "before_purchase", "tick_analysis"):
        check(find_block_by_type(blocks, t), f"missing top block {t}")

    # market
    mkt = find_block_by_type(blocks, "trade_definition_market")
    check(mkt, "no trade_definition_market")
    if mkt:
        fm = field_map(mkt[0])
        check(fm.get("MARKET_LIST") == "synthetic_index", "market not synthetic_index")
        check(fm.get("SYMBOL_LIST") == "R_10", "symbol not R_10")

    # contract type both
    ct = find_block_by_type(blocks, "trade_definition_contracttype")
    check(ct and field_map(ct[0]).get("TYPE_LIST") == "both", "contract type not 'both'")

    # tradeoptions
    to = find_block_by_type(blocks, "trade_definition_tradeoptions")
    check(to, "no tradeoptions")
    if to:
        fm = field_map(to[0])
        check(fm.get("DURATIONTYPE_LIST") == "t", "duration type not ticks")
        check(fm.get("CURRENCY_LIST") == "USD", "currency not USD")
        mut = to[0].find(NS + "mutation")
        check(mut is not None and all(
            mut.get(k) == "false" for k in
            ("has_first_barrier", "has_second_barrier", "has_prediction")),
            "tradeoptions barrier/prediction flags not all false")
        dur = to[0].find(f"{NS}value[@name='DURATION']")
        check(dur is not None and "math_number_positive" in
              ET.tostring(dur, encoding="unicode"), "DURATION not positive number value")
        # duration = 5
        if dur is not None:
            n = dur.find(f".//{NS}field[@name='NUM']")
            check(n is not None and n.text == "5", "duration != 5 ticks")
        amt = to[0].find(f"{NS}value[@name='AMOUNT']")
        check(amt is not None and "variables_get" in ET.tostring(amt, encoding="unicode")
              and "stake" in ET.tostring(amt, encoding="unicode"), "AMOUNT not stake variable")

    # locked market block (deletable/movable=false live on trade_definition_market)
    mkt2 = find_block_by_type(blocks, "trade_definition_market")
    check(mkt2 and mkt2[0].get("deletable") == "false" and mkt2[0].get("movable") == "false",
          "trade_definition_market not locked")

    # cooldown / stake math via serialized text
    blob = ET.tostring(root, encoding="unicode")
    check(">10</field>" in blob or ">10<" in blob, "cooldown 10 not found")
    check("0.02" in blob, "2% base stake factor missing")
    check("0.08" in blob, "8% cap factor missing")
    check("0.05" in blob, "5% take-profit factor missing")
    check("0.1" in blob, "10% stop-loss factor missing")
    check("0.35" in blob, "min stake floor missing")
    check("MULTIPLY" in blob, "MULTIPLY missing")
    check("logic_operation" in blob and ">AND<" in blob, "AND fold missing")

    # wait decrement in tick_analysis
    ta = find_block_by_type(blocks, "tick_analysis")
    if ta:
        t = ET.tostring(ta[0], encoding="unicode")
        check("math_change" in t and ">-1<" in t, "tick_analysis missing wait -1")


def validate_rise_fall(path, root, blocks):
    print("-- rise/fall specifics")
    tt = find_block_by_type(blocks, "trade_definition_tradetype")
    check(tt and field_map(tt[0]).get("TRADETYPECAT_LIST") == "callput"
          and field_map(tt[0]).get("TRADETYPE_LIST") == "callput", "tradetype not callput/callput")

    purchases = [field_map(b).get("PURCHASE_LIST") for b in find_block_by_type(blocks, "purchase")]
    check(sorted(purchases) == ["CALL", "PUT"], f"purchases != CALL+PUT: {purchases}")

    blob = ET.tostring(root, encoding="unicode")
    check("DIGITEVEN" not in blob and "DIGITODD" not in blob, "digit purchases leaked into rise/fall")
    check("lastDigitList" not in blob, "lastDigitList leaked into rise/fall")
    check("even_side" not in blob, "even_side leaked into rise/fall")

    # exactly two tick-vs-close comparisons, both (tick, close idx 2)
    tick_vs_close = 0
    for b in blocks:
        if b.get("type") != "logic_compare":
            continue
        va = b.find(f"{NS}value[@name='A']")
        vb = b.find(f"{NS}value[@name='B']")
        if va is None or vb is None:
            continue
        a = va.find(NS + "block")
        c = vb.find(NS + "block")
        if a is None or c is None:
            continue
        def is_tick(blk):
            return blk.get("type") == "tick"
        def is_close2(blk):
            if blk.get("type") != "read_ohlc":
                return False
            f = field_map(blk)
            if f.get("OHLCFIELD_LIST") != "close":
                return False
            idx = blk.find(f"{NS}value[@name='CANDLEINDEX']")
            n = idx.find(f".//{NS}field[@name='NUM']") if idx is not None else None
            return n is not None and n.text == "2"
        if (is_tick(a) and is_close2(c)) or (is_tick(c) and is_close2(a)):
            tick_vs_close += 1
    check(tick_vs_close == 2, f"tick-vs-close[2] comparisons = {tick_vs_close}, want 2 (GT+LT)")

    # candle index usage: idx2 >= 6 occurrences, idx1 >= 2
    idx2 = idx1 = 0
    for b in blocks:
        if b.get("type") == "read_ohlc":
            idx = b.find(f"{NS}value[@name='CANDLEINDEX']")
            n = idx.find(f".//{NS}field[@name='NUM']") if idx is not None else None
            if n is not None:
                if n.text == "2":
                    idx2 += 1
                elif n.text == "1":
                    idx1 += 1
    check(idx2 >= 6, f"read_ohlc idx2 count {idx2} < 6")
    check(idx1 >= 2, f"read_ohlc idx1 count {idx1} < 2")


def validate_evenodd(path, root, blocks):
    print("-- even/odd specifics")
    tt = find_block_by_type(blocks, "trade_definition_tradetype")
    check(tt and field_map(tt[0]).get("TRADETYPECAT_LIST") == "digits"
          and field_map(tt[0]).get("TRADETYPE_LIST") == "evenodd",
          "tradetype not digits/evenodd")

    purchases = [field_map(b).get("PURCHASE_LIST") for b in find_block_by_type(blocks, "purchase")]
    check(sorted(purchases) == ["DIGITEVEN", "DIGITODD"], f"purchases != DIGITEVEN+DIGITODD: {purchases}")

    blob = ET.tostring(root, encoding="unicode")
    check("CALL" not in [p for p in purchases] and "PUT" not in [p for p in purchases],
          "rise/fall purchases leaked")
    check("even_side" in blob, "even_side variable missing")

    # lists_getIndex on lastDigitList: indexes used
    digit_idx = []
    for b in blocks:
        if b.get("type") != "lists_getIndex":
            continue
        val = b.find(f"{NS}value[@name='VALUE']")
        if val is None:
            continue
        inner = val.find(NS + "block")
        if inner is not None and inner.get("type") == "lastDigitList":
            at = b.find(f"{NS}value[@name='AT']")
            n = at.find(f".//{NS}field[@name='NUM']") if at is not None else None
            digit_idx.append(int(n.text) if n is not None else -1)
    c = Counter(digit_idx)
    check(c[1] == 2, f"digit FROM_END 1 used {c[1]}x, want 2 (set + term)")
    check(c[11] == 1, f"digit FROM_END 11 used {c[11]}x, want 1 (anchor)")
    for i in range(2, 11):
        check(c[i] == 1, f"digit FROM_END {i} used {c[i]}x, want 1")
    check(len(digit_idx) == 12, f"lastDigitList lookups = {len(digit_idx)}, want 12")

    # math_number_property EVEN x12
    props = []
    for b in blocks:
        if b.get("type") == "math_number_property":
            props.append(field_map(b).get("PROPERTY"))
    check(len(props) == 12 and all(p == "EVEN" for p in props),
          f"math_number_property: {Counter(props)}, want 12x EVEN")

    # agreement threshold: GTE ... 6
    found6 = False
    for b in blocks:
        if b.get("type") == "logic_compare" and field_map(b).get("OP") == "GTE":
            vb = b.find(f"{NS}value[@name='B']")
            if vb is not None:
                n = vb.find(f".//{NS}field[@name='NUM']")
                if n is not None and n.text == "6":
                    found6 = True
    check(found6, "no GTE 6 agreement threshold")

    # ADD chain for the 10 agreement terms
    adds = [b for b in blocks if b.get("type") == "math_arithmetic"
            and field_map(b).get("OP") == "ADD"]
    # 10 terms -> 9 ADDs (+1 streak ADD in after_purchase = 10)
    check(len(adds) >= 9, f"ADD blocks = {len(adds)}, want >= 9")

    # even_side branch: controls_if with condition = variables_get even_side,
    # DO contains DIGITEVEN, ELSE contains DIGITODD
    ok_branch = False
    for b in blocks:
        if b.get("type") != "controls_if":
            continue
        if0 = b.find(f"{NS}value[@name='IF0']")
        if if0 is None:
            continue
        g = if0.find(f".//{NS}field[@name='VAR']")
        if g is None or g.text != "even_side":
            continue
        do = b.find(f"{NS}statement[@name='DO0']")
        els = b.find(f"{NS}statement[@name='ELSE']")
        if do is None or els is None:
            continue
        dt = ET.tostring(do, encoding="unicode")
        et = ET.tostring(els, encoding="unicode")
        if "DIGITEVEN" in dt and "DIGITODD" in et:
            ok_branch = True
    check(ok_branch, "even_side branch (DO=EVEN, ELSE=ODD) not found")

    # variables declared
    varnames = [(v.text or "") for v in root.iter(NS + "variable")]
    check("even_side" in varnames, "even_side not declared")
    check(len(varnames) == len(set(varnames)), "duplicate variable names")


def main():
    paths = sys.argv[1:] or [
        "/home/user/deriv-v10-bot/Deriv_V10_Streak_Scaling_Bot.xml",
        "/home/user/deriv-v10-bot/Deriv_V10_EvenOdd_Bot.xml",
    ]
    for path in paths:
        tree, root, blocks = load(path)
        validate_common(path, tree, root, blocks)
        name = path.split("/")[-1]
        if "EvenOdd" in name:
            validate_evenodd(path, root, blocks)
        else:
            validate_rise_fall(path, root, blocks)
        print("-- done")
    if FAILS:
        print(f"\nVALIDATION: {len(FAILS)} FAILURE(S)")
        sys.exit(1)
    print("\nVALIDATION: ALL PASS")


if __name__ == "__main__":
    main()
