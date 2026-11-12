/**
 * Game log archiver: a small always-on process (run under pm2 on the Mac mini).
 *
 * Every minute it pulls the game log for each active campaign and appends new
 * rolls to ~/.dndbeyond-mcp/gamelog-<campaignId>.jsonl, so no roll is lost when
 * D&D Beyond's short log window rolls over during a long session.
 *
 *   pm2 start build/src/archiver.js --name dnd-archiver
 */
import { TtlCache } from "./cache/lru.js";
import { CircuitBreaker, RateLimiter } from "./resilience/index.js";
import { DdbClient } from "./api/client.js";
import { ENDPOINTS } from "./api/endpoints.js";
import { getUserId } from "./api/auth.js";
import { appendToArchive, archivePath } from "./archive/gamelog-archive.js";
import type { DdbCampaign } from "./types/api.js";

const INTERVAL_MS = Number(process.env.ARCHIVE_INTERVAL_MS || 60_000);

const client = new DdbClient(
  new TtlCache<unknown>(1_000),
  new CircuitBreaker(5, 60_000),
  new RateLimiter(1, 1000)
);

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

let campaignIds: number[] = [];
let campaignsLoadedAt = 0;

async function loadCampaigns(): Promise<number[]> {
  // Refresh the campaign list hourly; it rarely changes.
  if (campaignIds.length > 0 && Date.now() - campaignsLoadedAt < 3_600_000) return campaignIds;
  const campaigns = await client.get<DdbCampaign[]>(ENDPOINTS.campaign.list(), `archiver:campaigns:${Date.now()}`, 1);
  campaignIds = (campaigns ?? []).map((c) => c.id);
  campaignsLoadedAt = Date.now();
  log(`campaigns: ${campaignIds.join(", ") || "none"}`);
  return campaignIds;
}

async function tick(): Promise<void> {
  const userId = await getUserId();
  if (!userId) {
    log("no User.ID cookie in ~/.dndbeyond-mcp/config.json; skipping");
    return;
  }
  for (const id of await loadCampaigns()) {
    const resp = await client.getRaw<{ data?: Array<Record<string, unknown>> }>(
      ENDPOINTS.gameLog.messages(id, userId),
      `archiver:log:${id}:${Date.now()}`,
      1
    );
    const added = appendToArchive(id, (resp?.data ?? []) as never);
    if (added > 0) log(`campaign ${id}: +${added} new (${archivePath(id)})`);
  }
}

async function loop(): Promise<void> {
  try {
    await tick();
  } catch (err) {
    log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  setTimeout(loop, INTERVAL_MS);
}

log(`game log archiver started, every ${INTERVAL_MS / 1000}s`);
void loop();
