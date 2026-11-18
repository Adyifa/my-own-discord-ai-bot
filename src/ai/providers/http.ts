import { setTimeout as sleep } from "node:timers/promises";
import { isRecord, truncate } from "../../utils/text.js";
import { AiError, type AiErrorCode } from "../errors.js";

export interface JsonRequest {
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

/** fetch() + timeout + JSON parsing, translating every failure into a typed AiError. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  // Every LLM call has a hard deadline. AbortSignal.any combines it with the caller's own
  // cancel signal, and checking which one fired tells a timeout apart from a cancel.
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

  let response: Response;
  let raw: string;
  try {
    response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...request.headers
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal
    });
    raw = await response.text();
  } catch (error) {
    if (timeout.aborted) {
      throw new AiError("TIMEOUT", `${request.provider} did not respond within ${request.timeoutMs} ms`, {
        provider: request.provider,
        cause: error
      });
    }
    if (request.signal?.aborted) {
      throw new AiError("CANCELLED", "The AI request was cancelled", { provider: request.provider, cause: error });
    }
    throw new AiError("CONNECTION", `Could not reach ${request.provider}`, { provider: request.provider, cause: error });
  }

  if (!response.ok) throw httpError(response, raw, request.provider);

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AiError("INVALID_RESPONSE", `${request.provider} returned a non-JSON response`, {
      provider: request.provider,
      status: response.status
    });
  }
}

function httpError(response: Response, raw: string, provider: string): AiError {
  const status = response.status;
  const detail = extractErrorDetail(raw);
  // HTTP status → one stable error code. The rest of the bot decides on these codes:
  // retry (429/5xx), fall back to another provider, or show the admin a hint.
  const code: AiErrorCode =
    status === 401 || status === 403 ? "AUTH"
      : status === 404 ? "MODEL_UNAVAILABLE"
        : status === 408 ? "TIMEOUT"
          : status === 429 ? "RATE_LIMITED"
            : status >= 500 ? "SERVER_ERROR"
              : "BAD_REQUEST";
  // A 429 can mean "slow down" (retry helps) or "out of credit" (retrying only wastes time).
  const quotaExhausted = status === 429 && /quota|billing|credit/i.test(detail ?? "");

  return new AiError(code, `${provider} returned HTTP ${status}${detail ? `: ${detail}` : ""}`, {
    provider,
    status,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    retryable: quotaExhausted ? false : undefined
  });
}

/** Pulls a readable message out of the common error body shapes. */
export function extractErrorDetail(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      if (typeof parsed.error === "string") return truncate(parsed.error, 200);
      if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
        return truncate(parsed.error.message, 200);
      }
      if (typeof parsed.message === "string") return truncate(parsed.message, 200);
    }
  } catch {
    // Not JSON: fall through to the plain-text body.
  }
  const text = raw.trim();
  return text ? truncate(text, 200) : undefined;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Retries rate-limit and 5xx errors with exponential backoff + jitter, honouring Retry-After. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AiError) || !error.retryable || attempt >= options.attempts) throw error;
      // Exponential backoff (500 ms, 1 s, 2 s, …) with jitter, so many waiting requests do not
      // all retry at the same moment. A server's Retry-After header always wins.
      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delay = error.retryAfterMs !== undefined
        ? Math.min(error.retryAfterMs, options.maxDelayMs)
        : Math.round(exponential * (0.5 + Math.random() * 0.5));
      await sleep(delay, undefined, { signal });
    }
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Tool-call arguments arrive as an object (Ollama) or a JSON string (OpenAI). */
export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Malformed JSON from the model: the tool will report missing arguments.
    }
  }
  return {};
}

/** Some reasoning models leak <think>…</think> blocks into the answer; strip them. */
export function stripReasoning(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
