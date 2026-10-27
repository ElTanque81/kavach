# DoraHacks submission texts (copy & paste)

## BUIDL name
KAVACH

## One-liner (≤ 120 chars)
An AI trading agent for HSKSwap whose stop-losses live on-chain, so they keep working even when the AI crashes.

## Track
AI Agent Trading

## Description

**Problem.** AI trading agents fail in ordinary ways: the process crashes, the server reboots, the model hallucinates. In almost every agent today the stop-loss is code inside that same process. When the agent dies, the protection dies with it, usually exactly when the market moves.

**Solution.** KAVACH splits the agent into a brain and a parachute. The brain (off-chain) scans HSKSwap and centralized exchanges, scores spreads and momentum, sizes trades and talks to the user in natural language. The parachute is `KavachVault`, a contract on HSK Chain mainnet: every position the AI opens is born with a stop-loss and take-profit stored on-chain. When the pool's TWAP crosses either, *anyone* can execute it via `keeperClose()` and earn a 0.2% reward. If the agent stops sending heartbeats, anyone can unwind all positions to USDT and the vault pauses itself. In our demo we kill the AI process and crash the market; a public keeper still closes the position on-chain.

**How it works**
- Trades the real HSKSwap V3 pools (WHSK, WETH, WBTC vs USDT) through HSKSwap's SwapRouter02; paper mode uses HSKSwap's QuoterV2 for real fill estimates.
- Triggers use the pool's own 10-minute TWAP, so flash-loan dumps can't fire a stop; every fill is floored against the TWAP (agent −1%, keeper −3%), so a sandwich can only delay a stop.
- On-chain policy: max 20% per position, 60% exposure, −5% daily loss halt, mandatory stop between 1% and 8%, cooldown, spot/TWAP deviation guard. The agent can trail a stop up but never loosen it, and can never withdraw.
- Agent council: Scout (HSKSwap + Binance/OKX/Bybit/Gate prices), Quant (DEX/CEX spread capture, EMA momentum, RSI, volatility), Risk Officer (volatility-based sizing and stops, veto), optional LLM Strategist (may only shrink or reject), Executor (logs decisions on-chain as heartbeats).
- Natural-language control in English and German: "how am I doing?", "be more careful", "stop-loss 3%", "only ETH", "close everything". The chat can only move the agent inside the on-chain policy.
- Dashboard with live positions shown as a rail between stop and take-profit, council feed, dead-man countdown and a one-click crash test.

**Quality**
- 20 Hardhat tests (limits, TWAP triggers, sandwich floor, dead-man switch, trailing stops, daily loss, owner exit).
- Uniswap TickMath ported to Solidity 0.8, constants verified at 120-digit precision and against a live `slot0` from HSK Chain mainnet.
- Three run modes: sim (offline), paper (live prices, no tx), live (mainnet).

**Deployed on HSK Chain mainnet**
- KavachVault: `0x…` (fill in) – https://hsk.blockscout.com/address/0x…
- Deploy tx: https://hsk.blockscout.com/tx/0x…

**Links**
- GitHub: https://github.com/ElTanque81/kavach
- Demo video: (YouTube link)

## Demo video script (≈ 2:30)

1. **0:00 – Hook.** "Every AI trading agent has a weak spot: its stop-loss lives in the same process as the AI. Kill the process and the protection is gone. KAVACH moves the stop-loss on-chain."
2. **0:20 – Dashboard.** Show markets: HSKSwap price vs CEX price, spread, TWAP. "The agent trades the real HSKSwap V3 pools on HSK Chain."
3. **0:45 – Council.** Point at the feed: Scout → Quant → Risk Officer approving size, stop and take-profit "enforced on-chain". Show a position rail between stop and take-profit.
4. **1:10 – Chat.** Type "Wie läuft es?" then "be more careful, stop-loss 3%". Then "position 30%" → the agent replies that the contract caps it at 20%.
5. **1:35 – Crash test.** Press the button: the AI dies (red light), the market drops 6%, the dead-man countdown runs, and a public keeper executes the stop-loss. "The AI was dead. The contract still protected the money."
6. **2:05 – Proof.** Show the vault on hsk.blockscout.com, the contract code `keeperClose`, and the test run (`npx hardhat test`, 20 passing).
7. **2:25 – Close.** "KAVACH: the AI decides, the chain protects."

## Pitch (Demo Day, 3 minutes) – key lines
- "Agents will fail. The question is what happens to the money when they do."
- "Three things the AI can never do: loosen a stop, exceed its size limits, touch the withdraw button."
- "Anyone can execute our stops for a reward. No server of ours needs to be up."
- Next steps: HSP integration so the agent pays for its own data feeds under the same limits (Track 2 bridge), Chainlink price feeds as a second oracle, vault templates others can copy.
