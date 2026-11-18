import { describeError, logger } from "../../logger.js";
import { AiError, type AiErrorCode } from "../errors.js";
import type { ChatProvider, ChatRequest, ChatResponse, ProviderHealth } from "./types.js";

/** Errors that mean "this provider is down", so it is skipped for a while (circuit breaker). */
const TRIP_CODES: ReadonlySet<AiErrorCode> = new Set(["CONNECTION", "TIMEOUT", "MODEL_UNAVAILABLE", "AUTH"]);

/**
 * Tries providers in priority order, e.g. a free local model first and a
 * cloud API as backup. A provider that is down is skipped for `cooldownMs`
 * so users do not wait for the same timeout on every message.
 */
export class FallbackProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  private readonly skipUntil = new Map<ChatProvider, number>();

  constructor(
    private readonly providers: readonly ChatProvider[],
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now
  ) {
    if (providers.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.id = providers.map(provider => provider.id).join(" → ");
    this.model = providers[0].model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Circuit breaker: providers that failed recently go to the back of the queue, so a
    // dead local model does not cost every user a 90-second timeout. They are still tried
    // last, which means the chain never gives up while something might work.
    const now = this.now();
    const available = this.providers.filter(provider => (this.skipUntil.get(provider) ?? 0) <= now);
    const coolingDown = this.providers.filter(provider => !available.includes(provider));
    const order = [...available, ...coolingDown];

    let lastError: unknown;
    for (const [index, provider] of order.entries()) {
      try {
        const response = await provider.chat(request);
        // A success closes the breaker again.
        this.skipUntil.delete(provider);
        return response;
      } catch (error) {
        lastError = error;
        // A cancelled request must not be retried on the next provider.
        const cancelled = request.signal?.aborted || (error instanceof AiError && error.code === "CANCELLED");
        if (cancelled) throw error;
        // Only "the provider is down" errors open the breaker. A bad request is the
        // request's fault, so it does not make the provider look unhealthy.
        if (error instanceof AiError && TRIP_CODES.has(error.code)) {
          this.skipUntil.set(provider, this.now() + this.cooldownMs);
        }
        const next = order[index + 1];
        if (next) logger.warn("ai.provider_fallback", { from: provider.id, to: next.id, ...describeError(error) });
      }
    }
    throw lastError;
  }

  async checkHealth(): Promise<ProviderHealth[]> {
    const results = await Promise.all(this.providers.map(provider => provider.checkHealth()));
    return results.flat();
  }
}
