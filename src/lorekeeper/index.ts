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
  Events,
  GatewayIntentBits,
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
- Sections marked Notes are written summaries by the players. Trust them over the transcript when they disagree.`;

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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask about anything from past sessions")
  .addStringOption((o) => o.setName("question").setDescription("What do you want to know?").setRequired(true));

const noteCommand = new SlashCommandBuilder()
  .setName("note")
  .setDescription("Save a note to the campaign history")
  .addStringOption((o) => o.setName("text").setDescription("What should be remembered?").setRequired(true).setMaxLength(1500));

client.once(Events.ClientReady, async (c) => {
  console.log(`Q&A bot online as ${c.user.tag} (model: ${llm.provider}:${llm.model})`);
  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.commands.set([askCommand.toJSON(), noteCommand.toJSON()]);
      console.log(`registered /ask and /note in ${guild.name}`);
    } catch (err) {
      console.error(`couldn't register /ask in ${guild.name}:`, err instanceof Error ? err.message : err);
    }
  }
  void loadParty();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const i = interaction as ChatInputCommandInteraction;
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
  if (message.author.bot || !client.user || !message.mentions.has(client.user)) return;
  const question = message.content.replace(/<@!?\d+>/g, "").trim();
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
