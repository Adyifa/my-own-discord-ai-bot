import type { Guild, GuildTextBasedChannel, User } from "discord.js";
import type { ChatTurnInput } from "../../src/ai/chat.js";
import { parsePersona } from "../../src/ai/persona.js";
import type { ChatProvider } from "../../src/ai/providers/index.js";
import type { AiRuntime } from "../../src/ai/runtime.js";
import type { AiSettings } from "../../src/config.js";

export const AUTHOR_ID = "111111111111111111";
export const OWNER_ID = "999999999999999999";

/** Minimal stand-ins for the discord.js objects the chat pipeline reads. */
export function chatInput(overrides: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    guild: { id: "g1", name: "Test Server", members: { me: null } } as unknown as Guild,
    channel: { id: "c1", name: "general" } as unknown as GuildTextBasedChannel,
    author: { id: AUTHOR_ID, username: "alex", globalName: "Alex" } as unknown as User,
    member: null,
    prompt: "hello",
    mentionedUsers: [],
    ...overrides
  };
}

export function testSettings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    providers: [],
    maxOutputTokens: 512,
    toolsEnabled: true,
    visionEnabled: true,
    learningEnabled: true,
    ragMinSimilarity: 0.45,
    ...overrides
  };
}

export function testRuntime(provider: ChatProvider | undefined, overrides: Partial<AiRuntime> = {}): AiRuntime {
  return {
    provider,
    persona: parsePersona({
      name: "Bot",
      instructions: ["You are Bot."],
      knownMembers: [{ id: OWNER_ID, name: "Owner" }]
    }),
    settings: testSettings(),
    timezone: "Asia/Jakarta",
    problems: [],
    ...overrides
  };
}
