import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, beforeEach, describe, it } from "node:test";
import { Embedder } from "../src/ai/embeddings.js";
import type { ChatProvider, ChatRequest, ChatResponse, ProviderHealth } from "../src/ai/providers/index.js";
import { EmbeddingIndexer } from "../src/ai/rag/indexer.js";
import { tokenize } from "../src/ai/rag/text.js";
import { closeDatabase, initDatabase } from "../src/db/database.js";
import {
  loadKnowledgeFiles,
  loadModerationDataset,
  loadModerationExamples,
  loadRagDataset,
  type ModerationEvalItem
} from "../src/evals/datasets.js";
import { binaryMetrics, hitAtK, mapWithConcurrency, mean, percentile, reciprocalRank } from "../src/evals/metrics.js";
import { runModerationEval } from "../src/evals/moderation-eval.js";
import { ingestKnowledgeFiles, runAnswerEval, runRetrievalEval } from "../src/evals/rag-eval.js";
import { moderationReport, retrievalReport } from "../src/evals/report.js";
import { testRuntime, testSettings } from "./helpers/discord-fakes.js";
import { ScriptedProvider } from "./helpers/fake-provider.js";
import { HashingEmbeddingProvider } from "./helpers/hashing-embedder.js";

describe("eval metrics", () => {
  it("computes accuracy, precision, recall and F1", () => {
    const metrics = binaryMetrics([
      { expected: true, predicted: true },
      { expected: true, predicted: false },
      { expected: false, predicted: true },
      { expected: false, predicted: false },
      { expected: false, predicted: false }
    ]);
    assert.deepEqual(metrics, { total: 5, tp: 1, fp: 1, tn: 2, fn: 1, accuracy: 0.6, precision: 0.5, recall: 0.5, f1: 0.5 });
    assert.equal(binaryMetrics([]).f1, 0);
  });

  it("scores rankings and latencies", () => {
    assert.equal(reciprocalRank(["b", "a"], "a"), 0.5);
    assert.equal(reciprocalRank(["b"], "a"), 0);
    assert.equal(hitAtK(["b", "c", "a"], "a", 3), true);
    assert.equal(hitAtK(["b", "c", "a"], "a", 2), false);
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
    assert.equal(mean([]), 0);
  });

  it("limits concurrency but keeps results in input order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(ms);
      active -= 1;
      return index;
    });
    assert.deepEqual(results, [0, 1, 2, 3]);
    assert.equal(peak, 2);
  });
});

describe("eval datasets", () => {
  it("ships valid, balanced datasets", () => {
    const moderation = loadModerationDataset("evals/datasets/moderation.jsonl");
    const flagged = moderation.filter(item => item.flagged).length;
    assert.ok(moderation.length >= 40);
    assert.ok(flagged > 15 && moderation.length - flagged > 15, "both classes are well represented");
    assert.ok(moderation.some(item => item.group === "server_norms"));
    assert.equal(new Set(moderation.map(item => item.id)).size, moderation.length);
    assert.ok(loadModerationExamples("evals/datasets/moderation-examples.jsonl").length >= 10);

    const titles = new Set(loadKnowledgeFiles("evals/datasets/knowledge").map(file => file.title));
    for (const item of loadRagDataset("evals/datasets/rag.jsonl")) assert.ok(titles.has(item.expectedDocument), item.id);
  });
});

/**
 * Stand-in for an LLM: it knows generic rules, over-flags gaming trash talk
 * and does not know the server's "no account selling" rule — unless the
 * prompt contains a similar past moderator decision, which it then follows.
 */
class RuleOfThumbClassifier implements ChatProvider {
  readonly id = "fake";
  readonly model = "rule-of-thumb";

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.messages[1].content.match(/<message>\n([\s\S]*)\n<\/message>/)?.[1] ?? "";
    if (message.includes("boom")) throw new Error("model crashed");
    const tokens = new Set(tokenize(message));
    const example = [...request.messages[0].content.matchAll(/- "(.+)" → (violates \((\w+)\)|fine)/g)]
      .find(match => tokenize(match[1]).some(token => ["noob", "akun"].includes(token) && tokens.has(token)));

    let verdict = { flagged: false, category: "none" };
    if (/goblok|idiot/.test(message)) verdict = { flagged: true, category: "harassment" };
    else if (example) verdict = example[3] ? { flagged: true, category: example[3] } : verdict;
    else if (tokens.has("noob")) verdict = { flagged: true, category: "harassment" };

    return {
      content: JSON.stringify({ ...verdict, confidence: verdict.flagged ? 0.95 : 0.05, reason: "test" }),
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 10 },
      provider: this.id,
      model: this.model
    };
  }

  async checkHealth(): Promise<ProviderHealth[]> {
    return [];
  }
}

describe("moderation eval", () => {
  const items: ModerationEvalItem[] = [
    { id: "a", text: "lu noob banget, uninstall aja", flagged: false, category: "none", group: "server_norms" },
    { id: "b", text: "jual akun ML murah, minat dm", flagged: true, category: "scam_spam", group: "server_norms" },
    { id: "c", text: "dasar goblok", flagged: true, category: "harassment", group: "general" },
    { id: "d", text: "gg wp semuanya", flagged: false, category: "none", group: "general" }
  ];
  const examplePool = [
    { text: "dasar noob, uninstall aja", flagged: false, category: "none" as const },
    { text: "jual akun valorant murah, minat dm", flagged: true, category: "scam_spam" as const }
  ];

  it("measures how much learning from moderator decisions improves the classifier", async () => {
    const zeroShot = await runModerationEval({ provider: new RuleOfThumbClassifier(), items, mode: "zero-shot", examplePool });
    const fewShot = await runModerationEval({ provider: new RuleOfThumbClassifier(), items, mode: "few-shot", examplePool });

    assert.equal(zeroShot.overall.accuracy, 0.5);
    assert.equal(zeroShot.serverNorms.accuracy, 0);
    assert.equal(fewShot.overall.accuracy, 1);
    assert.equal(fewShot.serverNorms.accuracy, 1);
    assert.equal(fewShot.predictions.find(prediction => prediction.id === "a")?.examplesUsed, 1);
    assert.equal(fewShot.inputTokens, 400);

    const report = moderationReport([zeroShot, fewShot]);
    assert.match(report, /F1 .+ → .+ \(\+\d/);
    assert.match(report, /server-norm accuracy 0\.0% → 100\.0%/);
  });

  it("fails open on model errors, like production", async () => {
    const result = await runModerationEval({
      provider: new RuleOfThumbClassifier(),
      items: [{ id: "x", text: "boom", flagged: true, category: "other", group: "general" }],
      mode: "zero-shot"
    });
    assert.equal(result.errors, 1);
    assert.equal(result.predictions[0].predicted, false);
  });
});

describe("RAG eval", () => {
  beforeEach(() => {
    initDatabase(":memory:");
    ingestKnowledgeFiles(loadKnowledgeFiles("evals/datasets/knowledge"));
  });
  after(() => closeDatabase());

  it("scores keyword retrieval on the shipped knowledge base", async () => {
    const [keyword] = await runRetrievalEval({ items: loadRagDataset("evals/datasets/rag.jsonl"), minSimilarity: 0.45 });
    assert.equal(keyword.mode, "keyword");
    assert.ok(keyword.hitAt3 >= 0.75, `hit@3 = ${keyword.hitAt3}`);
    assert.ok(keyword.mrr > 0.5);
    assert.match(retrievalReport([keyword]), /\| keyword \| — \|/);
  });

  it("adds vector and hybrid modes when an embedding model is available", async () => {
    const embedder = new Embedder(new HashingEmbeddingProvider());
    await new EmbeddingIndexer(embedder).runOnce();
    const results = await runRetrievalEval({ items: loadRagDataset("evals/datasets/rag.jsonl"), embedder, minSimilarity: 0.1 });
    assert.deepEqual(results.map(result => result.mode), ["keyword", "vector", "hybrid"]);
    assert.ok(results.every(result => result.hitAt3 > 0));
  });

  it("grades grounded answers and their citations through the production pipeline", async () => {
    const provider = new ScriptedProvider([{ content: "The IP is mc.nusantarahub.id [1]." }]);
    const result = await runAnswerEval({
      runtime: testRuntime(provider, { settings: testSettings({ toolsEnabled: false, learningEnabled: false }) }),
      items: [{ id: "ip", question: "What's the Minecraft server IP?", expectedDocument: "Minecraft Server", mustInclude: ["mc.nusantarahub.id"] }]
    });
    assert.equal(result.accuracy, 1);
    assert.equal(result.citationRate, 1);
    assert.match(provider.requests[0].messages[0].content, /\[1\] Minecraft Server/);
  });
});
