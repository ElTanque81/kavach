// Natural-language control: "how am I doing?", "be more careful", "stop at 3%", "only trade ETH",
// "close everything", "pause". Uses the LLM when configured, otherwise a bilingual (DE/EN) rule parser.
// The chat can only move the agent INSIDE the on-chain policy - loosening the policy needs the owner wallet.
import { PRESETS } from "./council.js";
import { DISPLAY } from "./config.js";
import { llmJson, llmEnabled } from "./llm.js";
import { fmt, fmtUsd, fmtPrice } from "./math.js";

const SYM = { hsk: "WHSK", whsk: "WHSK", eth: "WETH", weth: "WETH", ether: "WETH", ethereum: "WETH", btc: "WBTC", wbtc: "WBTC", bitcoin: "WBTC" };
const isGerman = (t) => /\b(wie|ist|und|nur|mehr|weniger|alles|risiko|zeig|bitte|kein|keine|ohne|wieder|sei|mach|gewinn|verlust|stopp|halt|handel|auch|warum|wieso|machst|nichts|nix|tust|du)\b|vorsicht|schlie|läuft|größe|aggressiver/i.test(t);

export async function handleChat(text, ctx) {
  const de = isGerman(text);
  if (llmEnabled() && ctx.settings.useLlm) {
    const r = await llmJson(
      "You control KAVACH, an AI spot-trading agent on HSKSwap (HSK Chain). Markets: WHSK (HSK), WETH (ETH), WBTC (BTC) vs USDT. " +
        "Interpret the user's message (any language) and reply in the SAME language, briefly (max 60 words), using the provided state for facts. " +
        "You may change settings only within the on-chain policy limits given. " +
        'Reply ONLY with JSON: {"reply":string,"set":{"risk"?:"conservative|balanced|aggressive","positionPct"?:number,"stopPct"?:number|null,"tpPct"?:number|null,"spreadEntry"?:number,"markets"?:{"WHSK"?:bool,"WETH"?:bool,"WBTC"?:bool},"trailing"?:bool,"agentPaused"?:bool},"command":"none|close_all|run_cycle"}',
      { message: text, state: summary(ctx), settings: ctx.settings, policyLimits: limits(ctx.policy) },
      500
    );
    if (r && typeof r.reply === "string") {
      const applied = apply(r.set || {}, ctx, de);
      if (r.command === "close_all") await ctx.engine.closeAll("closed via chat");
      if (r.command === "run_cycle") await ctx.engine.cycle();
      return { reply: [r.reply, ...applied.warnings].join(" "), changed: applied.changed };
    }
  }
  return rules(text, ctx, de);
}

function limits(p) {
  return {
    maxPositionPct: p.maxPositionBps / 100,
    maxExposurePct: p.maxExposureBps / 100,
    stopPctRange: [p.minStopTicks / 100, p.maxStopTicks / 100],
    maxTakeProfitPct: p.maxTakeProfitTicks / 100,
    maxDailyLossPct: p.maxDailyLossBps / 100,
  };
}

function summary({ state, snap, settings }) {
  return {
    equity: Math.round(state.equity * 100) / 100,
    realizedPnl: Math.round(state.realizedPnl * 100) / 100,
    openPositions: state.positions.map((p) => ({ market: DISPLAY[p.sym], usdt: p.quoteIn, pnlPct: Math.round(p.pnlPct * 100) / 100, stop: p.stopPrice, takeProfit: p.tpPrice })),
    prices: Object.fromEntries(Object.entries(snap || {}).map(([k, m]) => [DISPLAY[k], { dex: m.dexPrice, cex: m.cexPrice }])),
    risk: settings.risk,
  };
}

/** apply a settings patch, clamped to the on-chain policy */
function apply(set, { settings, policy }, de) {
  const warnings = [];
  const changed = [];
  const L = limits(policy);
  if (set.risk && PRESETS[set.risk]) {
    Object.assign(settings, PRESETS[set.risk], { risk: set.risk });
    changed.push(`risk=${set.risk}`);
  }
  if (Number.isFinite(set.positionPct)) {
    let v = set.positionPct;
    if (v > L.maxPositionPct) {
      warnings.push(de
        ? `Hinweis: Der Vault erlaubt on-chain max. ${L.maxPositionPct}% pro Position – das kann nur deine Owner-Wallet ändern (setPolicy).`
        : `Note: the vault enforces max ${L.maxPositionPct}% per position on-chain - only your owner wallet can raise it (setPolicy).`);
      v = L.maxPositionPct;
    }
    settings.positionPct = Math.max(1, v);
    changed.push(`positionPct=${settings.positionPct}`);
  }
  if (set.stopPct !== undefined) {
    if (set.stopPct === null) settings.stopPctOverride = null;
    else {
      let v = set.stopPct;
      const [lo, hi] = L.stopPctRange;
      if (v < lo || v > hi) {
        warnings.push(de
          ? `Stop-Loss muss on-chain zwischen ${lo}% und ${hi}% liegen – ich nehme ${Math.min(hi, Math.max(lo, v))}%.`
          : `The on-chain stop range is ${lo}%-${hi}% - using ${Math.min(hi, Math.max(lo, v))}%.`);
        v = Math.min(hi, Math.max(lo, v));
      }
      settings.stopPctOverride = v;
    }
    changed.push(`stop=${settings.stopPctOverride ?? "auto"}`);
  }
  if (set.tpPct !== undefined) {
    settings.tpPctOverride = set.tpPct === null ? null : Math.min(L.maxTakeProfitPct, Math.max(0.2, set.tpPct));
    changed.push(`tp=${settings.tpPctOverride ?? "auto"}`);
  }
  if (Number.isFinite(set.spreadEntry)) {
    settings.spreadEntry = Math.max(0.3, set.spreadEntry);
    changed.push(`spreadEntry=${settings.spreadEntry}`);
  }
  if (set.markets && typeof set.markets === "object") {
    for (const [k, v] of Object.entries(set.markets)) if (k in settings.markets) settings.markets[k] = !!v;
    changed.push(`markets=${Object.entries(settings.markets).filter(([, v]) => v).map(([k]) => DISPLAY[k]).join("/")}`);
  }
  if (typeof set.trailing === "boolean") {
    settings.trailing = set.trailing;
    changed.push(`trailing=${set.trailing}`);
  }
  if (typeof set.agentPaused === "boolean") {
    settings.agentPaused = set.agentPaused;
    changed.push(`paused=${set.agentPaused}`);
  }
  return { warnings, changed };
}

async function rules(text, ctx, de) {
  const t = text.toLowerCase();
  const { state, settings } = ctx;
  const T = (g, e) => (de ? g : e);
  const pct = (re) => {
    const m = t.match(re);
    return m ? parseFloat(m[1].replace(",", ".")) : null;
  };

  // ---- commands
  if (/(close|schlie(ß|ss)e?|verkauf|exit).*(all|alles|everything|positionen)|alles (verkaufen|schließen)/.test(t)) {
    const n = state.positions.length;
    await ctx.engine.closeAll(T("per Chat geschlossen", "closed via chat"));
    return { reply: T(`Erledigt – ${n} Position(en) werden geschlossen.`, `Done - closing ${n} position(s).`), changed: ["close_all"] };
  }
  if (/\b(pause|pausier|stopp?(e)? (den )?(agent|trading|handel)|halt|hör auf|stop trading)\b/.test(t) && !/stop.?loss/.test(t)) {
    apply({ agentPaused: true }, ctx, de);
    return { reply: T("Pausiert. Ich eröffne nichts Neues, aber offene Positionen bleiben durch Stop-Loss und Take-Profit on-chain geschützt.", "Paused. No new positions; open ones stay protected by their on-chain stop-loss and take-profit."), changed: ["paused"] };
  }
  if (/\b(start|weiter|resume|fortsetzen|los geht|go)\b/.test(t)) {
    apply({ agentPaused: false }, ctx, de);
    return { reply: T("Läuft wieder – ich suche nach Setups.", "Running again - scanning for setups."), changed: ["resumed"] };
  }

  const patch = {};
  if (/(konservativ|vorsichtig|weniger risiko|risiko runter|safer|careful|conservative|less risk)/.test(t)) patch.risk = "conservative";
  else if (/(aggressiv|mehr risiko|risiko hoch|more risk|aggressive|yolo)/.test(t)) patch.risk = "aggressive";
  else if (/(ausgewogen|normal|balanced|standard)/.test(t)) patch.risk = "balanced";

  const stop = pct(/stop.?(?:loss)?\D{0,12}?(\d+(?:[.,]\d+)?)\s*%/);
  if (stop !== null) patch.stopPct = stop;
  const tp = pct(/(?:take.?profit|tp|gewinnziel)\D{0,12}?(\d+(?:[.,]\d+)?)\s*%/);
  if (tp !== null) patch.tpPct = tp;
  const size = pct(/(?:position(?:sgr(?:ö|oe)(?:ß|ss)e)?|size|gr(?:ö|oe)(?:ß|ss)e|einsatz)\D{0,12}?(\d+(?:[.,]\d+)?)\s*%/);
  if (size !== null) patch.positionPct = size;
  const spread = pct(/spread\D{0,12}?(\d+(?:[.,]\d+)?)\s*%/);
  if (spread !== null) patch.spreadEntry = spread;
  if (/trailing.*(aus|off)|kein trailing/.test(t)) patch.trailing = false;
  else if (/trailing.*(an|on)/.test(t)) patch.trailing = true;

  // market selection: "nur eth", "only btc and eth", "kein hsk", "without btc"
  const mentioned = [...new Set([...t.matchAll(/\b(hsk|whsk|eth|weth|ether|ethereum|btc|wbtc|bitcoin)\b/g)].map((m) => SYM[m[1]]))];
  if (mentioned.length) {
    if (/\b(nur|only|just|ausschließlich)\b/.test(t)) patch.markets = { WHSK: false, WETH: false, WBTC: false, ...Object.fromEntries(mentioned.map((s) => [s, true])) };
    else if (/\b(kein|keine|ohne|no|without|not|nicht|disable)\b/.test(t)) patch.markets = Object.fromEntries(mentioned.map((s) => [s, false]));
    else if (/\b(auch|also|wieder|enable|add)\b/.test(t)) patch.markets = Object.fromEntries(mentioned.map((s) => [s, true]));
  }

  if (/(alle märkte|alles handeln|trade everything|all markets)/.test(t)) patch.markets = { WHSK: true, WETH: true, WBTC: true };

  if (Object.keys(patch).length) {
    const r = apply(patch, ctx, de);
    return { reply: [T(`Übernommen: ${r.changed.join(", ")}.`, `Updated: ${r.changed.join(", ")}.`), ...r.warnings].join(" "), changed: r.changed };
  }

  // ---- "why are you not trading?"
  if (/(warum|wieso|why).*(nicht|nichts|kein|not|nothing|no trade)|(macht|tust|tut) (nichts|nix)|doing nothing|not trading/.test(t)) {
    const w = ctx.engine.council.waiting;
    const on = Object.entries(settings.markets).filter(([, v]) => v).map(([k]) => DISPLAY[k]).join(", ");
    if (settings.agentPaused) return { reply: T("Ich bin pausiert. Schreib „weiter“, dann suche ich wieder nach Setups.", "I'm paused. Say \"resume\" and I'll look for setups again."), changed: [] };
    if (w) {
      return {
        reply: T(
          `Ich warte auf ein Signal. Bestes Setup gerade: ${DISPLAY[w.sym]} mit Score ${fmt(w.score)}, im Profil „${settings.risk}“ brauche ich ${fmt(w.threshold)}. Aktive Märkte: ${on}. Wenn du mehr Trades willst: „aggressiver“ oder „alle Märkte wieder“.`,
          `I'm waiting for an edge. Best setup right now: ${DISPLAY[w.sym]} at score ${fmt(w.score)}; the "${settings.risk}" profile needs ${fmt(w.threshold)}. Active markets: ${on}. For more trades say "more aggressive" or "trade everything again".`
        ),
        changed: [],
      };
    }
  }

  // ---- "what just happened?" -> explain the latest notable events
  if (/(passiert|happened|warum|why|erklär|explain)/.test(t)) {
    const ev = ctx.engine.feedLog.filter((l) => l.tone !== "info" && l.role !== "You").slice(-4);
    if (ev.length) {
      return {
        reply: T("Das Wichtigste der letzten Minuten:\n", "The latest notable events:\n") + ev.map((l) => `• ${l.role}: ${l.text}`).join("\n"),
        changed: [],
      };
    }
  }

  // ---- questions -> status
  const lines = [];
  const pnl = state.equity - state.dayStartEquity;
  lines.push(T(
    `Kapital ${fmtUsd(state.equity)} USDT (heute ${pnl >= 0 ? "+" : ""}${fmt(pnl)}), realisiert ${fmt(state.realizedPnl)} USDT.`,
    `Equity ${fmtUsd(state.equity)} USDT (today ${pnl >= 0 ? "+" : ""}${fmt(pnl)}), realized ${fmt(state.realizedPnl)} USDT.`
  ));
  if (!state.positions.length) lines.push(T("Keine offenen Positionen.", "No open positions."));
  for (const p of state.positions) {
    lines.push(`${DISPLAY[p.sym]}: ${fmt(p.quoteIn, 0)} USDT, ${p.pnlPct >= 0 ? "+" : ""}${fmt(p.pnlPct)}% · stop ${fmtPrice(p.stopPrice)} · TP ${fmtPrice(p.tpPrice)}`);
  }
  lines.push(T(
    `Profil: ${settings.risk}, ${settings.positionPct}% pro Trade. Sag z. B. „vorsichtiger“, „Stop 3%“, „nur ETH“ oder „alles schließen“.`,
    `Profile: ${settings.risk}, ${settings.positionPct}% per trade. Try "more careful", "stop 3%", "only ETH" or "close everything".`
  ));
  return { reply: lines.join("\n"), changed: [] };
}
