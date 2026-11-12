/**
 * Local archive of the D&D Beyond game log.
 *
 * The game log API only returns the most recent ~50 messages, so a long session
 * loses its early rolls within hours. The archiver (src/archiver.ts) polls the
 * log every minute and appends every new message here, one JSON object per line.
 * The game log, recap, stats and story tools merge this archive with the live log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function archiveDir(): string {
  return process.env.DNDBEYOND_ARCHIVE_DIR || join(homedir(), ".dndbeyond-mcp");
}

export function archivePath(campaignId: number | string): string {
  return join(archiveDir(), `gamelog-${campaignId}.jsonl`);
}

/** Same key the tools dedupe on: one roll per rollId, whatever tab it came from. */
export function messageKey(m: { id?: string; dateTime?: unknown; data?: unknown }): string {
  const data = m.data as { rollId?: string; setId?: string } | undefined;
  return data?.rollId ?? m.id ?? JSON.stringify([m.dateTime, data?.setId]);
}

export function readArchive<T = Record<string, unknown>>(campaignId: number | string): T[] {
  const path = archivePath(campaignId);
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip a partial line (e.g. written during a crash)
    }
  }
  return out;
}

/** Append messages not already archived. Returns how many were new. */
export function appendToArchive(
  campaignId: number | string,
  messages: Array<{ id?: string; dateTime?: unknown; data?: unknown }>
): number {
  mkdirSync(archiveDir(), { recursive: true });
  const seen = new Set(readArchive(campaignId).map((m) => messageKey(m as never)));
  const fresh = messages.filter((m) => {
    const k = messageKey(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (fresh.length > 0) {
    appendFileSync(archivePath(campaignId), fresh.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }
  return fresh.length;
}
