// Price helpers. A "price tick" is the pool tick re-oriented so that higher = base worth more quote,
// exactly like KavachVault._priceTick(). 1 tick = 0.01%.

export const LN_1_0001 = Math.log(1.0001);

export function priceTickFromPoolTick(poolTick, baseIsToken0) {
  return baseIsToken0 ? poolTick : -poolTick;
}

export function poolTickFromPriceTick(priceTick, baseIsToken0) {
  return baseIsToken0 ? priceTick : -priceTick;
}

/** human price (quote per 1 base) from a price tick */
export function priceFromPriceTick(priceTick, baseDec, quoteDec) {
  return Math.pow(1.0001, priceTick) * Math.pow(10, baseDec - quoteDec);
}

export function priceTickFromPrice(price, baseDec, quoteDec) {
  return Math.round(Math.log(price / Math.pow(10, baseDec - quoteDec)) / LN_1_0001);
}

/** TWAP tick from two tick cumulatives, rounding toward -infinity like the contract */
export function twapFromCumulatives(cumOld, cumNew, window) {
  const delta = BigInt(cumNew) - BigInt(cumOld);
  const w = BigInt(window);
  let t = delta / w;
  if (delta < 0n && delta % w !== 0n) t -= 1n;
  return Number(t);
}

export function ema(values, period) {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** standard deviation of log returns (per sample) */
export function realizedVol(values, lookback = 30) {
  const v = values.slice(-lookback - 1);
  if (v.length < 3) return 0;
  const r = [];
  for (let i = 1; i < v.length; i++) r.push(Math.log(v[i] / v[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
export const fmtUsd = (x) =>
  Number.isFinite(x) ? (Math.abs(x) >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 0 }) : x.toFixed(2)) : "–";
export function fmtPrice(p) {
  if (!Number.isFinite(p)) return "–";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}
