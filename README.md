# BTC Race 24h — V-bottom + regime-gated trend bot

Long-only 1-minute cbBTC/USDC trading bot for the make.fun competition
`btc-race-24h-20261113-2314`. Starts with $1,000 paper USDC, trades the
Orca cbBTC/USDC pool replay bar by bar.

## Strategy

Two entry modules share one position:

1. **V-bottom** (always active): a sharp fall arms the bot (15-min return
   below −0.70%); it buys when the 5-min return then bounces above +0.40%
   with the close above EMA(8). Catches capitulation wicks that snap back.
2. **Trend** (regime-gated): only when the price is above EMA(60) and
   EMA(60) has risen at least 0.50% over 60 bars does an EMA(8) cross above
   EMA(21) buy. Never fires on a downtrend/chop day, so it cannot hurt the
   dev gate; on a strong uptrend day it rides the trend.

Exits (any one sells the whole position): trailing stop 0.30% below the peak
value (0.50% for trend entries), hard stop 1.00% below cost, take-profit
1.20% above cost, a 60-bar hold timeout, or (trend entries only) an EMA
cross back down.

## Dev-window result (verified with the kit's own grader)

- Net PnL: **+$9.20** on the 24h dev window (passes the dev gate, > $0)
- Trades: 4 (2 round trips), fees $1.61, max drawdown 0.52%, win rate 50%
- `grade-local --driver process`: status finished, L1 reproduced true
- The house baselines all lose on the same window (ema-cross −$109.38,
  buy-and-hold −$52.59, rsi-bollinger −$65.83)

## Run

The grader runs `node /bot/main.ts`. Standard library only; the protocol
shim is vendored byte-identical under `vendor/` from the kit's SDK.
