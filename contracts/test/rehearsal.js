// Local rehearsal of scripts/testnet-proof.js: puts mock contracts at the real testnet addresses.
//   REHEARSAL=1 npx hardhat run test/rehearsal.js
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const T = require("../scripts/hsk").testnet;

async function place(addr, factory, args = []) {
  const c = await (await ethers.getContractFactory(factory)).deploy(...args);
  await network.provider.send("hardhat_setCode", [addr, await ethers.provider.getCode(await c.getAddress())]);
  return ethers.getContractAt(factory, addr);
}

async function main() {
  const [owner, agent] = await ethers.getSigners();
  process.env.AGENT_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // hardhat account #1
  const usdt = await place(T.tokens.USDT.address, "MockERC20", ["Test USDT", "USDT", 18]);
  await place(T.tokens.WHSK.address, "MockWETH");
  const pool = await place(T.pools.WHSK, "MockV3Pool", [T.tokens.WHSK.address, T.tokens.USDT.address, 3000]);
  const router = await place(T.hskswap.swapRouter02, "MockSwapRouter02");
  // the real testnet pool prices ~50 test USDT per WHSK (both 18 decimals)
  const tick = Math.round(Math.log(50) / Math.log(1.0001)) * ((await pool.token0()) === T.tokens.WHSK.address ? 1 : -1);
  await pool.setBoth(tick);
  await router.setPool(T.tokens.WHSK.address, T.tokens.USDT.address, 3000, T.pools.WHSK);
  if (process.env.PRE_USDT) await usdt.mint(owner.address, ethers.parseEther("2.4"));

  const vault = await (await ethers.getContractFactory("KavachVault")).deploy(T.tokens.USDT.address, T.hskswap.swapRouter02, agent.address, T.policy);
  await vault.setMarket(T.tokens.WHSK.address, T.pools.WHSK, true);
  const dep = path.join(__dirname, "..", "deployments", "hsk-testnet.json");
  const backup = fs.existsSync(dep) ? fs.readFileSync(dep) : null;
  fs.mkdirSync(path.dirname(dep), { recursive: true });
  fs.writeFileSync(dep, JSON.stringify({ vault: await vault.getAddress() }));
  try {
    require("../scripts/testnet-proof.js");
    await new Promise((r) => setTimeout(r, 8000));
  } finally {
    if (backup) fs.writeFileSync(dep, backup);
    else fs.unlinkSync(dep);
    const proof = path.join(__dirname, "..", "deployments", "hsk-testnet-proof.json");
    if (fs.existsSync(proof)) fs.unlinkSync(proof);
  }
}
main();
