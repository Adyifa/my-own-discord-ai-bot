import { isRecord } from "../../utils/text.js";
import { AiError } from "../errors.js";
import {
  DEFAULT_RETRY,
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

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  reasoningEffort?: string;
  retry?: RetryOptions;
}

interface RequestTarget {
  model: string;
  isOfficialApi: boolean;
  reasoningEffort?: string;
}

const HEALTH_TIMEOUT_MS = 5_000;
/** o-series and GPT-5 models spend part of the completion budget on hidden reasoning. */
const REASONING_MODEL = /(^|\/)(o\d|gpt-5)/i;
const REASONING_HEADROOM_TOKENS = 2_048;

/**
 * Any API that speaks the OpenAI Chat Completions format: OpenAI itself, plus
 * OpenRouter, Groq, Together, LM Studio, vLLM, or Ollama's /v1 endpoint.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly target: RequestTarget;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.target = {
      model: options.model,
      isOfficialApi: new URL(options.baseUrl).hostname === "api.openai.com",
      reasoningEffort: options.reasoningEffort
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const data = await withRetry(
      () => requestJson({
        provider: this.id,
        url: joinUrl(this.baseUrl, "chat/completions"),
        method: "POST",
        headers: this.authHeaders(),
        body: buildOpenAIRequestBody(request, this.target),
        timeoutMs: this.timeoutMs,
        signal: request.signal
      }),
      this.retry,
      request.signal
    );
    return parseOpenAIResponse(data, this.model);
  }

  async checkHealth(): Promise<ProviderHealth[]> {
    const base = { provider: this.id, model: this.model };
    try {
      const body = await requestJson({
        provider: this.id,
        url: joinUrl(this.baseUrl, "models"),
        headers: this.authHeaders(),
        timeoutMs: HEALTH_TIMEOUT_MS
      });
      const models = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const listed = models.some(entry => isRecord(entry) && entry.id === this.model);
      return [listed || models.length === 0
        ? { ...base, state: "ready" }
        : { ...base, state: "model_missing", detail: "Model not listed by the API" }];
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      if (error instanceof AiError && error.code === "AUTH") return [{ ...base, state: "auth_failed", detail }];
      if (error instanceof AiError && (error.code === "CONNECTION" || error.code === "TIMEOUT")) {
        return [{ ...base, state: "unreachable", detail }];
      }
      return [{ ...base, state: "error", detail }];
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }
}

export function buildOpenAIRequestBody(
  request: ChatRequest,
  target: RequestTarget
): Record<string, unknown> {
  const isReasoningModel = REASONING_MODEL.test(target.model);
  const body: Record<string, unknown> = {
    model: target.model,
    messages: request.messages.map(toOpenAIMessage)
  };

  if (request.maxOutputTokens !== undefined) {
    if (target.isOfficialApi) {
      // OpenAI replaced max_tokens with max_completion_tokens. For reasoning models that
      // budget also pays for hidden "thinking" tokens; without extra headroom the model
      // can spend everything on reasoning and return an empty answer.
      body.max_completion_tokens = request.maxOutputTokens + (isReasoningModel ? REASONING_HEADROOM_TOKENS : 0);
    } else {
      // Other OpenAI-compatible servers (Groq, LM Studio, vLLM…) still expect max_tokens.
      body.max_tokens = request.maxOutputTokens;
    }
  }
  // Reasoning models only accept the default temperature.
  if (request.temperature !== undefined && !isReasoningModel) body.temperature = request.temperature;

  // "low" reasoning keeps a chat bot fast and cheap; it is only sent where it is supported.
  const effort = target.reasoningEffort ?? (target.isOfficialApi && isReasoningModel ? "low" : undefined);
  if (effort) body.reasoning_effort = effort;

  if (request.tools?.length) {
    body.tools = request.tools.map(tool => ({ type: "function", function: tool }));
  }
  // Structured output: OpenAI enforces the exact JSON schema ("strict"); most compatible
  // servers only support plain JSON mode, so the result is validated on our side anyway.
  if (request.responseFormat) {
    body.response_format = target.isOfficialApi
      ? {
          type: "json_schema",
          json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true }
        }
      : { type: "json_object" };
  }
  return body;
}

export function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      if (!message.images?.length) return { role: "user", content: message.content };
      return {
        role: "user",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.images.map(image => ({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` }
          }))
        ]
      };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map(call => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
              }))
            }
          : {})
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

export function parseOpenAIResponse(data: unknown, requestedModel: string): ChatResponse {
  const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!isRecord(data) || !isRecord(choice) || !isRecord(choice.message)) {
    throw new AiError("INVALID_RESPONSE", "The OpenAI-compatible API returned an unexpected response shape", {
      provider: "openai"
    });
  }

  const message = choice.message;
  const refusal = typeof message.refusal === "string" ? message.refusal : "";
  const content = stripReasoning(readContent(message.content) || refusal);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.flatMap(parseToolCall) : [];
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  if (!content && toolCalls.length === 0) {
    throw new AiError(
      "EMPTY_RESPONSE",
      finishReason === "length"
        ? "The model spent its whole token budget (often on reasoning) before answering"
        : "The model returned an empty answer",
      { provider: "openai" }
    );
  }

  const usage: Record<string, unknown> = isRecord(data.usage) ? data.usage : {};
  return {
    content,
    toolCalls,
    usage: { inputTokens: toNumber(usage.prompt_tokens), outputTokens: toNumber(usage.completion_tokens) },
    provider: "openai",
    model: typeof data.model === "string" ? data.model : requestedModel,
    finishReason
  };
}

function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
  }
  return "";
}

function parseToolCall(call: unknown, index: number): ToolCall[] {
  if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string") return [];
  return [{
    id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
    name: call.function.name,
    arguments: parseToolArguments(call.function.arguments)
  }];
}
