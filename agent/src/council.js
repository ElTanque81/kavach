// The agent council: Scout -> Quant -> Risk Officer -> (Strategist LLM) -> Executor.
// Every role writes a short line into the feed, so a human can follow WHY the agent acts.
import { ema, rsi, realizedVol, clamp, fmt, fmtPrice } from "./math.js";
import { precheck } from "./vaults.js";
import { DISPLAY } from "./config.js";
import { llmJson, llmEnabled } from "./llm.js";

export const PRESETS = {
  conservative: { positionPct: 5, stopMult: 2.0, tpRatio: 2.0, spreadEntry: 0.7, entryScore: 0.8, maxOpen: 2 },
  balanced: { positionPct: 10, stopMult: 2.5, tpRatio: 2.0, spreadEntry: 0.55, entryScore: 0.65, maxOpen: 3 },
  aggressive: { positionPct: 18, stopMult: 3.0, tpRatio: 2.5, spreadEntry: 0.4, entryScore: 0.5, maxOpen: 5 },
};

export function defaultSettings() {
  return {
    risk: "balanced",
    ...PRESETS.balanced,
    stopPctOverride: null, // fixed stop distance in %, set via chat ("stop 3%")
    tpPctOverride: null,
    markets: { WHSK: true, WETH: true, WBTC: true },
    trailing: true,
    agentPaused: false,
    useLlm: true,
  };
}

export class Council {
  constructor() {
    this.history = {}; // sym -> [dexPrice]
    this.lastSignals = {};
  }

  observe(snap) {
    for (const [sym, m] of Object.entries(snap)) {
      const h = (this.history[sym] ||= []);
      h.push(m.dexPrice);
      if (h.length > 300) h.shift();
    }
  }

  /** Scout + Quant: indicators and a signal score per market */
  signals(snap, settings) {
    const out = {};
    for (const [sym, m] of Object.entries(snap)) {
      const h = this.history[sym] || [];
      const vol = realizedVol(h, 40) || 0.002;
      const fast = ema(h.slice(-60), 8);
      const slow = ema(h.slice(-120), 30);
      const momentum = clamp((fast / slow - 1) / (vol * 3), -1.5, 1.5);
      const r = rsi(h, 14);
      const hasCex = Number.isFinite(m.spread);
      const edgePct = hasCex ? -m.spread * 100 : 0; // + when HSKSwap is cheaper than the CEX
      const spreadScore = hasCex ? clamp(edgePct / settings.spreadEntry, -1.5, 1.5) : 0;
      let rsiAdj = 0;
      if (r > 75) rsiAdj = -0.5;
      else if (r < 25) rsiAdj = 0.2;
      const score = hasCex ? 0.55 * spreadScore + 0.45 * momentum + rsiAdj : 0.8 * momentum + rsiAdj;

      // stop distance from volatility: ~30-sample move, in ticks (1 tick = 0.01%)
      const volTicks = vol * Math.sqrt(30) * 10_000;
      out[sym] = { sym, vol, volTicks, momentum, rsi: r, edgePct, spreadScore, hasCex, score, fast, slow, samples: h.length };
    }
    this.lastSignals = out;
    return out;
  }

  /** Full decision cycle. Returns a list of actions and the council's feed lines. */
  async decide({ snap, st, settings, policy }) {
    const feed = [];
    const actions = [];
    const sig = this.signals(snap, settings);
    const say = (role, text, sym = null, tone = "info") => feed.push({ role, text, sym, tone });

    // ---------------- Scout
    const best = Object.values(sig).filter((s) => settings.markets[s.sym]).sort((a, b) => b.score - a.score)[0];
    const spreads = Object.values(sig)
      .filter((s) => s.hasCex)
      .map((s) => `${DISPLAY[s.sym]} ${s.edgePct >= 0 ? "-" : "+"}${fmt(Math.abs(s.edgePct), 2)}%`)
      .join(" · ");
    say("Scout", spreads ? `HSKSwap vs CEX: ${spreads}` : "No CEX reference reachable - trading on on-chain momentum only.");

    // ---------------- manage open positions first (exits + trailing stops)
    for (const p of st.positions) {
      const s = sig[p.sym];
      const m = snap[p.sym];
      const settled = Math.abs(m.spotPriceTick - m.twapPriceTick) <= policy.maxTwapDeviationTicks;
      // original stop distance (TP was set at tpRatio x stop distance)
      const stopDist = (p.takeProfitPriceTick - p.entryPriceTick) / settings.tpRatio;
      if (s.score <= -0.6 && settled) {
        actions.push({ type: "close", id: p.id, sym: p.sym, reason: `signal flipped (score ${fmt(s.score)}), cutting early at ${fmt(p.pnlPct)}%` });
        say("Quant", `${DISPLAY[p.sym]}: signal flipped to ${fmt(s.score)} - recommend exit.`, p.sym, "warn");
        continue;
      }
      if (s.hasCex && p.reason?.includes("spread") && s.edgePct <= 0 && p.pnl > 0 && settled) {
        actions.push({ type: "close", id: p.id, sym: p.sym, reason: `spread converged, banking ${fmt(p.pnlPct)}%` });
        say("Quant", `${DISPLAY[p.sym]}: DEX/CEX spread closed - taking the arbitrage profit.`, p.sym, "good");
        continue;
      }
      if (settings.trailing) {
        const gained = m.twapPriceTick - p.entryPriceTick;
        const dist = Math.max(policy.minStopTicks, Math.round(stopDist || policy.minStopTicks));
        if (gained > dist) {
          const newStop = Math.max(p.entryPriceTick + 10, m.twapPriceTick - dist);
          if (newStop > p.stopPriceTick + 25 && newStop < m.twapPriceTick) {
            actions.push({ type: "trail", id: p.id, sym: p.sym, stop: newStop, tp: p.takeProfitPriceTick, reason: `trailing stop to ${fmtPrice(stopPrice(m, newStop))}` });
            say("Risk Officer", `${DISPLAY[p.sym]}: +${(gained / 100).toFixed(2)}% - trailing the stop up, profit locked on-chain.`, p.sym, "good");
          }
        }
      }
    }

    // ---------------- look for a new entry
    if (settings.agentPaused) {
      say("Risk Officer", "Agent paused by you - only managing open positions.", null, "warn");
      return { actions, feed, sig };
    }
    const open = new Set(st.positions.map((p) => p.sym));
    const candidates = Object.values(sig)
      .filter((s) => settings.markets[s.sym] && !open.has(s.sym) && s.samples >= 20)
      .sort((a, b) => b.score - a.score);
    const c = candidates[0];
    const threshold = settings.entryScore + (c && !c.hasCex ? 0.3 : 0);
    if (!c || c.score < threshold) {
      say("Quant", best ? `Best setup ${DISPLAY[best.sym]} score ${fmt(best.score)} < ${fmt(threshold)} needed (${settings.risk}) - no edge, holding.` : "Warming up indicators.");
      this.waiting = best ? { sym: best.sym, score: best.score, threshold } : null;
      return { actions, feed, sig, hold: true };
    }

    const m = snap[c.sym];
    const why = [];
    if (c.hasCex && c.edgePct > 0.2) why.push(`spread ${fmt(c.edgePct)}% below CEX (${m.cexSource})`);
    if (c.momentum > 0.3) why.push(`momentum ${fmt(c.momentum)}`);
    if (c.rsi < 30) why.push(`RSI ${fmt(c.rsi, 0)} oversold`);
    this.waiting = null;
    say("Quant", `${DISPLAY[c.sym]} long setup: score ${fmt(c.score)} (${why.join(", ") || "composite"}).`, c.sym, "good");

    // ---------------- Risk Officer: size, stop, take-profit, veto
    let stopTicks = settings.stopPctOverride ? Math.round(settings.stopPctOverride * 100) : Math.round(settings.stopMult * c.volTicks);
    stopTicks = clamp(stopTicks, policy.minStopTicks, policy.maxStopTicks);
    let tpTicks = settings.tpPctOverride ? Math.round(settings.tpPctOverride * 100) : Math.round(stopTicks * settings.tpRatio);
    tpTicks = clamp(tpTicks, 1, policy.maxTakeProfitTicks);

    const conf = clamp(c.score / 1.5, 0.5, 1);
    let size = (st.equity * settings.positionPct * conf) / 100;
    const notes = [];
    const lossBps = st.dayStartEquity > 0 ? ((st.dayStartEquity - st.equity) * 10000) / st.dayStartEquity : 0;
    if (lossBps > policy.maxDailyLossBps * 0.6) {
      size *= 0.5;
      notes.push("defensive mode: >60% of daily loss budget used, half size");
    }
    if (c.vol > 0.006) {
      size *= 0.5;
      notes.push("high-volatility regime, half size");
    }
    size = Math.min(size, (st.equity * policy.maxPositionBps) / 10000 * 0.99, (st.equity * policy.maxExposureBps) / 10000 - st.exposure - 1);
    size = Math.floor(size * 100) / 100;

    let veto = null;
    if (st.positions.length >= settings.maxOpen) veto = `max ${settings.maxOpen} open positions for the "${settings.risk}" profile`;
    else if (size < 5) veto = "size too small after risk limits";
    else veto = precheck(st, m, size, stopTicks, tpTicks);

    if (veto) {
      say("Risk Officer", `VETO on ${DISPLAY[c.sym]}: ${veto}.`, c.sym, "bad");
      return { actions, feed, sig, hold: true };
    }
    say(
      "Risk Officer",
      `Approved ${fmt(size, 0)} USDT on ${DISPLAY[c.sym]} · stop -${(stopTicks / 100).toFixed(2)}% · take-profit +${(tpTicks / 100).toFixed(2)}% (both enforced on-chain)${notes.length ? " · " + notes.join("; ") : ""}.`,
      c.sym,
      "good"
    );

    const proposal = {
      type: "open",
      sym: c.sym,
      size,
      stopTicks,
      tpTicks,
      reason: `${c.hasCex && c.edgePct > 0.2 ? "spread" : "momentum"}: ${why.join(", ") || "composite score"}; score ${fmt(c.score)}`.slice(0, 170),
    };

    // ---------------- Strategist (optional LLM): may veto or shrink, never enlarge
    if (settings.useLlm && llmEnabled()) {
      const r = await llmJson(
        "You are the Strategist in an AI trading council for spot trades on HSKSwap (Uniswap V3 on HSK Chain). " +
          "Review a proposed long trade. You may APPROVE, SHRINK (factor 0.25-1) or REJECT it. Be skeptical about thin edges and fees (0.3% each way). " +
          'Reply ONLY with JSON: {"decision":"approve|shrink|reject","factor":number,"note":"one sentence, max 25 words"}',
        { proposal, signal: c, market: { dex: m.dexPrice, cex: m.cexPrice, twap: m.twapPrice }, equity: st.equity, openPositions: st.positions.length }
      );
      if (r?.decision === "reject") {
        say("Strategist (LLM)", `Rejected: ${r.note}`, c.sym, "bad");
        return { actions, feed, sig, hold: true };
      }
      if (r?.decision === "shrink" && r.factor > 0 && r.factor < 1) {
        proposal.size = Math.floor(proposal.size * clamp(r.factor, 0.25, 1) * 100) / 100;
        say("Strategist (LLM)", `Shrunk to ${fmt(proposal.size, 0)} USDT: ${r.note}`, c.sym, "warn");
      } else if (r?.note) {
        say("Strategist (LLM)", r.note, c.sym, "info");
      }
    }

    actions.push(proposal);
    return { actions, feed, sig };
  }
}

function stopPrice(m, priceTick) {
  return Math.pow(1.0001, priceTick) * Math.pow(10, m.baseDecimals - 6);
}
