import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSummaryMessages, buildTranscript } from "../src/ai/summarize.js";

const at = (iso: string) => new Date(iso);

describe("buildTranscript", () => {
  it("renders lines in the server time zone, marks bots and skips empty lines", () => {
    const transcript = buildTranscript([
      { author: "Alex", content: "hello   world", timestamp: at("2026-01-01T01:05:00Z"), isBot: false },
      { author: "Carl", content: "hi!", timestamp: at("2026-01-01T01:06:00Z"), isBot: true },
      { author: "Empty", content: "   ", timestamp: at("2026-01-01T01:07:00Z"), isBot: false }
    ], { timezone: "Asia/Jakarta" });
    assert.equal(transcript, "[08:05] Alex: hello world\n[08:06] Carl (bot): hi!");
  });

  it("keeps the most recent lines that fit the character budget", () => {
    const lines = Array.from({ length: 50 }, (_, index) => ({
      author: "u",
      content: `message ${index}`,
      timestamp: at("2026-01-01T00:00:00Z"),
      isBot: false
    }));
    const transcript = buildTranscript(lines, { timezone: "UTC", maxCharacters: 100 });
    assert.ok(transcript.length <= 100);
    assert.match(transcript, /message 49$/);
    assert.doesNotMatch(transcript, /message 0\b/);
  });
});

describe("buildSummaryMessages", () => {
  it("treats the transcript as untrusted data", () => {
    const [system, user] = buildSummaryMessages("general", "[10:00] a: hi");
    assert.match(system.content, /untrusted/);
    assert.match(user.content, /Channel: #general/);
  });
});
