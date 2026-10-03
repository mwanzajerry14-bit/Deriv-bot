# Audit — Deriv Trend Robot (pre-redesign)

Scope: `Trend_Robot.html` as of commit `c856742`. Audit performed before any
strategy changes, per the redesign brief. Nothing below is a profitability claim.

## 1. What the current robot does

| Area | Current implementation |
|---|---|
| Entry conditions | 4-check "trend scanner": side = direction of last **closed 1m candle**; live candle agrees; tick holds beyond closed candle's close; closed body ≥ 30% of range; net up/down over last 10 ticks. Plus composite percentile **score ≥ 90** (rank vs the other 12 Volatility feeds). |
| Exit / expiry | Fixed **5 ticks** (~2–10 s), Rise/Fall, one direction per entry. |
| Market / timeframe | All 13 Volatility indices, **1m candles + 100 ticks only**. No 5m/15m/1h context. |
| Indicators | Percentile-rank composite (trend persistence, strength, efficiency, tick momentum, range) — cross-sectional, not absolute edge. |
| Signal confirmation | Same-candle agreement only. No structure, no reaction requirement. |
| Trend detection | Adjacent closed-candle direction agreement (2-candle view). |
| Liquidity / BOS / CHOCH / CRT / FVG / Order blocks | **Absent.** |
| Volatility filter | Only a relative "range" percentile inside the composite score. No regime classification; chop is not detected. |
| Session filter | None. |
| Stake calculation | Was 2%→4%→8% **martingale** with $0.35/$0.70 floors (superseded mid-project by flat-risk; martingale removed per redesign §12). |
| Loss recovery | Martingale (original) — amplified drawdowns: one SL cancelled two TPs under +5/−10; later +5/−5. |
| Max trades / consec-loss handling | One trade at a time; 20 s cooldown; later 2-loss session pause. **No daily caps.** |
| Duplicate signals / re-entry | Re-enters same market after cooldown while it still qualifies (no setup-level dedupe). |
| Data source | Public WSS `api.derivws.com …/ws/public`; 1m candles capped at **1000 bars/request** (pagination available via `end=epoch`); ticks 100. |
| Execution latency | Sweep 2.5 s (parallel) + proposal + buy ≈ 2 sequential RTTs → ~3 s decision-to-fill. |
| Payout assumptions | **Never checked before v2.** Live probe: ask 0.35 → payout 0.66 → net **88.6%** → break-even win rate = 0.35/0.66 ≈ **53.0%** for every expiry tested (5t/1m/10m). |
| Backtest | **None.** No historical validation of any parameter (score gate, TP/SL, expiry) was ever run. |

## 2. Why it loses — root causes (ranked)

1. **The signal is approximately a coin flip on a 53% break-even game.**
   Last-candle direction + 10-tick persistence on 1m noise has no measured edge.
   After Deriv's ~11% net payout cost, anything under 53% win rate is a slow bleed;
   the signal was never measured against that bar.
2. **Cross-sectional score ≠ edge.** "Score ≥ 90" means *best of the 13 correlated
   feeds right now*, not *positive expected value*. On near-identical synthetic
   feeds, percentile rank mostly measures which random walk is currently loudest.
3. **Zero historical validation.** Every parameter (gate, expiry, TP/SL) was set
   by inspection, never by train/validation/out-of-sample testing.
4. **Single timeframe, no structural context.** No HTF bias, no liquidity sweep,
   no BOS/CHOCH, no premium/discount, no reaction requirement — entries occur in
   mid-range chop and after completed impulses alike ("chasing").
5. **No regime filter.** Trend-following logic runs unchanged in choppy
   conditions where it structurally loses.
6. **No payout / EV gate (pre-v2).** Technical signals entered regardless of the
   live payout, i.e. regardless of the break-even bar.
7. **Martingale (original build) compounded 1–6.** Loss streaks sized up into the
   worst regimes; the $0.35 floor made small-account stakes a large % of balance.
8. **13 correlated instruments ≠ diversification.** Simultaneous scanning mostly
   picks the same randomness; it did not spread risk.
9. **5-tick expiry ≈ pure micro-noise** — dominated by spread/payout cost and tick
   randomness rather than directional persistence.
10. **No trade log analysis** — losing conditions were never identified
    statistically; changes were reactive.

## 3. Verdict

The system's losses are consistent with its design: **paying ~11% per trade for a
signal with unmeasured, likely ~50% information content, sized with a martingale,
unfiltered for regime or payout, and never backtested.** The redesign addresses
root causes 1–10 in order: measurable ICT/SMC/CRT confluence scoring, regime +
payout/EV gates, flat risk with daily/session stops, and an in-browser
train/validation/OOS backtest lab with break-even-relative statistics, Monte
Carlo, and expiry matrices. No configuration may go live until it beats its
payout-derived break-even on out-of-sample data with a stability margin.


---

## §11 Engine implementation note (post-redesign)

The ICT/SMC/CRT engine, flat-risk module and backtest lab now live in `Trend_Robot.html`
(rcore: `evaluateICT` + risk + backtest; rapp: 1m data manager, EV-gated proposal, LAB/LOG tabs).
Transparency artifacts:
- `qa/ict_engine_test.js` — 91 checks incl. a parameter-proven fixture that must score 13/13 CALL.
- `qa/robot_e2e_test.js` — full UI flow (classic + PAT/OTP) incl. flat-stake-after-win proof.
- `qa/BACKTEST.md` — real 1m data, 5 symbols × 8.3 days: honest result = per-expiry n<12 →
  **no threshold applied** (default 11/13 kept); raw score≥8 pool sits BELOW break-even (52% vs 53%),
  confirming why the gate exists. No profitability claims — demo only.
