// The agent loop: observe -> council -> execute -> keeper sweep -> publish to the dashboard.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { config, DISPLAY, HSK } from "./config.js";
import { LiveFeed, SimFeed } from "./feeds.js";
import { PaperVault, ChainVault } from "./vaults.js";
import { Council, defaultSettings } from "./council.js";
import { llmName } from "./llm.js";
import { fmt, fmtPrice } from "./math.js";

export class Engine extends EventEmitter {
  constructor(mode = config.mode) {
    super();
    this.mode = mode;
    this.settings = defaultSettings();
    this.council = new Council();
    this.feedLog = []; // council lines
    this.trades = []; // executed actions
    this.equityCurve = [];
    this.running = false;
    this.cycles = 0;
    this.snap = null;
    this.state = null;
    this.signals = {};
    this.lastHeartbeatTx = 0;
    this.crashed = false; // "pull the plug" demo
    this.busy = false;
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.journalFile = path.join(config.dataDir, `journal-${mode}.jsonl`);
  }

  async init() {
    this.feed = this.mode === "sim" ? new SimFeed() : new LiveFeed();
    await this.feed.init();
    if (this.mode === "live") {
      this.vault = new ChainVault(this.feed);
      await this.vault.init();
    } else {
      this.vault = new PaperVault(this.feed, { file: path.join(config.dataDir, `paper-book.json`) });
    }
    this.policy = this.vault.policy;
    if (this.mode === "sim") {
      this.settings.useLlm = !!process.env.SIM_USE_LLM; // keep the offline demo instant and free
      this.policy.heartbeatTimeout = 900; // 15 simulated minutes, so the dead-man switch fires during a live demo
    }
    this.snap = await this.feed.snapshot();
    this.council.observe(this.snap);
    this.state = await this.vault.state(this.snap);
    this.log("Executor", `KAVACH online · mode ${this.mode.toUpperCase()} · ${this.mode === "live" ? `vault ${config.vault}` : "paper vault (same rules as the contract)"} · LLM: ${llmName() || "off (deterministic)"}`);
  }

  log(role, text, sym = null, tone = "info") {
    const line = { t: this.now(), role, text, sym, tone };
    this.feedLog.push(line);
    if (this.feedLog.length > 200) this.feedLog.shift();
    this.emit("line", line);
  }

  now() {
    return this.feed ? this.feed.nowSec() : Math.floor(Date.now() / 1000);
  }

  journal(entry) {
    fs.appendFileSync(this.journalFile, JSON.stringify({ t: this.now(), ...entry }) + "\n");
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.cycle().catch((e) => this.log("Executor", `cycle error: ${e.message}`, null, "bad"));
      this.timer = setTimeout(loop, config.tickMs);
    };
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  /** One full decision cycle. */
  async cycle() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.cycles++;
      this.snap = await this.feed.snapshot();
      this.council.observe(this.snap);
      this.state = await this.vault.state(this.snap);

      if (!this.crashed) {
        const { actions, feed, sig, hold } = await this.council.decide({ snap: this.snap, st: this.state, settings: this.settings, policy: this.policy });
        this.signals = sig;
        // only log the council when something interesting happens (or every 10th cycle) to keep the feed readable
        const interesting = actions.length || feed.some((l) => l.tone !== "info");
        if (interesting || this.cycles % 10 === 1) for (const l of feed) this.log(l.role, l.text, l.sym, l.tone);
        for (const a of actions) await this.execute(a);
        if (hold) await this.heartbeat(feed);
      }

      // what ANY keeper would do on-chain (paper/sim). In live mode the separate keeper bot does it.
      const kev = await this.vault.keeperSweep(this.snap);
      for (const e of kev) this.onKeeper(e);

      this.state = await this.vault.state(this.snap);
      this.equityCurve.push([this.now(), Math.round(this.state.equity * 100) / 100]);
      if (this.equityCurve.length > 600) this.equityCurve.shift();
      this.emit("state");
    } finally {
      this.busy = false;
    }
  }

  async heartbeat(feed) {
    // live: write a HOLD decision on-chain at most every 10 minutes (heartbeat + public reasoning trail)
    if (this.mode === "live") {
      if (Date.now() - this.lastHeartbeatTx < 10 * 60_000 && this.state.deadManIn > 900) return;
      this.lastHeartbeatTx = Date.now();
      const note = feed.find((l) => l.role === "Quant")?.text || "holding";
      const r = await this.vault.logDecision(null, "HOLD", note);
      if (r.ok) this.log("Executor", `HOLD logged on-chain (heartbeat)`, null, "info");
      else this.log("Executor", `heartbeat failed: ${r.error}`, null, "bad");
      this.trades.unshift({ t: this.now(), type: "hold", tx: r.tx, ok: r.ok, text: note });
    } else {
      await this.vault.logDecision(null, "HOLD", "");
    }
  }

  async execute(a) {
    const name = DISPLAY[a.sym];
    let r;
    if (a.type === "open") {
      r = await this.vault.open(a.sym, a.size, a.stopTicks, a.tpTicks, a.reason, this.snap);
      if (r.ok) this.log("Executor", `BUY ${name} for ${fmt(a.size, 0)} USDT @ ~${fmtPrice(this.snap[a.sym].dexPrice)} → position #${r.id}${r.tx ? " · tx " + r.tx.slice(0, 10) + "…" : ""}`, a.sym, "good");
    } else if (a.type === "close") {
      r = await this.vault.close(a.id, a.reason, this.snap);
      if (r.ok) this.log("Executor", `SELL ${name} #${a.id} · ${a.reason}${r.pnl !== undefined ? ` · PnL ${r.pnl >= 0 ? "+" : ""}${fmt(r.pnl)} USDT` : ""}`, a.sym, r.pnl >= 0 ? "good" : "warn");
    } else if (a.type === "trail") {
      r = await this.vault.adjustStop(a.id, a.stop, a.tp, this.snap);
      if (r.ok) this.log("Executor", `stop of ${name} #${a.id} raised on-chain · ${a.reason}`, a.sym, "good");
    }
    if (!r.ok) this.log("Executor", `${a.type} ${name} refused: ${r.error}`, a.sym, "bad");
    const entry = { t: this.now(), ...a, ok: r.ok, error: r.error, tx: r.tx, pnl: r.pnl };
    this.trades.unshift(entry);
    if (this.trades.length > 100) this.trades.pop();
    this.journal(entry);
  }

  onKeeper(e) {
    const label = { STOP_LOSS: "STOP-LOSS", TAKE_PROFIT: "TAKE-PROFIT", DEAD_MAN: "DEAD-MAN SWITCH" }[e.why] || e.why;
    if (e.ok) {
      this.log("Keeper", `${label} executed on ${DISPLAY[e.sym]} #${e.id} by a public keeper · PnL ${e.pnl >= 0 ? "+" : ""}${fmt(e.pnl)} USDT · keeper reward ${fmt(e.reward, 3)} USDT`, e.sym, e.why === "TAKE_PROFIT" ? "good" : "warn");
      if (e.why === "DEAD_MAN") this.log("Keeper", "Agent silent beyond the heartbeat timeout → vault auto-paused, all positions unwound to USDT. No human needed.", null, "warn");
    } else {
      const key = `${e.id}:${e.why}`;
      if (this.keeperBlocked === key) return; // log a waiting keeper once, not every cycle
      this.keeperBlocked = key;
      this.log("Keeper", `${label} on ${DISPLAY[e.sym]} #${e.id} triggered, fill waiting: ${e.error}`, e.sym, "warn");
      return;
    }
    const entry = { t: this.now(), type: "keeper", sym: e.sym, id: e.id, why: e.why, ok: e.ok, pnl: e.pnl, error: e.error };
    this.trades.unshift(entry);
    this.journal(entry);
  }

  async closeAll(reason) {
    const st = await this.vault.state(this.snap);
    for (const p of st.positions) await this.execute({ type: "close", id: p.id, sym: p.sym, reason });
    this.state = await this.vault.state(this.snap);
    this.emit("state");
  }

  /** Demo helper: open a position right now - still subject to every on-chain risk check. */
  async forceOpen(sym = "WHSK") {
    const st = await this.vault.state(this.snap);
    const size = Math.floor((st.equity * Math.min(this.settings.positionPct, this.policy.maxPositionBps / 100 - 1)) / 100);
    await this.execute({ type: "open", sym, size, stopTicks: Math.max(this.policy.minStopTicks, 300), tpTicks: 600, reason: "demo position (crash test)" });
    this.state = await this.vault.state(this.snap);
    this.emit("state");
  }

  /** The jury demo: open a position, kill the AI, crash the market - the parachute opens on-chain. */
  async crashTest(sym = "WHSK") {
    if (this.crashed) return this.log("Executor", "Crash test already running - restart the AI first to run it again.", null, "warn");
    // open a demo position in the first market the contract accepts right now (TWAP settled)
    let target = this.state.positions[0]?.sym || null;
    for (let i = 0; !target && i < 15; i++) {
      const order = [sym, ...Object.keys(this.snap).filter((k) => k !== sym)];
      const ok = order.find((k) => Math.abs(this.snap[k].spotPriceTick - this.snap[k].twapPriceTick) <= this.policy.maxTwapDeviationTicks);
      if (ok) {
        await this.forceOpen(ok);
        target = this.state.positions.find((p) => p.sym === ok)?.sym || null;
      }
      if (!target) await this.cycle();
    }
    if (!target) return this.log("Executor", "Crash test skipped: the market is too volatile to open a demo position right now.", null, "warn");
    this.pullThePlug();
    this.crash(target);
  }

  /** Demo: simulate the AI process dying. Heartbeats stop; the vault's dead-man switch takes over. */
  pullThePlug() {
    this.crashed = true;
    this.log("Executor", "⚡ AI process killed (demo). No more decisions, no more heartbeats. Watch the on-chain parachute…", null, "bad");
  }

  revive() {
    this.crashed = false;
    if (this.vault.kind === "paper") this.vault.setPaused(false);
    this.log("Executor", "AI process restarted. Owner un-paused the vault.", null, "good");
  }

  crash(sym = "WHSK") {
    if (this.feed.crash) {
      this.feed.crash(sym, -0.06);
      this.log("Scout", `⚠ Market shock injected on ${DISPLAY[sym]} (-6% over 6 minutes)`, sym, "warn");
    }
  }

  publicState() {
    const s = this.state;
    return {
      mode: this.mode,
      running: this.running,
      crashed: this.crashed,
      cycles: this.cycles,
      llm: llmName(),
      vault: config.vault,
      deployTx: config.deployTx,
      explorer: config.explorer,
      settings: this.settings,
      policy: this.policy,
      state: s,
      markets: Object.fromEntries(
        Object.entries(this.snap || {}).map(([k, m]) => [k, { ...m, name: DISPLAY[k], signal: this.signals[k] || null }])
      ),
      feed: this.feedLog.slice(-80),
      trades: this.trades.slice(0, 40),
      equityCurve: this.equityCurve,
      contracts: { router: HSK.hskswap.swapRouter02, quoter: HSK.hskswap.quoterV2, pools: HSK.pools },
    };
  }
}
