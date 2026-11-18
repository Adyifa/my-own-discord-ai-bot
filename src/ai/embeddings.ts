import type { EmbeddingConfig } from "../config.js";
import { describeError, logger } from "../logger.js";
import { isRecord } from "../utils/text.js";
import { AiError } from "./errors.js";
import { DEFAULT_RETRY, joinUrl, requestJson, toNumber, withRetry, type RetryOptions } from "./providers/http.js";
import { normalize } from "./rag/vectors.js";

export interface EmbeddingResult {
  /** Unit-length vectors, one per input text. */
  vectors: Float32Array[];
  inputTokens: number;
}

export interface EmbeddingProvider {
  /** Stable identity stored next to every vector, e.g. "ollama:bge-m3". */
  readonly id: string;
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

interface ProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  retry?: RetryOptions;
}

const BATCH_SIZE = 32;
const MAX_INPUT_CHARACTERS = 4_000;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(private readonly options: ProviderOptions) {
    this.id = `ollama:${options.model}`;
  }

  embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return embedInBatches(texts, async batch => {
      const data = await withRetry(() => requestJson({
        provider: "ollama",
        url: joinUrl(this.options.baseUrl, "/api/embed"),
        method: "POST",
        body: { model: this.options.model, input: batch, keep_alive: "5m" },
        timeoutMs: this.options.timeoutMs
      }), this.options.retry ?? DEFAULT_RETRY);
      return {
        vectors: parseVectors(isRecord(data) ? data.embeddings : undefined, batch.length, "ollama"),
        inputTokens: isRecord(data) ? toNumber(data.prompt_eval_count) : 0
      };
    });
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;

  constructor(private readonly options: ProviderOptions) {
    this.id = `openai:${options.model}`;
  }

  embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return embedInBatches(texts, async batch => {
      const data = await withRetry(() => requestJson({
        provider: "openai",
        url: joinUrl(this.options.baseUrl, "embeddings"),
        method: "POST",
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
        body: { model: this.options.model, input: batch },
        timeoutMs: this.options.timeoutMs
      }), this.options.retry ?? DEFAULT_RETRY);

      const rows = isRecord(data) && Array.isArray(data.data) ? [...data.data] : undefined;
      rows?.sort((a, b) => indexOf(a) - indexOf(b));
      return {
        vectors: parseVectors(rows?.map(row => isRecord(row) ? row.embedding : undefined), batch.length, "openai"),
        inputTokens: isRecord(data) && isRecord(data.usage) ? toNumber(data.usage.prompt_tokens) : 0
      };
    });
  }
}

export function createEmbeddingProvider(config: EmbeddingConfig | undefined): EmbeddingProvider | undefined {
  if (!config) return undefined;
  return config.kind === "ollama" ? new OllamaEmbeddingProvider(config) : new OpenAIEmbeddingProvider(config);
}

/**
 * Embedding access for the live bot. `tryEmbed` never throws and pauses for a
 * minute after a failure, so a missing embedding model only downgrades
 * retrieval to keyword search instead of slowing down every message.
 */
export class Embedder {
  private pausedUntil = 0;

  constructor(
    readonly provider: EmbeddingProvider,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  get id(): string {
    return this.provider.id;
  }

  get available(): boolean {
    return this.now() >= this.pausedUntil;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    try {
      const { vectors } = await this.provider.embed(texts);
      this.pausedUntil = 0;
      return vectors;
    } catch (error) {
      this.pausedUntil = this.now() + this.cooldownMs;
      throw error;
    }
  }

  async tryEmbed(text: string): Promise<Float32Array | undefined> {
    // Used on the hot path (every chat message): during the pause, or for empty text,
    // return immediately and let retrieval use keyword search only.
    if (!this.available || !text.trim()) return undefined;
    try {
      return (await this.embed([text]))[0];
    } catch (error) {
      logger.warn("ai.embedding_failed", { model: this.id, ...describeError(error) });
      return undefined;
    }
  }
}

async function embedInBatches(
  texts: readonly string[],
  run: (batch: string[]) => Promise<EmbeddingResult>
): Promise<EmbeddingResult> {
  const vectors: Float32Array[] = [];
  let inputTokens = 0;
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE).map(text => text.slice(0, MAX_INPUT_CHARACTERS) || " ");
    const result = await run(batch);
    vectors.push(...result.vectors);
    inputTokens += result.inputTokens;
  }
  return { vectors, inputTokens };
}

function parseVectors(raw: unknown, expected: number, provider: string): Float32Array[] {
  if (!Array.isArray(raw) || raw.length !== expected) {
    throw new AiError(
      "INVALID_RESPONSE",
      `${provider} returned ${Array.isArray(raw) ? raw.length : 0} embeddings for ${expected} inputs`,
      { provider }
    );
  }
  return raw.map(vector => {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(value => typeof value === "number")) {
      throw new AiError("INVALID_RESPONSE", `${provider} returned a malformed embedding`, { provider });
    }
    // Vectors are normalised once at write time, so every later similarity check is a
    // plain dot product (cosine similarity without the division).
    return normalize(vector as number[]);
  });
}

function indexOf(row: unknown): number {
  return isRecord(row) && typeof row.index === "number" ? row.index : 0;
}
