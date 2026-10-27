// Optional: fund the vault with a small amount of USDT for a live mainnet demo.
//   AMOUNT=10 npx hardhat run scripts/deposit.js --network hsk
// Real money: start small. The owner can withdraw at any time.
const { ethers } = require("hardhat");
const dep = require("../deployments/hsk-mainnet.json");

async function main() {
  const amount = ethers.parseUnits(process.env.AMOUNT || "10", 6);
  const [owner] = await ethers.getSigners();
  const usdt = new ethers.Contract(dep.tokens.USDT.address, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ], owner);
  const bal = await usdt.balanceOf(owner.address);
  if (bal < amount) throw new Error(`Only ${ethers.formatUnits(bal, 6)} USDT in ${owner.address}`);
  await (await usdt.approve(dep.vault, amount)).wait();
  const vault = await ethers.getContractAt("KavachVault", dep.vault, owner);
  const tx = await vault.deposit(amount);
  await tx.wait();
  console.log(`Deposited ${ethers.formatUnits(amount, 6)} USDT  https://hsk.blockscout.com/tx/${tx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
