/** Base64-encoded image passed to vision-capable models. */
export interface ImageInput {
  mimeType: string;
  data: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Provider-neutral chat message. Each provider maps it to its own wire format. */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImageInput[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool arguments. */
  parameters: JsonSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Ask for JSON that matches this schema (structured output). */
  responseFormat?: { name: string; schema: JsonSchema };
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** Which provider/model actually produced this response (matters with fallbacks). */
  provider: string;
  model: string;
  finishReason?: string;
}

export type ProviderHealthState = "ready" | "unreachable" | "model_missing" | "auth_failed" | "error";

export interface ProviderHealth {
  provider: string;
  model: string;
  state: ProviderHealthState;
  detail?: string;
}

/** Anything that can hold a chat completion: Ollama, OpenAI-compatible APIs, or a fallback chain. */
export interface ChatProvider {
  readonly id: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  checkHealth(): Promise<ProviderHealth[]>;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(total: TokenUsage, extra: TokenUsage): TokenUsage {
  total.inputTokens += extra.inputTokens;
  total.outputTokens += extra.outputTokens;
  return total;
}
