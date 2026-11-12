/**
 * Nightly backup of the campaign's history to a private Git repo.
 *
 * Copies what exists nowhere else: Parley's transcript database (a consistent
 * snapshot, safe while Parley is running), the dice log archive, session notes
 * and the name glossary. LegendKeeper pages are skipped: they live in
 * LegendKeeper. Credentials (config.json, *.env) are never copied.
 *
 *   pm2 start build/src/backup.js --name nightly-backup --cron-restart "17 4 * * *" --no-autorestart
 *
 * Env: BACKUP_REPO (default ~/strahd-campaign-backup), PARLEY_DB, DNDBEYOND_ARCHIVE_DIR
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat } from "./health.js";

const HOME = homedir();
const repo = process.env.BACKUP_REPO || join(HOME, "strahd-campaign-backup");
const dataDir = process.env.DNDBEYOND_ARCHIVE_DIR || join(HOME, ".dndbeyond-mcp");
const parleyDb = process.env.PARLEY_DB || join(HOME, "parley-data", "meetings.db");

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

async function main(): Promise<void> {
  if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} is not a git repo. Clone the backup repo there first.`);

  // 1. Parley database: VACUUM INTO writes a clean, consistent copy even while Parley is writing
  if (existsSync(parleyDb)) {
    mkdirSync(join(repo, "parley"), { recursive: true });
    const out = join(repo, "parley", "meetings.db");
    rmSync(out, { force: true });
    const { DatabaseSync } = (await import("node:sqlite" as string)) as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
    };
    const db = new DatabaseSync(parleyDb);
    try {
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  }

  // 2. Dice log archives and the glossary
  mkdirSync(join(repo, "dice-log"), { recursive: true });
  for (const f of existsSync(dataDir) ? readdirSync(dataDir) : []) {
    if (/^gamelog-.*\.jsonl$/.test(f)) copyFileSync(join(dataDir, f), join(repo, "dice-log", f));
    if (f === "glossary.json") copyFileSync(join(dataDir, f), join(repo, f));
  }

  // 3. Session notes (not the LegendKeeper mirror)
  const notes = join(dataDir, "notes");
  if (existsSync(notes)) {
    rmSync(join(repo, "notes"), { recursive: true, force: true });
    cpSync(notes, join(repo, "notes"), {
      recursive: true,
      filter: (src) => !src.includes(`${join(notes, "legendkeeper")}`),
    });
  }

  writeFileSync(
    join(repo, "README.md"),
    "# Campaign backup\n\nNightly snapshot from the Mac mini: Parley transcripts (`parley/meetings.db`), " +
      "D&D Beyond dice log (`dice-log/`), session notes (`notes/`) and the name glossary.\n"
  );

  git("add", "-A");
  const changed = git("status", "--porcelain");
  if (!changed) {
    log("nothing changed");
    writeHeartbeat("backup", "no changes");
    return;
  }
  git("commit", "-m", `Backup ${new Date().toISOString().slice(0, 10)}`);
  git("push", "-u", "origin", "HEAD");
  log(`pushed: ${changed.split("\n").length} file(s) changed`);
  writeHeartbeat("backup", "pushed");
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} backup failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
