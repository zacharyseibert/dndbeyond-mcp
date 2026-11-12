/**
 * Session transcripts from Parley (a self-hosted Discord recorder), woven
 * together with the D&D Beyond dice log.
 *
 * Parley stores per-speaker utterances in a local SQLite database
 * (default ~/parley-data/meetings.db, override with PARLEY_DB). Timestamps are
 * epoch milliseconds, the same clock as the game log, so rolls slot in exactly.
 *
 * Name fixes and speaker mapping live in ~/.dndbeyond-mcp/glossary.json:
 *   {
 *     "replacements": { "Barobia": "Barovia", "Irina": "Ireena" },
 *     "speakers": { "some_discord_name": "Lennie" }
 *   }
 *
 * Needs Node 22.5+ (built-in node:sqlite). On machines without Parley the tools
 * explain what's missing instead of failing.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DdbClient } from "../api/client.js";
import { fetchGameLog, formatRoll, isRoll, msgTime, who, type GameLogMessage } from "./game-log.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

interface Meeting {
  id: number;
  channel_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string;
}

interface Utterance {
  display_name: string;
  start_ms: number;
  end_ms: number;
  text: string;
}

interface Glossary {
  replacements: Record<string, string>;
  speakers: Record<string, string>;
}

function parleyDbPath(): string {
  return process.env.PARLEY_DB || join(homedir(), "parley-data", "meetings.db");
}

function loadGlossary(): Glossary {
  const path = join(process.env.DNDBEYOND_ARCHIVE_DIR || join(homedir(), ".dndbeyond-mcp"), "glossary.json");
  try {
    const g = JSON.parse(readFileSync(path, "utf8")) as Partial<Glossary>;
    return { replacements: g.replacements ?? {}, speakers: g.speakers ?? {} };
  } catch {
    return { replacements: {}, speakers: {} };
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function applyGlossary(s: string, g: Glossary): string {
  let out = s;
  // Longest first, so "Windshadow" is fixed before a shorter overlapping entry
  for (const [from, to] of Object.entries(g.replacements).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\b${escapeRe(from)}\\b`, "gi"), to);
  }
  return out;
}

// Minimal shape of node:sqlite's DatabaseSync that we use
interface SqliteDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  close(): void;
}

async function openParley(): Promise<SqliteDb | string> {
  const path = parleyDbPath();
  if (!existsSync(path)) {
    return `No Parley database at ${path}. Session transcripts are only available on the machine running Parley (set PARLEY_DB to override the path).`;
  }
  try {
    const mod = (await import("node:sqlite" as string)) as { DatabaseSync: new (p: string, o?: object) => SqliteDb };
    return new mod.DatabaseSync(path, { readOnly: true });
  } catch (err) {
    return `Couldn't open the Parley database (needs Node 22.5+ for node:sqlite): ${err instanceof Error ? err.message : String(err)}`;
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function day(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function pickMeeting(db: SqliteDb, sessionId?: number): Meeting | undefined {
  if (sessionId) return db.prepare("SELECT * FROM meetings WHERE id = ?").get(sessionId) as Meeting | undefined;
  return db
    .prepare("SELECT m.* FROM meetings m WHERE EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = m.id) ORDER BY m.started_at DESC LIMIT 1")
    .get() as Meeting | undefined;
}

function loadUtterances(db: SqliteDb, meetingId: number, g: Glossary): Utterance[] {
  const rows = db
    .prepare("SELECT display_name, start_ms, end_ms, text FROM utterances WHERE meeting_id = ? ORDER BY start_ms")
    .all(meetingId) as Utterance[];
  return rows.map((r) => ({
    ...r,
    display_name: g.speakers[r.display_name] ?? r.display_name,
    text: applyGlossary(r.text, g),
  }));
}

/** Merge consecutive lines by the same speaker into one paragraph. */
type Line = { ms: number; speaker: string; text: string; kind: "say" | "roll" };
function mergeLines(lines: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    const prev = out.at(-1);
    if (prev && l.kind === "say" && prev.kind === "say" && prev.speaker === l.speaker && l.ms - prev.ms < 60_000) {
      prev.text += " " + l.text;
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

function page(lines: string[], offset = 0, limit = 600): { body: string; note: string } {
  const slice = lines.slice(offset, offset + limit);
  const note =
    offset + slice.length < lines.length
      ? `\n\n*Showing lines ${offset + 1}–${offset + slice.length} of ${lines.length}. Call again with offset ${offset + slice.length} for more.*`
      : "";
  return { body: slice.join("\n"), note };
}

// ============================================================================

export async function listRecordedSessions(): Promise<ToolResult> {
  const db = await openParley();
  if (typeof db === "string") return text(db);
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.channel_name, m.started_at, m.ended_at, m.status,
                (SELECT COUNT(*) FROM utterances u WHERE u.meeting_id = m.id) AS lines,
                (SELECT COUNT(*) FROM attendees a WHERE a.meeting_id = m.id) AS people
         FROM meetings m ORDER BY m.started_at DESC LIMIT 50`
      )
      .all() as Array<Meeting & { lines: number; people: number }>;
    if (rows.length === 0) return text("No recorded sessions yet.");
    const out = rows.map((r) => {
      const start = r.started_at ? Date.parse(r.started_at) : 0;
      const end = r.ended_at ? Date.parse(r.ended_at) : start;
      const mins = Math.round((end - start) / 60_000);
      return `| ${r.id} | ${start ? `${day(start)} ${clock(start)}` : "?"} | ${mins} min | ${r.channel_name ?? "?"} | ${r.people} | ${r.lines} | ${r.status} |`;
    });
    return text(
      ["# Recorded sessions (Parley)", "", "| ID | Started | Length | Channel | People | Lines | Status |", "|---|---|---|---|---|---|---|", ...out].join("\n")
    );
  } finally {
    db.close();
  }
}

export async function getSessionTranscript(params: { sessionId?: number; offset?: number; limit?: number }): Promise<ToolResult> {
  const db = await openParley();
  if (typeof db === "string") return text(db);
  try {
    const m = pickMeeting(db, params.sessionId);
    if (!m) return text(params.sessionId ? `Session ${params.sessionId} not found.` : "No transcribed sessions yet.");
    const g = loadGlossary();
    const utts = loadUtterances(db, m.id, g);
    if (utts.length === 0) return text(`Session ${m.id} has no transcript yet (status: ${m.status}).`);
    const lines = mergeLines(utts.map((u) => ({ ms: u.start_ms, speaker: u.display_name, text: u.text, kind: "say" as const })))
      .map((l) => `[${clock(l.ms)}] **${l.speaker}:** ${l.text}`);
    const { body, note } = page(lines, params.offset, params.limit);
    return text(`# Session ${m.id} transcript: ${day(utts[0].start_ms)}\n\n${body}${note}`);
  } finally {
    db.close();
  }
}

export async function getSessionStory(
  client: DdbClient,
  params: { sessionId?: number; campaignId?: number; offset?: number; limit?: number }
): Promise<ToolResult> {
  const db = await openParley();
  if (typeof db === "string") return text(db);
  let meeting: Meeting | undefined;
  let utts: Utterance[] = [];
  try {
    meeting = pickMeeting(db, params.sessionId);
    if (!meeting) return text(params.sessionId ? `Session ${params.sessionId} not found.` : "No transcribed sessions yet.");
    utts = loadUtterances(db, meeting.id, loadGlossary());
  } finally {
    db.close();
  }
  if (utts.length === 0) return text(`Session ${meeting.id} has no transcript yet (status: ${meeting.status}).`);

  // Window: the recording, padded a few minutes either side
  const pad = 5 * 60_000;
  const from = (meeting.started_at ? Date.parse(meeting.started_at) : utts[0].start_ms) - pad;
  const to = (meeting.ended_at ? Date.parse(meeting.ended_at) : (utts.at(-1)?.end_ms ?? from)) + pad;

  const log = await fetchGameLog(client, params.campaignId, 5000, 50);
  const rolls: GameLogMessage[] = log.error ? [] : log.messages.filter((r) => isRoll(r) && msgTime(r) >= from && msgTime(r) <= to);

  const lines: Line[] = [
    ...utts.map((u) => ({ ms: u.start_ms, speaker: u.display_name, text: u.text, kind: "say" as const })),
    ...rolls.map((r) => ({
      ms: msgTime(r),
      speaker: who(r),
      text: `${r.data?.action ?? "Roll"}: ${(r.data?.rolls ?? []).map(formatRoll).join("; ")}`,
      kind: "roll" as const,
    })),
  ].sort((a, b) => a.ms - b.ms);

  const rendered = mergeLines(lines).map((l) =>
    l.kind === "roll" ? `[${clock(l.ms)}] 🎲 *${l.speaker}* · ${l.text}` : `[${clock(l.ms)}] **${l.speaker}:** ${l.text}`
  );
  const { body, note } = page(rendered, params.offset, params.limit);
  const header =
    `# Session ${meeting.id} story: ${day(utts[0].start_ms)}${log.campaignName ? ` · ${log.campaignName}` : ""}\n` +
    `*${utts.length} transcript lines and ${rolls.length} D&D Beyond rolls, in time order.` +
    (log.error ? ` Dice log unavailable: ${log.error}` : "") +
    `*\n`;
  return text(header + "\n" + body + note);
}
