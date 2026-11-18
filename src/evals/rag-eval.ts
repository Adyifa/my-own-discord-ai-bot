import type { Guild, GuildTextBasedChannel, User } from "discord.js";
import { generateChatReply, type ChatTurnInput } from "../ai/chat.js";
import type { Embedder } from "../ai/embeddings.js";
import { addDocument, retrieveKnowledge, type RetrievalMode } from "../ai/rag/knowledge.js";
import type { AiRuntime } from "../ai/runtime.js";
import type { KnowledgeFile, RagEvalItem } from "./datasets.js";
import { hitAtK, mapWithConcurrency, mean, reciprocalRank } from "./metrics.js";

export interface RetrievalEvalResult {
  mode: RetrievalMode;
  embeddingModel?: string;
  hitAt1: number;
  hitAt3: number;
  mrr: number;
  perItem: Array<{ id: string; expected: string; ranked: string[] }>;
}

export interface AnswerEvalResult {
  provider: string;
  model: string;
  /** Share of answers containing every required fact. */
  accuracy: number;
  /** Share of answers citing the document that holds the answer. */
  citationRate: number;
  avgLatencyMs: number;
  errors: number;
  results: Array<{ id: string; correct: boolean; cited: boolean; missing: string[]; latencyMs: number; answer: string; error?: string }>;
}

export const EVAL_GUILD_ID = "100000000000000000";

/** Loads the eval documents into the (in-memory) knowledge base, exactly like `/ai knowledge upload`. */
export function ingestKnowledgeFiles(files: readonly KnowledgeFile[], guildId = EVAL_GUILD_ID): void {
  for (const file of files) {
    addDocument({ guildId, title: file.title, content: file.content, source: "file", sourceRef: file.fileName, createdBy: "eval" });
  }
}

/** Measures retrieval alone: is the right document ranked first / in the top 3? */
export async function runRetrievalEval(options: {
  items: readonly RagEvalItem[];
  embedder?: Embedder;
  minSimilarity: number;
  guildId?: string;
}): Promise<RetrievalEvalResult[]> {
  const guildId = options.guildId ?? EVAL_GUILD_ID;
  const vectors = options.embedder ? await options.embedder.embed(options.items.map(item => item.question)) : undefined;
  const modes: RetrievalMode[] = options.embedder ? ["keyword", "vector", "hybrid"] : ["keyword"];

  return modes.map(mode => {
    const perItem = options.items.map((item, index) => {
      const hits = retrieveKnowledge(guildId, item.question, {
        mode,
        queryVector: vectors?.[index],
        embeddingModel: options.embedder?.id,
        minSimilarity: options.minSimilarity,
        limit: 5
      });
      return { id: item.id, expected: item.expectedDocument, ranked: [...new Set(hits.map(hit => hit.title))] };
    });
    return {
      mode,
      embeddingModel: mode === "keyword" ? undefined : options.embedder?.id,
      hitAt1: mean(perItem.map(item => Number(hitAtK(item.ranked, item.expected, 1)))),
      hitAt3: mean(perItem.map(item => Number(hitAtK(item.ranked, item.expected, 3)))),
      mrr: mean(perItem.map(item => reciprocalRank(item.ranked, item.expected))),
      perItem
    };
  });
}

/** Measures the full RAG answer path (the production prompt pipeline) for one model. */
export async function runAnswerEval(options: {
  runtime: AiRuntime;
  items: readonly RagEvalItem[];
  concurrency?: number;
  guildId?: string;
}): Promise<AnswerEvalResult> {
  const provider = options.runtime.provider;
  if (!provider) throw new Error("The answer eval needs a chat model.");
  const guildId = options.guildId ?? EVAL_GUILD_ID;

  const results = await mapWithConcurrency(options.items, options.concurrency ?? 1, async (item, index) => {
    const started = Date.now();
    try {
      // The eval calls the real production pipeline (retrieval → prompt → agent → citations)
      // with stand-in Discord objects, so it measures what members would actually get.
      const reply = await generateChatReply(options.runtime, evalChatInput(guildId, item.question, index));
      // Deterministic grading (no LLM judge): every required fact must appear in the answer,
      // where "sabtu|saturday" accepts either language. Cheap, reproducible and explainable.
      const answer = reply.text.toLowerCase();
      const missing = item.mustInclude.filter(required =>
        !required.toLowerCase().split("|").some(alternative => answer.includes(alternative.trim())));
      return {
        id: item.id,
        correct: missing.length === 0,
        cited: reply.sources.some(source => source.title === item.expectedDocument),
        missing,
        latencyMs: Date.now() - started,
        answer: reply.text
      };
    } catch (error) {
      return {
        id: item.id,
        correct: false,
        cited: false,
        missing: item.mustInclude,
        latencyMs: Date.now() - started,
        answer: "",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  return {
    provider: provider.id,
    model: provider.model,
    accuracy: mean(results.map(result => Number(result.correct))),
    citationRate: mean(results.map(result => Number(result.cited))),
    avgLatencyMs: Math.round(mean(results.map(result => result.latencyMs))),
    errors: results.filter(result => result.error).length,
    results
  };
}

/** Minimal stand-ins for the Discord objects the chat pipeline reads (a fresh user per question). */
function evalChatInput(guildId: string, question: string, index: number): ChatTurnInput {
  return {
    guild: { id: guildId, name: "Nusantara Gaming Hub", members: { me: null } } as unknown as Guild,
    channel: { id: "100000000000000001", name: "general" } as unknown as GuildTextBasedChannel,
    author: {
      id: `20000000000000${String(index).padStart(4, "0")}`,
      username: `eval_user_${index}`,
      globalName: `Eval User ${index}`
    } as unknown as User,
    member: null,
    prompt: question,
    mentionedUsers: []
  };
}
