import { PermissionFlagsBits, type Message } from "discord.js";
import type { AiRuntime } from "../ai/runtime.js";
import { getGuildConfig } from "../db/guild-config.js";
import { truncate, wholeWordPattern } from "../utils/text.js";
import { scheduleAiModeration } from "./ai-moderation.js";
import { removeWithNotice } from "./message-actions.js";
import { LogColor, sendLog } from "./server-log.js";

export type RuleViolation = "link" | "blocked_word" | "caps" | "spam";

export const VIOLATION_LABELS: Record<RuleViolation, string> = {
  link: "Links are not allowed",
  blocked_word: "Blocked word",
  caps: "Excessive uppercase",
  spam: "Spam detected"
};

export interface ContentRules {
  antiLink: boolean;
  capsPercent: number;
  blockedWords: RegExp | null;
}

const LINK_PATTERN = /(https?:\/\/|discord\.gg\/|www\.)\S+/i;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const URL_PATTERN = /https?:\/\/\S+/g;
const MIN_LETTERS_FOR_CAPS = 10;

/** Pure rule check (no Discord calls), so it is easy to unit test. */
export function checkContent(content: string, rules: ContentRules): RuleViolation | null {
  if (rules.antiLink && LINK_PATTERN.test(content)) return "link";
  if (rules.blockedWords?.test(content)) return "blocked_word";

  if (rules.capsPercent > 0) {
    const letters = content.replace(CUSTOM_EMOJI, "").replace(URL_PATTERN, "").replace(/[^a-z]/gi, "");
    if (letters.length >= MIN_LETTERS_FOR_CAPS) {
      const upper = letters.replace(/[^A-Z]/g, "").length;
      if ((upper / letters.length) * 100 >= rules.capsPercent) return "caps";
    }
  }
  return null;
}

/** Sliding-window message counter per user (default: 6 messages in 5 seconds). */
export class SpamTracker {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 5_000,
    private readonly threshold = 6
  ) {}

  /** Records one message and returns true when the user is over the limit. */
  record(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(time => now - time < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) this.prune(now);
    return recent.length >= this.threshold;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every(time => now - time >= this.windowMs)) this.hits.delete(key);
    }
  }
}

const blockedWordPatterns = new Map<string, RegExp | null>();

/** Compiles the comma-separated list once and caches it ("word*" matches word endings). */
export function compileBlockedWords(list: string): RegExp | null {
  if (!blockedWordPatterns.has(list)) {
    if (blockedWordPatterns.size > 500) blockedWordPatterns.clear();
    blockedWordPatterns.set(list, wholeWordPattern(list.split(","), { allowWildcard: true }));
  }
  return blockedWordPatterns.get(list) ?? null;
}

const spamTracker = new SpamTracker();

/**
 * Runs the cheap rule-based checks first. Clean messages are then handed to
 * the (optional, asynchronous) AI moderation. Returns true when the message
 * broke a rule, so the AI chat does not answer it.
 */
export async function runAutomod(message: Message<true>, runtime: AiRuntime): Promise<boolean> {
  if (message.author.bot || !message.member) return false;
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  const config = getGuildConfig(message.guildId);
  const violation = checkContent(message.content, {
    antiLink: config.antiLink,
    capsPercent: config.capsPercent,
    blockedWords: compileBlockedWords(config.badWords)
  }) ?? (config.antiSpam && spamTracker.record(`${message.guildId}:${message.author.id}`) ? "spam" : null);

  if (!violation) {
    scheduleAiModeration(message, config, runtime);
    return false;
  }

  const removed = await removeWithNotice(message, VIOLATION_LABELS[violation]);
  await sendLog(message.guild, {
    title: `AutoMod · ${VIOLATION_LABELS[violation]}`,
    color: LogColor.danger,
    fields: [
      { name: "Author", value: `${message.author} (${message.author.tag})`, inline: true },
      { name: "Channel", value: `${message.channel}`, inline: true },
      { name: "Action", value: removed ? "Message deleted" : "Could not delete (missing permission?)", inline: true },
      { name: "Content", value: truncate(message.content || "*No text content*", 1_000) }
    ]
  });
  return true;
}
