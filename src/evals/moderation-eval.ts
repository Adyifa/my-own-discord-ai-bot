import type { Embedder } from "../ai/embeddings.js";
import { classifyMessage, type ModerationCategory, type ModerationExample } from "../ai/moderation.js";
import type { ChatProvider } from "../ai/providers/index.js";
import { rankBySimilarity } from "../ai/rag/similarity.js";
import type { ModerationEvalItem, ModerationExampleItem } from "./datasets.js";
import { binaryMetrics, mapWithConcurrency, mean, percentile, type BinaryMetrics } from "./metrics.js";

/** zero-shot = generic classifier; few-shot = with similar past moderator decisions (what the bot learns). */
export type ModerationEvalMode = "zero-shot" | "few-shot";

export interface ModerationPrediction {
  id: string;
  group: ModerationEvalItem["group"];
  text: string;
  expected: boolean;
  predicted: boolean;
  expectedCategory: ModerationCategory;
  predictedCategory: ModerationCategory;
  confidence: number;
  examplesUsed: number;
  latencyMs: number;
  outcome: "ok" | "unparseable" | "error";
  error?: string;
}

export interface ModerationEvalResult {
  provider: string;
  model: string;
  mode: ModerationEvalMode;
  threshold: number;
  overall: BinaryMetrics;
  general: BinaryMetrics;
  serverNorms: BinaryMetrics;
  /** Among correctly flagged messages, how often the category was also right. */
  categoryAccuracy: number;
  unparseable: number;
  errors: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  predictions: ModerationPrediction[];
}

export interface ModerationEvalOptions {
  provider: ChatProvider;
  items: readonly ModerationEvalItem[];
  mode: ModerationEvalMode;
  /** Simulated moderator decisions available to the few-shot mode. */
  examplePool?: readonly ModerationExampleItem[];
  /** Optional: match examples by meaning instead of word overlap. */
  embedder?: Embedder;
  /** Confidence needed to act, like `/setup automod ai_threshold` (default 0.8). */
  threshold?: number;
  concurrency?: number;
  examplesPerItem?: number;
}

/** Runs the production classifier over a labelled dataset and scores it. */
export async function runModerationEval(options: ModerationEvalOptions): Promise<ModerationEvalResult> {
  const threshold = options.threshold ?? 0.8;
  // The only difference between the two modes: zero-shot gets no examples, few-shot gets
  // the simulated moderator decisions. Same model, same prompt, same messages, so any
  // change in the scores is the effect of learning.
  const pool = options.mode === "few-shot" ? options.examplePool ?? [] : [];

  let poolVectors: Float32Array[] | undefined;
  let itemVectors: Float32Array[] | undefined;
  if (options.embedder && pool.length > 0) {
    poolVectors = await options.embedder.embed(pool.map(example => example.text));
    itemVectors = await options.embedder.embed(options.items.map(item => item.text));
  }
  const candidates = pool.map((example, index) => ({
    item: example,
    text: example.text,
    vector: poolVectors?.[index] ?? null,
    model: options.embedder?.id ?? null
  }));

  let inputTokens = 0;
  let outputTokens = 0;
  const predictions = await mapWithConcurrency(options.items, options.concurrency ?? 2, async (item, index) => {
    // The same selection as in production (findModerationExamples): the most similar
    // past decisions, by meaning when an embedder is given, otherwise by word overlap.
    const examples: ModerationExample[] = candidates.length > 0
      ? rankBySimilarity(
          { text: item.text, vector: itemVectors?.[index], model: options.embedder?.id },
          candidates,
          { limit: options.examplesPerItem ?? 4, minCosine: 0.55, minOverlap: 0.3 }
        ).map(({ item: example }) => ({ text: example.text, violates: example.flagged, category: example.category }))
      : [];

    const base = {
      id: item.id,
      group: item.group,
      text: item.text,
      expected: item.flagged,
      expectedCategory: item.category,
      examplesUsed: examples.length
    };
    const started = Date.now();
    try {
      const { verdict, response } = await classifyMessage(options.provider, item.text, { examples });
      inputTokens += response.usage.inputTokens;
      outputTokens += response.usage.outputTokens;
      return {
        ...base,
        // "Flagged" only counts above the confidence threshold, exactly like the bot in production.
        predicted: Boolean(verdict?.flagged && verdict.confidence >= threshold),
        predictedCategory: verdict?.category ?? "none",
        confidence: verdict?.confidence ?? 0,
        latencyMs: Date.now() - started,
        outcome: verdict ? "ok" as const : "unparseable" as const
      };
    } catch (error) {
      // Fail open, exactly like production: an error never flags a message.
      return {
        ...base,
        predicted: false,
        predictedCategory: "none" as const,
        confidence: 0,
        latencyMs: Date.now() - started,
        outcome: "error" as const,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  const flaggedCorrectly = predictions.filter(prediction => prediction.expected && prediction.predicted);
  const latencies = predictions.map(prediction => prediction.latencyMs);
  return {
    provider: options.provider.id,
    model: options.provider.model,
    mode: options.mode,
    threshold,
    overall: binaryMetrics(predictions),
    general: binaryMetrics(predictions.filter(prediction => prediction.group === "general")),
    serverNorms: binaryMetrics(predictions.filter(prediction => prediction.group === "server_norms")),
    categoryAccuracy: flaggedCorrectly.length > 0
      ? flaggedCorrectly.filter(prediction => prediction.predictedCategory === prediction.expectedCategory).length / flaggedCorrectly.length
      : 0,
    unparseable: predictions.filter(prediction => prediction.outcome === "unparseable").length,
    errors: predictions.filter(prediction => prediction.outcome === "error").length,
    avgLatencyMs: Math.round(mean(latencies)),
    p95LatencyMs: percentile(latencies, 95),
    inputTokens,
    outputTokens,
    predictions
  };
}
