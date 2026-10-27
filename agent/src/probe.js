// Read-only check against HSK Chain mainnet: pools, live prices, TWAPs, CEX spreads, a real quote.
// Needs no wallet.   npm run probe
import { HSK } from "./config.js";
import { LiveFeed } from "./feeds.js";
import { fmtPrice } from "./math.js";
import { parseUnits, formatUnits } from "viem";

const feed = new LiveFeed();
await feed.init();
const snap = await feed.snapshot();
console.log("\nHSKSwap V3 pools on HSK Chain (chain 177)\n");
for (const m of Object.values(snap)) {
  console.log(
    `${m.symbol.padEnd(5)} dex ${fmtPrice(m.dexPrice).padStart(10)}  twap ${fmtPrice(m.twapPrice).padStart(10)}${m.twapOk ? "" : " (oracle warming up)"}  cex ${fmtPrice(m.cexPrice).padStart(10)} (${m.cexSource || "n/a"})  spread ${Number.isFinite(m.spread) ? (m.spread * 100).toFixed(2) + "%" : "–"}`
  );
}
const out = await feed.quote(HSK.tokens.USDT.address, HSK.tokens.WHSK.address, parseUnits("100", 6));
console.log(`\nQuoterV2: 100 USDT -> ${Number(formatUnits(out, 18)).toFixed(2)} HSK on HSKSwap`);
console.log(`Block explorer: ${HSK.explorer}\n`);
