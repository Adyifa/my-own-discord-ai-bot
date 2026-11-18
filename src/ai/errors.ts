export type AiErrorCode =
  | "NOT_CONFIGURED"
  | "CONNECTION"
  | "TIMEOUT"
  | "CANCELLED"
  | "RATE_LIMITED"
  | "AUTH"
  | "MODEL_UNAVAILABLE"
  | "BAD_REQUEST"
  | "SERVER_ERROR"
  | "EMPTY_RESPONSE"
  | "INVALID_RESPONSE"
  | "UNKNOWN";

const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set(["RATE_LIMITED", "SERVER_ERROR"]);

export interface AiErrorOptions {
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  /** Overrides the default retry policy for this code (e.g. 429 "quota exceeded"). */
  retryable?: boolean;
  cause?: unknown;
}

/** A provider-agnostic error with a stable code that the rest of the bot can act on. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
  }
}

export function toAiError(error: unknown, provider?: string): AiError {
  if (error instanceof AiError) return error;
  return new AiError("UNKNOWN", error instanceof Error ? error.message : "Unknown AI error", {
    provider,
    cause: error
  });
}

/** Short, non-technical explanation that is safe to show to any Discord user. */
export function userFacingAiMessage(error: AiError): string {
  switch (error.code) {
    case "TIMEOUT":
      return "The AI model took too long to answer. Please try again in a moment.";
    case "RATE_LIMITED":
      return "The AI service is busy right now. Please try again shortly.";
    case "NOT_CONFIGURED":
    case "CONNECTION":
    case "MODEL_UNAVAILABLE":
    case "AUTH":
      return "The AI service is unavailable right now.";
    default:
      return "Sorry, something went wrong while generating a reply. Please try again.";
  }
}
