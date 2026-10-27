// Market data: the live HSKSwap feed (paper + live mode) and a simulated market (sim mode).
import { createPublicClient, http, parseAbi } from "viem";
import { HSK, config } from "./config.js";
import { priceTickFromPoolTick, priceFromPriceTick, twapFromCumulatives, priceTickFromPrice } from "./math.js";

export const hskChain = {
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: HSK.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const TWAP_WINDOW = HSK.policy.twapWindow;
const QUOTE = HSK.tokens.USDT;

// ------------------------------------------------------------------ reference (CEX) prices

async function getJson(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "kavach-agent" } });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const CEX_SOURCES = {
  WETH: [
    async () => ({ src: "Binance", p: Number((await getJson("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT")).price) }),
    async () => ({ src: "OKX", p: Number((await getJson("https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT")).data[0].last) }),
    async () => ({ src: "Coinbase", p: Number((await getJson("https://api.coinbase.com/v2/prices/ETH-USD/spot")).data.amount) }),
  ],
  WBTC: [
    async () => ({ src: "Binance", p: Number((await getJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")).price) }),
    async () => ({ src: "OKX", p: Number((await getJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT")).data[0].last) }),
    async () => ({ src: "Coinbase", p: Number((await getJson("https://api.coinbase.com/v2/prices/BTC-USD/spot")).data.amount) }),
  ],
  WHSK: [
    async () => ({ src: "Bybit", p: Number((await getJson("https://api.bybit.com/v5/market/tickers?category=spot&symbol=HSKUSDT")).result.list[0].lastPrice) }),
    async () => ({ src: "Gate", p: Number((await getJson("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=HSK_USDT"))[0].last) }),
    async () => ({ src: "CoinGecko", p: Number((await getJson("https://api.coingecko.com/api/v3/simple/price?ids=hashkey-ecopoints&vs_currencies=usd"))["hashkey-ecopoints"].usd) }),
  ],
};

const cexCache = {};
async function cexPrice(sym) {
  const c = cexCache[sym];
  if (c && Date.now() - c.at < 10_000) return c;
  for (const f of CEX_SOURCES[sym] || []) {
    try {
      const r = await f();
      if (Number.isFinite(r.p) && r.p > 0) {
        cexCache[sym] = { ...r, at: Date.now() };
        return cexCache[sym];
      }
    } catch {
      /* try next source */
    }
  }
  return c || { src: null, p: NaN, at: 0 };
}

// ------------------------------------------------------------------ live HSKSwap feed

export class LiveFeed {
  constructor() {
    this.client = createPublicClient({ chain: hskChain, transport: http(config.rpcUrl, { timeout: 15_000 }) });
    this.meta = {};
    this.kind = "live";
  }

  async init() {
    for (const sym of config.markets) {
      const pool = HSK.pools[sym];
      const token0 = await this.client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" });
      this.meta[sym] = {
        pool,
        base: HSK.tokens[sym],
        baseIsToken0: token0.toLowerCase() === HSK.tokens[sym].address.toLowerCase(),
      };
    }
  }

  nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  async snapshot() {
    const out = {};
    await Promise.all(
      config.markets.map(async (sym) => {
        const m = this.meta[sym];
        const [slot0, liq, obs, cex] = await Promise.all([
          this.client.readContract({ address: m.pool, abi: POOL_ABI, functionName: "slot0" }),
          this.client.readContract({ address: m.pool, abi: POOL_ABI, functionName: "liquidity" }),
          this.client
            .readContract({ address: m.pool, abi: POOL_ABI, functionName: "observe", args: [[TWAP_WINDOW, 0]] })
            .catch(() => null),
          cexPrice(sym),
        ]);
        const spotPT = priceTickFromPoolTick(Number(slot0[1]), m.baseIsToken0);
        const twapPT = obs ? priceTickFromPoolTick(twapFromCumulatives(obs[0][0], obs[0][1], TWAP_WINDOW), m.baseIsToken0) : spotPT;
        const dex = priceFromPriceTick(spotPT, m.base.decimals, QUOTE.decimals);
        out[sym] = {
          symbol: sym,
          pool: m.pool,
          baseIsToken0: m.baseIsToken0,
          baseDecimals: m.base.decimals,
          spotPriceTick: spotPT,
          twapPriceTick: twapPT,
          twapOk: !!obs,
          dexPrice: dex,
          twapPrice: priceFromPriceTick(twapPT, m.base.decimals, QUOTE.decimals),
          cexPrice: cex.p,
          cexSource: cex.src,
          spread: Number.isFinite(cex.p) ? (dex - cex.p) / cex.p : NaN,
          liquidity: liq.toString(),
          ts: this.nowSec(),
        };
      })
    );
    return out;
  }

  /** Real fill estimate from HSKSwap's QuoterV2 (used for paper fills). */
  async quote(tokenIn, tokenOut, amountIn) {
    const { result } = await this.client.simulateContract({
      address: HSK.hskswap.quoterV2,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee: 3000, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  }
}

// ------------------------------------------------------------------ simulated market

/** Geometric random walk with regime changes and occasional DEX/CEX dislocations,
 *  so every agent behaviour (spread trades, stops, take-profits, dead-man) can be demoed offline. */
export class SimFeed {
  constructor(seed = 7) {
    this.kind = "sim";
    this.t = Math.floor(Date.now() / 1000);
    this.rand = mulberry32(seed);
    this.state = {
      WHSK: { p: 0.0886, vol: 0.0035, drift: 0, dex: 0.0886, dec: 18, baseIsToken0: true },
      WETH: { p: 2385, vol: 0.0022, drift: 0, dex: 2385, dec: 18, baseIsToken0: true },
      WBTC: { p: 80700, vol: 0.0016, drift: 0, dex: 80700, dec: 8, baseIsToken0: true },
    };
    this.history = { WHSK: [], WETH: [], WBTC: [] }; // [t, priceTick]
    this.shock = null;
  }

  async init() {
    // warm up ~2h of history so indicators and the TWAP are meaningful from the first tick
    for (let i = 0; i < 120; i++) this.step();
  }

  nowSec() {
    return this.t;
  }

  /** manual stress test from the dashboard */
  crash(sym = "WHSK", pct = -0.08) {
    this.shock = { sym, pct, steps: 6, total: 6 };
  }

  step() {
    this.t += config.simSecondsPerTick;
    for (const [sym, s] of Object.entries(this.state)) {
      if (this.rand() < 0.02) s.drift = (this.rand() - 0.5) * s.vol * 0.8; // regime change
      let r = s.drift + s.vol * gauss(this.rand);
      if (this.shock && this.shock.sym === sym && this.shock.steps > 0) {
        r += this.shock.pct / this.shock.total;
        this.shock.steps--;
      }
      s.p *= Math.exp(r);
      // CEX news moves first; the thinner on-chain pool follows with a lag -> tradable DEX/CEX spreads
      if (this.rand() < 0.035) s.p *= 1 + (this.rand() < 0.65 ? 1 : -1) * (0.006 + this.rand() * 0.009);
      s.dex += (s.p - s.dex) * 0.22;
      const pt = priceTickFromPrice(s.dex, s.dec, 6);
      this.history[sym].push([this.t, pt]);
      if (this.history[sym].length > 400) this.history[sym].shift();
    }
  }

  twapTick(sym) {
    const h = this.history[sym];
    const from = this.t - TWAP_WINDOW;
    // time-weighted average of the piecewise-constant tick path over the window
    let acc = 0;
    let span = 0;
    for (let i = h.length - 1; i >= 0; i--) {
      const [t, tick] = h[i];
      const tNext = i === h.length - 1 ? this.t : h[i + 1][0];
      const start = Math.max(t, from);
      if (tNext > start) {
        acc += tick * (tNext - start);
        span += tNext - start;
      }
      if (t <= from) break;
    }
    return span ? Math.floor(acc / span) : h[h.length - 1][1];
  }

  async snapshot() {
    this.step();
    const out = {};
    for (const [sym, s] of Object.entries(this.state)) {
      const spotPT = this.history[sym][this.history[sym].length - 1][1];
      const twapPT = this.twapTick(sym);
      const dex = priceFromPriceTick(spotPT, s.dec, 6);
      out[sym] = {
        symbol: sym,
        pool: HSK.pools[sym],
        baseIsToken0: s.baseIsToken0,
        baseDecimals: s.dec,
        spotPriceTick: spotPT,
        twapPriceTick: twapPT,
        twapOk: true,
        dexPrice: dex,
        twapPrice: priceFromPriceTick(twapPT, s.dec, 6),
        cexPrice: s.p,
        cexSource: "sim",
        spread: (dex - s.p) / s.p,
        liquidity: "sim",
        ts: this.t,
      };
    }
    return out;
  }
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
