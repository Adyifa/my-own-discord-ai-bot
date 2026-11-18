import "./helpers/quiet-logs.js";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { disableAi, enableAi, getAiGuildSettings, setCustomInstructions } from "../src/ai/guild-settings.js";
import { compactConversation } from "../src/ai/memory-compactor.js";
import {
  countMessages,
  deleteMemory,
  getRecentMessages,
  getSummary,
  purgeExpiredMemory,
  replaceWithSummary,
  saveExchange
} from "../src/ai/memory.js";
import { getDailyUsage, recordUsage } from "../src/ai/usage.js";
import { SCHEMA_VERSION, closeDatabase, getDatabase, initDatabase, runMigrations } from "../src/db/database.js";
import { getGuildConfig, updateGuildConfig } from "../src/db/guild-config.js";
import { ScriptedProvider } from "./helpers/fake-provider.js";

const key = { guildId: "g1", channelId: "c1", userId: "u1" };

describe("database migrations", () => {
  it("upgrades a database created by the original version without losing data", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE guild_config (
        guild_id TEXT PRIMARY KEY, welcome_channel_id TEXT,
        welcome_message TEXT NOT NULL DEFAULT 'Welcome {user} to **{server}**!', log_channel_id TEXT,
        anti_link INTEGER NOT NULL DEFAULT 0, anti_spam INTEGER NOT NULL DEFAULT 1,
        caps_percent INTEGER NOT NULL DEFAULT 80, bad_words TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE ai_config (
        guild_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, channel_id TEXT,
        mention_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO guild_config (guild_id, anti_link, bad_words) VALUES ('old', 1, 'foo');
      INSERT INTO ai_config (guild_id, enabled, channel_id) VALUES ('old', 1, 'c-old');
    `);

    runMigrations(legacy);
    runMigrations(legacy);

    assert.equal(legacy.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    assert.deepEqual(
      { ...legacy.prepare("SELECT anti_link, bad_words, ai_moderation, ai_moderation_action FROM guild_config").get() as object },
      { anti_link: 1, bad_words: "foo", ai_moderation: 0, ai_moderation_action: "flag" }
    );
    assert.deepEqual(
      { ...legacy.prepare("SELECT enabled, channel_id, custom_instructions FROM ai_config").get() as object },
      { enabled: 1, channel_id: "c-old", custom_instructions: null }
    );
    legacy.close();
  });
});

describe("storage", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  after(() => closeDatabase());

  it("returns history oldest-first, within budget, starting with a user turn", () => {
    for (let index = 1; index <= 3; index += 1) saveExchange(key, `question ${index}`, `answer ${index}`);
    assert.deepEqual(getRecentMessages(key, 3, 10_000).map(message => message.content), ["question 3", "answer 3"]);
    assert.deepEqual(getRecentMessages(key, 12, 20).map(message => message.content), ["question 3", "answer 3"]);
    assert.deepEqual(getRecentMessages({ ...key, userId: "nobody" }), []);
  });

  it("folds older messages into a rolling summary", async () => {
    for (let index = 1; index <= 15; index += 1) saveExchange(key, `q${index}`, `a${index}`);
    assert.equal(countMessages(key), 30);

    const provider = new ScriptedProvider([{ content: "User asked about TypeScript generics." }]);
    await compactConversation(provider, key);

    assert.equal(getSummary(key), "User asked about TypeScript generics.");
    assert.equal(countMessages(key), 12);
    assert.match(provider.requests[0].messages[1].content, /Previous summary:\n\(none\)/);
    assert.match(provider.requests[0].messages[1].content, /User: q1\nAssistant: a1/);
    assert.equal(getDailyUsage("g1").requestsByFeature.memory, 1);
  });

  it("enforces a hard cap even if summarisation never runs", () => {
    for (let index = 0; index < 60; index += 1) saveExchange(key, `q${index}`, `a${index}`);
    assert.equal(countMessages(key), 100);
  });

  it("deletes memory by scope, including summaries", () => {
    saveExchange(key, "a", "b");
    saveExchange({ ...key, userId: "u2" }, "c", "d");
    saveExchange({ ...key, channelId: "c2" }, "e", "f");
    replaceWithSummary(key, "summary", 0);

    assert.equal(deleteMemory({ guildId: "g1", channelId: "c1", userId: "u1" }), 2);
    assert.equal(getSummary(key), null);
    assert.equal(deleteMemory({ guildId: "g1", channelId: "c1" }), 2);
    assert.equal(deleteMemory({ guildId: "g1" }), 2);
  });

  it("purges memory older than the retention window", () => {
    saveExchange(key, "old", "old answer");
    getDatabase().prepare("UPDATE ai_messages SET created_at = datetime('now', '-40 days')").run();
    saveExchange(key, "new", "new answer");
    assert.equal(purgeExpiredMemory(30), 2);
    assert.equal(countMessages(key), 2);
  });

  it("aggregates AI usage per day and feature", () => {
    const base = { guildId: "g1", provider: "ollama", model: "m" };
    recordUsage({ ...base, feature: "chat", inputTokens: 100, outputTokens: 20, latencyMs: 1_000, ok: true });
    recordUsage({ ...base, feature: "chat", inputTokens: 50, outputTokens: 10, latencyMs: 3_000, ok: false });
    recordUsage({ ...base, feature: "summary", inputTokens: 10, outputTokens: 5, latencyMs: 2_000, ok: true });
    assert.deepEqual(getDailyUsage("g1"), {
      requests: 3,
      failures: 1,
      inputTokens: 160,
      outputTokens: 35,
      averageLatencyMs: 2_000,
      requestsByFeature: { chat: 2, summary: 1 }
    });
  });

  it("stores per-server AI settings and instructions", () => {
    assert.equal(getAiGuildSettings("g1").enabled, false);
    setCustomInstructions("g1", "Be formal.");
    enableAi("g1", "c1", false);
    assert.deepEqual(getAiGuildSettings("g1"), {
      enabled: true,
      channelId: "c1",
      mentionEnabled: false,
      customInstructions: "Be formal."
    });
    disableAi("g1");
    assert.equal(getAiGuildSettings("g1").enabled, false);
  });

  it("updates guild config only through the column whitelist", () => {
    assert.equal(getGuildConfig("g1").aiModeration, false);
    const updated = updateGuildConfig("g1", {
      aiModeration: true,
      aiModerationAction: "delete",
      aiModerationThreshold: 0.9,
      badWords: "a,b"
    });
    assert.equal(updated.aiModeration, true);
    assert.equal(updated.aiModerationAction, "delete");
    assert.equal(updated.aiModerationThreshold, 0.9);
    assert.equal(updated.badWords, "a,b");
    assert.throws(
      () => updateGuildConfig("g1", { "anti_link = 1; DROP TABLE warnings; --": true } as never),
      /Unknown guild config field/
    );
  });
});
