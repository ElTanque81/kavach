// Real HSK Chain mainnet (chain 177) addresses, read from the HSKSwap app bundle and verified on-chain
// on 2026-10-27 (factory()/WETH9() calls, getPool() lookups, live slot0/liquidity).
module.exports = {
  chainId: 177,
  explorer: "https://hsk.blockscout.com",
  hskswap: {
    v3Factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
    swapRouter02: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
    quoterV2: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
    positionManager: "0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5",
  },
  tokens: {
    USDT: { address: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029", decimals: 6 },
    USDC: { address: "0x054ed45810DbBAb8B27668922D110669c9D88D0a", decimals: 6 },
    WHSK: { address: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1", decimals: 18 },
    WETH: { address: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0", decimals: 18 },
    WBTC: { address: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14", decimals: 8 },
  },
  // HSKSwap V3 pools against USDT, 0.3% fee tier (the ones with real liquidity)
  pools: {
    WHSK: "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc",
    WETH: "0xb92b79ed6b370d5cfee2e14b1d0983c258304c16",
    WBTC: "0xd9ea2ce468957ba49ccc38c4758ed6ecd561449a",
  },
  policy: {
    maxPositionBps: 2000, // 20% of equity per position
    maxExposureBps: 6000, // 60% of equity in positions at most
    maxDailyLossBps: 500, // stop opening after -5% in a day
    maxSlippageBps: 100, // agent fills floored at TWAP - 1%
    maxStopSlippageBps: 300, // keeper stop fills floored at TWAP - 3% (fast markets)
    minStopTicks: 100, // stop-loss mandatory: at least 1% ...
    maxStopTicks: 800, // ... at most ~8% below entry
    maxTakeProfitTicks: 2500,
    maxTwapDeviationTicks: 60, // no agent trading while spot is >0.6% away from TWAP
    keeperRewardBps: 20, // 0.2% to whoever executes a stop
    twapWindow: 600, // 10-minute TWAP
    cooldown: 60,
    heartbeatTimeout: 3600, // dead-man switch after 1h of agent silence
  },
};

// HSK Chain testnet (chain 133): HSKSwap testnet deployment, verified on-chain on 2026-10-27
// (router02.factory() == v3Factory, router02.WETH9() == WHSK, WHSK/USDT 0.3% pool with liquidity).
module.exports.testnet = {
  chainId: 133,
  explorer: "https://testnet-explorer.hskchain.net",
  hskswap: {
    v3Factory: "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
    swapRouter02: "0xa6914E66690c6794244B5f66a09eAEbf66254237",
    quoterV2: "0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC",
    positionManager: "0x73dEc6bfa6751509b08480bd97f54b874E3b20e8",
  },
  tokens: {
    USDT: { address: "0x98B6173A8B7DFc52ce8bc88f1184a918A1CCaa4F", decimals: 18 },
    WHSK: { address: "0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6", decimals: 18 },
  },
  pools: {
    WHSK: "0xc076fb478b77633736738579c7f48d2539604a50",
  },
  // same rules as mainnet, with short timers so the dead-man switch can be shown live
  policy: {
    ...module.exports.policy,
    maxTwapDeviationTicks: 200,
    twapWindow: 60, // 1-minute TWAP
    heartbeatTimeout: 300, // dead-man switch after 5 minutes (contract minimum)
  },
};
