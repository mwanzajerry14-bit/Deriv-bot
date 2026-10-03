# Deriv V10 Streak-Scaling Bots — strategy files

**Files:**

| File | What it is |
|---|---|
| `Deriv_V10_Streak_Scaling_Bot.xml` | **Rise/Fall strategy** (4-check trend scanner) — load via **Bot Builder → Load strategy → Local → Select an XML file**; dragging onto the workspace works too |
| `Deriv_V10_EvenOdd_Bot.xml` | **Even/Odd strategy** (parity-streak gate) — same money management, digit contracts |
| `Best_Market_Analyzer.html` | Companion ranking tool with live badges for **both** bots (hosted: `https://mwanzajerry14-bit.github.io/Deriv-bot/`) |
| `Trend_Robot.html` | **Auto-trading robot** — same 4-check scanner running live in your browser; buys the first qualifying Volatility market when ARMED (demo default) |

Built against Deriv's own open-source bot template (`deriv-com/trading-bot-template`) — every block type, field name and dropdown value in both files was verified against their official block definitions, and both pass a real Blockly parse test (Rise/Fall: 292 blocks, Even/Odd: 336 blocks, 0 warnings each).

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

### Even/Odd variant (`Deriv_V10_EvenOdd_Bot.xml`) — parity-streak gate

Identical money management (2%→4%→8% cap, reset on win, TP +5% / SL −10%, 10-tick cooldown,
5-tick duration, R_10), but trades **digit contracts** — `Even`/`Odd` — and replaces the trend
scanner with a **parity gate** that must pass before every purchase:

| # | Check | What it verifies | Formula |
|---|---|---|---|
| A | **Anchor** | The newest tick's parity still matches the parity **10 ticks back** (no recent flip) | `digit[end 1] is even` == `digit[end 11] is even` |
| B | **Agreement** | At least **6 of the last 10** digits share the newest tick's parity | `Σ (digit[end i] is even == digit[end 1] is even), i=1..10 ≥ 6` |

If both pass, the bot purchases **Even** when the newest digit is even, otherwise **Odd**.
Digits come from Deriv's own `Last digits list` block (`Bot.getLastDigitList` — pip-accurated,
so `"6012.30"` → digit 0 → Even), and the parity test is the `is even` number-property block —
everything under **Tick and candle analysis** in your Blocks menu. The analyzer's green **EO**
badge mirrors these two checks live.

### Stake escalation (exactly as chosen)

```
stake = 2% of balance          (rounded to 2 decimals, floored at $0.35 = Deriv's
                                minimum stake for synthetic options)
after each LOSS:   stake × 2   (2% → 4% → 8% → capped at 8% of balance,
                                with a floor of $0.70 so one doubling always fits)
after a WIN:       stake resets to 2% of the CURRENT balance (compounds as you grow)
```

Example on a $1,000 balance: **$20 → $40 → $80 → $80 (cap) → … → win → $20**.
Session take-profit/stop-loss thresholds are fixed at start-up from the starting balance ($50 / $100 in this example).

### Small accounts (a $2 balance) — what changes

Deriv's minimum stake for synthetic options is **$0.35** (verified), which is 17.5% of a $2
account — so plain percentages alone would break the bot (2% = $0.04 < min stake; 8% cap =
$0.16 < one doubling; −10% stop-loss = −$0.20 < one loss). The generator therefore adds three
protections, active on **any** balance size but only binding on tiny ones:

| Protection | Rule | Effect on $2 |
|---|---|---|
| **Stake floor** | base stake = max(2% balance, **$0.35**) | orders are always placeable |
| **Cap floor** | escalation cap = max(8% balance, **$0.70**) | the ×2 step works: $0.35 → $0.70, then held |
| **Stop-loss floor** | stop = max(−10% balance, **−$0.70**) | survives **two** losses instead of dying after the first |
| **Affordability gate** | buy only if `balance ≥ next stake`; otherwise shrink stake to the affordable amount (if still ≥ $0.35) | no order can ever exceed the account |
| **Clean stop** | if balance < $0.35 → one ⛔ notification, then idle (no error-restart loop) | drained accounts stop gracefully |

A typical $2 session: lose at $0.35 (−0.35 > −0.70, continue, stake doubles to $0.70) →
either **win** (recovers the loss ≈ +$0.63, take-profit +$0.10 hit → session closes green) or
**lose again** (−1.05 ≤ −0.70 → stop-loss ends it). Note the take-profit (5% = $0.10) is
smaller than one win's profit on a $2 account, so **any single win ends the session** — raise
the `0.05` in Initialization if you want longer runs (e.g. `0.15` ≈ three wins).

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

The **Trend Robot** uses the same gate plus a **minimum entry score of 90** (editable in
*Strategy settings*): a market that is 4/4 but scores below 90 is shown in the table as
*4/4 but score X < 90* and **no buy happens**.

**Run it:** open **`https://mwanzajerry14-bit.github.io/Deriv-bot/`** and press *Scan markets* —
or double-click the downloaded `Best_Market_Analyzer.html` in Chrome. It connects from *your*
browser straight to Deriv's public WebSocket API (no login — current endpoint
`wss://api.derivws.com/trading/v1/options/ws/public`, with the legacy `ws.derivws.com` /
`ws.binaryws.com` hosts kept as automatic fallbacks; Deriv retired the legacy hosts in 2026,
which is exactly what the first failure banners were reporting).
If a scan fails, the red panel runs an automatic **per-endpoint connection test** (WebSocket
reachability per host vs plain HTTPS) and tells you what to try — usually an ad-block/VPN
extension, a different network (phone hotspot), or `status.deriv.com`.

**What it measures per market** (last 30 closed 1-min candles + last 100 ticks — the same
data your bot's scanner reads):

| Metric | Weight | Why it matters here |
|---|---|---|
| Trend persistence | 25% | Adjacent candles closing the same direction — the bot's side rule fires more often |
| Candle strength | 20% | % of candles passing the bot's own ≥0.3 body/range test |
| Directional efficiency | 20% | Net travel ÷ path — price actually going somewhere for 5-tick contracts |
| Tick-stream momentum | 15% | How persistently the bot's 10-tick check has held over 100 ticks |
| Volatility (avg range %) | 20% | 5-tick contracts need movement; rank-based so units never skew it |

Scores are weighted percentile ranks (0–100). Each row carries two live badges mirroring the
bots' exact entry checks: **RF** (`CALL · BOT-READY 4/4` = the Rise/Fall bot would take that
market right now) and **EO** (`EO EVEN · READY 8/10` = the Even/Odd parity gate passes).
Your current market (**R_10**) is highlighted, the hero card tells you the #1 market and
exactly what to set in **Trade parameters → Market**. Auto-refreshes every 60s.

## Trend Robot (`Trend_Robot.html`) — auto-trades the moment a trend qualifies

The analyzer *tells* you when a market is BOT-READY 4/4 — the robot **acts on it**. It runs
your bots' exact same engine in the browser: public WSS sweep over **every Volatility index**
(default every 5 s), the identical 4-check trend gate, and the identical money rules
(2%→4%→8% cap with the $0.35/$0.70 floors, TP +5%, **SL −5%**, cooldown, one trade at a time;
the XML bots on bot.deriv.com keep their original SL −10%). Sweep runs in parallel every 2.5 s,
entries require 4/4 **and** score ≥ 90, two losing sessions in a row trigger a 60s bleed-guard
pause, and a persistent *Balance peak* stat warns when you arm ≥10% below peak.

**How to run it (demo first):**

1. Open `https://mwanzajerry14-bit.github.io/Deriv-bot/Trend_Robot.html` (or the local file).
2. **Connect & scan** — needs no token; the live table shows every market's score and RF badge.
3. Create an API token at Deriv → *Settings → API tokens* → permissions **Read + Trade**.
4. Paste it (account stays on **Demo** by default), press **Arm auto-trade**. The robot then
   buys the **first** market that hits 4/4 (highest score if several qualify in one sweep) —
   CALL or PUT per the closed-candle side — with the next stake from the same escalation.
5. Big red **STOP** disarms instantly and never places new entries (any open contract still
   settles normally). The journal records every signal, proposal, buy and settlement.

**How authentication works** (verified against Deriv's current API): the robot opens the
options WebSocket and sends a plain **`authorize` with your token — no App ID, OTP or
registration required** (the new API forbids `app_id` on that socket entirely). It picks the
demo/real account from the token's account list, subscribes to balance, then trades on the same
session (`proposal` with `underlying_symbol` → `buy: {token, price}` → `proposal_open_contract`
for settlement). A REST + OTP flow is kept as automatic fallback for registered (non-legacy)
App IDs. The token is stored only in your browser's localStorage (revoke it anytime). All
errors print **verbatim** in the robot journal. The REST fallback rejects *legacy* App IDs
(like `1089`) with `401 Invalid application` — that path needs a PAT-type app registered at
`developers.deriv.com`, but you should not need it in direct mode.

**Safety rails:** arm is blocked without a token; default account is Demo; balance < $0.35
auto-disarms (⛔); TP/SL close the session (🎯/🛑); one open contract at a time; unknown
settlement after 60 s → auto-stop for manual check; proposal/buy errors (market closed,
insufficient balance) return to scanning with a 5 s penalty instead of retry-spamming.

---

## Important risk notes

- Loss-streak escalation is a **martingale-style** system: a long losing streak risks a large share of the balance (bounded by the 8% cap and the −10% stop-loss, but still). Run it on **demo first** and watch a full session before ever using real money.
- The scanner filters *when* the bot fires, it does not predict: requiring 4/4 alignment makes entries rarer but higher-conviction setups. No signal wins all the time — the protection still comes from the cap + session limits, not from prediction.
- The tick-stream check (block `ticks` → `in list … # from end`) reads the last-1000-tick list each attempt; if Deriv ever changes that block you'll see it immediately on import — the file validates against their official block definitions.
- The bot only holds **one open contract at a time** and stops itself at TP/SL; it will not trade again until you press Run.
- Minimum recommended balance ≈ **$25** so that 2% stays above the $0.35 minimum stake (the bot auto-floors to $0.35 below that).
