// Optional LLM layer. Works with the Anthropic API (ANTHROPIC_API_KEY) or any OpenAI-compatible
// endpoint (LLM_BASE_URL + LLM_API_KEY + LLM_MODEL). Without a key, the agent runs fully deterministic.
import { config } from "./config.js";

export function llmEnabled() {
  return !!(config.llm.anthropicKey || (config.llm.baseUrl && config.llm.model));
}

export function llmName() {
  if (config.llm.anthropicKey) return config.llm.anthropicModel;
  if (config.llm.baseUrl) return config.llm.model;
  return null;
}

async function complete(system, user, maxTokens = 400) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    if (config.llm.anthropicKey) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": config.llm.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.llm.anthropicModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || r.status);
      return j.content?.map((c) => c.text || "").join("") || "";
    }
    const r = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey || ""}` },
      body: JSON.stringify({
        model: config.llm.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || r.status);
    return j.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

/** Ask for a JSON object; returns null on any failure (callers always have a deterministic fallback). */
export async function llmJson(system, payload, maxTokens = 400) {
  if (!llmEnabled()) return null;
  try {
    const text = await complete(system, JSON.stringify(payload), maxTokens);
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn("[llm]", e.message);
    return null;
  }
}
