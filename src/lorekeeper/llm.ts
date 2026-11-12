/**
 * The model that answers questions. Local Ollama by default (free, private);
 * set LOREKEEPER_PROVIDER=anthropic plus ANTHROPIC_API_KEY to use Claude instead.
 */
export interface LlmConfig {
  provider: "ollama" | "anthropic";
  model: string;
  ollamaUrl: string;
  anthropicKey?: string;
}

export function llmConfigFromEnv(env = process.env): LlmConfig {
  const provider = env.LOREKEEPER_PROVIDER === "anthropic" ? "anthropic" : "ollama";
  return {
    provider,
    model: env.LOREKEEPER_MODEL || (provider === "anthropic" ? "claude-haiku-5-5" : "qwen2.5:14b"),
    ollamaUrl: env.OLLAMA_URL || "http://127.0.0.1:11434",
    anthropicKey: env.ANTHROPIC_API_KEY,
  };
}

export async function complete(cfg: LlmConfig, system: string, user: string): Promise<string> {
  if (cfg.provider === "anthropic") {
    if (!cfg.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, max_tokens: 700, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  }

  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      // Ollama defaults to a small context window; excerpts need room
      options: { num_ctx: 16384, temperature: 0.2 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { message?: { content?: string } };
  return (json.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
