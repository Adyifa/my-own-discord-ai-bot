import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAiSettings, loadConfig } from "../src/config.js";

describe("loadAiSettings", () => {
  it("turns AI off when no provider is configured", () => {
    const settings = loadAiSettings({});
    assert.deepEqual(settings.providers, []);
    assert.equal(settings.problem, undefined);
  });

  it("stays compatible with the original .env (OLLAMA_MODEL alone selects Ollama)", () => {
    const settings = loadAiSettings({ OLLAMA_MODEL: "gemma3:4b", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-5-mini" });
    assert.deepEqual(settings.providers.map(provider => provider.kind), ["ollama"]);
  });

  it("builds a local-first fallback chain", () => {
    const settings = loadAiSettings({
      AI_PROVIDER: "ollama",
      AI_FALLBACK_PROVIDER: "openai",
      OLLAMA_MODEL: "qwen3:4b",
      OPENAI_API_KEY: "sk-test",
      OPENAI_MODEL: "gpt-5-mini"
    });
    assert.deepEqual(
      settings.providers.map(provider => `${provider.kind}:${provider.model}`),
      ["ollama:qwen3:4b", "openai:gpt-5-mini"]
    );
  });

  it("reports an invalid AI setup instead of crashing the bot", () => {
    const missingKey = loadAiSettings({ AI_PROVIDER: "openai", OPENAI_MODEL: "gpt-5-mini" });
    assert.deepEqual(missingKey.providers, []);
    assert.match(missingKey.problem ?? "", /OPENAI_API_KEY/);
    assert.match(loadAiSettings({ AI_PROVIDER: "gemini" }).problem ?? "", /Unknown AI provider/);
  });

  it("allows keyless OpenAI-compatible servers such as LM Studio", () => {
    const settings = loadAiSettings({
      AI_PROVIDER: "openai",
      OPENAI_BASE_URL: "http://localhost:1234/v1/",
      OPENAI_MODEL: "local-model"
    });
    assert.equal(settings.providers[0].baseUrl, "http://localhost:1234/v1");
  });

  it("falls back to safe defaults for invalid numbers and flags", () => {
    const settings = loadAiSettings({
      OLLAMA_MODEL: "x",
      OLLAMA_TIMEOUT_MS: "5",
      AI_MAX_OUTPUT_TOKENS: "abc",
      AI_TOOLS: "off",
      AI_VISION: "maybe"
    });
    assert.equal(settings.providers[0].timeoutMs, 90_000);
    assert.equal(settings.maxOutputTokens, 1_024);
    assert.equal(settings.toolsEnabled, false);
    assert.equal(settings.visionEnabled, true);
  });
});

describe("loadConfig", () => {
  it("validates the bot time zone", () => {
    assert.equal(loadConfig({ BOT_TIMEZONE: "Asia/Jakarta" }).timezone, "Asia/Jakarta");
    assert.equal(loadConfig({}).timezone, "UTC");
    assert.throws(() => loadConfig({ BOT_TIMEZONE: "Mars/Olympus_Mons" }), /BOT_TIMEZONE/);
  });
});
