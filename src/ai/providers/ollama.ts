import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { isRecord } from "../../utils/text.js";
import { AiError } from "../errors.js";
import {
  joinUrl,
  parseToolArguments,
  requestJson,
  stripReasoning,
  toNumber,
  withRetry,
  type RetryOptions
} from "./http.js";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ProviderHealth,
  ToolCall
} from "./types.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  keepAlive?: string;
  /** Context window to allocate (Ollama's default is small and silently truncates long prompts). */
  numCtx?: number;
  retry?: RetryOptions;
}

const HEALTH_TIMEOUT_MS = 2_000;
const LOCAL_RETRY: RetryOptions = { attempts: 2, baseDelayMs: 500, maxDelayMs: 4_000 };

/** Local models through Ollama's native /api/chat endpoint (tools, vision, JSON schema output). */
export class OllamaProvider implements ChatProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string;
  private readonly numCtx?: number;
  private readonly retry: RetryOptions;
  /** Turned off the first time the model says it cannot use tools (e.g. gemma3). */
  private toolsSupported = true;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.keepAlive = options.keepAlive ?? "5m";
    this.numCtx = options.numCtx;
    this.retry = options.retry ?? LOCAL_RETRY;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const includeTools = Boolean(request.tools?.length) && this.toolsSupported;
    try {
      return await this.send(request, includeTools);
    } catch (error) {
      // Some local models (e.g. gemma3) reject tool definitions with HTTP 400. Instead of
      // failing, the bot remembers that and answers without tools from then on. RAG still
      // works, because knowledge excerpts are put into the prompt automatically.
      if (!includeTools || !isToolsUnsupported(error)) throw error;
      this.toolsSupported = false;
      logger.warn("ai.tools_unsupported", { provider: this.id, model: this.model });
      return this.send(request, false);
    }
  }

  async checkHealth(): Promise<ProviderHealth[]> {
    const base = { provider: this.id, model: this.model };
    try {
      const body = await requestJson({
        provider: this.id,
        url: joinUrl(this.baseUrl, "/api/tags"),
        timeoutMs: HEALTH_TIMEOUT_MS
      });
      const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
      const wanted = normalizeModelName(this.model);
      const installed = models.some(entry =>
        isRecord(entry) &&
        [entry.name, entry.model].some(name => typeof name === "string" && normalizeModelName(name) === wanted)
      );
      return [installed
        ? { ...base, state: "ready" }
        : { ...base, state: "model_missing", detail: `Run \`ollama pull ${this.model}\`` }];
    } catch (error) {
      const unreachable = error instanceof AiError && (error.code === "CONNECTION" || error.code === "TIMEOUT");
      return [{
        ...base,
        state: unreachable ? "unreachable" : "error",
        detail: error instanceof Error ? error.message : undefined
      }];
    }
  }

  private async send(request: ChatRequest, includeTools: boolean): Promise<ChatResponse> {
    const options: Record<string, number> = {};
    if (request.maxOutputTokens !== undefined) options.num_predict = request.maxOutputTokens;
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (this.numCtx !== undefined) options.num_ctx = this.numCtx;

    const body = {
      model: this.model,
      messages: request.messages.map(toOllamaMessage),
      stream: false,
      // Thinking models (qwen3) would otherwise reason at length first, which is slow on a laptop GPU.
      think: false,
      // Keep the model loaded in VRAM between messages, so a reply does not wait for a reload.
      keep_alive: this.keepAlive,
      options,
      ...(includeTools && request.tools
        ? { tools: request.tools.map(tool => ({ type: "function", function: tool })) }
        : {}),
      ...(request.responseFormat ? { format: request.responseFormat.schema } : {})
    };

    const data = await withRetry(
      () => requestJson({
        provider: this.id,
        url: joinUrl(this.baseUrl, "/api/chat"),
        method: "POST",
        body,
        timeoutMs: this.timeoutMs,
        signal: request.signal
      }),
      this.retry,
      request.signal
    );
    return parseOllamaResponse(data, this.model);
  }
}

export function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: message.content,
        ...(message.images?.length ? { images: message.images.map(image => image.data) } : {})
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? { tool_calls: message.toolCalls.map(call => ({ function: { name: call.name, arguments: call.arguments } })) }
          : {})
      };
    case "tool":
      return { role: "tool", content: message.content, tool_name: message.toolName };
  }
}

export function parseOllamaResponse(data: unknown, requestedModel: string): ChatResponse {
  if (!isRecord(data) || !isRecord(data.message)) {
    throw new AiError("INVALID_RESPONSE", "Ollama returned an unexpected response shape", { provider: "ollama" });
  }
  const message = data.message;
  const content = typeof message.content === "string" ? stripReasoning(message.content) : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap(parseToolCall)
    : [];
  const finishReason = typeof data.done_reason === "string" ? data.done_reason : undefined;

  if (!content && toolCalls.length === 0) {
    throw new AiError(
      "EMPTY_RESPONSE",
      finishReason === "length" ? "Ollama hit the output token limit before answering" : "Ollama returned an empty answer",
      { provider: "ollama" }
    );
  }

  return {
    content,
    toolCalls,
    usage: { inputTokens: toNumber(data.prompt_eval_count), outputTokens: toNumber(data.eval_count) },
    provider: "ollama",
    model: typeof data.model === "string" ? data.model : requestedModel,
    finishReason
  };
}

function parseToolCall(call: unknown): ToolCall[] {
  if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string") return [];
  return [{
    id: typeof call.id === "string" && call.id ? call.id : `call_${randomUUID().slice(0, 8)}`,
    name: call.function.name,
    arguments: parseToolArguments(call.function.arguments)
  }];
}

function isToolsUnsupported(error: unknown): boolean {
  return error instanceof AiError &&
    error.code === "BAD_REQUEST" &&
    /does not support tools/i.test(error.message);
}

export function normalizeModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.includes(":") ? normalized : `${normalized}:latest`;
}
