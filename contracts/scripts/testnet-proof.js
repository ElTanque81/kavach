// On-chain proof on HSK Chain testnet, with real transactions:
//   1. owner wraps a little test HSK, swaps it to test USDT on HSKSwap and funds the vault
//   2. the AGENT opens a position through the vault (stop-loss + take-profit stored on-chain)
//   3. the agent goes silent; after the 5-minute dead-man timeout a KEEPER closes the position
//      with keeperClose() and the vault pauses itself - no agent, no server involved
//
//   npx hardhat run scripts/testnet-proof.js --network hskTestnet
//
// Needs test HSK (faucet) on the owner address (~0.6) and the agent address (~0.05).
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const T = require("./hsk").testnet;

const DEP = path.join(__dirname, "..", "deployments", "hsk-testnet.json");
const OUT = path.join(__dirname, "..", "deployments", "hsk-testnet-proof.json");
const GAS = { gasPrice: 2_000_000_000n, gasLimit: 3_000_000n };
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.REHEARSAL ? 0 : ms));
const link = (h) => `${T.explorer}/tx/${h}`;

/** testnet reads lag writes: poll until a condition holds (max ~60s) */
async function waitFor(read, ok, what) {
  for (let i = 0; i < 30; i++) {
    const v = await read();
    if (ok(v)) return v;
    if (i === 3) console.log(`    waiting for the testnet node to show: ${what}`);
    await sleep(2000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function countdown(seconds, label) {
  if (process.env.REHEARSAL) {
    // local rehearsal only: jump the chain clock instead of waiting
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
    return console.log(`  ${label}: skipped ${seconds}s (rehearsal)`);
  }
  for (let s = seconds; s > 0; s -= 15) {
    process.stdout.write(`\r  ${label}: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left   `);
    await sleep(Math.min(15, s) * 1000);
  }
  process.stdout.write("\n");
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(DEP, "utf8"));
  const [owner] = await ethers.getSigners();
  if (!process.env.AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY missing in .env");
  const agent = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, ethers.provider);
  const keeper = process.env.KEEPER_PRIVATE_KEY ? new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, ethers.provider) : owner;
  const vault = await ethers.getContractAt("KavachVault", dep.vault, owner);
  const proof = { network: "hsk-testnet", vault: dep.vault, explorer: T.explorer, steps: [] };
  const step = (name, hash, extra = {}) => {
    proof.steps.push({ name, tx: hash, link: link(hash), ...extra });
    console.log(`  ✓ ${name}\n    ${link(hash)}`);
  };

  const fmt = (x) => ethers.formatEther(x);
  console.log(`vault   ${dep.vault}`);
  console.log(`owner   ${owner.address}  ${fmt(await ethers.provider.getBalance(owner.address))} HSK`);
  console.log(`agent   ${agent.address}  ${fmt(await ethers.provider.getBalance(agent.address))} HSK`);
  console.log(`keeper  ${keeper.address}${keeper === owner ? " (the owner wallet acting as an outside keeper)" : ""}\n`);
  if ((await ethers.provider.getBalance(agent.address)) < ethers.parseEther("0.005")) {
    throw new Error("The agent wallet needs a little test HSK for gas (faucet).");
  }

  if (await vault.paused()) {
    const tx = await vault.setPaused(false);
    await tx.wait();
    step("owner un-pauses the vault from a previous run", tx.hash);
  }

  // ---- 1. fund the vault with test USDT bought on HSKSwap
  const usdt = new ethers.Contract(T.tokens.USDT.address, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"], owner);
  const [equity0] = await vault.equity();
  const usdtHeld = await usdt.balanceOf(owner.address);
  if (equity0 === 0n && usdtHeld > 0n) console.log(`1) Owner already holds ${Number(fmt(usdtHeld)).toFixed(2)} test USDT from an earlier run - skipping the swap`);
  if (equity0 === 0n && usdtHeld === 0n) {
    console.log("1) Funding the vault");
    const amount = ethers.parseEther(process.env.FUND_HSK || "0.5");
    const whsk = new ethers.Contract(T.tokens.WHSK.address, ["function deposit() payable", "function approve(address,uint256) returns (bool)"], owner);
    let tx = await whsk.deposit({ value: amount });
    await tx.wait();
    step(`wrap ${fmt(amount)} HSK -> WHSK`, tx.hash);
    tx = await whsk.approve(T.hskswap.swapRouter02, amount);
    await tx.wait();
    const router = new ethers.Contract(
      T.hskswap.swapRouter02,
      ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"],
      owner
    );
    tx = await router.exactInputSingle({ tokenIn: T.tokens.WHSK.address, tokenOut: T.tokens.USDT.address, fee: 3000, recipient: owner.address, amountIn: amount, amountOutMinimum: 0, sqrtPriceLimitX96: 0 });
    await tx.wait();
    step("swap WHSK -> USDT on HSKSwap", tx.hash);
  }
  if (equity0 === 0n) {
    const bal = await waitFor(() => usdt.balanceOf(owner.address), (v) => v > 0n, "the swapped USDT");
    let tx = await usdt.approve(dep.vault, bal);
    await tx.wait();
    await waitFor(() => usdt.allowance(owner.address, dep.vault), (v) => v >= bal, "the USDT approval");
    tx = await vault.deposit(bal);
    await tx.wait();
    step(`deposit ${Number(fmt(bal)).toFixed(2)} test USDT into the vault`, tx.hash);
    console.log("  waiting for the pool's TWAP to cover the swap");
    await countdown(75, "TWAP");
  } else {
    console.log(`1) Vault already funded: ${Number(fmt(equity0)).toFixed(2)} USDT`);
  }

  // ---- 2. the agent opens a position
  console.log("\n2) The AGENT opens a position");
  const [equity] = await waitFor(() => vault.equity(), (v) => v[0] > 0n, "the vault deposit");
  const size = (equity * 15n) / 100n;
  const reason = "KAVACH testnet proof: momentum entry, 15% of equity; stop-loss and take-profit enforced on-chain";
  const tx2 = await vault.connect(agent).openPosition(T.tokens.WHSK.address, size, 150, 300, reason, GAS);
  const rc2 = await tx2.wait();
  const id = Number((await waitFor(() => vault.positionsCount(), (v) => v > 0n, "the new position")) - 1n);
  step(`agent buys WHSK for ${Number(fmt(size)).toFixed(2)} USDT -> position #${id}`, tx2.hash, { gasUsed: rc2.gasUsed.toString() });
  await sleep(4000);
  const pos = await vault.positions(id);
  console.log(`    entry tick ${pos.entryPriceTick} · stop tick ${pos.stopPriceTick} (-1.5%) · take-profit tick ${pos.takeProfitPriceTick} (+3%)`);
  proof.position = { id, entry: Number(pos.entryPriceTick), stop: Number(pos.stopPriceTick), takeProfit: Number(pos.takeProfitPriceTick) };

  // ---- 3. the agent goes silent; a keeper unwinds after the dead-man timeout
  console.log("\n3) The agent goes silent now. Nobody touches the vault...");
  const timeout = Number((await vault.policy()).heartbeatTimeout);
  await countdown(timeout + 20, "dead-man switch");
  console.log(`   isDeadManTriggered = ${await vault.isDeadManTriggered()}`);
  const tx3 = await vault.connect(keeper).keeperClose(id, GAS);
  const rc3 = await tx3.wait();
  const ev = rc3.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "PositionClosed");
  const reasons = ["AGENT", "OWNER", "STOP_LOSS", "TAKE_PROFIT", "DEAD_MAN"];
  step(`keeper closes position #${id}: ${ev ? reasons[Number(ev.args.why)] : "?"}`, tx3.hash, {
    reason: ev ? reasons[Number(ev.args.why)] : null,
    keeperReward: ev ? fmt(ev.args.keeperReward) : null,
  });
  await sleep(4000);
  console.log(`    vault paused automatically: ${await vault.paused()}`);
  if (ev) console.log(`    keeper reward: ${Number(fmt(ev.args.keeperReward)).toFixed(4)} USDT · PnL ${Number(fmt(ev.args.pnl)).toFixed(4)} USDT`);

  fs.writeFileSync(OUT, JSON.stringify(proof, null, 2));
  console.log(`\nSaved ${OUT}\nVault: ${T.explorer}/address/${dep.vault}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
