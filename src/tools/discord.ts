/**
 * Post to the campaign's Discord through a webhook, so scheduled runs on the
 * Mac mini can share recaps and pre-session reminders with the table.
 *
 * The webhook URL lives in ~/.dndbeyond-mcp/lorekeeper.env as
 * DISCORD_RECAP_WEBHOOK=https://discord.com/api/webhooks/...
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

function webhookUrl(): string | undefined {
  if (process.env.DISCORD_RECAP_WEBHOOK) return process.env.DISCORD_RECAP_WEBHOOK;
  const p = join(process.env.DNDBEYOND_ARCHIVE_DIR || join(homedir(), ".dndbeyond-mcp"), "lorekeeper.env");
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^DISCORD_RECAP_WEBHOOK=(.+)$/);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Split on paragraph breaks into Discord-sized (<= 1900 char) messages. */
export function chunkMessage(body: string, max = 1900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of body.split(/\n{2,}/)) {
    const piece = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? [] : [para];
    for (const p of piece) {
      if (cur && cur.length + p.length + 2 > max) {
        out.push(cur);
        cur = "";
      }
      cur += (cur ? "\n\n" : "") + p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export async function postToDiscord(params: { message: string }): Promise<ToolResult> {
  const url = webhookUrl();
  if (!url) return text("No Discord webhook set. Add DISCORD_RECAP_WEBHOOK=... to ~/.dndbeyond-mcp/lorekeeper.env");
  const parts = chunkMessage(params.message.trim());
  for (const [i, content] of parts.entries()) {
    const res = await fetch(url + "?wait=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, username: "Tinklerbot", allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) return text(`Discord rejected part ${i + 1} of ${parts.length}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 600));
  }
  return text(`Posted to Discord in ${parts.length} message(s).`);
}
