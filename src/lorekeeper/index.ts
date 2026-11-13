/**
 * Lorekeeper: a Discord bot the whole table can ask about the campaign.
 *
 *   /ask question:<text>      or      @Lorekeeper <question>
 *
 * Answers come only from recorded sessions (Parley transcripts), the dice
 * archive and the party's D&D Beyond sheets, with the session and time cited.
 *
 * Run (Mac mini):
 *   pm2 start "node --env-file=$HOME/.dndbeyond-mcp/lorekeeper.env build/src/lorekeeper/index.js" --name lorekeeper
 *
 * lorekeeper.env:
 *   LOREKEEPER_TOKEN=...            Discord bot token (its own app, not Parley's)
 *   LOREKEEPER_PROVIDER=ollama      or anthropic (then ANTHROPIC_API_KEY=...)
 *   LOREKEEPER_MODEL=qwen2.5:14b    optional
 *   LOREKEEPER_CAMPAIGN_ID=7143355  optional, defaults to your only campaign
 */
import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { TtlCache } from "../cache/lru.js";
import { CircuitBreaker, RateLimiter } from "../resilience/index.js";
import { DdbClient } from "../api/client.js";
import { ENDPOINTS } from "../api/endpoints.js";
import { getPartySnapshot } from "../tools/character.js";
import type { DdbCampaign } from "../types/api.js";
import { retrieve } from "./retrieve.js";
import { complete, llmConfigFromEnv } from "./llm.js";
import { appendQuickNote } from "../archive/notes.js";
import { formatChecks, runChecks, type Check } from "../health.js";

const token = process.env.LOREKEEPER_TOKEN;
if (!token) {
  console.error("LOREKEEPER_TOKEN is not set. Put it in ~/.dndbeyond-mcp/lorekeeper.env");
  process.exit(1);
}

const llm = llmConfigFromEnv();
const ddb = new DdbClient(new TtlCache<unknown>(300_000), new CircuitBreaker(5, 60_000), new RateLimiter(2, 1000));

let campaign: { id: number; name: string } | null = null;
let party = { text: "", at: 0 };

async function loadCampaign(): Promise<{ id: number; name: string } | null> {
  if (campaign) return campaign;
  try {
    const list = await ddb.get<DdbCampaign[]>(ENDPOINTS.campaign.list(), "campaigns", 3_600_000);
    const wanted = Number(process.env.LOREKEEPER_CAMPAIGN_ID) || undefined;
    const c = wanted ? list.find((x) => x.id === wanted) : list[0];
    campaign = c ? { id: c.id, name: c.name } : null;
  } catch (err) {
    console.error("campaign lookup failed:", err instanceof Error ? err.message : err);
  }
  return campaign;
}

async function loadParty(): Promise<string> {
  if (party.text && Date.now() - party.at < 3_600_000) return party.text;
  try {
    const c = await loadCampaign();
    const res = await getPartySnapshot(ddb, { campaignId: c?.id });
    party = { text: res.content[0]?.text ?? "", at: Date.now() };
  } catch {
    // party table is a nice-to-have
  }
  return party.text;
}

const system = (name: string) => `You are ${name}, the campaign lorekeeper for a Dungeons & Dragons group playing Curse of Strahd over Discord.
Players ask you what happened in past sessions. Answer ONLY from the session excerpts and party sheet provided.
- Excerpts are speech-to-text transcripts: names may be misspelled, and players often joke or talk out of character. The DM describes the world; players speak for their characters.
- Be brief: a few sentences or a short list. Plain words.
- Cite where it came from, like (Session 3, Nov 11 ~9:40 PM).
- If the excerpts don't answer the question, say you couldn't find it in the recorded sessions. Never invent events, names or details.
- Lines starting [dice] are real D&D Beyond rolls with their totals.
- Sections marked Notes are written session summaries, and Wiki sections come from the group's LegendKeeper campaign wiki. Trust both over the transcript when they disagree.`;

async function answer(question: string): Promise<string> {
  const c = await loadCampaign();
  const [found, partyText] = await Promise.all([retrieve(question, c?.id), loadParty()]);
  if (!found.found) {
    return "I couldn't find anything about that in the recorded sessions. Try different words, like a name or place.";
  }
  const user = `Party (from D&D Beyond):\n${partyText}\n\nSession excerpts:\n${found.excerpts}\n\nQuestion: ${question}`;
  const reply = await complete(llm, system(client.user?.username ?? "the Lorekeeper"), user);
  const sources = found.sources.slice(0, 4).join(" · ");
  const out = `${reply || "I couldn't come up with an answer."}\n-# Searched: ${sources}`;
  return out.length > 1990 ? out.slice(0, 1987) + "..." : out;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  // DM channels aren't cached until used; Partials.Channel lets the first DM through
  partials: [Partials.Channel],
});

/** Only people in a server the bot is in can DM it (it holds your campaign's history). */
async function sharesAServer(userId: string): Promise<boolean> {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch(userId);
      return true;
    } catch {
      // not a member of this guild
    }
  }
  return false;
}

const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask about anything from past sessions")
  .addStringOption((o) => o.setName("question").setDescription("What do you want to know?").setRequired(true));

const HELP = (name: string) => `**${name}: your campaign's memory**
I answer from the LegendKeeper wiki, past session recaps and notes, and recordings of past sessions.

**Commands**
\`/ask question: ...\`: ask about anything from past sessions or the wiki
\`/note text: ...\`: save something worth remembering (names, promises, clues)
\`/status\`: check that recording and the campaign tools are working
\`/help\`: this message
You can also **DM me** a question, no command needed.

**Good questions** name a person, place or thing:
• Who is Dmitri Krezkov?
• What did we promise the Martikovs?
• What was in Baba Lysaga's chest?
• What do we know about the Abbot?

**What I can't do**
• Tonight's session: I only learn it after the recording is transcribed overnight. Use \`/note\` for anything you want me to know now.
• Tactics or "what should we do?": I look things up, I don't give advice.
• Rules, spells and monster stats: check D&D Beyond.

**Every Wednesday** I post a *Previously, in Barovia...* catch-up before the session, and **every Thursday morning** the recap of the night before.
-# Each answer lists where it came from. If something's wrong, tell the group and add a /note.`;

const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("How to use the campaign bot");

const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Check that the recorder, dice log and campaign tools are all working");

const noteCommand = new SlashCommandBuilder()
  .setName("note")
  .setDescription("Save a note to the campaign history")
  .addStringOption((o) => o.setName("text").setDescription("What should be remembered?").setRequired(true).setMaxLength(1500));

client.once(Events.ClientReady, async (c) => {
  console.log(`Q&A bot online as ${c.user.tag} (model: ${llm.provider}:${llm.model})`);
  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.commands.set([askCommand.toJSON(), noteCommand.toJSON(), statusCommand.toJSON(), helpCommand.toJSON()]);
      console.log(`registered /ask, /note, /status and /help in ${guild.name}`);
    } catch (err) {
      console.error(`couldn't register /ask in ${guild.name}:`, err instanceof Error ? err.message : err);
    }
  }
  void loadParty();
  setTimeout(watchdog, 60_000);
});

// ---------------------------------------------------------------------------
// Watchdog: checks every 15 minutes and DMs the owner when something breaks
// (after two failures in a row, to skip blips) and again when it recovers.
// ---------------------------------------------------------------------------
const OWNER_ID = process.env.LOREKEEPER_OWNER_ID;
const failStreak = new Map<string, number>();
const alerted = new Set<string>();

async function notifyOwner(text: string): Promise<void> {
  if (!OWNER_ID) return;
  try {
    const user = await client.users.fetch(OWNER_ID);
    await user.send(text.slice(0, 2000));
  } catch (err) {
    console.error("couldn't DM owner:", err instanceof Error ? err.message : err);
  }
}

async function watchdog(): Promise<void> {
  try {
    const checks: Check[] = await runChecks(ddb);
    const broke: Check[] = [];
    const fixed: Check[] = [];
    for (const c of checks) {
      if (c.ok) {
        failStreak.delete(c.id);
        if (alerted.delete(c.id)) fixed.push(c);
      } else {
        const n = (failStreak.get(c.id) ?? 0) + 1;
        failStreak.set(c.id, n);
        if (n >= 2 && !alerted.has(c.id)) {
          alerted.add(c.id);
          broke.push(c);
        }
      }
    }
    if (broke.length) {
      await notifyOwner(
        `⚠️ **Campaign tools need attention**\n${broke.map((c) => `❌ **${c.name}**: ${c.detail}${c.fix ? `\n  ↳ Fix: \`${c.fix}\`` : ""}`).join("\n")}`
      );
    }
    if (fixed.length) await notifyOwner(`✅ Back to normal: ${fixed.map((c) => c.name).join(", ")}`);
  } catch (err) {
    console.error("watchdog failed:", err);
  }
  setTimeout(watchdog, 15 * 60_000);
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const i = interaction as ChatInputCommandInteraction;
  if (i.commandName === "help") {
    await i.reply({ content: HELP(client.user?.username ?? "Tinklerbot"), ephemeral: true }).catch(() => {});
    return;
  }
  if (i.commandName === "status") {
    await i.deferReply();
    try {
      await i.editReply(formatChecks(await runChecks(ddb)).slice(0, 2000));
    } catch (err) {
      console.error("status failed:", err);
      await i.editReply("Couldn't run the checks.").catch(() => {});
    }
    return;
  }
  if (i.commandName === "note") {
    const note = i.options.getString("text", true);
    const author = (i.member && "displayName" in i.member ? i.member.displayName : null) ?? i.user.username;
    try {
      appendQuickNote(author, note);
      await i.reply(`Noted: ${note}`.slice(0, 2000));
    } catch (err) {
      console.error("note failed:", err);
      await i.reply({ content: "Couldn't save that note.", ephemeral: true }).catch(() => {});
    }
    return;
  }
  if (i.commandName !== "ask") return;
  const question = i.options.getString("question", true);
  await i.deferReply();
  try {
    await i.editReply(`> ${question}\n${await answer(question)}`.slice(0, 2000));
  } catch (err) {
    console.error("ask failed:", err);
    await i.editReply("Something went wrong looking that up. Try again in a minute.").catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot || !client.user) return;
  const isDm = message.channel.type === ChannelType.DM;
  if (!isDm && !message.mentions.has(client.user)) return;
  if (isDm && !(await sharesAServer(message.author.id))) {
    await message.reply("I only answer questions from members of my campaign's server.").catch(() => {});
    return;
  }
  const question = message.content.replace(/<@!?\d+>/g, "").trim();
  if (/^(help|\/help|\?|commands)$/i.test(question)) {
    await message.reply(HELP(client.user.username)).catch(() => {});
    return;
  }
  if (!question) {
    await message.reply("Ask me about the campaign, like: who is Ireena?").catch(() => {});
    return;
  }
  try {
    if ("sendTyping" in message.channel) await message.channel.sendTyping().catch(() => {});
    await message.reply(await answer(question));
  } catch (err) {
    console.error("mention failed:", err);
    await message.reply("Something went wrong looking that up. Try again in a minute.").catch(() => {});
  }
});

void client.login(token);
