// Two interchangeable vault back-ends with the same interface:
//   PaperVault - mirrors KavachVault's rules 1:1 in memory (sim + paper mode)
//   ChainVault - talks to the deployed KavachVault on HSK Chain (live mode)
import fs from "node:fs";
import path from "node:path";
import { createWalletClient, http, parseUnits, formatUnits, BaseError, ContractFunctionRevertedError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HSK, VAULT_ABI, config } from "./config.js";
import { hskChain } from "./feeds.js";
import { priceFromPriceTick } from "./math.js";

const FEE = 0.003;
const Q = HSK.tokens.USDT;
const REASONS = ["AGENT", "OWNER", "STOP_LOSS", "TAKE_PROFIT", "DEAD_MAN"];

/** value of `baseAmount` (human units) at a price tick, in USDT */
function valueAt(sym, baseAmount, priceTick) {
  return baseAmount * priceFromPriceTick(priceTick, HSK.tokens[sym].decimals, Q.decimals);
}

/** The same checks KavachVault.openPosition() performs, so the agent never sends a doomed tx. */
export function precheck({ policy, equity, exposure, dayStartEquity, paused, openCount, lastOpenAt, now }, m, quoteIn, stopTicks, tpTicks) {
  if (paused) return "VaultPaused";
  if (now < lastOpenAt + policy.cooldown) return `Cooldown (${lastOpenAt + policy.cooldown - now}s)`;
  if (openCount >= 8) return "TooManyPositions";
  if (stopTicks < policy.minStopTicks || stopTicks > policy.maxStopTicks) return "StopOutOfRange";
  if (!tpTicks || tpTicks > policy.maxTakeProfitTicks) return "TakeProfitOutOfRange";
  if (!m.twapOk) return "OracleNotReady";
  if (Math.abs(m.spotPriceTick - m.twapPriceTick) > policy.maxTwapDeviationTicks) return "TwapDeviation";
  if (dayStartEquity > 0 && equity < dayStartEquity) {
    const lossBps = ((dayStartEquity - equity) * 10000) / dayStartEquity;
    if (lossBps >= policy.maxDailyLossBps) return "DailyLossLimit";
  }
  if (quoteIn > (equity * policy.maxPositionBps) / 10000) return "PositionTooLarge";
  if (exposure + quoteIn > (equity * policy.maxExposureBps) / 10000) return "ExposureTooHigh";
  return null;
}

// ====================================================================== paper

export class PaperVault {
  constructor(feed, { startCash = 10_000, file } = {}) {
    this.feed = feed;
    this.kind = "paper";
    this.policy = { ...HSK.policy };
    this.file = file;
    this.s = {
      cash: startCash,
      positions: [],
      realizedPnl: 0,
      dayStart: 0,
      dayStartEquity: startCash,
      paused: false,
      lastHeartbeat: feed.nowSec(),
      lastOpenAt: 0,
      decisions: 0,
      fees: 0,
    };
    if (file && feed.kind !== "sim") this.load();
  }

  load() {
    try {
      Object.assign(this.s, JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      /* fresh book */
    }
  }

  save() {
    if (!this.file || this.feed.kind === "sim") return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.s, null, 1));
  }

  now() {
    return this.feed.nowSec();
  }

  open_() {
    return this.s.positions.filter((p) => p.open);
  }

  async state(snap) {
    const now = this.now();
    let exposure = 0;
    const positions = this.open_().map((p) => {
      const m = snap[p.sym];
      const value = valueAt(p.sym, p.baseAmount, m.twapPriceTick);
      exposure += value;
      return decorate(p, m, value);
    });
    const equity = this.s.cash + exposure;
    if (now >= this.s.dayStart + 86400) {
      this.s.dayStart = now - (now % 86400);
      this.s.dayStartEquity = equity;
    }
    return {
      kind: this.kind,
      cash: this.s.cash,
      equity,
      exposure,
      positions,
      closed: this.s.positions.filter((p) => !p.open).slice(-30).reverse(),
      realizedPnl: this.s.realizedPnl,
      dayStartEquity: this.s.dayStartEquity,
      paused: this.s.paused,
      lastHeartbeat: this.s.lastHeartbeat,
      lastOpenAt: this.s.lastOpenAt,
      deadManIn: this.s.lastHeartbeat + this.policy.heartbeatTimeout - now,
      now,
      policy: this.policy,
      openCount: positions.length,
    };
  }

  async open(sym, quoteIn, stopTicks, tpTicks, reason, snap) {
    const st = await this.state(snap);
    const m = snap[sym];
    const err = precheck(st, m, quoteIn, stopTicks, tpTicks);
    if (err) return { ok: false, error: err };

    // fill: real HSKSwap quote in paper mode, price minus fee and impact in sim mode
    let baseOut;
    if (this.feed.quote) {
      try {
        const raw = await this.feed.quote(Q.address, HSK.tokens[sym].address, parseUnits(quoteIn.toFixed(6), 6));
        baseOut = Number(formatUnits(raw, HSK.tokens[sym].decimals));
      } catch {
        /* fall back below */
      }
    }
    if (!baseOut) baseOut = (quoteIn * (1 - FEE) * (1 - 0.0008)) / m.dexPrice;
    const floor = ((quoteIn / m.twapPrice) * (1 - FEE) * (10000 - this.policy.maxSlippageBps)) / 10000;
    if (baseOut < floor) return { ok: false, error: "Too little received (slippage floor)" };

    const id = this.s.positions.length;
    const entry = m.twapPriceTick;
    this.s.positions.push({
      id,
      sym,
      baseAmount: baseOut,
      quoteIn,
      entryPriceTick: entry,
      stopPriceTick: entry - stopTicks,
      takeProfitPriceTick: entry + tpTicks,
      openedAt: this.now(),
      open: true,
      reason,
      fillPrice: quoteIn / baseOut,
    });
    this.s.cash -= quoteIn;
    this.s.fees += quoteIn * FEE;
    this.s.lastOpenAt = this.now();
    this.s.lastHeartbeat = this.now();
    this.s.decisions++;
    this.save();
    return { ok: true, id, baseOut, tx: null };
  }

  _close(p, m, why, rewardBps = 0, slippageBps = this.policy.maxSlippageBps) {
    const expected = valueAt(p.sym, p.baseAmount, m.twapPriceTick);
    const out = p.baseAmount * m.dexPrice * (1 - FEE) * (1 - 0.0008);
    const floor = (expected * (1 - FEE) * (10000 - slippageBps)) / 10000;
    if (out < floor) return { ok: false, why, error: "spot is too far below the TWAP - waiting (anti-sandwich floor)" };
    const reward = (out * rewardBps) / 10000;
    const pnl = out - reward - p.quoteIn;
    Object.assign(p, { open: false, closedAt: this.now(), closeReason: why, quoteOut: out - reward, pnl, keeperReward: reward, exitPrice: out / p.baseAmount });
    this.s.cash += out - reward;
    this.s.realizedPnl += pnl;
    this.s.fees += p.baseAmount * m.dexPrice * FEE;
    this.save();
    return { ok: true, pnl, quoteOut: out - reward, reward, why };
  }

  async close(id, reason, snap) {
    const p = this.s.positions[id];
    if (!p?.open) return { ok: false, error: "PositionNotOpen" };
    const m = snap[p.sym];
    if (Math.abs(m.spotPriceTick - m.twapPriceTick) > this.policy.maxTwapDeviationTicks) return { ok: false, error: "TwapDeviation" };
    this.s.lastHeartbeat = this.now();
    p.closeNote = reason;
    return this._close(p, m, "AGENT");
  }

  async adjustStop(id, stopPT, tpPT, snap) {
    const p = this.s.positions[id];
    if (!p?.open) return { ok: false, error: "PositionNotOpen" };
    if (stopPT < p.stopPriceTick) return { ok: false, error: "StopCanOnlyTighten" };
    if (stopPT >= snap[p.sym].twapPriceTick) return { ok: false, error: "StopAboveMarket" };
    p.stopPriceTick = stopPT;
    p.takeProfitPriceTick = tpPT;
    this.s.lastHeartbeat = this.now();
    this.save();
    return { ok: true };
  }

  async logDecision() {
    this.s.lastHeartbeat = this.now();
    this.s.decisions++;
    return { ok: true, tx: null };
  }

  /** What any keeper on-chain would do: execute triggered stops / take-profits / dead-man closes. */
  async keeperSweep(snap) {
    const events = [];
    const dead = this.now() > this.s.lastHeartbeat + this.policy.heartbeatTimeout;
    for (const p of this.open_()) {
      const m = snap[p.sym];
      let why = null;
      if (dead) why = "DEAD_MAN";
      else if (m.twapPriceTick <= p.stopPriceTick) why = "STOP_LOSS";
      else if (m.twapPriceTick >= p.takeProfitPriceTick) why = "TAKE_PROFIT";
      if (!why) continue;
      if (dead && !this.s.paused) this.s.paused = true;
      const r = this._close(p, m, why, this.policy.keeperRewardBps, this.policy.maxStopSlippageBps);
      events.push({ id: p.id, sym: p.sym, why, ...r });
    }
    return events;
  }

  setPaused(b) {
    this.s.paused = b;
    if (!b) this.s.lastHeartbeat = this.now();
    this.save();
  }
}

function decorate(p, m, value) {
  const pnl = value - p.quoteIn;
  const span = p.takeProfitPriceTick - p.stopPriceTick;
  return {
    ...p,
    valueNow: value,
    pnl,
    pnlPct: (pnl / p.quoteIn) * 100,
    priceTickNow: m.twapPriceTick,
    // 0 = at stop, 1 = at take-profit
    progress: span > 0 ? (m.twapPriceTick - p.stopPriceTick) / span : 0.5,
    stopPrice: priceFromPriceTick(p.stopPriceTick, m.baseDecimals, 6),
    tpPrice: priceFromPriceTick(p.takeProfitPriceTick, m.baseDecimals, 6),
    entryPrice: priceFromPriceTick(p.entryPriceTick, m.baseDecimals, 6),
  };
}

// ====================================================================== on-chain

export class ChainVault {
  constructor(feed) {
    if (!config.vault) throw new Error("KAVACH_VAULT is not set (deploy first: contracts/scripts/deploy.js)");
    if (!config.agentKey) throw new Error("AGENT_PRIVATE_KEY is not set");
    this.feed = feed;
    this.kind = "chain";
    this.address = config.vault;
    this.pub = feed.client;
    this.account = privateKeyToAccount(config.agentKey);
    this.wallet = createWalletClient({ account: this.account, chain: hskChain, transport: http(config.rpcUrl) });
    this.meta = {}; // id -> local notes (reason) for the UI
    this.base2sym = Object.fromEntries(config.markets.map((s) => [HSK.tokens[s].address.toLowerCase(), s]));
  }

  read(fn, args = []) {
    return this.pub.readContract({ address: this.address, abi: VAULT_ABI, functionName: fn, args });
  }

  async init() {
    const p = await this.read("policy");
    const keys = ["maxPositionBps", "maxExposureBps", "maxDailyLossBps", "maxSlippageBps", "maxStopSlippageBps", "minStopTicks", "maxStopTicks", "maxTakeProfitTicks", "maxTwapDeviationTicks", "keeperRewardBps", "twapWindow", "cooldown", "heartbeatTimeout"];
    this.policy = Object.fromEntries(keys.map((k, i) => [k, Number(p[i])]));
    const agent = await this.read("agent");
    if (agent.toLowerCase() !== this.account.address.toLowerCase()) {
      throw new Error(`AGENT_PRIVATE_KEY is ${this.account.address}, but the vault's agent is ${agent}`);
    }
  }

  now() {
    return Math.floor(Date.now() / 1000);
  }

  async state(snap) {
    const [eq, ids, realized, dayStartEquity, paused, lastHeartbeat, lastOpenAt, cash] = await Promise.all([
      this.read("equity"),
      this.read("openPositionIds"),
      this.read("realizedPnl"),
      this.read("dayStartEquity"),
      this.read("paused"),
      this.read("lastHeartbeat"),
      this.read("lastOpenAt"),
      this.pub.readContract({ address: Q.address, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [this.address] }),
    ]);
    const positions = [];
    for (const id of ids) {
      const r = await this.read("positions", [id]);
      const sym = this.base2sym[r[0].toLowerCase()];
      const p = {
        id: Number(id),
        sym,
        baseAmount: Number(formatUnits(r[1], HSK.tokens[sym].decimals)),
        quoteIn: Number(formatUnits(r[2], 6)),
        entryPriceTick: Number(r[3]),
        stopPriceTick: Number(r[4]),
        takeProfitPriceTick: Number(r[5]),
        openedAt: Number(r[6]),
        open: r[7],
        reason: this.meta[Number(id)]?.reason || "",
      };
      positions.push(decorate(p, snap[sym], valueAt(sym, p.baseAmount, snap[sym].twapPriceTick)));
    }
    const now = this.now();
    return {
      kind: this.kind,
      vault: this.address,
      cash: Number(formatUnits(cash, 6)),
      equity: Number(formatUnits(eq[0], 6)),
      exposure: Number(formatUnits(eq[1], 6)),
      positions,
      closed: this.closed || [],
      realizedPnl: Number(formatUnits(realized, 6)),
      dayStartEquity: Number(formatUnits(dayStartEquity, 6)),
      paused,
      lastHeartbeat: Number(lastHeartbeat),
      lastOpenAt: Number(lastOpenAt),
      deadManIn: Number(lastHeartbeat) + this.policy.heartbeatTimeout - now,
      now,
      policy: this.policy,
      openCount: positions.length,
    };
  }

  async send(functionName, args) {
    try {
      const { request } = await this.pub.simulateContract({ address: this.address, abi: VAULT_ABI, functionName, args, account: this.account });
      const hash = await this.wallet.writeContract(request);
      const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (rc.status !== "success") return { ok: false, error: "reverted", tx: hash };
      return { ok: true, tx: hash, receipt: rc };
    } catch (e) {
      return { ok: false, error: decodeError(e) };
    }
  }

  async open(sym, quoteIn, stopTicks, tpTicks, reason) {
    const r = await this.send("openPosition", [HSK.tokens[sym].address, parseUnits(quoteIn.toFixed(6), 6), stopTicks, tpTicks, reason.slice(0, 180)]);
    if (r.ok) {
      r.id = Number((await this.read("positionsCount")) - 1n);
      this.meta[r.id] = { reason };
    }
    delete r.receipt;
    return r;
  }

  async close(id, reason) {
    const r = await this.send("closePosition", [BigInt(id), reason.slice(0, 180)]);
    delete r.receipt;
    return r;
  }

  async adjustStop(id, stopPT, tpPT) {
    const r = await this.send("adjustStop", [BigInt(id), stopPT, tpPT]);
    delete r.receipt;
    return r;
  }

  async logDecision(sym, action, reason) {
    const r = await this.send("logDecision", [sym ? HSK.tokens[sym].address : "0x0000000000000000000000000000000000000000", action, reason.slice(0, 180)]);
    delete r.receipt;
    return r;
  }

  /** In live mode stops are executed by the keeper bot (src/keeper-bot.js) - by anyone, on-chain. */
  async keeperSweep() {
    return [];
  }

  setPaused() {
    throw new Error("Only the owner wallet can pause the on-chain vault (setPaused).");
  }
}

export function decodeError(e) {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert?.data?.errorName) return revert.data.errorName + (revert.data.args?.length ? `(${revert.data.args.join(", ")})` : "");
    if (revert?.reason) return revert.reason;
    return e.shortMessage || e.message;
  }
  return String(e?.message || e);
}

export { REASONS };
