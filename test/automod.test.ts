import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpamTracker, checkContent, compileBlockedWords, type ContentRules } from "../src/features/automod.js";

const rules = (overrides: Partial<ContentRules> = {}): ContentRules => ({
  antiLink: false,
  capsPercent: 0,
  blockedWords: null,
  ...overrides
});

describe("checkContent", () => {
  it("flags links only when anti-link is on", () => {
    assert.equal(checkContent("see https://example.com", rules()), null);
    assert.equal(checkContent("see https://example.com", rules({ antiLink: true })), "link");
    assert.equal(checkContent("join discord.gg/abc", rules({ antiLink: true })), "link");
  });

  it("matches blocked words as whole words (no 'class' → 'ass' false positives)", () => {
    const blockedWords = compileBlockedWords("ass, scam*");
    assert.equal(checkContent("this class is great", rules({ blockedWords })), null);
    assert.equal(checkContent("you ass", rules({ blockedWords })), "blocked_word");
    assert.equal(checkContent("total SCAMMER", rules({ blockedWords })), "blocked_word");
    assert.equal(compileBlockedWords(""), null);
  });

  it("detects shouting but ignores short messages, custom emoji and URLs", () => {
    const capsRules = rules({ capsPercent: 50 });
    assert.equal(checkContent("WHY IS NOBODY ANSWERING ME", capsRules), "caps");
    assert.equal(checkContent("OK LOL", capsRules), null);
    assert.equal(checkContent("this is fine <:KEKWLAUGHINGHARD:123456789012345678>", capsRules), null);
    assert.equal(checkContent("please look at https://EXAMPLE.COM/ABCDEFGHIJ thanks", capsRules), null);
  });
});

describe("SpamTracker", () => {
  it("flags bursts inside the time window only", () => {
    const tracker = new SpamTracker(5_000, 3);
    assert.equal(tracker.record("user", 0), false);
    assert.equal(tracker.record("user", 1_000), false);
    assert.equal(tracker.record("user", 2_000), true);
    assert.equal(tracker.record("user", 9_000), false);
    assert.equal(tracker.record("someone-else", 9_000), false);
  });
});
