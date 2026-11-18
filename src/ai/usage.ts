import { statement } from "../db/database.js";
import { describeError, logger } from "../logger.js";

export type AiFeature = "chat" | "moderation" | "summary" | "memory";

export interface UsageEntry {
  guildId: string;
  feature: AiFeature;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  ok: boolean;
}

export interface UsageSummary {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  averageLatencyMs: number;
  requestsByFeature: Partial<Record<AiFeature, number>>;
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Aggregates requests, tokens and latency per server/day/feature/model. Never throws. */
export function recordUsage(entry: UsageEntry): void {
  try {
    statement(`
      INSERT INTO ai_usage (day, guild_id, feature, provider, model, requests, failures, input_tokens, output_tokens, total_latency_ms)
      VALUES (@day, @guildId, @feature, @provider, @model, 1, @failures, @inputTokens, @outputTokens, @latencyMs)
      ON CONFLICT (day, guild_id, feature, provider, model) DO UPDATE SET
        requests = requests + 1,
        failures = failures + excluded.failures,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_latency_ms = total_latency_ms + excluded.total_latency_ms
    `).run({
      day: utcDay(),
      guildId: entry.guildId,
      feature: entry.feature,
      provider: entry.provider,
      model: entry.model,
      failures: entry.ok ? 0 : 1,
      inputTokens: Math.round(entry.inputTokens),
      outputTokens: Math.round(entry.outputTokens),
      latencyMs: Math.round(entry.latencyMs)
    });
  } catch (error) {
    logger.warn("ai.usage_record_failed", describeError(error));
  }
}

export function getDailyUsage(guildId: string, day = utcDay()): UsageSummary {
  const rows = statement(`
    SELECT feature,
           SUM(requests) AS requests,
           SUM(failures) AS failures,
           SUM(input_tokens) AS inputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(total_latency_ms) AS latencyMs
    FROM ai_usage
    WHERE guild_id = ? AND day = ?
    GROUP BY feature
  `).all(guildId, day) as Array<{
    feature: AiFeature;
    requests: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;

  const summary: UsageSummary = {
    requests: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    averageLatencyMs: 0,
    requestsByFeature: {}
  };
  let totalLatency = 0;
  for (const row of rows) {
    summary.requests += row.requests;
    summary.failures += row.failures;
    summary.inputTokens += row.inputTokens;
    summary.outputTokens += row.outputTokens;
    summary.requestsByFeature[row.feature] = row.requests;
    totalLatency += row.latencyMs;
  }
  summary.averageLatencyMs = summary.requests > 0 ? Math.round(totalLatency / summary.requests) : 0;
  return summary;
}
