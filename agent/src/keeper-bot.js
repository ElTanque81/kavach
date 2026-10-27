// Public keeper: ANYONE can run this with any wallet that holds a little HSK for gas.
// It watches a KavachVault and executes triggered stop-losses, take-profits and dead-man unwinds,
// earning the vault's keeper reward. This is what makes the AI's risk limits survive the AI.
//
//   KEEPER_PRIVATE_KEY=0x... KAVACH_VAULT=0x... node src/keeper-bot.js
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, VAULT_ABI } from "./config.js";
import { LiveFeed, hskChain } from "./feeds.js";
import { decodeError } from "./vaults.js";

const REASONS = ["", "AGENT", "OWNER", "STOP_LOSS", "TAKE_PROFIT", "DEAD_MAN"];
const key = process.env.KEEPER_PRIVATE_KEY;
if (!config.vault) throw new Error("Set KAVACH_VAULT");
if (!key) throw new Error("Set KEEPER_PRIVATE_KEY (any wallet with a little HSK for gas)");

const feed = new LiveFeed();
const pub = feed.client;
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: hskChain, transport: http(config.rpcUrl) });
const read = (functionName, args = []) => pub.readContract({ address: config.vault, abi: VAULT_ABI, functionName, args });

console.log(`keeper ${account.address} watching vault ${config.vault}`);

async function sweep() {
  const ids = await read("openPositionIds");
  const dead = await read("isDeadManTriggered");
  for (const id of ids) {
    const [status, priceTick] = await read("keeperStatus", [id]);
    if (Number(status) === 0) continue;
    console.log(`#${id} triggered: ${REASONS[Number(status)]} (price tick ${priceTick})${dead ? " [dead-man]" : ""}`);
    try {
      const { request } = await pub.simulateContract({ address: config.vault, abi: VAULT_ABI, functionName: "keeperClose", args: [id], account });
      const hash = await wallet.writeContract(request);
      const rc = await pub.waitForTransactionReceipt({ hash });
      console.log(`  closed: ${rc.status}  ${config.explorer}/tx/${hash}`);
    } catch (e) {
      console.log(`  not executed: ${decodeError(e)}`);
    }
  }
}

for (;;) {
  await sweep().catch((e) => console.log("sweep error:", e.shortMessage || e.message));
  await new Promise((r) => setTimeout(r, Number(process.env.KEEPER_INTERVAL_MS || 15000)));
}
