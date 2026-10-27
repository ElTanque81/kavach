import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const require = createRequire(import.meta.url);
export const HSK = require(path.join(ROOT, "contracts", "scripts", "hsk.js"));
export const VAULT_ABI = JSON.parse(fs.readFileSync(path.join(here, "abi", "KavachVault.json"), "utf8"));

let deployment = null;
try {
  deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts", "deployments", "hsk-mainnet.json"), "utf8"));
} catch {
  /* not deployed yet */
}

const env = process.env;
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  mode: (env.MODE || "sim").toLowerCase(), // sim | paper | live
  port: num(env.PORT, 8787),
  rpcUrl: env.HSK_RPC_URL || "https://mainnet.hsk.xyz",
  vault: env.KAVACH_VAULT || deployment?.vault || null,
  deployTx: deployment?.deployTx || null,
  agentKey: env.AGENT_PRIVATE_KEY || null,
  tickMs: num(env.TICK_MS, env.MODE === "sim" || !env.MODE ? 1500 : 20000),
  // sim: seconds of market time that pass per tick (so the dead-man switch can be shown live)
  simSecondsPerTick: num(env.SIM_SECONDS_PER_TICK, 60),
  markets: ["WHSK", "WETH", "WBTC"],
  llm: {
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    anthropicModel: env.ANTHROPIC_MODEL || "claude-haiku-5-5",
    baseUrl: env.LLM_BASE_URL || null, // any OpenAI-compatible endpoint
    apiKey: env.LLM_API_KEY || null,
    model: env.LLM_MODEL || null,
  },
  dataDir: path.join(ROOT, "agent", "data"),
  explorer: HSK.explorer,
};

export const DISPLAY = { WHSK: "HSK", WETH: "ETH", WBTC: "BTC" };
