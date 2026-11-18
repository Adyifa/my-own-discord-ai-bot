import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time
} from "discord.js";
import { acquireChatSlot, finishExchange, MAX_PROMPT_CHARACTERS, startExchange } from "../ai/chat-handler.js";
import {
  generateChatReply,
  rememberChatTurn,
  replyFootnote,
  toUserRef,
  type ChatTurnInput,
  type ChatTurnResult
} from "../ai/chat.js";
import { toAiError, userFacingAiMessage } from "../ai/errors.js";
import {
  MAX_CUSTOM_INSTRUCTIONS,
  disableAi,
  enableAi,
  getAiGuildSettings,
  setCustomInstructions
} from "../ai/guild-settings.js";
import { feedbackRow } from "../ai/learning/components.js";
import { deleteUserExchanges } from "../ai/learning/exchanges.js";
import { getLearningStats } from "../ai/learning/stats.js";
import { MEMORY_LIMITS, countGuildMessages, deleteMemory, getUserMemoryOverview } from "../ai/memory.js";
import type { DiscordUserRef } from "../ai/persona.js";
import type { ChatProvider, ProviderHealth } from "../ai/providers/index.js";
import {
  KnowledgeError,
  addDocument,
  deleteDocument,
  getKnowledgeCounts,
  listDocuments,
  retrieveKnowledge,
  type KnowledgeSource
} from "../ai/rag/knowledge.js";
import { summarizeConversation, type TranscriptLine } from "../ai/summarize.js";
import { getDailyUsage, recordUsage } from "../ai/usage.js";
import { addUserFacts, deleteUserFact, deleteUserFacts, getUserFacts } from "../ai/user-memory.js";
import type { AppContext } from "../context.js";
import { getGuildConfig } from "../db/guild-config.js";
import { LogColor } from "../features/server-log.js";
import { describeError, logger } from "../logger.js";
import { Cooldowns } from "../utils/cooldown.js";
import { allowedMentionsFor, splitDiscordMessage, withSubtext } from "../utils/discord-message.js";
import { formatCount, parseSqliteTimestamp, truncate } from "../utils/text.js";
import {
  UserFacingError,
  commandChannel,
  missingBotPermissions,
  replyEphemeral,
  requireAdministrator,
  type GuildCommandInteraction,
  type SlashCommand
} from "./types.js";

const summaryCooldowns = new Cooldowns(30_000);
const MAX_UPLOAD_BYTES = 1_000_000;
const percent = (value: number | null) => value === null ? "n/a" : `${Math.round(value * 100)}%`;
const onOff = (value: boolean) => value ? "On" : "Off";

export const aiCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ai")
    .setDescription("AI assistant: chat, knowledge base, memory and settings")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(sub => sub
      .setName("ask").setDescription("Ask the AI assistant something")
      .addStringOption(option => option
        .setName("prompt").setDescription("Your question or request")
        .setRequired(true).setMaxLength(MAX_PROMPT_CHARACTERS))
      .addBooleanOption(option => option.setName("private").setDescription("Only you can see the answer (default: false)")))
    .addSubcommand(sub => sub
      .setName("summarize").setDescription("Summarise the recent conversation in this channel")
      .addIntegerOption(option => option
        .setName("messages").setDescription("How many recent messages to read (10-100, default 50)")
        .setMinValue(10).setMaxValue(100))
      .addBooleanOption(option => option.setName("public").setDescription("Post the summary for everyone (default: only you)")))
    .addSubcommandGroup(group => group
      .setName("knowledge").setDescription("The server knowledge base the AI answers from (administrators)")
      .addSubcommand(sub => sub
        .setName("add").setDescription("Add a text entry, e.g. rules, an FAQ or event info")
        .addStringOption(option => option.setName("title").setDescription("Short title").setRequired(true).setMaxLength(100))
        .addStringOption(option => option.setName("text").setDescription("The content").setRequired(true).setMaxLength(6_000)))
      .addSubcommand(sub => sub
        .setName("upload").setDescription("Add a .txt or .md document (max 1 MB)")
        .addAttachmentOption(option => option.setName("file").setDescription("A .txt or .md file").setRequired(true))
        .addStringOption(option => option.setName("title").setDescription("Title (default: first heading or file name)").setMaxLength(100)))
      .addSubcommand(sub => sub.setName("list").setDescription("List knowledge base documents"))
      .addSubcommand(sub => sub
        .setName("remove").setDescription("Delete a document")
        .addIntegerOption(option => option.setName("id").setDescription("Document ID from /ai knowledge list").setRequired(true).setMinValue(1)))
      .addSubcommand(sub => sub
        .setName("search").setDescription("Test retrieval: show what the AI would find for a question")
        .addStringOption(option => option.setName("query").setDescription("A question").setRequired(true).setMaxLength(300))))
    .addSubcommandGroup(group => group
      .setName("memory").setDescription("What the AI remembers about you")
      .addSubcommand(sub => sub.setName("view").setDescription("See what the AI remembers about you"))
      .addSubcommand(sub => sub
        .setName("remember").setDescription("Tell the AI something to remember about you")
        .addStringOption(option => option.setName("fact").setDescription("e.g. \"I prefer answers in English\"").setRequired(true).setMaxLength(200)))
      .addSubcommand(sub => sub
        .setName("forget").setDescription("Delete one fact, or everything the AI remembers about you")
        .addIntegerOption(option => option.setName("fact").setDescription("Fact number from /ai memory view (empty = forget everything)").setMinValue(1))))
    .addSubcommand(sub => sub
      .setName("learning").setDescription("What the AI has learned on this server (administrators)"))
    .addSubcommand(sub => sub
      .setName("setup").setDescription("Turn on AI chat and choose its channel (administrators)")
      .addChannelOption(option => option
        .setName("channel").setDescription("Channel where the AI answers without a mention")
        .addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addBooleanOption(option => option
        .setName("mention_enabled").setDescription("Also answer when mentioned in other channels (default: true)")))
    .addSubcommand(sub => sub
      .setName("instructions").setDescription("Show or set extra AI instructions for this server (administrators)")
      .addStringOption(option => option
        .setName("text").setDescription("E.g. server rules, tone, topics to avoid")
        .setMaxLength(MAX_CUSTOM_INSTRUCTIONS))
      .addBooleanOption(option => option.setName("clear").setDescription("Remove the current instructions")))
    .addSubcommand(sub => sub
      .setName("status").setDescription("AI settings, model health and today's usage (administrators)"))
    .addSubcommand(sub => sub
      .setName("reset").setDescription("Delete AI conversation memory")
      .addStringOption(option => option
        .setName("scope").setDescription("What to delete (default: your memory in this channel)")
        .addChoices(
          { name: "My memory in this channel", value: "mine" },
          { name: "One user's memory in this channel (admin)", value: "user" },
          { name: "All memory in this channel (admin)", value: "channel" },
          { name: "All memory in this server (admin)", value: "server" }
        ))
      .addUserOption(option => option.setName("user").setDescription("Target user for the \"user\" scope (admin)"))
      .addBooleanOption(option => option.setName("confirm").setDescription("Required for the channel and server scopes")))
    .addSubcommand(sub => sub
      .setName("disable").setDescription("Turn AI chat off on this server (administrators)")
      .addBooleanOption(option => option
        .setName("delete_memory").setDescription("Also delete all AI memory for this server (default: false)"))),

  async execute(interaction, context) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    if (group === "knowledge") return knowledge(interaction, context, subcommand);
    if (group === "memory") return memory(interaction, subcommand);

    switch (subcommand) {
      case "ask": return ask(interaction, context);
      case "summarize": return summarize(interaction, context);
      case "learning": return learning(interaction, context);
      case "setup": return setup(interaction, context);
      case "instructions": return instructions(interaction);
      case "status": return status(interaction, context);
      case "reset": return reset(interaction);
      case "disable": return disable(interaction);
      default: throw new UserFacingError("Unknown subcommand.");
    }
  }
};

function requireProvider(interaction: GuildCommandInteraction, context: AppContext): ChatProvider {
  if (!getAiGuildSettings(interaction.guildId).enabled) {
    throw new UserFacingError("AI is not enabled on this server yet. An administrator can turn it on with `/ai setup`.");
  }
  if (!context.ai.provider) {
    throw new UserFacingError("No AI model is configured for this bot. An administrator can check `/ai status`.");
  }
  return context.ai.provider;
}

// ---------------------------------------------------------------------------
// /ai ask
// ---------------------------------------------------------------------------

async function ask(interaction: GuildCommandInteraction, context: AppContext): Promise<void> {
  requireProvider(interaction, context);
  const prompt = interaction.options.getString("prompt", true).trim();
  const isPrivate = interaction.options.getBoolean("private") ?? false;
  const channel = await commandChannel(interaction);

  const slot = acquireChatSlot(interaction.guildId, interaction.user.id);
  if (!slot.ok) throw new UserFacingError(slot.message);

  try {
    await interaction.deferReply(isPrivate ? { flags: MessageFlags.Ephemeral } : {});
    const input: ChatTurnInput = {
      guild: interaction.guild,
      channel,
      author: interaction.user,
      member: interaction.member,
      prompt,
      mentionedUsers: await resolveMentionedUsers(interaction, prompt)
    };

    let reply: ChatTurnResult;
    try {
      reply = await generateChatReply(context.ai, input);
    } catch (error) {
      const aiError = toAiError(error);
      logger.error("ai.ask_failed", { guildId: interaction.guildId, code: aiError.code, ...describeError(error) });
      const isAdministrator = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
      await interaction.editReply(`${userFacingAiMessage(aiError)}${isAdministrator ? ` (\`${aiError.code}\`)` : ""}`);
      return;
    }

    // The quoted question must never ping the people it mentions.
    const mentionedIds = new Set(input.mentionedUsers.map(user => user.id));
    const allowedIds = reply.allowedMentionIds.filter(id => !mentionedIds.has(id));
    const question = `> **${interaction.member.displayName}:** ${truncate(prompt.replace(/\s+/g, " "), 180)}`;
    const chunks = splitDiscordMessage(withSubtext(`${question}\n\n${reply.text}`, replyFootnote(reply)));
    const exchangeId = startExchange(context.ai, input, reply);
    const buttons = exchangeId === undefined ? [] : [feedbackRow(exchangeId)];

    let lastMessageId: string | undefined;
    try {
      const first = await interaction.editReply({
        content: chunks[0],
        allowedMentions: allowedMentionsFor(chunks[0], allowedIds),
        components: chunks.length === 1 ? buttons : []
      });
      lastMessageId = first.id;
      for (const [index, chunk] of chunks.slice(1).entries()) {
        const sent = await interaction.followUp({
          content: chunk,
          allowedMentions: allowedMentionsFor(chunk, allowedIds),
          components: index === chunks.length - 2 ? buttons : [],
          ...(isPrivate ? { flags: MessageFlags.Ephemeral } : {})
        });
        lastMessageId = sent.id;
      }
    } finally {
      finishExchange(exchangeId, lastMessageId);
    }

    try {
      rememberChatTurn(context.ai, input, reply.text);
    } catch (error) {
      logger.error("ai.memory_save_failed", { guildId: interaction.guildId, ...describeError(error) });
    }
  } finally {
    slot.release();
  }
}

async function resolveMentionedUsers(interaction: GuildCommandInteraction, text: string): Promise<DiscordUserRef[]> {
  const ids = [...new Set([...text.matchAll(/<@!?(\d{15,22})>/g)].map(match => match[1]))].slice(0, 5);
  const members = await Promise.all(ids.map(id =>
    interaction.guild.members.cache.get(id) ?? interaction.guild.members.fetch(id).catch(() => null)
  ));
  return members.flatMap(member => member ? [toUserRef(member.user, member)] : []);
}

// ---------------------------------------------------------------------------
// /ai summarize
// ---------------------------------------------------------------------------

async function summarize(interaction: GuildCommandInteraction, context: AppContext): Promise<void> {
  const provider = requireProvider(interaction, context);
  const channel = await commandChannel(interaction);
  const missing = missingBotPermissions(interaction, channel, {
    "View Channel": PermissionFlagsBits.ViewChannel,
    "Read Message History": PermissionFlagsBits.ReadMessageHistory
  });
  if (missing.length > 0) throw new UserFacingError(`I need these permissions here: ${missing.join(", ")}.`);
  if (!interaction.member.permissionsIn(channel).has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new UserFacingError("You need the Read Message History permission in this channel.");
  }

  const cooldownKey = `${interaction.guildId}:${interaction.user.id}`;
  const waitMs = summaryCooldowns.acquire(cooldownKey);
  if (waitMs > 0) throw new UserFacingError(`Please wait ${Math.ceil(waitMs / 1_000)}s before requesting another summary.`);

  const isPublic = interaction.options.getBoolean("public") ?? false;
  await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

  const fetched = await channel.messages.fetch({ limit: interaction.options.getInteger("messages") ?? 50 });
  const lines: TranscriptLine[] = [...fetched.values()]
    .reverse()
    .filter(message => !message.system)
    .map(message => ({
      author: message.member?.displayName ?? message.author.globalName ?? message.author.username,
      content: message.content || (message.attachments.size > 0 ? "[attachment]" : message.embeds[0]?.description ?? ""),
      timestamp: message.createdAt,
      isBot: message.author.bot
    }))
    .filter(line => line.content.trim().length > 0);

  if (lines.length < 3) {
    summaryCooldowns.release(cooldownKey);
    await interaction.editReply("There is not enough conversation here to summarise yet.");
    return;
  }

  const started = Date.now();
  try {
    const response = await summarizeConversation(provider, {
      channelName: channel.name,
      lines,
      timezone: context.ai.timezone,
      maxOutputTokens: Math.min(context.ai.settings.maxOutputTokens, 900)
    });
    recordUsage({
      guildId: interaction.guildId,
      feature: "summary",
      provider: response.provider,
      model: response.model,
      ...response.usage,
      latencyMs: Date.now() - started,
      ok: true
    });
    const embed = new EmbedBuilder()
      .setTitle(`Summary of #${channel.name}`)
      .setDescription(truncate(response.content, 4_000))
      .setColor(LogColor.ai)
      .setFooter({ text: `Last ${lines.length} messages · ${response.provider} / ${response.model}` })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    recordUsage({
      guildId: interaction.guildId,
      feature: "summary",
      provider: provider.id,
      model: provider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      ok: false
    });
    summaryCooldowns.release(cooldownKey);
    const aiError = toAiError(error);
    logger.error("ai.summary_failed", { guildId: interaction.guildId, code: aiError.code, ...describeError(error) });
    await interaction.editReply(userFacingAiMessage(aiError));
  }
}

// ---------------------------------------------------------------------------
// /ai knowledge … (RAG)
// ---------------------------------------------------------------------------

async function knowledge(interaction: GuildCommandInteraction, context: AppContext, subcommand: string): Promise<void> {
  requireAdministrator(interaction);
  const guildId = interaction.guildId;

  if (subcommand === "add") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await saveKnowledge(interaction, context, {
      title: interaction.options.getString("title", true).trim(),
      content: interaction.options.getString("text", true),
      source: "admin"
    });
    return;
  }

  if (subcommand === "upload") {
    const file = interaction.options.getAttachment("file", true);
    if (!/\.(txt|md|markdown)$/i.test(file.name)) throw new UserFacingError("Please upload a .txt or .md file.");
    if (file.size > MAX_UPLOAD_BYTES) throw new UserFacingError("The file is larger than 1 MB.");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const response = await fetch(file.url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!response?.ok) throw new UserFacingError("I could not download that file. Please try again.");
    const content = await response.text();
    await saveKnowledge(interaction, context, {
      title: interaction.options.getString("title")?.trim() || firstHeading(content) || file.name,
      content,
      source: "file",
      sourceRef: file.name
    });
    return;
  }

  if (subcommand === "list") {
    const documents = listDocuments(guildId, 20);
    const counts = getKnowledgeCounts(guildId, context.ai.embedder?.id);
    const lines = documents.map(document => {
      const created = parseSqliteTimestamp(document.createdAt);
      return `\`#${document.id}\` **${truncate(document.title, 60)}** · ${document.source} · ` +
        `${document.chunkCount} chunk(s)${created ? ` · ${time(created, "R")}` : ""}`;
    });
    const embed = new EmbedBuilder()
      .setTitle("Knowledge base")
      .setColor(LogColor.ai)
      .setDescription(lines.length > 0 ? lines.join("\n") : "Empty. Add something with `/ai knowledge add` or `/ai knowledge upload`.")
      .setFooter({
        text: `${counts.documents} document(s) · ${counts.chunks} chunk(s) · ` +
          (context.ai.embedder ? `${counts.embeddedChunks} embedded with ${context.ai.embedder.id}` : "keyword search only")
      });
    await replyEphemeral(interaction, { embeds: [embed] });
    return;
  }

  if (subcommand === "remove") {
    const id = interaction.options.getInteger("id", true);
    if (!deleteDocument(guildId, id)) throw new UserFacingError(`There is no document #${id} on this server.`);
    await replyEphemeral(interaction, `🗑️ Document #${id} removed from the knowledge base.`);
    return;
  }

  // search: lets admins see exactly what retrieval returns (useful for tuning and demos).
  const query = interaction.options.getString("query", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const queryVector = await context.ai.embedder?.tryEmbed(query);
  const hits = retrieveKnowledge(guildId, query, {
    queryVector,
    embeddingModel: context.ai.embedder?.id,
    minSimilarity: context.ai.settings.ragMinSimilarity,
    limit: 5
  });
  const embed = new EmbedBuilder()
    .setTitle(`Retrieval for “${truncate(query, 80)}”`)
    .setColor(LogColor.ai)
    .setFooter({ text: queryVector ? `Hybrid: BM25 + ${context.ai.embedder?.id}, fused with RRF` : "Keyword search (BM25) only" });
  if (hits.length === 0) embed.setDescription("Nothing relevant found.");
  hits.forEach((hit, index) => embed.addFields({
    name: `${index + 1}. ${truncate(hit.title, 80)}`,
    value: [
      [
        hit.keywordRank ? `keyword rank #${hit.keywordRank}` : "no keyword match",
        hit.vectorSimilarity !== undefined ? `similarity ${hit.vectorSimilarity.toFixed(2)}` : undefined,
        `fused ${hit.score.toFixed(4)}`
      ].filter(Boolean).join(" · "),
      `> ${truncate(hit.content.replace(/\s+/g, " "), 300)}`
    ].join("\n")
  }));
  await interaction.editReply({ embeds: [embed] });
}

async function saveKnowledge(
  interaction: GuildCommandInteraction,
  context: AppContext,
  input: { title: string; content: string; source: KnowledgeSource; sourceRef?: string }
): Promise<void> {
  let document;
  try {
    document = addDocument({ ...input, guildId: interaction.guildId, createdBy: interaction.user.id });
  } catch (error) {
    if (error instanceof KnowledgeError) throw new UserFacingError(error.message);
    throw error;
  }

  let indexing = "Searchable by keywords. Set an embedding model to enable semantic search.";
  if (context.ai.indexer) {
    try {
      await context.ai.indexer.runOnce();
      indexing = `Indexed for semantic search with \`${context.ai.embedder?.id}\`.`;
    } catch (error) {
      logger.warn("ai.knowledge_index_failed", { guildId: interaction.guildId, ...describeError(error) });
      indexing = "Searchable by keywords now; semantic indexing will retry in the background.";
    }
  }
  await replyEphemeral(
    interaction,
    `📚 Added **${truncate(document.title, 80)}** as #${document.id} (${document.chunkCount} chunk(s)). ${indexing}`
  );
}

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim().slice(0, 100);
}

// ---------------------------------------------------------------------------
// /ai memory … (personal memory, controlled by each member)
// ---------------------------------------------------------------------------

async function memory(interaction: GuildCommandInteraction, subcommand: string): Promise<void> {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  if (subcommand === "remember") {
    const fact = interaction.options.getString("fact", true).trim();
    const added = addUserFacts(guildId, userId, [fact], "user");
    await replyEphemeral(interaction, added > 0 ? `🧠 Got it, I'll remember: “${fact}”` : "I already remember that. 🙂");
    return;
  }

  if (subcommand === "forget") {
    const number = interaction.options.getInteger("fact");
    if (number !== null) {
      const fact = getUserFacts(guildId, userId)[number - 1];
      if (!fact) throw new UserFacingError("There is no fact with that number. Check `/ai memory view`.");
      deleteUserFact(guildId, userId, fact.id);
      await replyEphemeral(interaction, `🗑️ Forgotten: “${fact.fact}”`);
      return;
    }
    const facts = deleteUserFacts(guildId, userId);
    const messages = deleteMemory({ guildId, userId });
    const answers = deleteUserExchanges(guildId, userId);
    await replyEphemeral(
      interaction,
      `🧹 Done. I deleted ${formatCount(facts)} fact(s), ${formatCount(messages)} chat message(s) and ` +
        `${formatCount(answers)} logged answer(s) about you on this server.`
    );
    return;
  }

  const facts = getUserFacts(guildId, userId);
  const overview = getUserMemoryOverview(guildId, userId);
  const embed = new EmbedBuilder()
    .setTitle("What I remember about you")
    .setColor(LogColor.ai)
    .addFields(
      {
        name: "Facts",
        value: facts.length > 0
          ? truncate(facts.map((fact, index) => `${index + 1}. ${fact.fact}${fact.source === "auto" ? " *(learned)*" : ""}`).join("\n"), 1_024)
          : "Nothing yet. Tell me something with `/ai memory remember`."
      },
      {
        name: "Conversations",
        value: `${formatCount(overview.messages)} recent message(s) and ${formatCount(overview.summaries)} summary(ies) ` +
          `across ${formatCount(overview.channels)} channel(s)`
      }
    )
    .setFooter({ text: "Only used when you talk to me · /ai memory forget deletes it" });
  await replyEphemeral(interaction, { embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Admin subcommands
// ---------------------------------------------------------------------------

async function learning(interaction: GuildCommandInteraction, context: AppContext): Promise<void> {
  requireAdministrator(interaction);
  const stats = getLearningStats(interaction.guildId, context.ai.embedder?.id);
  const { knowledge: kb, feedback, moderation, personalMemory } = stats;

  const embed = new EmbedBuilder()
    .setTitle("What I've learned on this server")
    .setColor(LogColor.ai)
    .setDescription(context.ai.settings.learningEnabled
      ? "Learning loops are **on**: answer feedback, moderator corrections, moderation reviews and personal memory."
      : "Learning loops are **off** (`AI_LEARNING=false`). The knowledge base still works.")
    .addFields(
      {
        name: "📚 Knowledge base",
        value: `${formatCount(kb.documents)} document(s), ${formatCount(kb.chunks)} chunk(s)\n` +
          `${formatCount(kb.corrections)} taught by moderators\n` +
          (context.ai.embedder
            ? `Hybrid search · ${formatCount(kb.embeddedChunks)}/${formatCount(kb.chunks)} embedded`
            : "Keyword search only")
      },
      {
        name: "👍 Answer feedback (30 days)",
        value: `${formatCount(feedback.up)} 👍 · ${formatCount(feedback.down)} 👎 · satisfaction ${percent(feedback.satisfaction)}\n` +
          `${formatCount(feedback.helpfulAnswers)} answer(s) reused as examples`
      },
      {
        name: "🛡️ AI moderation (30 days)",
        value: `${formatCount(moderation.flags)} flag(s), ${formatCount(moderation.reviewed)} reviewed · precision ${percent(moderation.precision)}\n` +
          `${formatCount(moderation.learnedExamples)} moderator decision(s) learned`
      },
      {
        name: "🧠 Personal memory",
        value: `${formatCount(personalMemory.facts)} fact(s) about ${formatCount(personalMemory.users)} member(s)`
      }
    );
  await replyEphemeral(interaction, { embeds: [embed] });
}

async function setup(interaction: GuildCommandInteraction, context: AppContext): Promise<void> {
  requireAdministrator(interaction);
  const channel = interaction.options.getChannel("channel", true, [ChannelType.GuildText]);
  const missing = missingBotPermissions(interaction, channel, {
    "View Channel": PermissionFlagsBits.ViewChannel,
    "Send Messages": PermissionFlagsBits.SendMessages,
    "Read Message History": PermissionFlagsBits.ReadMessageHistory
  });
  if (missing.length > 0) throw new UserFacingError(`I need these permissions in ${channel}: ${missing.join(", ")}.`);

  const mentionEnabled = interaction.options.getBoolean("mention_enabled") ?? true;
  enableAi(interaction.guildId, channel.id, mentionEnabled);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const lines = [`✅ AI chat is on in ${channel}. Mentions in other channels: **${mentionEnabled ? "on" : "off"}**.`];
  if (!context.ai.provider) {
    lines.push(`⚠️ No AI model is configured yet: ${context.ai.problems[0] ?? "set AI_PROVIDER in .env"}`);
  } else {
    const health = await context.ai.provider.checkHealth();
    if (!health.some(entry => entry.state === "ready")) {
      lines.push(`⚠️ The model is not ready yet:\n${health.map(formatHealth).join("\n")}`);
    }
  }
  await interaction.editReply(lines.join("\n"));
}

async function instructions(interaction: GuildCommandInteraction): Promise<void> {
  requireAdministrator(interaction);
  const text = interaction.options.getString("text")?.trim();
  const clear = interaction.options.getBoolean("clear") ?? false;

  if (clear) {
    setCustomInstructions(interaction.guildId, null);
    await replyEphemeral(interaction, "🗑️ Custom AI instructions removed.");
    return;
  }
  if (text) {
    setCustomInstructions(interaction.guildId, text.slice(0, MAX_CUSTOM_INSTRUCTIONS));
    await replyEphemeral(interaction, `✅ Saved. The AI will follow these instructions on this server:\n>>> ${text}`);
    return;
  }

  const current = getAiGuildSettings(interaction.guildId).customInstructions;
  await replyEphemeral(interaction, current
    ? `Current AI instructions:\n>>> ${current}`
    : "No custom instructions yet. Add some with `/ai instructions text:...` (e.g. server rules or the tone to use).");
}

async function status(interaction: GuildCommandInteraction, context: AppContext): Promise<void> {
  requireAdministrator(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  const runtime = context.ai;
  const settings = getAiGuildSettings(guildId);
  const health = runtime.provider ? await runtime.provider.checkHealth() : [];
  const usage = getDailyUsage(guildId);
  const moderation = getGuildConfig(guildId);
  const knowledgeCounts = getKnowledgeCounts(guildId, runtime.embedder?.id);
  const channelValue = settings.channelId
    ? interaction.guild.channels.cache.has(settings.channelId) ? `<#${settings.channelId}>` : `Deleted channel (${settings.channelId})`
    : "Not set";

  const embed = new EmbedBuilder()
    .setTitle("AI status")
    .setColor(LogColor.ai)
    .addFields(
      { name: "AI chat", value: onOff(settings.enabled), inline: true },
      { name: "AI channel", value: channelValue, inline: true },
      { name: "Mention mode", value: onOff(settings.mentionEnabled), inline: true },
      { name: "Models (in fallback order)", value: health.length > 0 ? health.map(formatHealth).join("\n") : "Not configured" },
      {
        name: "Retrieval",
        value: runtime.embedder
          ? `Hybrid (BM25 + \`${runtime.embedder.id}\`)${runtime.embedder.available ? "" : " · embeddings paused after an error"}`
          : "Keyword (BM25) only",
        inline: true
      },
      { name: "Knowledge base", value: `${formatCount(knowledgeCounts.documents)} document(s)`, inline: true },
      { name: "Learning", value: onOff(runtime.settings.learningEnabled), inline: true },
      { name: "Persona", value: runtime.persona.name, inline: true },
      { name: "Tools · Vision", value: `${onOff(runtime.settings.toolsEnabled)} · ${onOff(runtime.settings.visionEnabled)}`, inline: true },
      {
        name: "AI moderation",
        value: moderation.aiModeration ? `On (${moderation.aiModerationAction}, ≥ ${Math.round(moderation.aiModerationThreshold * 100)}%)` : "Off",
        inline: true
      },
      {
        name: "Server instructions",
        value: settings.customInstructions ? `${formatCount(settings.customInstructions.length)} characters` : "None",
        inline: true
      },
      {
        name: "Stored memory",
        value: `${formatCount(countGuildMessages(guildId))} messages (kept ${MEMORY_LIMITS.retentionDays} days)`,
        inline: true
      },
      {
        name: "Today (UTC)",
        value: usage.requests > 0
          ? `${formatCount(usage.requests)} requests (${formatCount(usage.failures)} failed) · ` +
            `${formatCount(usage.inputTokens)} in / ${formatCount(usage.outputTokens)} out tokens · ` +
            `avg ${formatCount(usage.averageLatencyMs)} ms`
          : "No requests yet"
      }
    );
  if (runtime.problems.length > 0) {
    embed.addFields({ name: "⚠️ Configuration problems", value: truncate(runtime.problems.join("\n"), 1_000) });
  }
  await interaction.editReply({ embeds: [embed] });
}

async function reset(interaction: GuildCommandInteraction): Promise<void> {
  const scope = interaction.options.getString("scope") ?? "mine";
  const target = interaction.options.getUser("user");
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  if (scope === "mine") {
    if (target) throw new UserFacingError("The `user` option only works with the \"user\" scope.");
    const deleted = deleteMemory({ guildId, channelId, userId: interaction.user.id });
    await replyEphemeral(interaction, `🧹 Deleted ${formatCount(deleted)} message(s) from your AI memory in this channel.`);
    return;
  }

  requireAdministrator(interaction);
  if (scope === "user") {
    if (!target) throw new UserFacingError("Choose a `user` for the \"user\" scope.");
    const deleted = deleteMemory({ guildId, channelId, userId: target.id });
    await replyEphemeral(interaction, {
      content: `🧹 Deleted ${formatCount(deleted)} message(s) from ${target}'s AI memory in this channel.`,
      allowedMentions: { parse: [] }
    });
    return;
  }
  if (scope !== "channel" && scope !== "server") throw new UserFacingError("Unknown reset scope.");
  if (!interaction.options.getBoolean("confirm")) {
    throw new UserFacingError(`Add \`confirm:true\` to delete all AI memory in this ${scope}.`);
  }
  const deleted = deleteMemory(scope === "channel" ? { guildId, channelId } : { guildId });
  await replyEphemeral(interaction, `🧹 Deleted ${formatCount(deleted)} message(s) of AI memory in this ${scope}.`);
}

async function disable(interaction: GuildCommandInteraction): Promise<void> {
  requireAdministrator(interaction);
  disableAi(interaction.guildId);
  const deleteAll = interaction.options.getBoolean("delete_memory") ?? false;
  const deleted = deleteAll ? deleteMemory({ guildId: interaction.guildId }) : 0;
  await replyEphemeral(interaction, deleteAll
    ? `AI chat is off and ${formatCount(deleted)} stored message(s) were deleted.`
    : `AI chat is off. Stored memory is kept until it expires (${MEMORY_LIMITS.retentionDays} days) or is reset. ` +
      "AI moderation is controlled separately with `/setup automod`.");
}

const HEALTH_LABELS: Record<ProviderHealth["state"], string> = {
  ready: "🟢 ready",
  model_missing: "🟡 model not found",
  unreachable: "🔴 unreachable",
  auth_failed: "🔴 invalid API key",
  error: "🔴 error"
};

function formatHealth(health: ProviderHealth): string {
  const detail = health.detail && health.state !== "ready" ? ` — ${truncate(health.detail, 120)}` : "";
  return `${HEALTH_LABELS[health.state]} · \`${health.provider}\` / \`${health.model}\`${detail}`;
}
