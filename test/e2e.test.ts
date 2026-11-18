import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { generateChatReply } from "../src/ai/chat.js";
import { OllamaProvider, createChatProvider } from "../src/ai/providers/index.js";
import { getDailyUsage } from "../src/ai/usage.js";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/database.js";
import { chatInput, testRuntime } from "./helpers/discord-fakes.js";
import { startMockServer } from "./helpers/mock-server.js";

/**
 * Full pipeline (prompt building → agent → real HTTP provider → tools → usage
 * tracking) against local servers that imitate the Ollama and OpenAI APIs.
 */
describe("end-to-end with mock LLM servers", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  after(() => closeDatabase());

  it("completes a tool-calling round trip through the Ollama HTTP API", async () => {
    const server = await startMockServer(request => {
      const last = request.body.messages.at(-1);
      if (last.role === "tool") {
        const { formatted } = JSON.parse(last.content);
        return { body: { message: { role: "assistant", content: `Sekarang ${formatted}` }, prompt_eval_count: 300, eval_count: 20 } };
      }
      return {
        body: {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "get_current_time", arguments: { timezone: "Asia/Jakarta" } } }]
          },
          prompt_eval_count: 250,
          eval_count: 15
        }
      };
    });

    try {
      const provider = new OllamaProvider({ baseUrl: server.url, model: "qwen3:4b", timeoutMs: 5_000 });
      const reply = await generateChatReply(testRuntime(provider), chatInput({ prompt: "jam berapa sekarang?" }));

      assert.match(reply.text, /^Sekarang .+ (2\d{3})/);
      assert.deepEqual(reply.toolLabels, ["clock"]);

      const followUp = server.requests[1].body;
      assert.equal(followUp.messages.at(-2).tool_calls[0].function.name, "get_current_time");
      assert.equal(followUp.messages.at(-1).tool_name, "get_current_time");

      const usage = getDailyUsage("g1");
      assert.equal(usage.requests, 1);
      assert.equal(usage.inputTokens, 550);
      assert.equal(usage.outputTokens, 35);
    } finally {
      await server.close();
    }
  });

  it("falls back to an OpenAI-compatible API when the local model is not installed", async () => {
    const ollama = await startMockServer(() => ({
      status: 404,
      body: { error: "model 'gemma3:4b' not found, try pulling it first" }
    }));
    const openai = await startMockServer(() => ({
      body: {
        model: "gpt-5-mini",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Halo dari cloud!" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      }
    }));

    try {
      const provider = createChatProvider([
        { kind: "ollama", baseUrl: ollama.url, model: "gemma3:4b", timeoutMs: 5_000, keepAlive: "5m", numCtx: 8_192 },
        { kind: "openai", baseUrl: `${openai.url}/v1`, apiKey: "sk-test", model: "gpt-5-mini", timeoutMs: 5_000 }
      ]);
      assert.ok(provider);

      const reply = await generateChatReply(testRuntime(provider), chatInput({ prompt: "halo" }));
      assert.equal(reply.text, "Halo dari cloud!");
      assert.equal(ollama.requests.length, 1);
      assert.equal(openai.requests[0].headers.authorization, "Bearer sk-test");

      // Usage is attributed to the provider that actually answered.
      const row = getDatabase().prepare("SELECT provider, model, requests FROM ai_usage").get() as object;
      assert.deepEqual({ ...row }, { provider: "openai", model: "gpt-5-mini", requests: 1 });
    } finally {
      await ollama.close();
      await openai.close();
    }
  });
});
