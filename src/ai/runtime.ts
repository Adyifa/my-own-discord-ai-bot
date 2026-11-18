import type { AiSettings } from "../config.js";
import { Embedder, createEmbeddingProvider } from "./embeddings.js";
import { resolvePersona, type Persona } from "./persona.js";
import { createChatProvider, type ChatProvider } from "./providers/index.js";
import { EmbeddingIndexer } from "./rag/indexer.js";

/** Everything the AI features need at runtime, created once at startup. */
export interface AiRuntime {
  provider: ChatProvider | undefined;
  /** Semantic search; when missing, retrieval and learning fall back to keyword matching. */
  embedder?: Embedder;
  /** Keeps knowledge, rated answers and reviewed flags embedded in the background. */
  indexer?: EmbeddingIndexer;
  persona: Persona;
  settings: AiSettings;
  timezone: string;
  /** Configuration problems to surface in logs and `/ai status`. */
  problems: string[];
}

export function createAiRuntime(settings: AiSettings, timezone: string): AiRuntime {
  const problems: string[] = [];
  if (settings.problem) problems.push(settings.problem);
  if (settings.embeddingProblem) problems.push(`Embeddings disabled: ${settings.embeddingProblem}`);

  const { persona, problem } = resolvePersona(settings.personaFile);
  if (problem) problems.push(problem);

  const embeddingProvider = createEmbeddingProvider(settings.embedding);
  const embedder = embeddingProvider ? new Embedder(embeddingProvider) : undefined;

  return {
    provider: createChatProvider(settings.providers),
    embedder,
    indexer: embedder ? new EmbeddingIndexer(embedder) : undefined,
    persona,
    settings,
    timezone,
    problems
  };
}
