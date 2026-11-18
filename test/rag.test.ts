import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { Embedder } from "../src/ai/embeddings.js";
import { CitationRegistry } from "../src/ai/rag/citations.js";
import { EmbeddingIndexer, findPendingEmbeddings } from "../src/ai/rag/indexer.js";
import {
  KnowledgeError,
  addDocument,
  deleteDocument,
  getKnowledgeCounts,
  retrieveKnowledge,
  type KnowledgeHit
} from "../src/ai/rag/knowledge.js";
import { buildFtsQuery, chunkText, overlapScore, tokenize } from "../src/ai/rag/text.js";
import { cosine, decodeVector, encodeVector, normalize, reciprocalRankFusion } from "../src/ai/rag/vectors.js";
import { closeDatabase, initDatabase } from "../src/db/database.js";
import { loadKnowledgeFiles } from "../src/evals/datasets.js";
import { ingestKnowledgeFiles } from "../src/evals/rag-eval.js";
import { HashingEmbeddingProvider } from "./helpers/hashing-embedder.js";

const files = loadKnowledgeFiles("evals/datasets/knowledge");

describe("text processing", () => {
  it("tokenizes without stopwords, accents or punctuation", () => {
    assert.deepEqual(tokenize("Gimana cara dapat role Verified? Café!"), ["cara", "dapat", "role", "verified", "cafe"]);
  });

  it("builds FTS5 queries that cannot inject operators", () => {
    assert.equal(buildFtsQuery("jadwal \"turnamen\" OR NOT valorant*"), "\"jadwal\" OR \"turnamen\" OR \"valorant\"");
    assert.equal(buildFtsQuery("?? !!"), null);
  });

  it("scores word overlap between 0 and 1", () => {
    assert.equal(overlapScore(["scrim", "valorant"], ["scrim", "valorant"]), 1);
    assert.equal(overlapScore([], ["scrim"]), 0);
  });
});

describe("chunkText", () => {
  it("keeps short documents whole", () => {
    assert.deepEqual(chunkText("Hello world.\n\nSecond paragraph."), ["Hello world.\n\nSecond paragraph."]);
    assert.deepEqual(chunkText(" \n\n "), []);
  });

  it("respects the size limit, covers every paragraph and overlaps neighbouring chunks", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) =>
      `Paragraph ${index} talks about topic number ${index} in some detail so it has length.`);
    const chunks = chunkText(paragraphs.join("\n\n"), { maxChars: 200, overlapChars: 50 });
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every(chunk => chunk.length <= 200));
    for (const paragraph of paragraphs) assert.ok(chunks.some(chunk => chunk.includes(paragraph)), paragraph);
    assert.ok(chunks[1].includes(paragraphs[1].slice(-20)), "second chunk starts with the tail of the first");
  });

  it("splits huge paragraphs by sentences and words", () => {
    const sentences = chunkText("This is a sentence with several words. ".repeat(60), { maxChars: 120, overlapChars: 0 });
    assert.ok(sentences.every(chunk => chunk.length <= 120));
    assert.equal(chunkText("x".repeat(500), { maxChars: 100, overlapChars: 0 }).length, 5);
  });
});

describe("vectors", () => {
  it("normalizes, compares and round-trips through unaligned SQLite blobs", () => {
    const vector = normalize([3, 4]);
    assert.deepEqual([...vector].map(value => Number(value.toFixed(3))), [0.6, 0.8]);
    assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-6);
    assert.equal(cosine(vector, normalize([1, 2, 3])), 0);

    const unaligned = Buffer.concat([Buffer.alloc(1), encodeVector(vector)]).subarray(1);
    assert.deepEqual([...(decodeVector(unaligned) ?? [])], [...vector]);
    assert.equal(decodeVector(null), null);
  });

  it("fuses rankings with reciprocal rank fusion", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"], ["c", "a"]], id => id);
    assert.deepEqual(fused.map(entry => entry.item), ["a", "c", "b"]);
  });
});

describe("knowledge base", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  after(() => closeDatabase());

  it("finds documents with BM25 keyword search, isolated per server", () => {
    ingestKnowledgeFiles(files, "g1");
    const [top] = retrieveKnowledge("g1", "What's the Minecraft server IP?", { minSimilarity: 0.45 });
    assert.equal(top.title, "Minecraft Server");
    assert.equal(top.keywordRank, 1);
    assert.equal(top.vectorSimilarity, undefined);
    assert.deepEqual(retrieveKnowledge("another-server", "minecraft", { minSimilarity: 0.45 }), []);
  });

  it("deletes documents together with their search index", () => {
    const document = addDocument({ guildId: "g1", title: "Temp", content: "zebra crossing facts", source: "admin", createdBy: "u" });
    assert.equal(retrieveKnowledge("g1", "zebra", { minSimilarity: 0.45 }).length, 1);
    assert.equal(deleteDocument("g1", document.id), true);
    assert.equal(retrieveKnowledge("g1", "zebra", { minSimilarity: 0.45 }).length, 0);
    assert.equal(deleteDocument("g1", document.id), false);
    assert.throws(
      () => addDocument({ guildId: "g1", title: "Empty", content: "   ", source: "admin", createdBy: "u" }),
      KnowledgeError
    );
  });

  it("hybrid search recovers a paraphrased question that keyword search misses", async () => {
    ingestKnowledgeFiles(files, "g1");
    const embedder = new Embedder(new HashingEmbeddingProvider("test:hash", 256, {
      kotak: "minecraft", minggu: "sunday", bareng: "together", main: "play"
    }));
    const indexed = await new EmbeddingIndexer(embedder).runOnce();
    assert.equal(indexed, getKnowledgeCounts("g1", embedder.id).chunks);

    const question = "Jam berapa kita main bareng di dunia kotak-kotak tiap hari Minggu?";
    const titles = (hits: KnowledgeHit[]) => hits.slice(0, 3).map(hit => hit.title);
    const keyword = retrieveKnowledge("g1", question, { mode: "keyword", minSimilarity: 0.2 });
    assert.ok(!titles(keyword).includes("Events & Tournaments"));

    const [queryVector] = await embedder.embed([question]);
    const hybrid = retrieveKnowledge("g1", question, { queryVector, embeddingModel: embedder.id, minSimilarity: 0.2 });
    assert.ok(titles(hybrid).includes("Events & Tournaments"));
    assert.ok(hybrid.some(hit => hit.vectorSimilarity !== undefined));
  });

  it("re-embeds everything when the embedding model changes", async () => {
    ingestKnowledgeFiles(files, "g1");
    const chunks = getKnowledgeCounts("g1").chunks;
    await new EmbeddingIndexer(new Embedder(new HashingEmbeddingProvider("test:v1"))).runOnce();
    assert.equal(findPendingEmbeddings("test:v1", 1_000).length, 0);
    assert.equal(findPendingEmbeddings("test:v2", 1_000).length, chunks);

    await new EmbeddingIndexer(new Embedder(new HashingEmbeddingProvider("test:v2"))).runOnce();
    assert.equal(findPendingEmbeddings("test:v2", 1_000).length, 0);
    assert.equal(getKnowledgeCounts("g1", "test:v2").embeddedChunks, chunks);
  });
});

describe("CitationRegistry", () => {
  const hit = (chunkId: number, documentId: number, title: string): KnowledgeHit =>
    ({ chunkId, documentId, title, source: "admin", content: "", score: 1 });

  it("numbers each excerpt once and maps cited numbers back to documents", () => {
    const registry = new CitationRegistry();
    assert.equal(registry.register(hit(10, 1, "Rules")), 1);
    assert.equal(registry.register(hit(11, 2, "Events")), 2);
    assert.equal(registry.register(hit(10, 1, "Rules")), 1);
    assert.equal(registry.register(hit(12, 1, "Rules")), 3);
    assert.deepEqual(registry.cited("Scrims are on Saturday [2]. No selling accounts [1, 3]. Bogus [9]."), [
      { number: 1, title: "Rules", documentId: 1 },
      { number: 2, title: "Events", documentId: 2 }
    ]);
  });
});
