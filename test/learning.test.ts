import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { correctionModal, feedbackRow, parseLearningCustomId, reviewRow } from "../src/ai/learning/components.js";
import {
  findExemplars,
  getExchange,
  hasExemplars,
  purgeExchanges,
  recordExchange,
  recordFeedback
} from "../src/ai/learning/exchanges.js";
import {
  decideFlag,
  findModerationExamples,
  getModerationStats,
  recordFlag
} from "../src/ai/learning/moderation-flags.js";
import { getLearningStats } from "../src/ai/learning/stats.js";
import { compactConversation, parseMemoryUpdate } from "../src/ai/memory-compactor.js";
import { getSummary, saveExchange } from "../src/ai/memory.js";
import { buildModerationMessages, type ModerationCategory } from "../src/ai/moderation.js";
import { addDocument } from "../src/ai/rag/knowledge.js";
import { MAX_FACTS_PER_USER, addUserFacts, deleteUserFact, deleteUserFacts, getUserFacts } from "../src/ai/user-memory.js";
import { closeDatabase, getDatabase, initDatabase } from "../src/db/database.js";
import { ScriptedProvider } from "./helpers/fake-provider.js";

const exchange = (prompt: string, answer: string, guildId = "g1") =>
  recordExchange({ guildId, channelId: "c1", userId: "asker", prompt, answer, provider: "fake", model: "m" });

const flag = (content: string, category: ModerationCategory) =>
  recordFlag({ guildId: "g1", channelId: "c1", messageId: "m1", authorId: "a1", content, category, confidence: 0.9, reason: "r", deleted: false });

describe("learning loops", () => {
  beforeEach(() => {
    initDatabase(":memory:");
  });
  after(() => closeDatabase());

  describe("answer feedback", () => {
    it("records one vote per person and keeps live totals", () => {
      const id = exchange("q", "a");
      assert.deepEqual(recordFeedback(id, "u1", 1, false), { up: 1, down: 0 });
      assert.deepEqual(recordFeedback(id, "u2", -1, false), { up: 1, down: 1 });
      assert.deepEqual(recordFeedback(id, "u2", 1, false), { up: 2, down: 0 });
    });

    it("reuses helpful answers as examples unless a moderator vetoed them", () => {
      const helpful = exchange("Jam berapa scrim valorant?", "Setiap Sabtu jam 19:00 WIB.");
      const vetoed = exchange("Jam berapa scrim valorant mulai?", "Jam 3 pagi.");
      exchange("scrim valorant kapan?", "Tidak tahu.");
      recordFeedback(helpful, "u1", 1, false);
      recordFeedback(vetoed, "u1", 1, false);
      recordFeedback(vetoed, "u2", 1, false);
      recordFeedback(vetoed, "mod", -1, true);

      assert.equal(hasExemplars("g1"), true);
      assert.equal(hasExemplars("another-server"), false);
      const exemplars = findExemplars("g1", { text: "kapan scrim valorant dimulai jam berapa?" });
      assert.deepEqual(exemplars.map(example => example.answer), ["Setiap Sabtu jam 19:00 WIB."]);
    });

    it("expires unrated answers after 30 days but keeps helpful ones", () => {
      const unrated = exchange("old question", "old answer");
      const helpful = exchange("kept question", "kept answer");
      recordFeedback(helpful, "u1", 1, false);
      getDatabase().prepare("UPDATE ai_exchanges SET created_at = datetime('now', '-40 days')").run();
      assert.equal(purgeExchanges(), 1);
      assert.equal(getExchange(unrated), undefined);
      assert.ok(getExchange(helpful));
    });
  });

  describe("moderation reviews", () => {
    it("turns moderator decisions into few-shot examples and precision stats", () => {
      const falsePositive = flag("dasar noob mainnya kayak bot", "harassment");
      const truePositive = flag("jual akun valorant murah dm aja", "scam_spam");
      flag("this one was never reviewed", "other");

      assert.equal(decideFlag(falsePositive, "g1", "false_positive", "mod")?.decision, "false_positive");
      assert.equal(decideFlag(falsePositive, "g1", "confirmed", "mod"), undefined, "already reviewed");
      assert.equal(decideFlag(truePositive, "another-server", "confirmed", "mod"), undefined, "wrong server");
      decideFlag(truePositive, "g1", "confirmed", "mod");

      assert.deepEqual(findModerationExamples("g1", { text: "lu noob banget mainnya kayak bot" }), [
        { text: "dasar noob mainnya kayak bot", violates: false, category: "harassment" }
      ]);
      assert.deepEqual(getModerationStats("g1"), {
        flags: 3, reviewed: 2, confirmed: 1, falsePositives: 1, precision: 0.5, learnedExamples: 2
      });
    });

    it("adds learned examples to the classifier prompt", () => {
      const [system] = buildModerationMessages("lu noob", {
        examples: [
          { text: "dasar \"noob\"", violates: false, category: "none" },
          { text: "jual akun", violates: true, category: "scam_spam" }
        ]
      });
      assert.match(system.content, /- "dasar 'noob'" → fine \(none\)/);
      assert.match(system.content, /- "jual akun" → violates \(scam_spam\)/);
    });
  });

  describe("personal memory", () => {
    it("dedupes facts, caps them and drops learned facts before user-provided ones", () => {
      assert.equal(addUserFacts("g1", "u1", ["Prefers English.", "prefers english", "  "], "user"), 1);
      addUserFacts("g1", "u1", Array.from({ length: 25 }, (_, index) => `plays game number ${index}`), "auto");

      const facts = getUserFacts("g1", "u1");
      assert.equal(facts.length, MAX_FACTS_PER_USER);
      assert.equal(facts[0].fact, "Prefers English");
      assert.equal(facts.at(-1)?.fact, "plays game number 24");
      assert.equal(deleteUserFact("g1", "u1", facts[0].id), true);
      assert.equal(deleteUserFacts("g1", "u1"), MAX_FACTS_PER_USER - 1);
    });

    it("parses memory updates from JSON or plain text", () => {
      assert.deepEqual(
        parseMemoryUpdate("```json\n{\"summary\":\"Talked about Valorant.\",\"facts\":[\"Plays Valorant\",3,\" \"]}\n```"),
        { summary: "Talked about Valorant.", facts: ["Plays Valorant"] }
      );
      assert.deepEqual(parseMemoryUpdate("Just a summary."), { summary: "Just a summary.", facts: [] });
      assert.equal(parseMemoryUpdate("{\"broken\": "), null);
    });

    it("learns facts while compacting a long conversation", async () => {
      const key = { guildId: "g1", channelId: "c1", userId: "u1" };
      for (let index = 0; index < 15; index += 1) saveExchange(key, `q${index}`, `a${index}`);
      const provider = new ScriptedProvider([{ content: "{\"summary\":\"Asked about ranks.\",\"facts\":[\"Main role is duelist\"]}" }]);

      await compactConversation(provider, key, { extractFacts: true });
      assert.equal(getSummary(key), "Asked about ranks.");
      assert.deepEqual(getUserFacts("g1", "u1").map(fact => [fact.fact, fact.source]), [["Main role is duelist", "auto"]]);
      assert.equal(provider.requests[0].responseFormat?.name, "memory_update");
    });
  });

  describe("learning stats", () => {
    it("summarises everything learned on a server", () => {
      addDocument({ guildId: "g1", title: "Correction: x", content: "Question: x\nCorrect answer: y", source: "correction", createdBy: "mod" });
      recordFeedback(exchange("q1", "a1"), "u1", 1, false);
      recordFeedback(exchange("q2", "a2"), "u2", -1, false);
      addUserFacts("g1", "u1", ["Likes cats"], "user");

      const stats = getLearningStats("g1");
      assert.equal(stats.knowledge.corrections, 1);
      assert.deepEqual(stats.feedback, { up: 1, down: 1, satisfaction: 0.5, helpfulAnswers: 1 });
      assert.deepEqual(stats.personalMemory, { users: 1, facts: 1 });
      assert.equal(stats.moderation.precision, null);
    });
  });
});

describe("learning components", () => {
  const customIds = (row: ActionRowBuilder<ButtonBuilder>) =>
    row.toJSON().components.map(component => ("custom_id" in component ? component.custom_id : ""));

  it("round-trips custom IDs and rejects anything else", () => {
    assert.deepEqual(parseLearningCustomId("ai-fb:12:up"), { kind: "feedback", exchangeId: 12, rating: 1 });
    assert.deepEqual(parseLearningCustomId("ai-fb:12:down"), { kind: "feedback", exchangeId: 12, rating: -1 });
    assert.deepEqual(parseLearningCustomId("ai-fix:7"), { kind: "correction", exchangeId: 7 });
    assert.deepEqual(parseLearningCustomId("ai-mod:3:dismiss"), { kind: "review", flagId: 3, action: "dismiss" });
    for (const invalid of ["ai-fb:0:up", "ai-fb:x:up", "ai-fb:1:sideways", "ai-fix:1:extra", "other:1", "ai-mod:1:delete:now"]) {
      assert.equal(parseLearningCustomId(invalid), null, invalid);
    }
  });

  it("shows live vote counts on the feedback buttons", () => {
    const labels = feedbackRow(5, { up: 3, down: 0 }).toJSON().components
      .map(component => ("label" in component ? component.label ?? "" : ""));
    assert.deepEqual(customIds(feedbackRow(5)), ["ai-fb:5:up", "ai-fb:5:down"]);
    assert.deepEqual(labels, ["3", ""]);
  });

  it("offers the delete button only while the flagged message still exists", () => {
    assert.deepEqual(customIds(reviewRow(9, false)), ["ai-mod:9:confirm", "ai-mod:9:delete", "ai-mod:9:dismiss"]);
    assert.deepEqual(customIds(reviewRow(9, true)), ["ai-mod:9:confirm", "ai-mod:9:dismiss"]);
  });

  it("builds the correction modal", () => {
    const modal = correctionModal(4, "Kapan scrim?").toJSON();
    assert.equal(modal.custom_id, "ai-fix:4");
    assert.equal(modal.title, "Teach the correct answer");
  });
});
