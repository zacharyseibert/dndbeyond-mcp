/**
 * Session notes: plain Markdown files in ~/.dndbeyond-mcp/notes/, named
 * YYYY-MM-DD-<slug>.md. They fill in history Parley didn't record (sessions
 * before it existed, things typed with /note, recaps pasted in by hand) and
 * are searched by the Q&A bot alongside the transcripts.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function notesDir(): string {
  return join(process.env.DNDBEYOND_ARCHIVE_DIR || join(homedir(), ".dndbeyond-mcp"), "notes");
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "notes";

export interface NoteFile {
  file: string;
  date: string; // YYYY-MM-DD from the file name, or "" if none
  title: string;
  text: string;
}

function readNoteDir(dir: string, prefix = ""): NoteFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const date = f.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      return { file: prefix + f, date, title: heading || f.replace(/\.(md|txt)$/, ""), text };
    });
}

/** Session notes (dated, newest first), then wiki pages synced from LegendKeeper. */
export function listNotes(): NoteFile[] {
  const sessions = readNoteDir(notesDir()).sort((a, b) => b.date.localeCompare(a.date));
  const wiki = readNoteDir(join(notesDir(), "legendkeeper"), "legendkeeper/");
  return [...sessions, ...wiki];
}

/** Save a full notes document for a session date. Returns the file name. */
export function saveNotes(date: string, title: string, body: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  mkdirSync(notesDir(), { recursive: true });
  const file = `${date}-${slug(title)}.md`;
  writeFileSync(join(notesDir(), file), `# ${title}\n\n${body.trim()}\n`);
  return file;
}

/** Append one quick note (e.g. from /note in Discord) to today's notes file. */
export function appendQuickNote(author: string, note: string, now = new Date()): string {
  mkdirSync(notesDir(), { recursive: true });
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  const date = local.toISOString().slice(0, 10);
  const file = `${date}-table-notes.md`;
  const path = join(notesDir(), file);
  if (!existsSync(path)) writeFileSync(path, `# Table notes, ${date}\n\n`);
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  appendFileSync(path, `- ${time}, ${author}: ${note.replace(/\s+/g, " ").trim()}\n`);
  return file;
}

/** Split notes into paragraphs/bullets (long ones cut further) and score them against search terms. */
export function searchNotes(terms: string[], limit = 8): Array<{ note: NoteFile; chunk: string; score: number }> {
  if (terms.length === 0) return [];
  const out: Array<{ note: NoteFile; chunk: string; score: number }> = [];
  for (const note of listNotes()) {
    const titleLow = note.title.toLowerCase();
    const titleHits = terms.filter((t) => titleLow.includes(t)).length;
    const raw = note.text.split(/\n\s*\n|\n(?=\s*[-*]\s)/).map((c) => c.trim()).filter((c) => c.length > 0 && !/^#\s/.test(c));
    // Wiki text can come as long runs of single lines: cut anything over ~1200 chars
    const chunks = raw.flatMap((c) => {
      if (c.length <= 1200) return [c];
      const lines = c.split("\n");
      const parts: string[] = [];
      let cur = "";
      for (const l of lines) {
        if (cur.length + l.length > 1200 && cur) {
          parts.push(cur);
          cur = "";
        }
        cur += (cur ? "\n" : "") + l;
      }
      if (cur) parts.push(cur);
      return parts;
    });
    for (const chunk of chunks) {
      const low = chunk.toLowerCase();
      const hits = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0);
      // A page named after the thing asked about ("Who is Ireena?" -> the Ireena page) ranks high
      const score = hits + titleHits * 2;
      if (hits > 0 || titleHits > 0) out.push({ note, chunk, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.note.date.localeCompare(a.note.date)).slice(0, limit);
}
