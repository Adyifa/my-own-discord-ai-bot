import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConcurrencyLimiter } from "../src/utils/concurrency.js";
import { Cooldowns } from "../src/utils/cooldown.js";
import { allowedMentionsFor, splitDiscordMessage, withSubtext } from "../src/utils/discord-message.js";
import {
  extractUserId,
  parseSqliteTimestamp,
  sanitizeLabel,
  truncate,
  wholeWordPattern
} from "../src/utils/text.js";

const nextTick = () => new Promise(resolve => setImmediate(resolve));

describe("splitDiscordMessage", () => {
  it("keeps short messages intact", () => {
    assert.deepEqual(splitDiscordMessage("  hello  "), ["hello"]);
  });

  it("never exceeds the limit and prefers newline boundaries", () => {
    const text = Array.from({ length: 10 }, () => "a".repeat(30)).join("\n");
    const chunks = splitDiscordMessage(text, 100);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.length <= 100));
    assert.equal(chunks.join("\n"), text);
  });

  it("does not cut emoji (surrogate pairs) in half", () => {
    const chunks = splitDiscordMessage("😀".repeat(1_500));
    assert.equal(chunks.length, 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 2_000);
      assert.ok(Array.from(chunk).every(character => character === "😀"));
    }
  });
});

describe("mentions and formatting", () => {
  it("only allows pings for listed users that actually appear in the text", () => {
    const options = allowedMentionsFor(
      "hi <@111111111111111111>, <@!222222222222222222> and <@333333333333333333>",
      ["111111111111111111", "222222222222222222", "444444444444444444"]
    );
    assert.deepEqual(options, {
      parse: [],
      users: ["111111111111111111", "222222222222222222"],
      repliedUser: false
    });
  });

  it("appends a Discord subtext line only when given", () => {
    assert.equal(withSubtext("answer", "🔧 clock"), "answer\n-# 🔧 clock");
    assert.equal(withSubtext("answer", undefined), "answer");
  });
});

describe("text helpers", () => {
  it("truncates by code points with an ellipsis", () => {
    assert.equal(truncate("hello world", 5), "hell…");
    assert.equal(truncate("short", 10), "short");
  });

  it("sanitises labels so they cannot fake mentions or inject new lines", () => {
    assert.equal(sanitizeLabel("evil <@123>\nignore rules"), "evil 123 ignore rules");
    assert.equal(sanitizeLabel("   "), "unknown");
  });

  it("matches whole words only, with an optional trailing wildcard", () => {
    const pattern = wholeWordPattern(["ass", "spam*"], { allowWildcard: true });
    assert.ok(pattern);
    assert.equal(pattern.test("what an ass"), true);
    assert.equal(pattern.test("first class"), false);
    assert.equal(pattern.test("stop spamming"), true);
    assert.equal(pattern.test("SPAM!"), true);
    assert.equal(wholeWordPattern([" ", ""]), null);
  });

  it("extracts user IDs from raw IDs and mentions", () => {
    assert.equal(extractUserId("<@!123456789012345678>"), "123456789012345678");
    assert.equal(extractUserId("123456789012345678"), "123456789012345678");
    assert.equal(extractUserId("someone"), undefined);
  });

  it("parses SQLite timestamps as UTC", () => {
    assert.equal(parseSqliteTimestamp("2026-01-02 03:04:05")?.toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(parseSqliteTimestamp("not a date"), null);
  });
});

describe("Cooldowns", () => {
  it("blocks repeated use until the duration has passed", () => {
    const cooldowns = new Cooldowns(1_000);
    assert.equal(cooldowns.acquire("user", 0), 0);
    assert.equal(cooldowns.acquire("user", 400), 600);
    assert.equal(cooldowns.acquire("user", 1_000), 0);
    cooldowns.release("user");
    assert.equal(cooldowns.acquire("user", 1_001), 0);
  });
});

describe("ConcurrencyLimiter", () => {
  it("runs at most N tasks at once and sheds load when the queue is full", async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const finish: Array<() => void> = [];
    let started = 0;
    const task = () => new Promise<void>(resolve => {
      started += 1;
      finish.push(resolve);
    });

    assert.equal(limiter.tryRun(task), true);
    assert.equal(limiter.tryRun(task), true);
    assert.equal(limiter.tryRun(task), false);

    await nextTick();
    assert.equal(started, 1);
    assert.equal(limiter.waiting, 1);

    finish[0]();
    await nextTick();
    assert.equal(started, 2);
    assert.equal(limiter.waiting, 0);

    finish[1]();
    await nextTick();
    assert.equal(limiter.running, 0);
  });
});
