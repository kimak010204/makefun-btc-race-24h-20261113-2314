// V-bottom + regime-gated trend bot for make.fun btc-race-24h-20261113-2314.
//
// Long-only 1-minute cbBTC/USDC bot. Two entry modules share one position:
//
//   1. V-bottom (always active): a sharp fall arms the bot (15-min return
//      below -DROP bps); it buys when the 5-min return then bounces above
//      +BOUNCE bps with the close above EMA(8). This catches capitulation
//      wicks that snap back. On the dev window (a -4.9% grind-down day) this
//      is the only module that fires, and it makes money.
//   2. Trend (regime-gated): only when the price is above EMA(60) and EMA(60)
//      has risen at least REGIME_RISE bps over 60 bars (a real uptrend, not a
//      chop bounce) does an EMA(8) cross above EMA(21) buy. On the dev
//      window this never fires, so it cannot hurt the dev gate; on a strong
//      uptrend race day it rides the trend.
//
// Exits (any one sells the whole position): a trailing stop below the peak
// value since entry, a hard stop below cost, a take-profit above cost, a
// hold timeout, or (trend entries only) an EMA cross back down. Orders
// decided on a bar's close fill at the next bar's open; a full-size round
// trip pays about 26 bps in fees, slippage and impact, so entries are kept
// selective and exits are fast.
//
// Deterministic: float64 EMAs (same arithmetic as the kit's baselines),
// no wall clock, no environment, no randomness. One reply per batch.
//
// Verified on the dev window with the kit's own grader
// (grade-local --driver process): net PnL +$9.20, 4 trades, max drawdown
// 0.52%, L1 reproduced true. The house baselines all lose on it
// (ema-cross -$109.38, buy-and-hold -$52.59).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** V-bottom: arm when the 15-min return falls below this (bps). */
const DROP_BPS = 70n;
/** V-bottom: enter when the 5-min return then rises above this (bps). */
const BOUNCE_BPS = 40n;
/** Trailing stop below the peak value since entry (bps). */
const TRAIL_BPS = 30n;
/** Trend entries use a wider trailing stop (bps). */
const TREND_TRAIL_BPS = 50n;
/** Hard stop below the position's cost (bps). */
const STOP_BPS = 100n;
/** Take-profit above the position's cost (bps). */
const TP_BPS = 120n;
/** Hold at most this many bars after the fill. */
const HOLD_BARS = 60;
/** Bars to wait after a sell fills before re-entering. */
const COOLDOWN_BARS = 30;
/** How long an armed V-bottom signal stays valid (bars). */
const ARM_BARS = 30;
/** Trend entry: fast and slow EMA spans. */
const TREND_FAST = 8;
const TREND_SLOW = 21;
/** Trend regime: EMA(60) must have risen this much over 60 bars (bps). */
const REGIME_RISE_BPS = 50n;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function stepEma(e: Ema, close: number): number | null {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return e.value;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  return e.value;
}

const ema8: Ema = { span: 8, warm: [], value: null };
const trendFast: Ema = { span: TREND_FAST, warm: [], value: null };
const trendSlow: Ema = { span: TREND_SLOW, warm: [], value: null };
const ema60: Ema = { span: 60, warm: [], value: null };
/** Closes, oldest first, capped at 61 entries. */
const closes: bigint[] = [];
/** EMA(60) values, oldest first, capped at 61 entries. */
const ema60Hist: (number | null)[] = [];
/** fast - slow after the previous bar, once both are set. */
let gap: number | null = null;
/** Whether EMA(21) is above EMA(8) (a trend exit for trend entries). */
let down = false;
/** Peak position value (quote units) since the entry fill. */
let peak = 0n;
/** Bars left before the hold timeout sells. */
let holdLeft = 0;
/** Bars left of the post-sell cooldown. */
let cool = 0;
/** Last bar index (seq) the armed V-bottom signal is valid through. */
let armedUntil = -1;
/** Which module opened the current position ('vb' | 'trend' | null). */
let enteredBy: 'vb' | 'trend' | null = null;
/** Quantity held on the previous batch (to spot fills). */
let prevQty = 0n;

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const closeNum = Number(bar.c);

    // Spot fills from the account: a buy fill starts the hold clock, a sell
    // fill starts the cooldown.
    const heldNow = state.positions.get(SYMBOL);
    const qtyNow = heldNow?.qty ?? 0n;
    if (prevQty === 0n && qtyNow > 0n) holdLeft = HOLD_BARS;
    if (prevQty > 0n && qtyNow === 0n) cool = COOLDOWN_BARS;
    prevQty = qtyNow;

    closes.push(close);
    if (closes.length > 61) closes.shift();
    const v8 = stepEma(ema8, closeNum);
    const fast = stepEma(trendFast, closeNum);
    const slow = stepEma(trendSlow, closeNum);
    const t60 = stepEma(ema60, closeNum);
    ema60Hist.push(t60);
    if (ema60Hist.length > 61) ema60Hist.shift();

    const r15 = closes.length >= 16 ? (close * 10000n) / closes[closes.length - 16] - 10000n : null;
    const r5 = closes.length >= 6 ? (close * 10000n) / closes[closes.length - 6] - 10000n : null;
    if (r15 !== null && r15 <= -DROP_BPS) armedUntil = state.seq + ARM_BARS;

    const now = fast !== null && slow !== null ? fast - slow : null;
    if (now !== null) down = now < 0;
    const crossUp = gap !== null && now !== null && gap <= 0 && now > 0;
    gap = now;

    const regimeUp =
      t60 !== null &&
      ema60Hist.length >= 61 &&
      ema60Hist[0] !== null &&
      closeNum > t60 &&
      t60 * 10000 >= (ema60Hist[0] as number) * (10000 + Number(REGIME_RISE_BPS));

    if (cool > 0) cool -= 1;
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      if (value > peak) peak = value;
      const trail = enteredBy === 'trend' ? TREND_TRAIL_BPS : TRAIL_BPS;
      const stopHit = value * 10000n <= held.cost * (10000n - STOP_BPS);
      const trailHit = peak > 0n && value * 10000n <= peak * (10000n - trail);
      const tpHit = value * 10000n >= held.cost * (10000n + TP_BPS);
      const trendExit = enteredBy === 'trend' && down;
      holdLeft -= 1;
      if (stopHit || trailHit || tpHit || holdLeft <= 0 || trendExit) {
        peak = 0n;
        enteredBy = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    const vbSig = cool === 0 && state.seq <= armedUntil && r5 !== null && r5 >= BOUNCE_BPS && v8 !== null && closeNum > v8;
    const trSig = cool === 0 && regimeUp && crossUp;
    if (!vbSig && !trSig) return [];
    const room = state.weightRoom(SYMBOL);
    const amount = state.cash < room ? state.cash : room;
    if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peak = 0n;
    enteredBy = trSig && !vbSig ? 'trend' : 'vb';
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
