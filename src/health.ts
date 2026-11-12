/**
 * Health checks for everything the campaign pipeline runs on the Mac mini.
 * Used by Tinklerbot's /status command and its watchdog alerts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DdbClient } from "./api/client.js";
import { ENDPOINTS } from "./api/endpoints.js";
import { openParley } from "./tools/sessions.js";

const dataDir = () => process.env.DNDBEYOND_ARCHIVE_DIR || join(homedir(), ".dndbeyond-mcp");

/** Long-running jobs call this after each successful pass. */
export function writeHeartbeat(name: string, detail: string): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(join(dataDir(), `heartbeat-${name}.json`), JSON.stringify({ at: Date.now(), detail }));
  } catch {
    // never let a heartbeat break the job
  }
}

function readHeartbeat(name: string): { at: number; detail: string } | null {
  const p = join(dataDir(), `heartbeat-${name}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export interface Check {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  /** What to do about it, shown when not ok */
  fix?: string;
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

async function httpUp(url: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function runChecks(ddb: DdbClient): Promise<Check[]> {
  const checks: Check[] = [];

  // D&D Beyond login (the cookie expires every so often)
  try {
    const campaigns = await ddb.get<Array<{ name: string }>>(ENDPOINTS.campaign.list(), `health:campaigns:${Date.now()}`, 1);
    checks.push({ id: "ddb", name: "D&D Beyond login", ok: true, detail: `${campaigns?.length ?? 0} campaign(s) visible` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const expired = /401|403|auth|expired|unauthor/i.test(msg);
    checks.push({
      id: "ddb",
      name: "D&D Beyond login",
      ok: false,
      detail: expired ? "login cookie expired or rejected" : msg.slice(0, 120),
      fix: expired ? "Copy a fresh CobaltSession cookie from Safari into ~/.dndbeyond-mcp/config.json" : undefined,
    });
  }

  // Parley (the recorder bot) and its speech engine
  const parleyUrl = process.env.PARLEY_DASHBOARD_URL || "http://127.0.0.1:3001";
  const parleyUp = await httpUp(parleyUrl);
  checks.push({ id: "parley", name: "Parley recorder", ok: parleyUp, detail: parleyUp ? "running" : "not responding", fix: parleyUp ? undefined : "pm2 restart parley-bot" });

  const sttUp = await httpUp((process.env.STT_URL || "http://127.0.0.1:8000") + "/health");
  checks.push({ id: "stt", name: "Speech engine", ok: sttUp, detail: sttUp ? "running" : "not responding", fix: sttUp ? undefined : "pm2 restart parley-stt" });

  // Ollama (answers questions; Parley's summarizer)
  const ollama = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  try {
    const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(4000) });
    const tags = (await res.json()) as { models?: Array<{ name: string }> };
    const want = process.env.LOREKEEPER_MODEL || "qwen2.5:14b";
    const have = (tags.models ?? []).some((m) => m.name === want || m.name.startsWith(want));
    checks.push({ id: "ollama", name: "Local AI (Ollama)", ok: have, detail: have ? `${want} ready` : `${want} not installed`, fix: have ? undefined : `ollama pull ${want}` });
  } catch {
    checks.push({ id: "ollama", name: "Local AI (Ollama)", ok: false, detail: "not responding", fix: "brew services restart ollama" });
  }

  // Background jobs report a heartbeat after each pass
  const arch = readHeartbeat("archiver");
  const archOk = !!arch && Date.now() - arch.at < 10 * 60_000;
  checks.push({
    id: "archiver",
    name: "Dice log archiver",
    ok: archOk,
    detail: arch ? `last pass ${ago(arch.at)} (${arch.detail})` : "no heartbeat yet",
    fix: archOk ? undefined : "pm2 restart dnd-archiver (and check the D&D Beyond login)",
  });

  if (process.env.LEGENDKEEPER_API_KEY) {
    const lk = readHeartbeat("lk-sync");
    const lkOk = !!lk && Date.now() - lk.at < 3 * 3_600_000;
    checks.push({
      id: "lk-sync",
      name: "LegendKeeper sync",
      ok: lkOk,
      detail: lk ? `last sync ${ago(lk.at)} (${lk.detail})` : "no successful sync yet",
      fix: lkOk ? undefined : "pm2 logs lk-sync",
    });
  }

  const bk = readHeartbeat("backup");
  if (bk) {
    const bkOk = Date.now() - bk.at < 36 * 3_600_000;
    checks.push({ id: "backup", name: "Nightly backup", ok: bkOk, detail: `last run ${ago(bk.at)} (${bk.detail})`, fix: bkOk ? undefined : "pm2 logs nightly-backup" });
  }

  // Last recording: did it finish transcribing?
  const db = await openParley();
  if (typeof db !== "string") {
    try {
      const m = db.prepare("SELECT id, status, ended_at, started_at FROM meetings ORDER BY started_at DESC LIMIT 1").get() as
        | { id: number; status: string; ended_at: string | null; started_at: string }
        | undefined;
      if (m) {
        const end = Date.parse(m.ended_at ?? m.started_at);
        const stuck = m.status !== "done" && Date.now() - end > 6 * 3_600_000;
        checks.push({
          id: "last-recording",
          name: "Last recording",
          ok: !stuck,
          detail: `session ${m.id} ${m.status}, ${ago(Date.parse(m.started_at))}`,
          fix: stuck ? `Open the Parley dashboard and click Retry on session ${m.id}` : undefined,
        });
      }
    } finally {
      db.close();
    }
  }

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const bad = checks.filter((c) => !c.ok);
  const head = bad.length === 0 ? "**All systems go.**" : `**${bad.length} problem${bad.length > 1 ? "s" : ""}:**`;
  const lines = checks.map((c) => `${c.ok ? "✅" : "❌"} **${c.name}**: ${c.detail}${!c.ok && c.fix ? `\n  ↳ Fix: \`${c.fix}\`` : ""}`);
  return `${head}\n${lines.join("\n")}`;
}
