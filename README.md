# KAVACH

**An AI trading agent whose stop-losses live on-chain, so they keep working when the AI doesn't.**

Built for the HSK Chain Horizon Hackathon (Mumbai edition), Track 1: AI Agent Trading.
*Kavach* (कवच) is Hindi for armour.

**Demo video:** https://youtu.be/ooxRfDhLhd0

---

## The problem

AI trading agents fail in boring ways: the process crashes, the server reboots, the API key runs out, the model hallucinates a trade. Today the stop-loss of almost every "AI agent" is a line of code inside that same process. When the agent dies, the protection dies with it, exactly when the market is moving.

## The idea

Split the agent in two:

| | Lives where | Can fail? |
|---|---|---|
| **The brain**: market scanning, signals, sizing, chat | off-chain Node.js process + optional LLM | yes, and that's fine |
| **The parachute**: limits, stop-loss, take-profit, dead-man switch | `KavachVault.sol` on HSK Chain mainnet | no server needed |

Every position the AI opens is born with a stop-loss and a take-profit **stored in the contract**. Once the pool's TWAP crosses either, **anyone** can call `keeperClose()` and earns a 0.2% reward for it. If the agent stops sending heartbeats for an hour, anyone can unwind every position to USDT and the vault pauses itself.

We show this live: the demo opens a position, **kills the AI process, crashes the market**, and a public keeper executes the stop-loss on-chain while the AI is dead.

## Live on HSK Chain testnet (chain 133)

| | |
|---|---|
| KavachVault | [`0x560295F23c699c97C35368B34FcFDFAD83780A2D`](https://testnet-explorer.hskchain.net/address/0x560295F23c699c97C35368B34FcFDFAD83780A2D) |
| Deploy | [tx](https://testnet-explorer.hskchain.net/tx/0x83849e1ffc6f4e1b7a89876598b002c3e2d4652492f47c95879ff26b48ba56e7) |
| Owner funds the vault | [deposit](https://testnet-explorer.hskchain.net/tx/0x12b85bd17779e3ccf940fce27341a65d86ddc606b444bc2c6a09c1ac481706b3) |
| **Agent** opens a WHSK position on HSKSwap, stop −1.5% / take-profit +3% stored on-chain | [openPosition](https://testnet-explorer.hskchain.net/tx/0x7a981cc48ee2d761c01de61475abe1ba9dd97df88d0dbf9dab3eda5bea4591eb) |
| Agent goes silent; 5 minutes later a **keeper** closes it via the dead-man switch, the vault pauses itself | [keeperClose → DEAD_MAN](https://testnet-explorer.hskchain.net/tx/0x55adb894239616e303689d923a0a01d832674839331c255482a189cf72b55f7e) |

No agent process was involved in the last transaction.

## What makes it robust

- **Trades real HSKSwap liquidity.** HSKSwap is a Uniswap V3 fork. KAVACH swaps through its SwapRouter02 on the real WHSK/USDT, WETH/USDT and WBTC/USDT 0.3% pools (verified on-chain: ~2.5M HSK + 223k USDT in the HSK pool).
- **Manipulation-resistant triggers.** Stops trigger on the pool's own 10-minute TWAP (`observe()`), so a flash-loan dump cannot fire them.
- **Sandwich floor.** Every fill is floored against the TWAP price: agent trades at TWAP − 1%, keeper stops at TWAP − 3%. A front-runner who dumps the pool before a stop just makes the stop wait.
- **The AI can never loosen its own risk.** It can trail a stop up, never down. It cannot withdraw. Position size (20%), total exposure (60%), daily loss (−5%), mandatory stop range (1–8%), cooldown and spot/TWAP deviation are all checked in `openPosition()`.
- **Exact on-chain math.** Uniswap's TickMath is ported to Solidity 0.8; all 20 constants were re-derived at 120-digit precision and the library is tested against a live `slot0` from HSK Chain mainnet.

## The agent

A council of five roles writes every decision into a readable feed (and, in live mode, into `Decision` events on-chain):

1. **Scout** reads HSKSwap pools (spot + TWAP) and reference prices from Binance / OKX / Bybit / Gate / Coinbase.
2. **Quant** scores each market: DEX/CEX spread (arbitrage-style spread capture), EMA momentum, RSI, realised volatility.
3. **Risk Officer** sizes the trade (volatility-scaled, defensive mode after losses), sets stop and take-profit from volatility, and vetoes anything the contract would reject.
4. **Strategist (LLM, optional)** may approve, shrink or reject a proposal, never enlarge it. Claude or any OpenAI-compatible model.
5. **Executor** sends the transaction; trails stops; logs `HOLD` decisions on-chain as heartbeats.

A separate **keeper bot** (`npm run keeper`) can be run by anyone.

**Chat control** in German or English: "How am I doing?", "be more careful", "stop-loss 3%", "only ETH and BTC", "close everything", "what just happened?". The chat moves the agent only inside the on-chain policy; asking for a 30% position answers that the contract caps it at 20% and only the owner wallet can change that.

## Run it

Requirements: Node 20+.

```bash
cp .env.example .env
cd agent && npm install
npm run sim      # offline demo with a simulated market → http://localhost:8787
npm run probe    # read-only check of the live HSKSwap pools, TWAPs and spreads
npm run paper    # live HSKSwap prices and QuoterV2 fills, no transactions
```

In the dashboard, press **Crash test** to watch the parachute open.

### Deploy to HSK Chain testnet (on-chain proof)

```bash
cd contracts && npm install
npx hardhat run scripts/deploy.js --network hskTestnet         # vault + WHSK/USDT market on testnet HSKSwap
npx hardhat run scripts/testnet-proof.js --network hskTestnet  # ~7 min, real transactions
```

The proof script funds the vault through HSKSwap, lets the **agent** open a position with an on-chain stop and take-profit, then the agent goes silent. After the 5-minute dead-man timeout a **keeper** closes the position with `keeperClose()` and the vault pauses itself. Every step prints an explorer link and is saved to `contracts/deployments/hsk-testnet-proof.json`.

### Deploy to HSK Chain mainnet

```bash
cd contracts && npm install
npx hardhat test                                            # 20 tests
DRY_RUN=1 npx hardhat run scripts/deploy.js --network hsk   # checks pools, sends nothing
npx hardhat run scripts/deploy.js --network hsk             # deploys + whitelists the 3 markets
AMOUNT=10 npx hardhat run scripts/deposit.js --network hsk  # optional: fund with 10 USDT
cd ../agent && npm run live
```

`.env` needs `DEPLOYER_PRIVATE_KEY` (owner), `AGENT_ADDRESS` and `AGENT_PRIVATE_KEY` (a separate hot wallet for the agent). Deployment costs a fraction of a cent in HSK gas.

## Contracts

| | Address (chain 177) |
|---|---|
| KavachVault | *see `contracts/deployments/hsk-mainnet.json` after deploy* |
| HSKSwap SwapRouter02 | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` |
| HSKSwap QuoterV2 | `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` |
| HSKSwap V3 Factory | `0x972cA9D1662F5e029cD18327D29026532E84c742` |
| WHSK/USDT pool | `0x4ff515761864e7838b0adb8b5b2b8b7a068905dc` |
| WETH/USDT pool | `0xb92b79ed6b370d5cfee2e14b1d0983c258304c16` |
| WBTC/USDT pool | `0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a` |

## Repository

```
contracts/   KavachVault.sol, TickMath port, mocks, 20 Hardhat tests, deploy + deposit scripts
agent/       feeds (HSKSwap + CEX), council, paper/chain vaults, chat, keeper bot, dashboard
demo/        self-contained replay of a recorded session (for judges without Node)
```

## Limitations

- Spot only (long or flat). No leverage, no shorting.
- The strategy is simple on purpose; the claim is not that the model is always right but that being wrong is bounded and enforced on-chain.
- A stop fills at TWAP − 3% at worst. In a gap larger than that, it waits until the TWAP catches up (like a stop-limit order); the owner can always close or withdraw.
- Pools with a short oracle history need `increaseObservationCardinalityNext` once; the deploy script does it.

MIT licensed.
