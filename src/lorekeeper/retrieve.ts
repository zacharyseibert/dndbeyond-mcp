/**
 * Finds the parts of past sessions that answer a question.
 *
 * Searches Parley's full-text index for the question's key words, widens each
 * hit to the conversation around it, adds the D&D Beyond rolls from those same
 * minutes, and returns labelled excerpts the model can quote and cite.
 */
import { applyGlossary, clock, day, loadGlossary, openParley, type SqliteDb } from "../tools/sessions.js";
import { readArchive } from "../archive/gamelog-archive.js";
import { listNotes, searchNotes } from "../archive/notes.js";

interface Hit { id: number; meeting_id: number; start_ms: number }
interface Utt { meeting_id: number; display_name: string; start_ms: number; text: string }
interface Roll {
  dateTime?: string;
  eventType?: string;
  data?: {
    action?: string;
    context?: { name?: string };
    rolls?: Array<{ rollType?: string; rollKind?: string; result?: { total?: number; values?: number[] } }>;
  };
}

const STOP = new Set(
  ("a an and are as at be but by did do does for from had has have how i if in is it its me my of on or our so " +
    "that the their them then there they this to us was we were what when where which who why will with you your " +
    "about after again all also any back can could get got just know last like make more much need now off one " +
    "out over said say see should some still tell than thing think time up very want way well went would yeah okay")
    .split(" ")
);

const WINDOW_MS = 90_000; // conversation kept either side of a hit
const MAX_CHARS = 24_000; // excerpt budget handed to the model

function keywords(question: string, aliases: Record<string, string>): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/'s$/, "").replace(/'/g, ""))
    .filter((w) => w.length > 2 && !STOP.has(w));
  // Also search the misheard spellings the glossary maps to a name, e.g. "barobia" for "barovia"
  const extra: string[] = [];
  for (const [heard, real] of Object.entries(aliases)) {
    if (words.includes(real.toLowerCase())) extra.push(...heard.toLowerCase().split(/\s+/));
  }
  return [...new Set([...words, ...extra])].slice(0, 12);
}

function wantsLatestSession(q: string): boolean {
  return /\b(last|latest|previous|recent)\b.*\b(session|time|game|night|week)\b|\brecap\b/i.test(q);
}

function rollLine(r: Roll): string {
  const who = r.data?.context?.name ?? "someone";
  const parts = (r.data?.rolls ?? []).map((x) => {
    const kind = x.rollKind ? ` (${x.rollKind})` : "";
    return `${x.rollType ?? "roll"}${kind} = ${x.result?.total ?? "?"}${x.result?.values?.includes(20) && x.rollType !== "damage" ? " [natural 20]" : ""}${x.result?.values?.includes(1) && x.rollType !== "damage" ? " [natural 1]" : ""}`;
  });
  return `${who} rolled ${r.data?.action ?? "dice"}: ${parts.join("; ")}`;
}

export interface Retrieved {
  excerpts: string;
  sources: string[];
  found: boolean;
}

async function retrieveTranscripts(question: string, campaignId: number | undefined, budget: number): Promise<Retrieved> {
  const db = await openParley();
  if (typeof db === "string") return { excerpts: "", sources: [], found: false };
  const g = loadGlossary();
  try {
    const windows: Array<{ meeting: number; from: number; to: number }> = [];

    if (wantsLatestSession(question)) {
      const latest = db
        .prepare("SELECT meeting_id, MIN(start_ms) AS a, MAX(end_ms) AS b FROM utterances GROUP BY meeting_id ORDER BY a DESC LIMIT 1")
        .get() as { meeting_id: number; a: number; b: number } | undefined;
      if (latest) windows.push({ meeting: latest.meeting_id, from: latest.a, to: latest.b });
    }

    const terms = keywords(question, g.replacements);
    if (terms.length > 0) {
      const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
      let hits: Hit[] = [];
      try {
        hits = db
          .prepare(
            `SELECT u.id, u.meeting_id, u.start_ms FROM utterances_fts f JOIN utterances u ON u.id = f.rowid
             WHERE utterances_fts MATCH ? ORDER BY bm25(utterances_fts) LIMIT 15`
          )
          .all(match) as Hit[];
      } catch {
        hits = [];
      }
      for (const h of hits) windows.push({ meeting: h.meeting_id, from: h.start_ms - WINDOW_MS, to: h.start_ms + WINDOW_MS });
    }

    if (windows.length === 0) return { excerpts: "", sources: [], found: false };

    // Merge overlapping windows within the same session
    windows.sort((a, b) => a.meeting - b.meeting || a.from - b.from);
    const merged: typeof windows = [];
    for (const w of windows) {
      const last = merged.at(-1);
      if (last && last.meeting === w.meeting && w.from <= last.to) last.to = Math.max(last.to, w.to);
      else merged.push({ ...w });
    }

    const rolls = campaignId ? readArchive<Roll>(campaignId).filter((r) => r.eventType === "dice/roll/fulfilled") : [];
    const blocks: string[] = [];
    const sources: string[] = [];
    let used = 0;
    // Newest sessions first, so recent context wins the budget
    for (const w of merged.sort((a, b) => b.from - a.from)) {
      const utts = db
        .prepare("SELECT meeting_id, display_name, start_ms, text FROM utterances WHERE meeting_id = ? AND start_ms BETWEEN ? AND ? ORDER BY start_ms")
        .all(w.meeting, w.from, w.to) as Utt[];
      if (utts.length === 0) continue;
      const lines = [
        ...utts.map((u) => ({ ms: u.start_ms, s: `${g.speakers[u.display_name] ?? u.display_name}: ${applyGlossary(u.text, g)}` })),
        ...rolls
          .filter((r) => Number(r.dateTime) >= w.from && Number(r.dateTime) <= w.to)
          .map((r) => ({ ms: Number(r.dateTime), s: `[dice] ${rollLine(r)}` })),
      ].sort((a, b) => a.ms - b.ms);
      const label = `Session ${w.meeting}, ${day(utts[0].start_ms)} around ${clock(utts[0].start_ms)}`;
      let block = `### ${label}\n${lines.map((l) => `[${clock(l.ms)}] ${l.s}`).join("\n")}`;
      if (used + block.length > budget) {
        const room = budget - used;
        if (room < 800) break;
        block = block.slice(0, room) + "\n[...]";
      }
      blocks.push(block);
      sources.push(label);
      used += block.length;
    }
    return { excerpts: blocks.join("\n\n"), sources, found: blocks.length > 0 };
  } finally {
    (db as SqliteDb).close();
  }
}

const NOTES_BUDGET = 8_000;

/** Notes first (curated, dense), then transcript excerpts with what budget is left. */
export async function retrieve(question: string, campaignId?: number): Promise<Retrieved> {
  const terms = keywords(question, {});
  const blocks: string[] = [];
  const sources: string[] = [];
  let used = 0;

  if (wantsLatestSession(question)) {
    const latest = listNotes().find((n) => n.date);
    if (latest) {
      const body = latest.text.slice(0, NOTES_BUDGET);
      blocks.push(`### Notes: ${latest.title} (${latest.date})\n${body}`);
      sources.push(`Notes ${latest.date}`);
      used += body.length;
    }
  }
  for (const hit of searchNotes(terms)) {
    if (used > NOTES_BUDGET) break;
    if (blocks.some((b) => b.includes(hit.chunk))) continue;
    const wiki = hit.note.file.startsWith("legendkeeper/");
    blocks.push(`### ${wiki ? "Wiki" : "Notes"}: ${hit.note.title}${hit.note.date ? ` (${hit.note.date})` : ""}\n${hit.chunk}`);
    const label = wiki ? `Wiki: ${hit.note.title}` : `Notes ${hit.note.date || hit.note.title}`;
    if (!sources.includes(label)) sources.push(label);
    used += hit.chunk.length;
  }

  const t = await retrieveTranscripts(question, campaignId, MAX_CHARS - Math.min(used, NOTES_BUDGET));
  if (t.found) {
    blocks.push(t.excerpts);
    sources.push(...t.sources);
  }
  return { excerpts: blocks.join("\n\n"), sources, found: blocks.length > 0 };
}
