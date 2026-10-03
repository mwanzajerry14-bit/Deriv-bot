# Trend_Robot real-data backtest (transparent report)

Run: 2026-10-03 16:39 UTC - engine `backtestRun` in Trend_Robot.html - payout net 0.886 (probe-measured 0.66/0.35).

## Method
- Data: Deriv WS `ticks_history` 1m candles, paginated (1000/page), R_10, R_25, R_50, R_75, R_100 x 8.3 days.
- Decisions at every CLOSED 1m bar; candle-close proxy; tie=loss; cooldown = expiry bars; flat stake $7.5.
- Chronological 60/20/20 train/val/OOS; threshold swept on TRAIN only; expiry chosen on VAL; OOS reported once (no leakage).
- Critical gates (must ALL be true): 1H+15M structure agree | liquidity sweep | 5M BOS/CHOCH | CRT ref-candle sweep.
- Break-even WR from actual payout: 1/(1+0.886) = 53.0%.

## Results
```
HISTORY: R_10=12000 R_25=12000 R_50=12000 R_75=12000 R_100=12000 | 8.3 days of 1m | stake $7.5 (0.75% of $1000)
candidate setups at score>=8: 25 (symbol x expiry evaluations)
per symbol: {"R_25":5,"R_50":10,"R_75":10}

EXPIRY | n | th*(train) | trainWR | valWR | OOSn | OOS-WR | OOS-EV | OOS-PF | OOS-DD | BE | edge
1m | 5 | n<12 - calibration impossible this window (honest: no th applied)
2m | 5 | n<12 - calibration impossible this window (honest: no th applied)
3m | 5 | n<12 - calibration impossible this window (honest: no th applied)
5m | 5 | n<12 - calibration impossible this window (honest: no th applied)
10m | 5 | n<12 - calibration impossible this window (honest: no th applied)

NO expiry validated on train+val in this window -> robot keeps default threshold 11, NO parameter applied (honest OOS discipline).

RAW score>=8 pool (all expiries pooled, NOT a strategy): n=25 WR 52.0% EV -0.142 PF 0.961 maxDD 5505.0% BE 53.0%
Rate: 0.60 candidates/symbol/day over 5 symbols (live robot scans all Volatility indices).
DISCLAIMER: demo-only research on 8.3 days of 1m candles; past does not guarantee future results; losses are unavoidable; no profitability claim.
```

## Honest reading
- The four critical gates pass together on ~0.03% of bars per symbol - this is the "NO TRADE unless clear edge" rule doing its job.
- In this 8.3-day window the per-expiry sample never reached n>=12, so **no threshold/expiry was applied**; the robot keeps the default 11/13 until the lab gates pass.
- The live robot scans every Volatility index (not just these 5), which multiplies the candidate rate; the TRADE LOG unlocks condition analysis at 50 entries and only statistically-gated parameter changes.
- Demo only. Past results never guarantee future results.
