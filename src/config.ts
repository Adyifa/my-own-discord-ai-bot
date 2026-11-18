import { isLogLevel, type LogLevel } from "./logger.js";

export type ProviderKind = "ollama" | "openai";

export interface OllamaProviderConfig {
  kind: "ollama";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  keepAlive: string;
  /** Context window Ollama allocates; its small default would silently cut long prompts. */
  numCtx: number;
}

export interface OpenAIProviderConfig {
  kind: "openai";
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  reasoningEffort?: string;
}

export type ProviderConfig = OllamaProviderConfig | OpenAIProviderConfig;

export interface EmbeddingConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export interface AiSettings {
  /** Chat providers in priority order. Empty means AI features are off. */
  providers: ProviderConfig[];
  /** Why the chat provider configuration could not be used, if it is invalid. */
  problem?: string;
  /** Embedding model for semantic search. Without it, retrieval uses keyword search only. */
  embedding?: EmbeddingConfig;
  embeddingProblem?: string;
  maxOutputTokens: number;
  temperature?: number;
  personaFile?: string;
  toolsEnabled: boolean;
  visionEnabled: boolean;
  /** Feedback buttons, learned examples, moderation reviews and automatic memory facts. */
  learningEnabled: boolean;
  /** Minimum cosine similarity for a semantic (vector-only) knowledge match. */
  ragMinSimilarity: number;
}

export interface AppConfig {
  discordToken?: string;
  clientId?: string;
  devGuildId?: string;
  databasePath: string;
  timezone: string;
  logLevel: LogLevel;
  logJson: boolean;
  ai: AiSettings;
}

type Env = Record<string, string | undefined>;

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Reads and validates all environment variables once at startup. Core
 * settings fail fast; AI settings are optional, so an invalid AI setup only
 * disables that part (the reason is shown in `/ai status`) and moderation keeps working.
 */
export function loadConfig(env: Env = process.env): AppConfig {
  const logLevel = (text(env.LOG_LEVEL) ?? "info").toLowerCase();
  return {
    discordToken: text(env.DISCORD_TOKEN),
    clientId: text(env.CLIENT_ID),
    devGuildId: text(env.GUILD_ID),
    databasePath: text(env.DATABASE_PATH) ?? "./data/carl-lite.sqlite",
    timezone: timezone(env.BOT_TIMEZONE),
    logLevel: isLogLevel(logLevel) ? logLevel : "info",
    logJson: text(env.LOG_FORMAT)?.toLowerCase() === "json",
    ai: loadAiSettings(env)
  };
}

export function loadAiSettings(env: Env): AiSettings {
  const providers = attempt(() => resolveProviders(env));
  const embedding = attempt(() => resolveEmbedding(env));
  return {
    providers: providers.value ?? [],
    problem: providers.error,
    embedding: embedding.value,
    embeddingProblem: embedding.error,
    maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, { min: 64, max: 8_192, fallback: 1_024 }),
    temperature: optionalNumber(env.AI_TEMPERATURE, { min: 0, max: 2 }),
    personaFile: text(env.AI_PERSONA_FILE),
    toolsEnabled: flag(env.AI_TOOLS, true),
    visionEnabled: flag(env.AI_VISION, true),
    learningEnabled: flag(env.AI_LEARNING, true),
    ragMinSimilarity: optionalNumber(env.AI_RAG_MIN_SIMILARITY, { min: 0, max: 1 }) ?? 0.45
  };
}

/** Builds one chat provider config, optionally overriding the model (used by the eval CLI). */
export function buildProviderConfig(kind: string, env: Env, modelOverride?: string): ProviderConfig {
  if (kind === "ollama") {
    const model = modelOverride ?? text(env.OLLAMA_MODEL);
    if (!model) throw new ConfigError("OLLAMA_MODEL is required when the ollama provider is enabled.");
    return {
      kind: "ollama",
      baseUrl: httpUrl(env.OLLAMA_BASE_URL, DEFAULT_OLLAMA_URL, "OLLAMA_BASE_URL"),
      model,
      timeoutMs: integer(env.OLLAMA_TIMEOUT_MS, { min: 5_000, max: 300_000, fallback: 90_000 }),
      keepAlive: text(env.OLLAMA_KEEP_ALIVE) ?? "5m",
      numCtx: integer(env.OLLAMA_NUM_CTX, { min: 2_048, max: 262_144, fallback: 8_192 })
    };
  }
  if (kind === "openai") {
    const model = modelOverride ?? text(env.OPENAI_MODEL);
    if (!model) throw new ConfigError("OPENAI_MODEL is required when the openai provider is enabled.");
    return {
      kind: "openai",
      ...openAIConnection(env),
      model,
      timeoutMs: integer(env.OPENAI_TIMEOUT_MS, { min: 5_000, max: 300_000, fallback: 60_000 }),
      reasoningEffort: text(env.OPENAI_REASONING_EFFORT)?.toLowerCase()
    };
  }
  throw new ConfigError(`Unknown AI provider "${kind}". Use "ollama" or "openai".`);
}

/** Builds the embedding config, optionally overriding the model (used by the eval CLI). */
export function buildEmbeddingConfig(kind: string, env: Env, modelOverride?: string): EmbeddingConfig {
  if (kind === "ollama") {
    const model = modelOverride ?? text(env.OLLAMA_EMBED_MODEL);
    if (!model) throw new ConfigError("OLLAMA_EMBED_MODEL is required for Ollama embeddings (e.g. bge-m3).");
    return {
      kind: "ollama",
      baseUrl: httpUrl(env.OLLAMA_BASE_URL, DEFAULT_OLLAMA_URL, "OLLAMA_BASE_URL"),
      model,
      timeoutMs: 30_000
    };
  }
  if (kind === "openai") {
    const model = modelOverride ?? text(env.OPENAI_EMBED_MODEL);
    if (!model) throw new ConfigError("OPENAI_EMBED_MODEL is required for OpenAI embeddings (e.g. text-embedding-3-small).");
    return { kind: "openai", ...openAIConnection(env), model, timeoutMs: 30_000 };
  }
  throw new ConfigError(`Unknown AI_EMBED_PROVIDER "${kind}". Use "ollama", "openai" or "none".`);
}

function resolveProviders(env: Env): ProviderConfig[] {
  const primary = text(env.AI_PROVIDER)?.toLowerCase() ??
    (text(env.OLLAMA_MODEL) ? "ollama" : text(env.OPENAI_MODEL) ? "openai" : undefined);
  if (!primary || primary === "none") return [];

  const fallback = text(env.AI_FALLBACK_PROVIDER)?.toLowerCase();
  const order = fallback && fallback !== "none" && fallback !== primary ? [primary, fallback] : [primary];
  return order.map(kind => buildProviderConfig(kind, env));
}

function resolveEmbedding(env: Env): EmbeddingConfig | undefined {
  const kind = text(env.AI_EMBED_PROVIDER)?.toLowerCase() ??
    (text(env.OLLAMA_EMBED_MODEL) ? "ollama" : text(env.OPENAI_EMBED_MODEL) ? "openai" : undefined);
  if (!kind || kind === "none") return undefined;
  return buildEmbeddingConfig(kind, env);
}

function openAIConnection(env: Env): { baseUrl: string; apiKey?: string } {
  const baseUrl = httpUrl(env.OPENAI_BASE_URL, DEFAULT_OPENAI_URL, "OPENAI_BASE_URL");
  const apiKey = text(env.OPENAI_API_KEY);
  if (!apiKey && new URL(baseUrl).hostname === "api.openai.com") {
    throw new ConfigError("OPENAI_API_KEY is required when OPENAI_BASE_URL points to api.openai.com.");
  }
  return { baseUrl, apiKey };
}

function attempt<T>(work: () => T): { value?: T; error?: string } {
  try {
    return { value: work() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function integer(
  value: string | undefined,
  options: { min: number; max: number; fallback: number }
): number {
  const parsed = Number(text(value));
  return Number.isInteger(parsed) && parsed >= options.min && parsed <= options.max
    ? parsed
    : options.fallback;
}

function optionalNumber(
  value: string | undefined,
  options: { min: number; max: number }
): number | undefined {
  if (text(value) === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= options.min && parsed <= options.max ? parsed : undefined;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const normalized = text(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function httpUrl(value: string | undefined, fallback: string, name: string): string {
  const raw = text(value) ?? fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https.`);
  }
  return raw.replace(/\/+$/, "");
}

function timezone(value: string | undefined): string {
  const zone = text(value) ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new ConfigError(`BOT_TIMEZONE "${zone}" is not a valid IANA time zone (e.g. Asia/Jakarta).`);
  }
  return zone;
}
