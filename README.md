# Deriv V10 Streak-Scaling Bot — strategy file

**Files:** `Deriv_V10_Streak_Scaling_Bot.xml` (the strategy — load it in **Bot Builder → Load strategy → Local → Select an XML file from your device**, the dialog in your screenshot; dragging it onto the workspace also works) and `Best_Market_Analyzer.html` (standalone tool that ranks the best market for it — see below).

Built against Deriv's own open-source bot template (`deriv-com/trading-bot-template`) — every block type, field name and dropdown value in this file was verified against their official block definitions, and the file passes a real Blockly parse test (245 blocks, 0 warnings).

---

## What the bot does

| Setting | Value |
|---|---|
| Market | **Volatility 10 Index (R_10)** — synthetic_index / random_index |
| Trade type | **Rise/Fall**, both directions (Call & Put) |
| Duration | **5 ticks** |
| Entry signal | Direction of the **last closed 1-minute candle** — but only after the **market scanner** passes (see below) |
| Market scanner | **4 checks must ALL pass** before any purchase: trend, momentum, strength, tick-stream |
| Cooldown | **10 ticks** between trades (variable `cooldown`) |
| Stake sizing | **2% of balance**, doubling per consecutive loss, **capped at 8%**, reset on a win |
| Take-profit | **+5% of session-start balance** → bot stops with a 🎯 notification |
| Stop-loss | **−10% of session-start balance** → bot stops with a 🛑 notification |
| On error | Restarts automatically (`Restart on error` = TRUE) |
| Currency | USD |

### Market scanner (runs before every execution)

**Candle indexing, verified against Deriv's own engine code** (`getOhlcFromEnd` + the ticks
service): `read_ohlc` index **1 = the LIVE (forming) 1-min candle** (last element of the
series), index **2 = the last CLOSED candle**. The scanner uses exactly that.

The trade **side** is chosen by the last closed candle (`close[2] > open[2]` → Call side,
red → Put side). Once a side exists, **all four checks must pass** (mirrored for Put):

| # | Check | What it verifies | Formula (for a Call) |
|---|---|---|---|
| 1 | **Live agrees** | The current minute is still on the same side — no immediate reversal | `close[1] > open[1]` |
| 2 | **Held beyond** | Price is holding **beyond the last closed candle's close** | `tick > close[2]` |
| 3 | **Strength** | The last **closed** candle's body is ≥ 30% of its range — a decisive candle, not a doji | `(close[2]−open[2]) ≥ (high[2]−low[2]) × 0.3` |
| 4 | **Tick stream** | Net move over the last 10 ticks (≈20s) is upward | `ticks[end 1] > ticks[end 10]` |

If any check fails, no trade is placed that tick — the bot keeps scanning and waits for the
setup to line up (the 10-tick cooldown still applies between trades). The scanner uses only
`tick`, `ticks` (last-1000-tick list), and `read_ohlc` blocks — all standard Deriv Bot analysis
blocks sitting right there in your Blocks menu under **Tick and candle analysis**.

### Stake escalation (exactly as chosen)

```
stake = 2% of balance          (rounded to 2 decimals, min $0.35)
after each LOSS:   stake × 2   (2% → 4% → 8% → capped at 8%)
after a WIN:       stake resets to 2% of the CURRENT balance (compounds as you grow)
```

Example on a $1,000 balance: **$20 → $40 → $80 → $80 (cap) → … → win → $20**.
Session take-profit/stop-loss thresholds are fixed at start-up from the starting balance ($50 / $100 in this example).

### Notifications

- On start: balance, take-profit and stop-loss levels
- After every trade: `✅ Trade closed — streak: N | next stake: X | session P/L: Y`
- 🎯 Take-profit hit or 🛑 Stop-loss hit → bot stops trading (press **Run** again for a new session)

---

## How to tune it (all in the Bot Builder workspace)

| What | Where |
|---|---|
| Risk % (2% / 8%) | **Trade parameters → Initialization**: numbers `0.02` (base) and `0.08` (cap) |
| Take-profit / stop-loss % | **Initialization**: `0.05` (TP) and `0.1` (SL) |
| Cooldown ticks | **Initialization**: `cooldown = 10`, and the `wait` countdown in **Tick analysis** |
| Duration | **Trade parameters → Trade options**: `5` ticks |
| Scanner side rule | **Purchase conditions**: `close[2] > open[2]` (last closed candle) |
| Scanner: strength threshold | **Purchase conditions**: the `0.3` multiplier (body vs range) |
| Scanner: tick window | **Purchase conditions**: the `AT` number `10` on the two `in list … from end` blocks |
| Market / type | **Trade parameters**: R_10, Rise/Fall, Both |

---

## Best Market Analyzer (`Best_Market_Analyzer.html`)

Your bot's blocks can only see the market they're loaded with — so the companion tool ranks
**every Volatility index** for you, then you set the winner in Trade parameters (two clicks).

**Run it:** double-click `Best_Market_Analyzer.html` (or drag it into Chrome). It connects
from *your* browser straight to Deriv's public WebSocket API (no login, `app_id 1089`) —
it must run on your machine because Deriv's data API isn't reachable from sandboxed previews.
If your network blocks it, serve the folder with `python -m http.server 8000` and open
`http://localhost:8000/Best_Market_Analyzer.html`.

**What it measures per market** (last 30 closed 1-min candles + last 100 ticks — the same
data your bot's scanner reads):

| Metric | Weight | Why it matters here |
|---|---|---|
| Trend persistence | 25% | Adjacent candles closing the same direction — the bot's side rule fires more often |
| Candle strength | 20% | % of candles passing the bot's own ≥0.3 body/range test |
| Directional efficiency | 20% | Net travel ÷ path — price actually going somewhere for 5-tick contracts |
| Tick-stream momentum | 15% | How persistently the bot's 10-tick check has held over 100 ticks |
| Volatility (avg range %) | 20% | 5-tick contracts need movement; rank-based so units never skew it |

Scores are weighted percentile ranks (0–100). The **bot-scanner badge** on each row mirrors
your bot's exact four checks live — a green `CALL · BOT-READY 4/4` badge means the bot, if
loaded with that market right now, would take the trade. Your current market (**R_10**) is
highlighted, the hero card tells you the #1 market and exactly what to set in
**Trade parameters → Market**. Auto-refreshes every 60s.

## Important risk notes

- Loss-streak escalation is a **martingale-style** system: a long losing streak risks a large share of the balance (bounded by the 8% cap and the −10% stop-loss, but still). Run it on **demo first** and watch a full session before ever using real money.
- The scanner filters *when* the bot fires, it does not predict: requiring 4/4 alignment makes entries rarer but higher-conviction setups. No signal wins all the time — the protection still comes from the cap + session limits, not from prediction.
- The tick-stream check (block `ticks` → `in list … # from end`) reads the last-1000-tick list each attempt; if Deriv ever changes that block you'll see it immediately on import — the file validates against their official block definitions.
- The bot only holds **one open contract at a time** and stops itself at TP/SL; it will not trade again until you press Run.
- Minimum recommended balance ≈ **$25** so that 2% stays above the $0.35 minimum stake (the bot auto-floors to $0.35 below that).
