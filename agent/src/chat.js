// Natural-language control: "how am I doing?", "be more careful", "stop at 3%", "only trade ETH",
// "close everything", "pause". Uses the LLM when configured, otherwise a rule parser that understands
// English, German, Hindi and Chinese and answers in the language it was asked in.
// The chat can only move the agent INSIDE the on-chain policy - loosening the policy needs the owner wallet.
import { PRESETS } from "./council.js";
import { DISPLAY } from "./config.js";
import { llmJson, llmEnabled } from "./llm.js";
import { fmt, fmtUsd, fmtPrice } from "./math.js";

const SYM = { hsk: "WHSK", whsk: "WHSK", eth: "WETH", weth: "WETH", ether: "WETH", ethereum: "WETH", btc: "WBTC", wbtc: "WBTC", bitcoin: "WBTC" };
// market names written in Devanagari / Chinese
const SYM_INTL = [
  [/एचएसके|हैशकी/, "WHSK"],
  [/ईथर|इथेरियम|एथेरियम/, "WETH"],
  [/बिटकॉइन|बिटकोइन/, "WBTC"],
  [/以太坊|以太/, "WETH"],
  [/比特币/, "WBTC"],
];

/** de | en | hi | zh */
export function detectLang(t) {
  if (/[ऀ-ॿ]/.test(t)) return "hi";
  if (/[一-鿿]/.test(t)) return "zh";
  if (/\b(wie|ist|und|nur|mehr|weniger|alles|risiko|zeig|bitte|kein|keine|ohne|wieder|sei|mach|gewinn|verlust|stopp|halt|handel|auch|warum|wieso|machst|nichts|nix|tust|du)\b|vorsicht|schlie|läuft|größe|aggressiver/i.test(t)) return "de";
  return "en";
}

/** pick the text for a language, falling back to English */
const L = (lang, texts) => texts[lang] ?? texts.en;

/** contract / pre-check refusals in plain words */
function explainRefusal(err, lang) {
  const key = Object.keys(REFUSALS).find((k) => err.startsWith(k));
  return key ? L(lang, REFUSALS[key]) : err;
}
const REFUSALS = {
  Cooldown: { en: "the contract allows only one new position per minute, try again shortly", de: "der Contract erlaubt nur eine neue Position pro Minute, gleich nochmal versuchen", hi: "कॉन्ट्रैक्ट एक मिनट में सिर्फ़ एक नई पोजीशन की अनुमति देता है, थोड़ी देर में फिर कोशिश करें", zh: "合约每分钟只允许开一个新仓位，请稍后再试" },
  TwapDeviation: { en: "the price is moving too fast right now (spot is far from the TWAP), so the contract blocks new trades for safety", de: "der Kurs bewegt sich gerade zu schnell (Spot weit weg vom TWAP), deshalb blockiert der Contract neue Trades", hi: "अभी कीमत बहुत तेज़ी से बदल रही है (स्पॉट TWAP से दूर है), इसलिए कॉन्ट्रैक्ट सुरक्षा के लिए नए ट्रेड रोक रहा है", zh: "当前价格波动过快（现价偏离 TWAP），合约出于安全暂停新交易" },
  PositionTooLarge: { en: "the position would be larger than the on-chain size limit", de: "die Position wäre größer als das On-Chain-Limit", hi: "पोजीशन ऑन-चेन सीमा से बड़ी हो जाती", zh: "仓位超过链上规模上限" },
  ExposureTooHigh: { en: "too much capital is already invested; the contract caps total exposure", de: "es ist schon zu viel Kapital investiert; der Contract begrenzt das Gesamtengagement", hi: "पहले से बहुत पूँजी लगी है; कॉन्ट्रैक्ट कुल एक्सपोज़र सीमित करता है", zh: "已投入资金过多，合约限制总敞口" },
  DailyLossLimit: { en: "today's loss limit is reached, so no new positions until tomorrow", de: "das Tagesverlust-Limit ist erreicht, keine neuen Positionen bis morgen", hi: "आज की घाटा सीमा पूरी हो गई, कल तक कोई नई पोजीशन नहीं", zh: "已达当日亏损上限，明天之前不能开新仓" },
  VaultPaused: { en: "the vault is paused", de: "der Vault ist pausiert", hi: "वॉल्ट रुका हुआ है", zh: "金库已暂停" },
  OracleNotReady: { en: "the pool's price oracle is not ready yet", de: "das Preis-Oracle des Pools ist noch nicht bereit", hi: "पूल का प्राइस ओरेकल अभी तैयार नहीं है", zh: "资金池的价格预言机尚未就绪" },
};

/** "stop=1.5" -> "stop-loss 1.5%" in the user's language */
function describe(change, lang) {
  const [k, raw] = change.split("=");
  const v = (raw ?? "").replace(/\//g, ", ");
  const D = {
    en: { risk: `risk profile ${v}`, stop: v === "auto" ? "stop-loss automatic" : `stop-loss ${v}%`, tp: v === "auto" ? "take-profit automatic" : `take-profit ${v}%`, positionPct: `position size ${v}% of equity`, markets: `markets ${v}`, trailing: v === "true" ? "trailing stop on" : "trailing stop off", spreadEntry: `entry spread ${v}%`, paused: v === "true" ? "paused" : "running" },
    de: { risk: `Risikoprofil ${v}`, stop: v === "auto" ? "Stop-Loss automatisch" : `Stop-Loss ${v}%`, tp: v === "auto" ? "Take-Profit automatisch" : `Take-Profit ${v}%`, positionPct: `Positionsgröße ${v}% des Kapitals`, markets: `Märkte ${v}`, trailing: v === "true" ? "Trailing-Stop an" : "Trailing-Stop aus", spreadEntry: `Einstiegs-Spread ${v}%`, paused: v === "true" ? "pausiert" : "läuft" },
    hi: { risk: `जोखिम प्रोफ़ाइल ${v}`, stop: v === "auto" ? "स्टॉप-लॉस स्वचालित" : `स्टॉप-लॉस ${v}%`, tp: v === "auto" ? "टेक-प्रॉफ़िट स्वचालित" : `टेक-प्रॉफ़िट ${v}%`, positionPct: `पोजीशन साइज़ पूँजी का ${v}%`, markets: `बाज़ार ${v}`, trailing: v === "true" ? "ट्रेलिंग स्टॉप चालू" : "ट्रेलिंग स्टॉप बंद", spreadEntry: `एंट्री स्प्रेड ${v}%`, paused: v === "true" ? "रुका हुआ" : "चालू" },
    zh: { risk: `风险模式 ${v}`, stop: v === "auto" ? "止损 自动" : `止损 ${v}%`, tp: v === "auto" ? "止盈 自动" : `止盈 ${v}%`, positionPct: `仓位 资产的 ${v}%`, markets: `市场 ${v}`, trailing: v === "true" ? "追踪止损 开" : "追踪止损 关", spreadEntry: `入场价差 ${v}%`, paused: v === "true" ? "已暂停" : "运行中" },
  };
  return (D[lang] ?? D.en)[k] ?? change;
}

/** Hindi, Chinese or German text answers in that language; otherwise the language chosen in the dashboard. */
export function replyLang(text, uiLang) {
  const d = detectLang(text);
  if (d !== "en") return d;
  return ["en", "de", "hi", "zh"].includes(uiLang) ? uiLang : "en";
}

export async function handleChat(text, ctx, uiLang) {
  const lang = replyLang(text, uiLang);
  if (llmEnabled() && ctx.settings.useLlm) {
    const r = await llmJson(
      "You control KAVACH, an AI spot-trading agent on HSKSwap (HSK Chain). Markets: WHSK (HSK), WETH (ETH), WBTC (BTC) vs USDT. " +
        "Interpret the user's message (any language, including Hindi and Chinese) and reply in the SAME language, briefly (max 60 words), using the provided state for facts. " +
        "You may change settings only within the on-chain policy limits given. " +
        'Reply ONLY with JSON: {"reply":string,"set":{"risk"?:"conservative|balanced|aggressive","positionPct"?:number,"stopPct"?:number|null,"tpPct"?:number|null,"spreadEntry"?:number,"markets"?:{"WHSK"?:bool,"WETH"?:bool,"WBTC"?:bool},"trailing"?:bool,"agentPaused"?:bool},"command":"none|close_all|run_cycle"}',
      { message: text, state: summary(ctx), settings: ctx.settings, policyLimits: limits(ctx.policy) },
      500
    );
    if (r && typeof r.reply === "string") {
      const applied = apply(r.set || {}, ctx, lang);
      if (r.command === "close_all") await ctx.engine.closeAll("closed via chat");
      if (r.command === "run_cycle") await ctx.engine.cycle();
      return { reply: [r.reply, ...applied.warnings].join(" "), changed: applied.changed };
    }
  }
  return rules(text, ctx, lang);
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
function apply(set, { settings, policy }, lang) {
  const warnings = [];
  const changed = [];
  const P = limits(policy);
  if (set.risk && PRESETS[set.risk]) {
    Object.assign(settings, PRESETS[set.risk], { risk: set.risk });
    changed.push(`risk=${set.risk}`);
  }
  if (Number.isFinite(set.positionPct)) {
    let v = set.positionPct;
    if (v > P.maxPositionPct) {
      const m = P.maxPositionPct;
      warnings.push(L(lang, {
        de: `Hinweis: Der Vault erlaubt on-chain max. ${m}% pro Position – das kann nur deine Owner-Wallet ändern (setPolicy).`,
        en: `Note: the vault enforces max ${m}% per position on-chain - only your owner wallet can raise it (setPolicy).`,
        hi: `ध्यान दें: वॉल्ट ऑन-चेन हर पोजीशन को अधिकतम ${m}% तक सीमित करता है – इसे सिर्फ़ आपका ओनर वॉलेट बदल सकता है (setPolicy)।`,
        zh: `注意：金库在链上限制每个仓位最多 ${m}% — 只有你的所有者钱包可以提高上限（setPolicy）。`,
      }));
      v = m;
    }
    settings.positionPct = Math.max(1, v);
    changed.push(`positionPct=${settings.positionPct}`);
  }
  if (set.stopPct !== undefined) {
    if (set.stopPct === null) settings.stopPctOverride = null;
    else {
      let v = set.stopPct;
      const [lo, hi] = P.stopPctRange;
      if (v < lo || v > hi) {
        const use = Math.min(hi, Math.max(lo, v));
        warnings.push(L(lang, {
          de: `Stop-Loss muss on-chain zwischen ${lo}% und ${hi}% liegen – ich nehme ${use}%.`,
          en: `The on-chain stop range is ${lo}%-${hi}% - using ${use}%.`,
          hi: `ऑन-चेन स्टॉप-लॉस ${lo}% से ${hi}% के बीच होना चाहिए – मैं ${use}% इस्तेमाल कर रहा हूँ।`,
          zh: `链上止损范围是 ${lo}%–${hi}%，已改用 ${use}%。`,
        }));
        v = use;
      }
      settings.stopPctOverride = v;
    }
    changed.push(`stop=${settings.stopPctOverride ?? "auto"}`);
  }
  if (set.tpPct !== undefined) {
    settings.tpPctOverride = set.tpPct === null ? null : Math.min(P.maxTakeProfitPct, Math.max(0.2, set.tpPct));
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

async function rules(text, ctx, lang) {
  const t = text.toLowerCase();
  const { state, settings } = ctx;
  const T = (texts) => L(lang, texts);
  // a number with % (or "प्रतिशत" / "百分之") within a few characters after a keyword
  const pct = (re) => {
    const m = t.match(re);
    return m ? parseFloat(m[1].replace(",", ".")) : null;
  };
  const NUM = String.raw`(\d+(?:[.,]\d+)?)\s*(?:%|प्रतिशत|％)`;
  const near = (kw) => new RegExp(`(?:${kw})[^\\d]{0,14}?${NUM}`);

  // ---- commands
  if (
    /(close|schlie(ß|ss)e?|verkauf|exit).*(all|alles|everything|positionen)|alles (verkaufen|schließen)/.test(t) ||
    /सब(?:\s|ी\s)?.*(बंद|बेच)|सारी पोजीशन.*(बंद|बेच)|पोजीशन बंद/.test(t) ||
    /全部平仓|平仓|全部卖出|关闭所有|全部关闭/.test(t)
  ) {
    const n = state.positions.length;
    await ctx.engine.closeAll("closed via chat");
    return {
      reply: T({
        de: `Erledigt – ${n} Position(en) werden geschlossen.`,
        en: `Done - closing ${n} position(s).`,
        hi: `ठीक है – ${n} पोजीशन बंद की जा रही हैं।`,
        zh: `好的，正在平掉 ${n} 个仓位。`,
      }),
      changed: ["close_all"],
    };
  }
  if (
    (/\b(pause|pausier|stopp?(e)? (den )?(agent|trading|handel)|halt|hör auf|stop trading)\b/.test(t) && !/stop.?loss/.test(t)) ||
    /रोको|रुको|रोक दो|पॉज़|पॉज|ट्रेडिंग बंद/.test(t) ||
    /暂停|停止交易|别交易/.test(t)
  ) {
    apply({ agentPaused: true }, ctx, lang);
    return {
      reply: T({
        de: "Pausiert. Ich eröffne nichts Neues, aber offene Positionen bleiben durch Stop-Loss und Take-Profit on-chain geschützt.",
        en: "Paused. No new positions; open ones stay protected by their on-chain stop-loss and take-profit.",
        hi: "रुक गया। मैं कोई नई पोजीशन नहीं खोलूँगा, लेकिन खुली पोजीशन ऑन-चेन स्टॉप-लॉस और टेक-प्रॉफ़िट से सुरक्षित रहेंगी।",
        zh: "已暂停。不再开新仓，已有仓位仍由链上止损和止盈保护。",
      }),
      changed: ["paused"],
    };
  }
  if (/\b(start|weiter|resume|fortsetzen|los geht|go)\b/.test(t) || /फिर से शुरू|शुरू करो|चालू करो/.test(t) || /继续|恢复|开始交易/.test(t)) {
    apply({ agentPaused: false }, ctx, lang);
    return {
      reply: T({
        de: "Läuft wieder – ich suche nach Setups.",
        en: "Running again - scanning for setups.",
        hi: "फिर से चालू – मैं ट्रेडिंग के मौक़े ढूँढ रहा हूँ।",
        zh: "已恢复，正在寻找交易机会。",
      }),
      changed: ["resumed"],
    };
  }

  const patch = {};
  if (/(konservativ|vorsichtig|weniger risiko|risiko runter|safer|careful|conservative|less risk)/.test(t) || /सावधान|कम जोखिम|कम रिस्क/.test(t) || /保守|谨慎|小心|降低风险|低风险/.test(t)) patch.risk = "conservative";
  else if (/(aggressiv|mehr risiko|risiko hoch|more risk|aggressive|yolo)/.test(t) || /आक्रामक|ज़्यादा जोखिम|ज्यादा जोखिम|ज़्यादा रिस्क|ज्यादा रिस्क/.test(t) || /激进|提高风险|高风险/.test(t)) patch.risk = "aggressive";
  else if (/(ausgewogen|normal|balanced|standard)/.test(t) || /संतुलित/.test(t) || /平衡|均衡/.test(t)) patch.risk = "balanced";

  const stop = pct(near("stop.?(?:loss)?|स्टॉप.?लॉस|स्टॉप|止损"));
  if (stop !== null) patch.stopPct = stop;
  const tp = pct(near("take.?profit|\\btp\\b|gewinnziel|टेक.?प्रॉफ़िट|टेक.?प्रॉफिट|मुनाफ़ा लक्ष्य|止盈"));
  if (tp !== null) patch.tpPct = tp;
  const size = pct(near("position(?:sgr(?:ö|oe)(?:ß|ss)e)?|size|gr(?:ö|oe)(?:ß|ss)e|einsatz|पोजीशन|पोज़ीशन|साइज़|साइज|仓位"));
  if (size !== null && stop === null && tp === null) patch.positionPct = size;
  const spread = pct(near("spread|स्प्रेड|价差"));
  if (spread !== null) patch.spreadEntry = spread;
  if (/trailing.*(aus|off)|kein trailing/.test(t)) patch.trailing = false;
  else if (/trailing.*(an|on)/.test(t)) patch.trailing = true;

  // market selection: "nur eth", "only btc and eth", "kein hsk", "सिर्फ़ ETH", "只交易比特币"
  const mentioned = [
    ...new Set([
      ...[...t.matchAll(/\b(hsk|whsk|eth|weth|ether|ethereum|btc|wbtc|bitcoin)\b/g)].map((m) => SYM[m[1]]),
      ...SYM_INTL.filter(([re]) => re.test(t)).map(([, s]) => s),
    ]),
  ];
  // "trade HSK", "handel nur ETH", "kauf BTC", "HSK ट्रेड करो", "交易比特币" also mean: focus on these markets
  const tradeVerb = /\b(trade|trading|handel\w*|kauf\w*|buy)\b/.test(t) || /ट्रेड|ख़रीद|खरीद/.test(t) || /交易|买/.test(t);
  if (mentioned.length) {
    if (/\b(nur|only|just|ausschließlich)\b/.test(t) || /सिर्फ़|सिर्फ|केवल/.test(t) || /只|仅/.test(t)) {
      patch.markets = { WHSK: false, WETH: false, WBTC: false, ...Object.fromEntries(mentioned.map((s) => [s, true])) };
    } else if (/\b(kein|keine|ohne|no|without|not|nicht|disable)\b/.test(t) || /नहीं|बिना|मत/.test(t) || /不要|不|别|除了/.test(t)) {
      patch.markets = Object.fromEntries(mentioned.map((s) => [s, false]));
    } else if (/\b(auch|also|wieder|enable|add)\b/.test(t) || /भी|फिर से/.test(t) || /也|加上|恢复/.test(t)) {
      patch.markets = Object.fromEntries(mentioned.map((s) => [s, true]));
    } else if (tradeVerb) {
      patch.markets = { WHSK: false, WETH: false, WBTC: false, ...Object.fromEntries(mentioned.map((s) => [s, true])) };
    }
  }
  // "buy HSK now", "kauf jetzt ETH", "अभी BTC ख़रीदो", "现在买入比特币": open a position right away
  const buyNow =
    mentioned.length > 0 &&
    ((/\b(buy|kauf\w*)\b/.test(t) && /\b(now|jetzt|sofort|right away)\b/.test(t)) || /अभी.*(ख़रीद|खरीद)|(ख़रीद|खरीद).*अभी/.test(t) || /(现在|立即|马上).*买|买.*(现在|立即|马上)/.test(t));

  if (/(alle märkte|alles handeln|trade everything|all markets)/.test(t) || /सभी बाज़ार|सभी बाजार|सब मार्केट|सभी मार्केट/.test(t) || /所有市场|全部市场|全部交易/.test(t)) {
    patch.markets = { WHSK: true, WETH: true, WBTC: true };
  }

  if (Object.keys(patch).length || buyNow) {
    const r = apply(patch, ctx, lang);
    const parts = [];
    if (r.changed.length) {
      parts.push(T({ de: "Erledigt. Neu: ", en: "Done. New settings: ", hi: "हो गया। नई सेटिंग्स: ", zh: "已更新：" }) + r.changed.map((c) => describe(c, lang)).join(" · ") + T({ de: ".", en: ".", hi: "।", zh: "。" }));
    }
    parts.push(...r.warnings);
    if ((patch.stopPct !== undefined || patch.tpPct !== undefined) && state.positions.length) {
      parts.push(T({
        de: "Gilt für neue Positionen; offene behalten ihren On-Chain-Stop (der kann nur angehoben werden).",
        en: "This applies to new positions; open ones keep their on-chain stop (it can only be raised).",
        hi: "यह नई पोजीशन पर लागू होगा; खुली पोजीशन का ऑन-चेन स्टॉप वैसा ही रहेगा (उसे सिर्फ़ ऊपर किया जा सकता है)।",
        zh: "新设置适用于新仓位；已有仓位保留链上止损（只能上调）。",
      }));
    }
    if (buyNow) {
      const sym = mentioned[0];
      const tr = await ctx.engine.forceOpen(sym, `user order via chat: "${text.slice(0, 60)}"`);
      const name = DISPLAY[sym];
      if (tr?.ok) {
        const sl = (tr.stopTicks / 100).toFixed(2);
        const tp = (tr.tpTicks / 100).toFixed(2);
        const size = fmt(tr.size, 0);
        parts.push(T({
          de: `Gekauft: ${name} für ${size} USDT · Stop −${sl}% · Take-Profit +${tp}% (on-chain).`,
          en: `Bought ${name} for ${size} USDT · stop −${sl}% · take-profit +${tp}% (on-chain).`,
          hi: `${name} ख़रीदा: ${size} USDT · स्टॉप −${sl}% · टेक-प्रॉफ़िट +${tp}% (ऑन-चेन)।`,
          zh: `已买入 ${name}：${size} USDT · 止损 −${sl}% · 止盈 +${tp}%（链上）。`,
        }));
      } else {
        const why = explainRefusal(tr?.error || "?", lang);
        parts.push(T({
          de: `Kauf von ${name} abgelehnt: ${why}. Das prüft der Contract, nicht ich.`,
          en: `Buying ${name} was refused: ${why}. That check is the contract's, not mine.`,
          hi: `${name} की ख़रीद अस्वीकृत: ${why}। यह जाँच कॉन्ट्रैक्ट करता है, मैं नहीं।`,
          zh: `买入 ${name} 被拒绝：${why}。这是合约的检查，不是我的。`,
        }));
      }
    }
    return { reply: parts.join(" "), changed: [...r.changed, ...(buyNow ? ["buy"] : [])] };
  }

  // ---- "why are you not trading?"
  if (
    /(warum|wieso|why).*(nicht|nichts|kein|not|nothing|no trade)|(macht|tust|tut) (nichts|nix)|doing nothing|not trading/.test(t) ||
    /क्यों.*(नहीं|कुछ नहीं)|कुछ नहीं कर/.test(t) ||
    /为什么.*(不|没)|没有交易|不交易/.test(t)
  ) {
    const w = ctx.engine.council.waiting;
    const on = Object.entries(settings.markets).filter(([, v]) => v).map(([k]) => DISPLAY[k]).join(", ");
    if (settings.agentPaused) {
      return {
        reply: T({
          de: "Ich bin pausiert. Schreib „weiter“, dann suche ich wieder nach Setups.",
          en: "I'm paused. Say \"resume\" and I'll look for setups again.",
          hi: "मैं रुका हुआ हूँ। „फिर से शुरू करो“ लिखिए, फिर मैं दोबारा मौक़े ढूँढूँगा।",
          zh: "我目前处于暂停状态。输入「继续」，我就会重新寻找机会。",
        }),
        changed: [],
      };
    }
    if (w) {
      const name = DISPLAY[w.sym];
      const s = fmt(w.score);
      const need = fmt(w.threshold);
      return {
        reply: T({
          de: `Ich warte auf ein Signal. Bestes Setup gerade: ${name} mit Score ${s}, im Profil „${settings.risk}“ brauche ich ${need}. Aktive Märkte: ${on}. Wenn du mehr Trades willst: „aggressiver“ oder „alle Märkte wieder“.`,
          en: `I'm waiting for an edge. Best setup right now: ${name} at score ${s}; the "${settings.risk}" profile needs ${need}. Active markets: ${on}. For more trades say "more aggressive" or "trade everything again".`,
          hi: `मैं सही मौक़े का इंतज़ार कर रहा हूँ। अभी सबसे अच्छा सेटअप: ${name}, स्कोर ${s}; „${settings.risk}“ प्रोफ़ाइल को ${need} चाहिए। सक्रिय बाज़ार: ${on}। ज़्यादा ट्रेड चाहिए तो „आक्रामक“ या „सभी बाज़ार“ लिखिए।`,
          zh: `我在等待交易机会。目前最好的机会：${name}，评分 ${s}；「${settings.risk}」模式需要 ${need}。当前市场：${on}。想要更多交易，请说「激进」或「所有市场」。`,
        }),
        changed: [],
      };
    }
  }

  // ---- "what just happened?" -> explain the latest notable events
  if (/(passiert|happened|warum|why|erklär|explain)/.test(t) || /क्या हुआ|क्यों|समझाओ/.test(t) || /发生了什么|为什么|解释/.test(t)) {
    const ev = ctx.engine.feedLog.filter((l) => l.tone !== "info" && l.role !== "You").slice(-4);
    if (ev.length) {
      return {
        reply:
          T({ de: "Das Wichtigste der letzten Minuten:\n", en: "The latest notable events:\n", hi: "पिछले कुछ मिनटों की मुख्य घटनाएँ:\n", zh: "最近几分钟的重要事件：\n" }) +
          ev.map((l) => `• ${l.role}: ${l.text}`).join("\n"),
        changed: [],
      };
    }
  }

  // ---- questions -> status
  const lines = [];
  const pnl = state.equity - state.dayStartEquity;
  const eq = fmtUsd(state.equity);
  const today = `${pnl >= 0 ? "+" : ""}${fmt(pnl)}`;
  const real = fmt(state.realizedPnl);
  lines.push(T({
    de: `Kapital ${eq} USDT (heute ${today}), realisiert ${real} USDT.`,
    en: `Equity ${eq} USDT (today ${today}), realized ${real} USDT.`,
    hi: `पूँजी ${eq} USDT (आज ${today}), रियलाइज़्ड ${real} USDT।`,
    zh: `资产 ${eq} USDT（今日 ${today}），已实现盈亏 ${real} USDT。`,
  }));
  if (!state.positions.length) lines.push(T({ de: "Keine offenen Positionen.", en: "No open positions.", hi: "कोई खुली पोजीशन नहीं है।", zh: "目前没有持仓。" }));
  for (const p of state.positions) {
    lines.push(`${DISPLAY[p.sym]}: ${fmt(p.quoteIn, 0)} USDT, ${p.pnlPct >= 0 ? "+" : ""}${fmt(p.pnlPct)}% · stop ${fmtPrice(p.stopPrice)} · TP ${fmtPrice(p.tpPrice)}`);
  }
  const prof = settings.risk;
  const per = settings.positionPct;
  lines.push(T({
    de: `Profil: ${prof}, ${per}% pro Trade. Sag z. B. „vorsichtiger“, „Stop 3%“, „nur ETH“ oder „alles schließen“.`,
    en: `Profile: ${prof}, ${per}% per trade. Try "more careful", "stop 3%", "only ETH" or "close everything".`,
    hi: `प्रोफ़ाइल: ${prof}, हर ट्रेड में ${per}%। उदाहरण: „सावधान रहो“, „स्टॉप लॉस 3%“, „सिर्फ़ ETH“ या „सब पोजीशन बंद करो“।`,
    zh: `模式：${prof}，每笔 ${per}%。可以说：「保守一点」「止损3%」「只交易ETH」或「全部平仓」。`,
  }));
  return { reply: lines.join("\n"), changed: [] };
}
