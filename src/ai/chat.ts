import type { Guild, GuildMember, GuildTextBasedChannel, User } from "discord.js";
import { logger } from "../logger.js";
import { truncate } from "../utils/text.js";
import { runAgent } from "./agent.js";
import { AiError } from "./errors.js";
import { getAiGuildSettings } from "./guild-settings.js";
import { findExemplars, hasExemplars, type Exemplar } from "./learning/exchanges.js";
import { scheduleMemoryCompaction } from "./memory-compactor.js";
import { MEMORY_LIMITS, getRecentMessages, getSummary, saveExchange, type ConversationKey } from "./memory.js";
import {
  buildSystemPrompt,
  buildTurnContext,
  detectActiveModes,
  knownMemberIds,
  type DiscordUserRef
} from "./persona.js";
import type { ChatMessage, ImageInput } from "./providers/index.js";
import { CitationRegistry, type CitedSource } from "./rag/citations.js";
import { hasKnowledge, retrieveKnowledge, type KnowledgeHit } from "./rag/knowledge.js";
import type { AiRuntime } from "./runtime.js";
import { getDiscordTools, type KnowledgeToolAccess } from "./tools.js";
import { recordUsage } from "./usage.js";
import { getUserFacts } from "./user-memory.js";

export interface ChatTurnInput {
  guild: Guild;
  channel: GuildTextBasedChannel;
  author: User;
  member: GuildMember | null;
  prompt: string;
  mentionedUsers: DiscordUserRef[];
  images?: ImageInput[];
  /** Message that triggered the turn (excluded from the "recent messages" tool). */
  triggerMessageId?: string;
}

export interface ChatTurnResult {
  text: string;
  /** Labels of tools the agent used successfully, shown under the answer. */
  toolLabels: string[];
  /** Knowledge base documents the answer cites. */
  sources: CitedSource[];
  /** The only users the answer is allowed to ping. */
  allowedMentionIds: string[];
  provider: string;
  model: string;
}

/** What the bot knows that is relevant to this turn (retrieval + learning). */
interface TurnKnowledge {
  citations: CitationRegistry;
  excerpts: KnowledgeHit[];
  exemplars: Exemplar[];
  facts: string[];
  toolAccess?: KnowledgeToolAccess;
}

const IMAGE_ONLY_PROMPT = "(The user sent an image without any text.)";
const AUTO_RETRIEVAL_LIMIT = 4;

export function toUserRef(user: User, member?: GuildMember | null): DiscordUserRef {
  return {
    id: user.id,
    username: user.username,
    displayName: member?.displayName ?? user.globalName ?? user.username
  };
}

function conversationKey(input: ChatTurnInput): ConversationKey {
  return { guildId: input.guild.id, channelId: input.channel.id, userId: input.author.id };
}

/**
 * Retrieval-augmented context for one turn: knowledge base excerpts (hybrid
 * search), answers the community rated helpful (few-shot learning) and the
 * speaker's personal memory. The query is embedded once and reused.
 */
async function gatherKnowledge(runtime: AiRuntime, input: ChatTurnInput): Promise<TurnKnowledge> {
  const guildId = input.guild.id;
  // Numbers every excerpt the model sees ([1], [2], …) so its citations can be resolved later.
  const citations = new CitationRegistry();
  const learning = runtime.settings.learningEnabled;
  // Cheap existence checks first, so servers without knowledge or feedback skip all retrieval work.
  const knowledgeAvailable = hasKnowledge(guildId);
  const exemplarsAvailable = learning && hasExemplars(guildId);
  // Personal memory: durable facts about the speaker (e.g. "prefers English").
  const facts = getUserFacts(guildId, input.author.id).map(fact => fact.fact);

  const prompt = input.prompt.trim();
  // Embed the question once and reuse the vector for both knowledge and example search.
  // tryEmbed never throws: without embeddings, retrieval falls back to keyword search.
  const queryVector = prompt && (knowledgeAvailable || exemplarsAvailable)
    ? await runtime.embedder?.tryEmbed(prompt)
    : undefined;
  const retrieval = {
    embeddingModel: runtime.embedder?.id,
    minSimilarity: runtime.settings.ragMinSimilarity
  };

  // RAG: automatic retrieval before the model runs. This also works with models that
  // cannot call tools (e.g. gemma3), because the excerpts go straight into the prompt.
  const excerpts = knowledgeAvailable && prompt
    ? retrieveKnowledge(guildId, prompt, { ...retrieval, queryVector, limit: AUTO_RETRIEVAL_LIMIT })
    : [];
  for (const hit of excerpts) citations.register(hit);

  // Learning from feedback: answers members rated 👍 for similar questions become examples.
  // The bar is higher than for knowledge, because a weak example misleads more than it helps.
  const exemplars = exemplarsAvailable && prompt
    ? findExemplars(guildId, { text: prompt, vector: queryVector, model: runtime.embedder?.id }, {
        minCosine: runtime.settings.ragMinSimilarity + 0.15
      })
    : [];

  // Agentic retrieval: the model can also search on its own (e.g. with a reworded query).
  // It shares the citation registry, so its results continue the numbering.
  const toolAccess: KnowledgeToolAccess | undefined = knowledgeAvailable
    ? {
        citations,
        search: async query => retrieveKnowledge(guildId, query, {
          ...retrieval,
          queryVector: await runtime.embedder?.tryEmbed(query),
          limit: AUTO_RETRIEVAL_LIMIT
        })
      }
    : undefined;

  return { citations, excerpts, exemplars, facts, toolAccess };
}

/**
 * One chat turn: builds the prompt (persona + server instructions + personal
 * memory + retrieved knowledge + rated examples + history + speaker context),
 * runs the tool-calling agent and records usage. Saving to memory is a
 * separate step, done only after the answer was delivered to Discord.
 */
export async function generateChatReply(runtime: AiRuntime, input: ChatTurnInput): Promise<ChatTurnResult> {
  const provider = runtime.provider;
  if (!provider) throw new AiError("NOT_CONFIGURED", runtime.problems[0] ?? "No AI provider is configured");

  // 1. Short-term memory: the latest messages of this conversation, within a character
  //    budget that leaves room for the new prompt.
  const key = conversationKey(input);
  const settings = getAiGuildSettings(input.guild.id);
  const history = getRecentMessages(
    key,
    MEMORY_LIMITS.contextMessages,
    Math.max(0, MEMORY_LIMITS.contextCharacters - input.prompt.length)
  );
  // 2. Long-term context: knowledge excerpts, rated examples and personal facts.
  const knowledge = await gatherKnowledge(runtime, input);
  // 3. Tools for the agent, already filtered by what the speaker is allowed to see.
  const toolContext = {
    guild: input.guild,
    channel: input.channel,
    requester: input.member,
    timezone: runtime.timezone,
    triggerMessageId: input.triggerMessageId,
    knowledge: knowledge.toolAccess
  };
  const tools = runtime.settings.toolsEnabled ? getDiscordTools(toolContext) : [];
  // Persona modes (e.g. "competitive") look at the last few messages, so a mode stays on
  // for the whole topic instead of flickering message by message.
  const recentText = [...history.slice(-4).map(message => message.content), input.prompt].join("\n");

  // 4. Message order matters:
  //    system prompt (persona, rules, memory, knowledge, examples) → history →
  //    a short "who is speaking / active mode" note → the new message.
  //    The note sits right before the question so small local models do not lose track of it.
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(runtime.persona, {
        serverName: input.guild.name,
        customInstructions: settings.customInstructions,
        memorySummary: getSummary(key),
        toolsEnabled: tools.length > 0,
        userFacts: knowledge.facts,
        knowledge: knowledge.citations.entries().map(({ number, hit }) => ({
          number,
          title: hit.title,
          content: hit.content
        })),
        exemplars: knowledge.exemplars
      })
    },
    ...history.map((message): ChatMessage => ({ role: message.role, content: message.content })),
    {
      role: "system",
      content: buildTurnContext(runtime.persona, {
        speaker: toUserRef(input.author, input.member),
        mentionedUsers: input.mentionedUsers,
        activeModes: detectActiveModes(runtime.persona, recentText)
      })
    },
    {
      role: "user",
      content: input.prompt || IMAGE_ONLY_PROMPT,
      ...(input.images?.length ? { images: input.images } : {})
    }
  ];

  const started = Date.now();
  try {
    // 5. Run the tool-calling loop (see agent.ts). The provider may be a fallback chain.
    const result = await runAgent({
      provider,
      messages,
      tools,
      context: toolContext,
      maxOutputTokens: runtime.settings.maxOutputTokens,
      temperature: runtime.settings.temperature
    });
    const latencyMs = Date.now() - started;
    // 6. Map the [n] markers in the answer back to documents for the "📚 Sources" footnote.
    //    Only sources the model actually cited are shown, not everything it was given.
    const sources = knowledge.citations.cited(result.text);
    // 7. Tokens and latency per server, shown in /ai status.
    recordUsage({
      guildId: input.guild.id,
      feature: "chat",
      provider: result.provider,
      model: result.model,
      ...result.usage,
      latencyMs,
      ok: true
    });
    logger.info("ai.chat_completed", {
      guildId: input.guild.id,
      provider: result.provider,
      model: result.model,
      steps: result.steps,
      tools: result.toolCalls.map(call => call.name),
      retrievedExcerpts: knowledge.excerpts.length,
      citedSources: sources.length,
      exemplars: knowledge.exemplars.length,
      facts: knowledge.facts.length,
      images: input.images?.length ?? 0,
      latencyMs,
      ...result.usage
    });

    return {
      text: result.text,
      toolLabels: [...new Set(result.toolCalls.filter(call => call.ok).map(call => call.label))],
      sources,
      // Mention allow-list: the answer may only ping these users, whatever the model writes.
      allowedMentionIds: [...new Set([
        input.author.id,
        ...input.mentionedUsers.map(user => user.id),
        ...knownMemberIds(runtime.persona)
      ])],
      provider: result.provider,
      model: result.model
    };
  } catch (error) {
    // Failures are recorded too, so /ai status shows the real error rate.
    recordUsage({
      guildId: input.guild.id,
      feature: "chat",
      provider: provider.id,
      model: provider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      ok: false
    });
    throw error;
  }
}

/** Stores the exchange and, if the conversation got long, compacts older turns in the background. */
export function rememberChatTurn(runtime: AiRuntime, input: ChatTurnInput, answer: string): void {
  const key = conversationKey(input);
  const imageNote = input.images?.length ? ` [sent ${input.images.length} image(s)]` : "";
  saveExchange(key, `${input.prompt}${imageNote}`.trim(), answer);
  if (runtime.provider) {
    scheduleMemoryCompaction(runtime.provider, key, { extractFacts: runtime.settings.learningEnabled });
  }
}

/** Small grey line under an answer: tools used and cited knowledge sources. */
export function replyFootnote(result: Pick<ChatTurnResult, "toolLabels" | "sources">): string | undefined {
  const parts: string[] = [];
  if (result.toolLabels.length > 0) parts.push(`🔧 ${result.toolLabels.join(" · ")}`);
  if (result.sources.length > 0) {
    parts.push(`📚 ${result.sources.slice(0, 4).map(source => `[${source.number}] ${truncate(source.title, 40)}`).join(" · ")}`);
  }
  return parts.length > 0 ? parts.join("  |  ") : undefined;
}
