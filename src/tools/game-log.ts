import type { DdbClient } from "../api/client.js";
import { ENDPOINTS } from "../api/endpoints.js";
import { getUserId } from "../api/auth.js";
import type { DdbCampaign } from "../types/api.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

interface GameLogDie {
  dieType?: string;
  dieValue?: number;
}

interface GameLogRoll {
  diceNotation?: {
    set?: Array<{ count?: number; dieType?: string; dice?: GameLogDie[] }>;
    constant?: number;
  };
  diceNotationStr?: string;
  rollType?: string;
  rollKind?: string;
  result?: { constant?: number; values?: number[]; total?: number; text?: string };
}

interface GameLogMessage {
  id?: string;
  dateTime?: string | number;
  gameId?: string | number;
  userId?: string | number;
  entityId?: string | number;
  entityType?: string;
  eventType?: string;
  persist?: boolean;
  data?: {
    action?: string;
    rolls?: GameLogRoll[];
    context?: { entityId?: string; entityType?: string; name?: string; avatarUrl?: string };
    setId?: string;
    [key: string]: unknown;
  };
}

interface GameLogResponse {
  data?: GameLogMessage[];
  lastKey?: unknown;
}

export interface GameLogParams {
  campaignId?: number;
  limit?: number;
  characterName?: string;
  raw?: boolean;
}

function formatTime(dt: string | number | undefined): string {
  if (dt === undefined) return "?";
  const n = typeof dt === "string" && /^\d+$/.test(dt) ? Number(dt) : dt;
  const d = new Date(n);
  if (isNaN(d.getTime())) return String(dt);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function notation(roll: GameLogRoll): string {
  if (roll.diceNotationStr) return roll.diceNotationStr;
  const sets = roll.diceNotation?.set ?? [];
  const dice = sets.map((s) => `${s.count ?? s.dice?.length ?? 1}${s.dieType ?? "d?"}`).join("+");
  const c = roll.diceNotation?.constant ?? roll.result?.constant ?? 0;
  return c ? `${dice}${c > 0 ? "+" : ""}${c}` : dice;
}

function formatRoll(roll: GameLogRoll): string {
  const kind = roll.rollKind && roll.rollKind !== "" ? ` (${roll.rollKind})` : "";
  const type = roll.rollType ? `${roll.rollType}` : "roll";
  const values = roll.result?.values?.length ? ` [${roll.result.values.join(", ")}]` : "";
  const total = roll.result?.total ?? "?";
  return `${type}${kind}: ${notation(roll)}${values} = **${total}**`;
}

function formatMessage(m: GameLogMessage): string | null {
  const who = m.data?.context?.name ?? `user ${m.userId ?? "?"}`;
  const when = formatTime(m.dateTime);
  const event = m.eventType ?? "unknown";

  if (event.startsWith("dice/roll")) {
    // Pending rolls are followed by a fulfilled message with results
    if (event !== "dice/roll/fulfilled") return null;
    const action = m.data?.action ?? "Roll";
    const rolls = (m.data?.rolls ?? []).map(formatRoll).join("; ");
    return `- ${when} · **${who}** · ${action}: ${rolls || "(no result)"}`;
  }

  // Anything else: show the type and whatever text-ish fields exist
  const extras = Object.entries(m.data ?? {})
    .filter(([k, v]) => k !== "context" && (typeof v === "string" || typeof v === "number"))
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return `- ${when} · **${who}** · ${event}${extras ? ` (${extras})` : ""}`;
}


interface FetchResult {
  messages: GameLogMessage[];
  campaignId: number;
  campaignName: string;
  error?: string;
  rawDump?: string;
}

async function fetchGameLog(
  client: DdbClient,
  campaignIdParam: number | undefined,
  maxMessages: number,
  maxPages: number,
  raw = false
): Promise<FetchResult> {
  const empty = (error: string): FetchResult => ({ messages: [], campaignId: 0, campaignName: "", error });

  const userId = await getUserId();
  if (!userId) return empty("No User.ID cookie found. Add it to ~/.dndbeyond-mcp/config.json or re-run setup.");

  let campaignId = campaignIdParam;
  let campaignName = "";
  try {
    const campaigns = await client.get<DdbCampaign[]>(ENDPOINTS.campaign.list(), "campaigns", 300_000);
    if (!campaignId) {
      if (!campaigns?.length) return empty("No active campaigns found.");
      if (campaigns.length > 1) {
        const list = campaigns.map((c) => `• ${c.name} (ID ${c.id})`).join("\n");
        return empty(`You're in more than one campaign. Pass campaignId:\n${list}`);
      }
      campaignId = campaigns[0].id;
    }
    campaignName = campaigns?.find((c) => c.id === campaignId)?.name ?? "";
  } catch {
    if (!campaignId) return empty("Couldn't load campaigns. Pass campaignId explicitly.");
  }

  const messages: GameLogMessage[] = [];
  let lastKey: string | undefined;
  for (let page = 0; page < maxPages && messages.length < maxMessages; page++) {
    let resp: GameLogResponse;
    try {
      resp = await client.getRaw<GameLogResponse>(
        ENDPOINTS.gameLog.messages(campaignId!, userId, lastKey),
        `gamelog:${campaignId}:${lastKey ?? "first"}`,
        30_000
      );
    } catch (error) {
      if (page === 0) {
        const msg = error instanceof Error ? error.message : String(error);
        return empty(`Couldn't load the game log for campaign ${campaignId}: ${msg}`);
      }
      break;
    }
    if (raw) {
      return { messages: [], campaignId: campaignId!, campaignName, rawDump: JSON.stringify(resp, null, 2).slice(0, 8000) };
    }
    const batch = resp.data ?? [];
    messages.push(...batch);
    if (!resp.lastKey || batch.length === 0) break;
    lastKey = typeof resp.lastKey === "string" ? resp.lastKey : JSON.stringify(resp.lastKey);
  }

  // Dedupe by id, keep only completed rolls/events, newest first
  const seen = new Set<string>();
  const unique = messages.filter((m) => {
    // The same roll arrives once per open browser tab, each with its own id
    const rollId = (m.data as { rollId?: string } | undefined)?.rollId;
    const key = rollId ?? m.id ?? JSON.stringify([m.dateTime, m.data?.setId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => msgTime(b) - msgTime(a));
  return { messages: unique, campaignId: campaignId!, campaignName };
}

function msgTime(m: GameLogMessage): number {
  const t = m.dateTime;
  const n = typeof t === "string" && /^\d+$/.test(t) ? Number(t) : t;
  return new Date(n ?? 0).getTime() || 0;
}

const isRoll = (m: GameLogMessage) => m.eventType === "dice/roll/fulfilled";
const who = (m: GameLogMessage) => m.data?.context?.name ?? `user ${m.userId ?? "?"}`;

/** The d20 that counted: highest with advantage, lowest with disadvantage. */
function keptD20(roll: GameLogRoll): number | null {
  const d20s = (roll.diceNotation?.set ?? [])
    .filter((s) => s.dieType === "d20")
    .flatMap((s) => (s.dice ?? []).map((d) => d.dieValue))
    .filter((v): v is number => typeof v === "number");
  if (d20s.length === 0) return null;
  const kind = (roll.rollKind ?? "").toLowerCase();
  if (kind.includes("disadvantage")) return Math.min(...d20s);
  if (kind.includes("advantage")) return Math.max(...d20s);
  return d20s[0];
}

const isDamage = (r: GameLogRoll) => (r.rollType ?? "").toLowerCase().includes("damage");
const isHeal = (r: GameLogRoll) => (r.rollType ?? "").toLowerCase().includes("heal");

export async function getGameLog(client: DdbClient, params: GameLogParams): Promise<ToolResult> {
  const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const res = await fetchGameLog(client, params.campaignId, limit, 10, params.raw);
  if (res.error) return text(res.error);
  if (res.rawDump) return text("```json\n" + res.rawDump + "\n```");

  let filtered = res.messages;
  if (params.characterName) {
    const q = params.characterName.toLowerCase();
    filtered = filtered.filter((m) => m.data?.context?.name?.toLowerCase().includes(q));
  }

  const lines = filtered.map(formatMessage).filter((l): l is string => l !== null).slice(0, limit);
  if (lines.length === 0) {
    return text(`No game log entries found${res.campaignName ? ` for ${res.campaignName}` : ""}.`);
  }
  const header = `# Game Log${res.campaignName ? `: ${res.campaignName}` : ""} (${lines.length} most recent)\n`;
  return text(header + "\n" + lines.join("\n"));
}

// ============================================================================
// SESSION RECAP
// ============================================================================

export interface SessionRecapParams {
  campaignId?: number;
  sessions?: number;
  gapHours?: number;
}

/** Split newest-first messages into sessions wherever there's a long gap. */
function splitSessions(messages: GameLogMessage[], gapHours: number): GameLogMessage[][] {
  const sessions: GameLogMessage[][] = [];
  let current: GameLogMessage[] = [];
  let prev: number | null = null;
  for (const m of messages) {
    const t = msgTime(m);
    if (prev !== null && prev - t > gapHours * 3_600_000 && current.length) {
      sessions.push(current);
      current = [];
    }
    current.push(m);
    prev = t;
  }
  if (current.length) sessions.push(current);
  return sessions;
}

function fmtDate(t: number): string {
  return new Date(t).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function recapSession(session: GameLogMessage[], index: number): string {
  const rolls = session.filter(isRoll);
  const newest = msgTime(session[0]);
  const oldest = msgTime(session[session.length - 1]);
  const lines: string[] = [];
  lines.push(`## Session ${index}: ${fmtDate(oldest)}, ${fmtClock(oldest)} to ${fmtClock(newest)}`);
  lines.push(`${rolls.length} rolls\n`);

  type Stat = { rolls: number; d20: number[]; nat20: string[]; nat1: string[]; damage: number; heal: number };
  const by = new Map<string, Stat>();
  const bigHits: Array<{ who: string; action: string; total: number }> = [];

  // Chronological order reads better for a recap
  for (const m of [...rolls].reverse()) {
    const name = who(m);
    const st = by.get(name) ?? { rolls: 0, d20: [], nat20: [], nat1: [], damage: 0, heal: 0 };
    st.rolls++;
    const action = m.data?.action ?? "roll";
    for (const r of m.data?.rolls ?? []) {
      const d = keptD20(r);
      if (d !== null) {
        st.d20.push(d);
        const label = `${action}${r.rollType ? ` (${r.rollType})` : ""}`;
        if (d === 20) st.nat20.push(label);
        if (d === 1) st.nat1.push(label);
      }
      const total = r.result?.total ?? 0;
      if (isDamage(r)) {
        st.damage += total;
        bigHits.push({ who: name, action, total });
      }
      if (isHeal(r)) st.heal += total;
    }
    by.set(name, st);
  }

  lines.push("| Character | Rolls | Avg d20 | Nat 20s | Nat 1s | Damage rolled | Healing rolled |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const [name, st] of [...by.entries()].sort((a, b) => b[1].rolls - a[1].rolls)) {
    const avg = st.d20.length ? (st.d20.reduce((a, b) => a + b, 0) / st.d20.length).toFixed(1) : "-";
    lines.push(`| ${name} | ${st.rolls} | ${avg} | ${st.nat20.length} | ${st.nat1.length} | ${st.damage} | ${st.heal} |`);
  }

  lines.push("");
  const crits = [...by.entries()].flatMap(([n, st]) => st.nat20.map((a) => `${n}: ${a}`));
  const fumbles = [...by.entries()].flatMap(([n, st]) => st.nat1.map((a) => `${n}: ${a}`));
  if (crits.length) lines.push(`**Natural 20s:** ${crits.join("; ")}`);
  if (fumbles.length) lines.push(`**Natural 1s:** ${fumbles.join("; ")}`);

  const top = bigHits.sort((a, b) => b.total - a.total).slice(0, 5);
  if (top.length) {
    lines.push(`**Biggest hits:** ${top.map((h) => `${h.who} ${h.action} ${h.total}`).join("; ")}`);
  }

  // Timeline of actions, compressed: consecutive rolls by the same character merge
  const timeline: string[] = [];
  let last = "";
  for (const m of [...rolls].reverse()) {
    const entry = `${who(m)}: ${m.data?.action ?? "roll"}`;
    if (entry === last) continue;
    timeline.push(`${fmtClock(msgTime(m))} ${entry}`);
    last = entry;
  }
  if (timeline.length) {
    lines.push(`\n**Timeline:**`);
    lines.push(timeline.slice(0, 150).map((t) => `- ${t}`).join("\n"));
    if (timeline.length > 150) lines.push(`- ...and ${timeline.length - 150} more`);
  }
  return lines.join("\n");
}

export async function getSessionRecap(client: DdbClient, params: SessionRecapParams): Promise<ToolResult> {
  const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
  const count = Math.min(Math.max(params.sessions ?? 1, 1), 10);
  const res = await fetchGameLog(client, params.campaignId, 5000, 50);
  if (res.error) return text(res.error);

  const sessions = splitSessions(res.messages, params.gapHours ?? 4).filter((s) => s.some(isRoll));
  if (sessions.length === 0) return text(`No rolls found in the game log${res.campaignName ? ` for ${res.campaignName}` : ""}.`);

  const picked = sessions.slice(0, count);
  const parts = picked.map((s, i) => recapSession(s, sessions.length - i));
  const header = `# Session Recap${res.campaignName ? `: ${res.campaignName}` : ""}\n` +
    `*Built from the dice log only. It shows who rolled what and when, not the story. ` +
    `${sessions.length} session(s) found in ${res.messages.length} log entries.*\n`;
  return text(header + "\n" + parts.join("\n\n---\n\n"));
}

// ============================================================================
// LUCK / ROLL STATS
// ============================================================================

export interface RollStatsParams {
  campaignId?: number;
  characterName?: string;
}

export async function getRollStats(client: DdbClient, params: RollStatsParams): Promise<ToolResult> {
  const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
  const res = await fetchGameLog(client, params.campaignId, 5000, 50);
  if (res.error) return text(res.error);

  let rolls = res.messages.filter(isRoll);
  if (params.characterName) {
    const q = params.characterName.toLowerCase();
    rolls = rolls.filter((m) => who(m).toLowerCase().includes(q));
  }
  if (rolls.length === 0) return text("No rolls found in the game log.");

  type Stat = {
    rolls: number; d20: number[]; adv: number; dis: number;
    dmgRolls: number; dmgTotal: number; best: { action: string; total: number } | null;
  };
  const by = new Map<string, Stat>();
  for (const m of rolls) {
    const name = who(m);
    const st = by.get(name) ?? { rolls: 0, d20: [], adv: 0, dis: 0, dmgRolls: 0, dmgTotal: 0, best: null };
    st.rolls++;
    for (const r of m.data?.rolls ?? []) {
      const d = keptD20(r);
      if (d !== null) {
        st.d20.push(d);
        const kind = (r.rollKind ?? "").toLowerCase();
        if (kind.includes("disadvantage")) st.dis++;
        else if (kind.includes("advantage")) st.adv++;
      }
      if (isDamage(r)) {
        const total = r.result?.total ?? 0;
        st.dmgRolls++;
        st.dmgTotal += total;
        if (!st.best || total > st.best.total) st.best = { action: m.data?.action ?? "roll", total };
      }
    }
    by.set(name, st);
  }

  const rows = [...by.entries()]
    .filter(([, st]) => st.d20.length > 0 || st.dmgRolls > 0)
    .map(([name, st]) => {
      const n = st.d20.length;
      const avg = n ? st.d20.reduce((a, b) => a + b, 0) / n : 0;
      const n20 = st.d20.filter((d) => d === 20).length;
      const n1 = st.d20.filter((d) => d === 1).length;
      return { name, st, n, avg, n20, n1 };
    })
    .sort((a, b) => b.avg - a.avg);

  const pct = (x: number, n: number) => (n ? `${((x / n) * 100).toFixed(1)}%` : "-");
  const lines: string[] = [];
  const oldest = msgTime(res.messages[res.messages.length - 1]);
  lines.push(`# Luck Report${res.campaignName ? `: ${res.campaignName}` : ""}`);
  lines.push(`*${rolls.length} rolls since ${fmtDate(oldest)}. A fair d20 averages 10.5 with 5% nat 20s and 5% nat 1s.*\n`);
  lines.push("| Character | d20 rolls | Avg d20 | Nat 20s | Nat 1s | Adv / Dis | Avg damage roll | Biggest hit |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const avgDmg = r.st.dmgRolls ? (r.st.dmgTotal / r.st.dmgRolls).toFixed(1) : "-";
    const best = r.st.best ? `${r.st.best.total} (${r.st.best.action})` : "-";
    lines.push(
      `| ${r.name} | ${r.n} | ${r.n ? r.avg.toFixed(2) : "-"} | ${r.n20} (${pct(r.n20, r.n)}) | ${r.n1} (${pct(r.n1, r.n)}) | ${r.st.adv} / ${r.st.dis} | ${avgDmg} | ${best} |`
    );
  }

  const ranked = rows.filter((r) => r.n >= 20);
  if (ranked.length >= 2) {
    lines.push(`\n**Luckiest:** ${ranked[0].name} (avg ${ranked[0].avg.toFixed(2)})`);
    const unlucky = ranked[ranked.length - 1];
    lines.push(`**Most cursed:** ${unlucky.name} (avg ${unlucky.avg.toFixed(2)})`);
  } else {
    lines.push(`\n*Not enough rolls yet (20+ per character) to crown anyone lucky or cursed.*`);
  }
  return text(lines.join("\n"));
}
