// Deploys KavachVault to HSK Chain (mainnet or testnet) against the real HSKSwap V3 router and pools.
//
//   npx hardhat run scripts/deploy.js --network hskTestnet   (testnet, chain 133)
//   npx hardhat run scripts/deploy.js --network hsk
//   DRY_RUN=1 npx hardhat run scripts/deploy.js --network hsk   (checks everything, sends nothing)
//
// Needs in ../.env : DEPLOYER_PRIVATE_KEY (the owner wallet) and AGENT_ADDRESS (the agent's hot wallet).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const MAINNET = require("./hsk");

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)",
  "function observe(uint32[]) view returns (int56[],uint160[])",
  "function increaseObservationCardinalityNext(uint16)",
];

async function main() {
  const dry = !!process.env.DRY_RUN;
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const HSK = Number(chainId) === 133 ? MAINNET.testnet : MAINNET;
  if (Number(chainId) !== HSK.chainId) throw new Error(`Unknown chain ${chainId}`);

  const agent = process.env.AGENT_ADDRESS;
  if (!agent || !ethers.isAddress(agent)) throw new Error("Set AGENT_ADDRESS in .env (the agent's own wallet address)");

  console.log(`network      ${network.name} (chain ${chainId})`);
  console.log(`owner        ${deployer.address}`);
  console.log(`agent        ${agent}`);
  console.log(`balance      ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} HSK`);

  // ---- sanity-check the pools we are about to whitelist
  const usdt = HSK.tokens.USDT.address.toLowerCase();
  for (const [sym, addr] of Object.entries(HSK.pools)) {
    const pool = new ethers.Contract(addr, POOL_ABI, ethers.provider);
    const [t0, t1, fee, liq, slot0] = await Promise.all([pool.token0(), pool.token1(), pool.fee(), pool.liquidity(), pool.slot0()]);
    const base = HSK.tokens[sym].address.toLowerCase();
    const okPair = [t0.toLowerCase(), t1.toLowerCase()].sort().join() === [base, usdt].sort().join();
    let twapOk = true;
    try {
      await pool.observe([HSK.policy.twapWindow, 0]);
    } catch {
      twapOk = false;
    }
    console.log(
      `pool ${sym.padEnd(5)} ${addr} pair=${okPair ? "ok" : "MISMATCH"} fee=${fee} liq=${liq} card=${slot0[3]}/${slot0[4]} twap(${HSK.policy.twapWindow}s)=${twapOk ? "ok" : "not yet"}`
    );
    if (!okPair) throw new Error(`pool ${sym} does not match its tokens`);
    if (Number(slot0[4]) < 16 && !dry) {
      console.log(`  -> raising observation cardinality of ${sym} pool to 16 (one-time, makes the TWAP robust)`);
      await (await pool.connect(deployer).increaseObservationCardinalityNext(16)).wait();
    }
  }

  if (dry) {
    console.log("\nDRY_RUN: configuration looks good, nothing was sent.");
    return;
  }

  // ---- deploy
  const Vault = await ethers.getContractFactory("KavachVault");
  const vault = await Vault.deploy(HSK.tokens.USDT.address, HSK.hskswap.swapRouter02, agent, HSK.policy);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  const deployTx = vault.deploymentTransaction().hash;
  console.log(`\nKavachVault  ${vaultAddr}\n  tx ${HSK.explorer}/tx/${deployTx}`);

  for (const [sym, pool] of Object.entries(HSK.pools)) {
    const tx = await vault.setMarket(HSK.tokens[sym].address, pool, true);
    await tx.wait();
    console.log(`market ${sym} enabled  ${HSK.explorer}/tx/${tx.hash}`);
  }

  const out = {
    network: HSK.chainId === 133 ? "hsk-testnet" : "hsk-mainnet",
    chainId: Number(chainId),
    vault: vaultAddr,
    owner: deployer.address,
    agent,
    deployTx,
    deployedAt: new Date().toISOString(),
    router: HSK.hskswap.swapRouter02,
    quoter: HSK.hskswap.quoterV2,
    pools: HSK.pools,
    tokens: HSK.tokens,
    policy: HSK.policy,
  };
  const file = path.join(__dirname, "..", "deployments", HSK.chainId === 133 ? "hsk-testnet.json" : "hsk-mainnet.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file}`);
  console.log(`Explorer: ${HSK.explorer}/address/${vaultAddr}`);
  console.log(HSK.chainId === 133 ? "\nNext: npx hardhat run scripts/testnet-proof.js --network hskTestnet" : `\nNext: put KAVACH_VAULT=${vaultAddr} into .env and start the agent.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
