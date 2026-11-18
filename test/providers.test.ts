import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  Embedder,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  type EmbeddingProvider
} from "../src/ai/embeddings.js";
import { AiError } from "../src/ai/errors.js";
import {
  FallbackProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  type ChatRequest
} from "../src/ai/providers/index.js";
import { buildOpenAIRequestBody } from "../src/ai/providers/openai-compatible.js";
import { ScriptedProvider } from "./helpers/fake-provider.js";
import { startMockServer } from "./helpers/mock-server.js";

const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 };
const hi: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
const isAiError = (code: AiError["code"]) => (error: unknown) => error instanceof AiError && error.code === code;

describe("OllamaProvider", () => {
  it("maps messages, images, tools and options to /api/chat and parses the reply", async () => {
    const server = await startMockServer(() => ({
      body: {
        model: "qwen3:4b",
        message: {
          role: "assistant",
          content: "<think>let me think</think>Halo!",
          tool_calls: [{ function: { name: "get_server_info", arguments: {} } }]
        },
        done_reason: "stop",
        prompt_eval_count: 42,
        eval_count: 7
      }
    }));
    try {
      const provider = new OllamaProvider({ baseUrl: server.url, model: "qwen3:4b", timeoutMs: 5_000, retry: FAST_RETRY });
      const response = await provider.chat({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi", images: [{ mimeType: "image/png", data: "AAAA" }] },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_current_time", arguments: { timezone: "UTC" } }] },
          { role: "tool", toolCallId: "c1", toolName: "get_current_time", content: "{\"iso\":\"x\"}" }
        ],
        tools: [{ name: "get_server_info", description: "info", parameters: { type: "object", properties: {} } }],
        maxOutputTokens: 256,
        temperature: 0.5
      });

      const { url, body } = server.requests[0];
      assert.equal(url, "/api/chat");
      assert.equal(body.model, "qwen3:4b");
      assert.equal(body.stream, false);
      assert.deepEqual(body.options, { num_predict: 256, temperature: 0.5 });
      assert.deepEqual(body.messages[1], { role: "user", content: "hi", images: ["AAAA"] });
      assert.deepEqual(body.messages[2].tool_calls, [{ function: { name: "get_current_time", arguments: { timezone: "UTC" } } }]);
      assert.deepEqual(body.messages[3], { role: "tool", content: "{\"iso\":\"x\"}", tool_name: "get_current_time" });
      assert.equal(body.tools[0].type, "function");
      assert.equal(body.tools[0].function.name, "get_server_info");

      assert.equal(response.content, "Halo!");
      assert.equal(response.toolCalls[0].name, "get_server_info");
      assert.deepEqual(response.usage, { inputTokens: 42, outputTokens: 7 });
      assert.equal(response.provider, "ollama");
    } finally {
      await server.close();
    }
  });

  it("retries without tools when the model cannot use them, and remembers that", async () => {
    const server = await startMockServer(request => request.body.tools
      ? { status: 400, body: { error: "registry.ollama.ai/library/gemma3:4b does not support tools" } }
      : { body: { message: { role: "assistant", content: "ok" } } });
    try {
      const provider = new OllamaProvider({ baseUrl: server.url, model: "gemma3:4b", timeoutMs: 5_000, retry: FAST_RETRY });
      const tools = [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }];
      assert.equal((await provider.chat({ ...hi, tools })).content, "ok");
      assert.equal((await provider.chat({ ...hi, tools })).content, "ok");
      assert.equal(server.requests.length, 3);
      assert.equal(server.requests[2].body.tools, undefined);
    } finally {
      await server.close();
    }
  });

  it("sends a JSON schema as `format` for structured output", async () => {
    const server = await startMockServer(() => ({ body: { message: { content: "{\"flagged\":false}" } } }));
    try {
      const provider = new OllamaProvider({ baseUrl: server.url, model: "m", timeoutMs: 5_000 });
      await provider.chat({ ...hi, responseFormat: { name: "verdict", schema: { type: "object" } } });
      assert.deepEqual(server.requests[0].body.format, { type: "object" });
    } finally {
      await server.close();
    }
  });

  it("maps HTTP errors, timeouts and connection failures to typed errors", async () => {
    const missing = await startMockServer(() => ({ status: 404, body: { error: "model 'x' not found" } }));
    const provider = new OllamaProvider({ baseUrl: missing.url, model: "x", timeoutMs: 5_000, retry: FAST_RETRY });
    await assert.rejects(provider.chat(hi), isAiError("MODEL_UNAVAILABLE"));
    await missing.close();
    await assert.rejects(provider.chat(hi), isAiError("CONNECTION"));

    const slow = await startMockServer(async () => {
      await sleep(300);
      return { body: {} };
    });
    try {
      const impatient = new OllamaProvider({ baseUrl: slow.url, model: "x", timeoutMs: 50, retry: FAST_RETRY });
      await assert.rejects(impatient.chat(hi), isAiError("TIMEOUT"));
    } finally {
      await slow.close();
    }
  });

  it("reports model health from /api/tags", async () => {
    const server = await startMockServer(() => ({ body: { models: [{ name: "gemma3:4b" }, { model: "qwen3" }] } }));
    try {
      const health = async (model: string) =>
        (await new OllamaProvider({ baseUrl: server.url, model, timeoutMs: 5_000 }).checkHealth())[0].state;
      assert.equal(await health("gemma3:4b"), "ready");
      assert.equal(await health("qwen3:latest"), "ready");
      assert.equal(await health("llama3.2"), "model_missing");
    } finally {
      await server.close();
    }
  });
});

describe("OpenAICompatibleProvider", () => {
  it("uses max_completion_tokens and low reasoning effort for GPT-5 models on api.openai.com", () => {
    const body = buildOpenAIRequestBody(
      { ...hi, maxOutputTokens: 500, temperature: 0.2, responseFormat: { name: "v", schema: { type: "object" } } },
      { model: "gpt-5-mini", isOfficialApi: true }
    );
    assert.equal(body.max_completion_tokens, 500 + 2_048);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.reasoning_effort, "low");
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: { name: "v", schema: { type: "object" }, strict: true }
    });
  });

  it("uses classic parameters for other OpenAI-compatible servers", () => {
    const body = buildOpenAIRequestBody(
      { ...hi, maxOutputTokens: 500, temperature: 0.2, responseFormat: { name: "v", schema: {} } },
      { model: "llama-3.1-8b-instant", isOfficialApi: false }
    );
    assert.equal(body.max_tokens, 500);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.reasoning_effort, undefined);
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("maps images, tool calls and tool results to the Chat Completions format", () => {
    const body = buildOpenAIRequestBody({
      messages: [
        { role: "user", content: "what is this?", images: [{ mimeType: "image/jpeg", data: "QUJD" }] },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_current_time", arguments: { timezone: "UTC" } }] },
        { role: "tool", toolCallId: "call_1", toolName: "get_current_time", content: "{}" }
      ]
    }, { model: "gpt-4o-mini", isOfficialApi: true });
    const [user, assistant, tool] = body.messages as Array<Record<string, unknown>>;
    assert.deepEqual(user.content, [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } }
    ]);
    assert.deepEqual(assistant, {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "get_current_time", arguments: "{\"timezone\":\"UTC\"}" }
      }]
    });
    assert.deepEqual(tool, { role: "tool", tool_call_id: "call_1", content: "{}" });
  });

  it("sends the API key and parses tool calls and token usage", async () => {
    const server = await startMockServer(() => ({
      body: {
        model: "local-model",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_9", type: "function", function: { name: "get_member_info", arguments: "{\"user\":\"Alex\"}" } }]
          }
        }],
        usage: { prompt_tokens: 120, completion_tokens: 15 }
      }
    }));
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: `${server.url}/v1`,
        apiKey: "test-key",
        model: "local-model",
        timeoutMs: 5_000,
        retry: FAST_RETRY
      });
      const response = await provider.chat(hi);
      assert.equal(server.requests[0].url, "/v1/chat/completions");
      assert.equal(server.requests[0].headers.authorization, "Bearer test-key");
      assert.deepEqual(response.toolCalls, [{ id: "call_9", name: "get_member_info", arguments: { user: "Alex" } }]);
      assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 15 });
    } finally {
      await server.close();
    }
  });

  it("retries rate limits (honouring Retry-After) but not an exhausted quota", async () => {
    let calls = 0;
    const limited = await startMockServer(() => {
      calls += 1;
      return calls === 1
        ? { status: 429, headers: { "Retry-After": "0" }, body: { error: { message: "Rate limit reached" } } }
        : { body: { choices: [{ message: { content: "done" } }] } };
    });
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: limited.url, model: "m", timeoutMs: 5_000, retry: FAST_RETRY });
      assert.equal((await provider.chat(hi)).content, "done");
      assert.equal(calls, 2);
    } finally {
      await limited.close();
    }

    const quota = await startMockServer(() => ({
      status: 429,
      body: { error: { message: "You exceeded your current quota, please check your plan and billing details." } }
    }));
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: quota.url, model: "m", timeoutMs: 5_000, retry: FAST_RETRY });
      await assert.rejects(provider.chat(hi), (error: unknown) =>
        error instanceof AiError && error.code === "RATE_LIMITED" && !error.retryable);
      assert.equal(quota.requests.length, 1);
    } finally {
      await quota.close();
    }
  });

  it("explains empty answers caused by the token budget", async () => {
    const server = await startMockServer(() => ({
      body: { choices: [{ finish_reason: "length", message: { content: "" } }] }
    }));
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, model: "gpt-5-mini", timeoutMs: 5_000 });
      await assert.rejects(provider.chat(hi), (error: unknown) =>
        error instanceof AiError && error.code === "EMPTY_RESPONSE" && /token budget/.test(error.message));
    } finally {
      await server.close();
    }
  });

  it("reports an invalid API key in the health check", async () => {
    const server = await startMockServer(() => ({ status: 401, body: { error: { message: "Incorrect API key provided" } } }));
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: server.url, apiKey: "bad", model: "m", timeoutMs: 5_000 });
      assert.equal((await provider.checkHealth())[0].state, "auth_failed");
    } finally {
      await server.close();
    }
  });
});

describe("FallbackProvider", () => {
  it("falls back when the primary is down and skips it while it cools down", async () => {
    let now = 0;
    const primary = new ScriptedProvider([new AiError("CONNECTION", "down"), { content: "primary is back" }], "primary");
    const backup = new ScriptedProvider([{ content: "from backup" }, { content: "backup again" }], "backup");
    const chain = new FallbackProvider([primary, backup], 30_000, () => now);

    assert.equal((await chain.chat(hi)).content, "from backup");
    assert.equal((await chain.chat(hi)).content, "backup again");
    assert.equal(primary.requests.length, 1, "primary is skipped during its cooldown");

    now = 31_000;
    assert.equal((await chain.chat(hi)).content, "primary is back");
    assert.equal(chain.id, "primary → backup");
  });

  it("throws the last error when every provider fails", async () => {
    const chain = new FallbackProvider([
      new ScriptedProvider([new AiError("TIMEOUT", "slow")]),
      new ScriptedProvider([new AiError("AUTH", "bad key")])
    ]);
    await assert.rejects(chain.chat(hi), isAiError("AUTH"));
  });
});

describe("embedding providers", () => {
  it("embeds through Ollama /api/embed in batches and normalizes the vectors", async () => {
    const server = await startMockServer(request => ({
      body: { embeddings: request.body.input.map(() => [3, 4]), prompt_eval_count: 7 }
    }));
    try {
      const provider = new OllamaEmbeddingProvider({ baseUrl: server.url, model: "bge-m3", timeoutMs: 5_000 });
      const result = await provider.embed(Array.from({ length: 40 }, (_, index) => `text ${index}`));
      assert.equal(provider.id, "ollama:bge-m3");
      assert.equal(result.vectors.length, 40);
      assert.equal(server.requests.length, 2, "batches of 32");
      assert.equal(server.requests[0].url, "/api/embed");
      assert.equal(server.requests[0].body.model, "bge-m3");
      assert.deepEqual([...result.vectors[0]].map(value => Number(value.toFixed(2))), [0.6, 0.8]);
      assert.equal(result.inputTokens, 14);
    } finally {
      await server.close();
    }
  });

  it("orders OpenAI embeddings by index and sends the API key", async () => {
    const server = await startMockServer(() => ({
      body: {
        data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [5, 0] }],
        usage: { prompt_tokens: 12 }
      }
    }));
    try {
      const provider = new OpenAIEmbeddingProvider({ baseUrl: `${server.url}/v1`, apiKey: "sk-test", model: "text-embedding-3-small", timeoutMs: 5_000 });
      const result = await provider.embed(["first", "second"]);
      assert.equal(server.requests[0].url, "/v1/embeddings");
      assert.equal(server.requests[0].headers.authorization, "Bearer sk-test");
      assert.deepEqual(result.vectors.map(vector => [...vector]), [[1, 0], [0, 1]]);
      assert.equal(result.inputTokens, 12);
    } finally {
      await server.close();
    }
  });

  it("rejects malformed embedding responses", async () => {
    const server = await startMockServer(() => ({ body: { embeddings: [[1, 2]] } }));
    try {
      const provider = new OllamaEmbeddingProvider({ baseUrl: server.url, model: "m", timeoutMs: 5_000 });
      await assert.rejects(provider.embed(["a", "b"]), isAiError("INVALID_RESPONSE"));
    } finally {
      await server.close();
    }
  });

  it("pauses embeddings after a failure so chat does not slow down", async () => {
    let now = 0;
    let calls = 0;
    const failing: EmbeddingProvider = {
      id: "test:down",
      embed: async () => {
        calls += 1;
        throw new AiError("CONNECTION", "down");
      }
    };
    const embedder = new Embedder(failing, 60_000, () => now);
    assert.equal(await embedder.tryEmbed("hello"), undefined);
    assert.equal(embedder.available, false);
    assert.equal(await embedder.tryEmbed("hello again"), undefined);
    assert.equal(calls, 1, "no second call during the pause");
    now = 61_000;
    assert.equal(embedder.available, true);
  });
});
