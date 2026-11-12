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

export function listNotes(): NoteFile[] {
  const dir = notesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const date = file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      return { file, date, title: heading || file.replace(/\.(md|txt)$/, ""), text };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
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

/** Split notes into paragraphs/bullets and score them against search terms. */
export function searchNotes(terms: string[], limit = 8): Array<{ note: NoteFile; chunk: string; score: number }> {
  if (terms.length === 0) return [];
  const out: Array<{ note: NoteFile; chunk: string; score: number }> = [];
  for (const note of listNotes()) {
    const chunks = note.text.split(/\n\s*\n|\n(?=\s*[-*]\s)/).map((c) => c.trim()).filter((c) => c.length > 0 && !/^#\s/.test(c));
    for (const chunk of chunks) {
      const low = chunk.toLowerCase();
      const score = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0);
      if (score > 0) out.push({ note, chunk, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.note.date.localeCompare(a.note.date)).slice(0, limit);
}
