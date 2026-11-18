import type { MessageMentionOptions } from "discord.js";

export const DISCORD_MESSAGE_LIMIT = 2_000;

function codePointBoundary(value: string, maximumLength: number): number {
  let length = 0;
  for (const codePoint of value) {
    if (length + codePoint.length > maximumLength) break;
    length += codePoint.length;
  }
  return length;
}

/**
 * Splits a long answer into Discord-sized chunks, preferring to break on a
 * newline, then on whitespace, and never inside a surrogate pair (emoji).
 */
export function splitDiscordMessage(
  content: string,
  maximumLength = DISCORD_MESSAGE_LIMIT
): string[] {
  if (maximumLength < 1) throw new Error("maximumLength must be positive");

  const chunks: string[] = [];
  let remaining = content.trim();

  while (remaining.length > maximumLength) {
    const safeBoundary = codePointBoundary(remaining, maximumLength);
    const candidate = remaining.slice(0, safeBoundary);
    const minimumPreferred = Math.floor(maximumLength * 0.4);
    const newlineBoundary = candidate.lastIndexOf("\n");
    const whitespaceBoundary = candidate.search(/\s+\S*$/);
    const preferredBoundary = newlineBoundary >= minimumPreferred
      ? newlineBoundary
      : whitespaceBoundary >= minimumPreferred
        ? whitespaceBoundary
        : safeBoundary;

    const chunk = remaining.slice(0, preferredBoundary).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(preferredBoundary).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Appends a small grey "-# subtext" line (Discord markdown) when provided. */
export function withSubtext(content: string, subtext: string | undefined): string {
  return subtext ? `${content}\n-# ${subtext}` : content;
}

/**
 * Only lets the bot ping users from an explicit allow-list, and only when the
 * mention really appears in the content. Roles, @everyone and @here never ping.
 */
export function allowedMentionsFor(
  content: string,
  allowedUserIds: Iterable<string>
): MessageMentionOptions {
  const users = [...new Set(allowedUserIds)]
    .filter(id => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`))
    .slice(0, 100);
  return { parse: [], users, repliedUser: false };
}
