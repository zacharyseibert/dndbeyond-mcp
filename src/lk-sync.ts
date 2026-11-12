/**
 * LegendKeeper sync: copies every wiki page the API key can see into
 * ~/.dndbeyond-mcp/notes/legendkeeper/ as Markdown, so the Discord Q&A bot can
 * search the campaign wiki alongside recaps and transcripts.
 *
 * Uses LegendKeeper's v3 REST API (project API key, paid plan). Use a key made
 * by a PLAYER account: keys never exceed their creator's rights, so a player
 * key can't see GM secrets or hidden pages, and none can leak into the bot.
 *
 *   pm2 start "node --env-file=$HOME/.dndbeyond-mcp/lorekeeper.env build/src/lk-sync.js" --name lk-sync
 *
 * Env: LEGENDKEEPER_API_KEY (required), LEGENDKEEPER_PROJECT_ID (optional),
 *      LK_SYNC_INTERVAL_MS (default 1 hour), LK_SYNC_ONCE=1 to run once and exit.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notesDir } from "./archive/notes.js";

const BASE = (process.env.LEGENDKEEPER_BASE_URL || "https://www.legendkeeper.com").replace(/\/$/, "") + "/api/v3";
const KEY = process.env.LEGENDKEEPER_API_KEY;
const INTERVAL = Number(process.env.LK_SYNC_INTERVAL_MS || 3_600_000);
const outDir = () => join(notesDir(), "legendkeeper");

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(BASE + (path.endsWith("/") ? path : path + "/"));
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } });
    if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2 ** attempt * 1000;
      await sleep(wait);
      continue;
    }
    throw new Error(`LegendKeeper ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function listAll(path: string): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api<{ data?: any[]; nextCursor?: string; hasMore?: boolean }>(path, { limit: 100, cursor });
    items.push(...(page?.data ?? []));
    if (!page?.hasMore || !page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";

async function projectId(): Promise<string> {
  if (process.env.LEGENDKEEPER_PROJECT_ID) return process.env.LEGENDKEEPER_PROJECT_ID;
  const page = await api<{ data?: Array<{ id: string; name?: string }> }>("/projects", { limit: 1 });
  const p = page?.data?.[0];
  if (!p) throw new Error("This API key can't see any LegendKeeper project.");
  log(`project: ${p.name ?? "?"} (${p.id})`);
  return String(p.id);
}

async function syncOnce(): Promise<void> {
  const pid = await projectId();
  const base = `/projects/${encodeURIComponent(pid)}`;
  const resources = await listAll(`${base}/resources`);
  const byId = new Map(resources.map((r) => [r.id, r]));
  const pathOf = (r: any): string => {
    const names: string[] = [];
    let cur = r.parentId ? byId.get(r.parentId) : undefined;
    while (cur && names.length < 10) {
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return names.join(" / ");
  };

  mkdirSync(outDir(), { recursive: true });
  const written = new Set<string>();
  let pages = 0;
  for (const r of resources) {
    if (r.isTemplate || r.template || r.isHidden) continue;
    let docs: any[] = [];
    try {
      docs = (await api<{ data?: any[] }>(`${base}/resources/${r.id}/docs`))?.data ?? [];
    } catch (err) {
      log(`skip ${r.name}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const parts: string[] = [];
    for (const d of docs.filter((d) => d.type === "page")) {
      try {
        const data = await api<{ text?: string }>(`${base}/resources/${r.id}/docs/${d.id}/blocks`);
        const text = String(data?.text ?? "").trim();
        if (text) parts.push(docs.length > 1 ? `## ${d.name}\n\n${text}` : text);
      } catch (err) {
        log(`skip ${r.name} / ${d.name}: ${err instanceof Error ? err.message : err}`);
      }
      await sleep(150); // be polite to the API
    }
    if (parts.length === 0) continue;
    const file = `${slug(r.name)}-${String(r.id).slice(0, 8)}.md`;
    const where = pathOf(r);
    const aliases = Array.isArray(r.aliases) && r.aliases.length ? `\nAlso known as: ${r.aliases.join(", ")}` : "";
    writeFileSync(
      join(outDir(), file),
      `# ${r.name}\n\nLegendKeeper wiki${where ? `: ${where}` : ""}${aliases}\n\n${parts.join("\n\n")}\n`
    );
    written.add(file);
    pages++;
  }

  // Remove pages that were deleted or hidden in LegendKeeper since the last sync
  let removed = 0;
  if (existsSync(outDir())) {
    for (const f of readdirSync(outDir())) {
      if (f.endsWith(".md") && !written.has(f)) {
        rmSync(join(outDir(), f));
        removed++;
      }
    }
  }
  log(`synced ${pages} pages from ${resources.length} resources${removed ? `, removed ${removed} stale` : ""}`);
}

async function loop(): Promise<void> {
  try {
    await syncOnce();
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (process.env.LK_SYNC_ONCE) return;
  setTimeout(loop, INTERVAL);
}

if (!KEY) {
  console.error("LEGENDKEEPER_API_KEY is not set.");
  process.exit(1);
}
log(`LegendKeeper sync started, every ${INTERVAL / 60_000} min`);
void loop();
