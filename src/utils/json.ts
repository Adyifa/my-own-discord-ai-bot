/** Pulls the outermost {...} object out of model output that may include code fences or prose. */
export function extractJsonObject(text: string): string | null {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : null;
}

/** Parses the first JSON object in `text`, or returns undefined if there is none. */
export function parseJsonObject(text: string): unknown {
  const json = extractJsonObject(text);
  if (!json) return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
