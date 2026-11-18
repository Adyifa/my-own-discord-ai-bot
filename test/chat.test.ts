import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { generateChatReply, rememberChatTurn, replyFootnote } from "../src/ai/chat.js";
import { setCustomInstructions } from "../src/ai/guild-settings.js";
import { downloadImages, selectImageAttachments } from "../src/ai/images.js";
import { recordExchange, recordFeedback } from "../src/ai/learning/exchanges.js";
import { getRecentMessages, replaceWithSummary, saveExchange } from "../src/ai/memory.js";
import { addDocument } from "../src/ai/rag/knowledge.js";
import { addUserFacts } from "../src/ai/user-memory.js";
import { getDailyUsage } from "../src/ai/usage.js";
import { closeDatabase, initDatabase } from "../src/db/database.js";
import { AUTHOR_ID, OWNER_ID, chatInput, testRuntime as runtime, testSettings } from "./helpers/discord-fakes.js";
import { ScriptedProvider } from "./helpers/fake-provider.js";
import { startMockServer } from "./helpers/mock-server.js";

describe("chat pipeline", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  after(() => closeDatabase());

  it("assembles persona, server instructions, memory, history and speaker context", async () => {
    const memoryKey = { guildId: "g1", channelId: "c1", userId: AUTHOR_ID };
    setCustomInstructions("g1", "Server rule: no spoilers.");
    saveExchange(memoryKey, "my favourite game is Valorant", "Nice choice!");
    replaceWithSummary(memoryKey, "Alex is learning TypeScript.", 0);

    const provider = new ScriptedProvider([{ content: "Sure, Alex!" }]);
    const input = chatInput({ prompt: "remind me what I like" });
    const reply = await generateChatReply(runtime(provider), input);

    assert.equal(reply.text, "Sure, Alex!");
    assert.deepEqual([...reply.allowedMentionIds].sort(), [AUTHOR_ID, OWNER_ID].sort());

    const [system, ...rest] = provider.requests[0].messages;
    assert.equal(system.role, "system");
    assert.match(system.content, /^You are Bot\./);
    assert.match(system.content, /"Test Server"/);
    assert.match(system.content, /Server rule: no spoilers\./);
    assert.match(system.content, /Alex is learning TypeScript\./);
    assert.deepEqual(rest.map(message => message.role), ["user", "assistant", "system", "user"]);
    assert.match(rest[2].content, /Speaker: Alex \(@alex, <@111111111111111111>\)/);
    assert.equal(rest[3].content, "remind me what I like");
    assert.deepEqual(
      provider.requests[0].tools?.map(tool => tool.name),
      ["get_current_time", "get_server_info", "get_member_info"]
    );
    assert.equal(getDailyUsage("g1").requestsByFeature.chat, 1);

    rememberChatTurn(runtime(provider), input, reply.text);
    assert.deepEqual(
      getRecentMessages(memoryKey).map(message => message.content).slice(-2),
      ["remind me what I like", "Sure, Alex!"]
    );
  });

  it("lets the model call a tool and reports it for the answer footnote", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "t1", name: "get_current_time", arguments: {} }] },
      request => {
        const toolMessage = request.messages.at(-1);
        assert.equal(toolMessage?.role, "tool");
        assert.match(toolMessage?.content ?? "", /Asia\/Jakarta/);
        return { content: "It is evening in Jakarta." };
      }
    ]);
    const reply = await generateChatReply(runtime(provider), chatInput({ prompt: "what time is it?" }));
    assert.equal(reply.text, "It is evening in Jakarta.");
    assert.deepEqual(reply.toolLabels, ["clock"]);
  });

  it("passes images to vision models and refuses to run without a provider", async () => {
    const provider = new ScriptedProvider([{ content: "A cat." }]);
    const noTools = runtime(provider, { settings: testSettings({ toolsEnabled: false }) });
    await generateChatReply(noTools, chatInput({ prompt: "", images: [{ mimeType: "image/png", data: "AAAA" }] }));
    assert.deepEqual(provider.requests[0].messages.at(-1), {
      role: "user",
      content: "(The user sent an image without any text.)",
      images: [{ mimeType: "image/png", data: "AAAA" }]
    });
    assert.equal(provider.requests[0].tools, undefined);

    await assert.rejects(
      generateChatReply(runtime(undefined, { problems: ["OLLAMA_MODEL is required"] }), chatInput()),
      /OLLAMA_MODEL is required/
    );
  });
});

describe("chat pipeline with knowledge and learning", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  after(() => closeDatabase());

  it("grounds answers in the knowledge base, personal memory and rated examples", async () => {
    addDocument({ guildId: "g1", title: "Server Rules", content: "Selling game accounts is not allowed here.", source: "admin", createdBy: "admin" });
    addUserFacts("g1", AUTHOR_ID, ["Prefers short answers"], "user");
    const helpful = recordExchange({
      guildId: "g1", channelId: "c1", userId: "someone", prompt: "can I sell my game account?",
      answer: "No, account trading breaks rule 4.", provider: "fake", model: "m"
    });
    recordFeedback(helpful, "someone", 1, false);

    const provider = new ScriptedProvider([{ content: "No, selling accounts is not allowed [1]." }]);
    const reply = await generateChatReply(runtime(provider), chatInput({ prompt: "Can I sell my game account here?" }));

    const system = provider.requests[0].messages[0].content;
    assert.match(system, /\[1\] Server Rules\nSelling game accounts is not allowed here\./);
    assert.match(system, /- Prefers short answers/);
    assert.match(system, /A: No, account trading breaks rule 4\./);
    assert.ok(provider.requests[0].tools?.some(tool => tool.name === "search_knowledge_base"));
    assert.deepEqual(reply.sources, [{ number: 1, title: "Server Rules", documentId: 1 }]);
    assert.equal(replyFootnote(reply), "📚 [1] Server Rules");
  });

  it("lets the agent search the knowledge base itself and cite what it found", async () => {
    addDocument({ guildId: "g1", title: "Minecraft Server", content: "The server IP is mc.example.id", source: "admin", createdBy: "admin" });
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "k1", name: "search_knowledge_base", arguments: { query: "minecraft ip" } }] },
      request => {
        assert.match(request.messages.at(-1)?.content ?? "", /"cite":"\[1\]"/);
        return { content: "Use mc.example.id [1]." };
      }
    ]);
    const reply = await generateChatReply(runtime(provider), chatInput({ prompt: "hello there" }));
    assert.deepEqual(reply.sources.map(source => source.title), ["Minecraft Server"]);
    assert.equal(replyFootnote(reply), "🔧 knowledge base  |  📚 [1] Minecraft Server");
  });
});

describe("image attachments", () => {
  it("selects up to three supported, reasonably small images", () => {
    const attachments = [
      { url: "a", contentType: "image/png", size: 10 },
      { url: "b", contentType: "image/gif", size: 10 },
      { url: "c", contentType: "image/jpeg; charset=binary", size: 10 },
      { url: "d", contentType: "image/webp", size: 6 * 1024 * 1024 },
      { url: "e", contentType: null, size: 10 },
      { url: "f", contentType: "image/webp", size: 10 },
      { url: "g", contentType: "image/png", size: 10 }
    ];
    assert.deepEqual(selectImageAttachments(attachments).map(attachment => attachment.url), ["a", "c", "f"]);
  });

  it("downloads images as base64 and skips failed downloads", async () => {
    const server = await startMockServer(request => request.url === "/ok.png"
      ? { body: "PNGDATA" }
      : { status: 404, body: "missing" });
    try {
      const images = await downloadImages([
        { url: `${server.url}/ok.png`, contentType: "image/png", size: 7 },
        { url: `${server.url}/gone.png`, contentType: "image/png", size: 7 }
      ]);
      assert.deepEqual(images, [{ mimeType: "image/png", data: Buffer.from("PNGDATA").toString("base64") }]);
    } finally {
      await server.close();
    }
  });
});
