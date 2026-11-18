import "dotenv/config";
import { purgeExchanges } from "./ai/learning/exchanges.js";
import { purgeModerationFlags } from "./ai/learning/moderation-flags.js";
import { MEMORY_LIMITS, purgeExpiredMemory } from "./ai/memory.js";
import { createAiRuntime } from "./ai/runtime.js";
import { createBot } from "./bot.js";
import { ConfigError, loadConfig } from "./config.js";
import { closeDatabase, initDatabase } from "./db/database.js";
import { configureLogger, describeError, logger } from "./logger.js";

const MEMORY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const EMBEDDING_INDEX_INTERVAL_MS = 10 * 60 * 1_000;

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger({ level: config.logLevel, json: config.logJson });
  if (!config.discordToken) {
    throw new ConfigError("DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.");
  }

  initDatabase(config.databasePath);

  const ai = createAiRuntime(config.ai, config.timezone);
  logger.info("ai.configured", {
    providers: config.ai.providers.map(provider => `${provider.kind}:${provider.model}`),
    embeddings: ai.embedder?.id ?? "none (keyword retrieval)",
    persona: ai.persona.name,
    tools: config.ai.toolsEnabled,
    vision: config.ai.visionEnabled,
    learning: config.ai.learningEnabled
  });
  for (const problem of ai.problems) logger.warn("ai.config_problem", { problem });

  // Retention: chat memory 30 days, unrated answers 30 days, unreviewed flags 30 days.
  const purgeExpiredData = (): void => {
    try {
      const removed = {
        messages: purgeExpiredMemory(MEMORY_LIMITS.retentionDays),
        exchanges: purgeExchanges(),
        flags: purgeModerationFlags()
      };
      if (removed.messages + removed.exchanges + removed.flags > 0) logger.info("ai.data_purged", removed);
    } catch (error) {
      logger.warn("ai.data_purge_failed", describeError(error));
    }
  };
  purgeExpiredData();
  setInterval(purgeExpiredData, MEMORY_CLEANUP_INTERVAL_MS).unref();

  // Keeps knowledge, rated answers and reviewed flags embedded (also after an embedding-model change).
  if (ai.indexer) {
    ai.indexer.schedule();
    setInterval(() => ai.indexer?.schedule(), EMBEDDING_INDEX_INTERVAL_MS).unref();
  }

  const client = createBot({ config, ai });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("bot.shutdown", { signal });
    await client.destroy().catch(() => undefined);
    closeDatabase();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", reason => logger.error("process.unhandled_rejection", describeError(reason)));

  await client.login(config.discordToken);
}

main().catch(error => {
  logger.error("bot.startup_failed", describeError(error));
  process.exit(1);
});
