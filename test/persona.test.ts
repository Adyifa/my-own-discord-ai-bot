import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PERSONA,
  buildSystemPrompt,
  buildTurnContext,
  detectActiveModes,
  findKnownMember,
  loadPersonaFile,
  parsePersona,
  resolvePersona
} from "../src/ai/persona.js";

const persona = parsePersona({
  name: "Test Bot",
  instructions: ["Be nice."],
  modes: [{ name: "competitive", triggers: ["ranked", "mobile legends"], instructions: ["Be fierce."] }],
  knownMembers: [
    { id: "111111111111111111", name: "Alex", about: "Server owner.", whenSpeaking: "Greet Alex warmly." },
    { username: "Sam_Plays", name: "Sam" }
  ]
});

describe("persona files", () => {
  it("validates persona files with helpful errors", () => {
    assert.throws(() => parsePersona({ name: "x" }), /instructions/);
    assert.throws(
      () => parsePersona({ name: "x", instructions: ["a"], knownMembers: [{ name: "n" }] }),
      /needs an "id" or a "username"/
    );
    assert.throws(
      () => parsePersona({ name: "x", instructions: ["a"], knownMembers: [{ id: "abc", name: "n" }] }),
      /Discord user ID/
    );
  });

  it("ships a valid example persona", () => {
    const example = loadPersonaFile("personas/shy-gamer.example.json");
    assert.ok(example.instructions.length > 0);
    assert.ok(example.modes.length > 0);
  });

  it("falls back to the default persona when the file cannot be used", () => {
    const result = resolvePersona("personas/does-not-exist.json");
    assert.equal(result.persona, DEFAULT_PERSONA);
    assert.match(result.problem ?? "", /cannot read/);
  });
});

describe("prompt building", () => {
  it("layers persona, server context, admin instructions, memory, tools and guardrails", () => {
    const prompt = buildSystemPrompt(persona, {
      serverName: "My <@Server>",
      customInstructions: "No spoilers.",
      memorySummary: "User likes Valorant.",
      toolsEnabled: true
    });
    assert.match(prompt, /^Be nice\./);
    assert.match(prompt, /"My Server"/);
    assert.match(prompt, /- Alex \(<@111111111111111111>\): Server owner\./);
    assert.match(prompt, /- Sam \(@sam_plays\)/);
    assert.match(prompt, /No spoilers\./);
    assert.match(prompt, /User likes Valorant\./);
    assert.match(prompt, /## Tools/);
    assert.match(prompt, /never mention roles, @everyone or @here/);
    assert.doesNotMatch(buildSystemPrompt(persona, { serverName: "s", toolsEnabled: false }), /## Tools/);
  });

  it("tells the model who is speaking, with sanitised names", () => {
    const context = buildTurnContext(persona, {
      speaker: { id: "111111111111111111", username: "alex", displayName: "Alex <@999>" },
      mentionedUsers: [{ id: "222222222222222222", username: "sam_plays", displayName: "Sammy" }],
      activeModes: detectActiveModes(persona, "anyone up for ranked?")
    });
    assert.match(context, /Speaker: Alex 999 \(@alex, <@111111111111111111>\), known to you as Alex\./);
    assert.match(context, /About the speaker: Greet Alex warmly\./);
    assert.match(context, /Sammy \(@sam_plays, <@222222222222222222>\), known to you as Sam/);
    assert.match(context, /Active mode "competitive": Be fierce\./);
  });

  it("matches identities by ID when one is given, otherwise by username", () => {
    assert.equal(findKnownMember(persona, { id: "333333333333333333", username: "alex" }), undefined);
    assert.equal(findKnownMember(persona, { id: "444444444444444444", username: "SAM_PLAYS" })?.name, "Sam");
  });

  it("activates modes on whole-word triggers only", () => {
    assert.equal(detectActiveModes(persona, "main Mobile Legends yuk").length, 1);
    assert.equal(detectActiveModes(persona, "unranked chat").length, 0);
  });
});
