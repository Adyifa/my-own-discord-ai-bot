/** Shortens text to `maxLength` code points, adding an ellipsis when it had to cut. */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const codePoints = Array.from(text);
  if (codePoints.length <= maxLength) return text;
  return `${codePoints.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}…`;
}

/**
 * Neutralises user-controlled labels (display names, usernames, channel names)
 * before they are placed inside a prompt, so they cannot fake mentions or
 * break out of the surrounding structure.
 */
export function sanitizeLabel(value: string, maxLength = 80): string {
  const cleaned = value.replace(/[\r\n<>@`]/g, " ").replace(/\s+/g, " ").trim();
  return truncate(cleaned, maxLength) || "unknown";
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a case-insensitive, Unicode-aware pattern that matches any of the
 * terms as whole words ("ass" does not match "class"). With `allowWildcard`,
 * a trailing `*` matches any word ending ("spam*" matches "spammer").
 */
export function wholeWordPattern(
  terms: readonly string[],
  options: { allowWildcard?: boolean } = {}
): RegExp | null {
  const parts = terms
    .map(term => term.trim())
    .filter(term => term.length > 0 && term !== "*")
    .map(term => options.allowWildcard && term.endsWith("*")
      ? `${escapeRegExp(term.slice(0, -1))}[\\p{L}\\p{N}_]*`
      : escapeRegExp(term));
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses SQLite's CURRENT_TIMESTAMP format ("YYYY-MM-DD HH:MM:SS", always UTC). */
export function parseSqliteTimestamp(value: string): Date | null {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Matches a raw snowflake (`123…`) or a user mention (`<@123…>` / `<@!123…>`). */
export function extractUserId(input: string): string | undefined {
  const trimmed = input.trim();
  return trimmed.match(/^<@!?(\d{15,22})>$/)?.[1] ?? (/^\d{15,22}$/.test(trimmed) ? trimmed : undefined);
}
