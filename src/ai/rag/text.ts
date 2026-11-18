/** Very common Indonesian, Indonesian-slang and English words that carry no search meaning. */
const STOPWORDS = new Set([
  // Indonesian (formal + Discord slang)
  "yang", "dan", "di", "ke", "dari", "ini", "itu", "untuk", "dengan", "pada", "adalah", "ada", "apa", "atau",
  "juga", "saya", "aku", "kamu", "anda", "kita", "kami", "mereka", "dia", "ia", "nya", "akan", "sudah", "udah",
  "belum", "bisa", "tidak", "tak", "gak", "ga", "nggak", "enggak", "jadi", "kalau", "kalo", "karena", "tapi",
  "tetapi", "saja", "aja", "lagi", "sih", "dong", "deh", "kok", "ya", "yg", "dgn", "utk", "dalam", "oleh",
  "sebagai", "para", "pun", "lah", "kah", "bagaimana", "gimana", "kapan", "dimana", "mana", "siapa", "berapa",
  "kenapa", "mengapa", "apakah", "tolong", "mohon", "bang", "kak", "min", "nih", "tuh", "mau", "ingin", "punya",
  "buat", "bikin", "sama", "lu", "lo", "gue", "gw", "banget", "kayak", "seperti", "bro", "sis",
  // English
  "the", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "at", "for",
  "with", "by", "from", "as", "it", "its", "this", "that", "these", "those", "you", "he", "she", "we", "they",
  "me", "my", "your", "our", "their", "what", "which", "who", "whom", "how", "when", "where", "why", "do",
  "does", "did", "can", "could", "should", "would", "will", "shall", "may", "might", "must", "have", "has",
  "had", "not", "no", "yes", "so", "if", "then", "than", "there", "here", "about", "into", "any", "all",
  "some", "please", "hi", "hello", "im", "dont", "get", "got"
]);

/** Lower-cased, accent-free word tokens without stopwords (used for keyword search). */
export function tokenize(text: string): string[] {
  const words = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter(word => word.length >= 2 && !STOPWORDS.has(word));
}

/** Safe FTS5 query: each term quoted (no operator injection) and OR-ed together. */
export function buildFtsQuery(text: string, maxTerms = 12): string | null {
  const terms = [...new Set(tokenize(text))].slice(0, maxTerms);
  return terms.length > 0 ? terms.map(term => `"${term}"`).join(" OR ") : null;
}

/** Word-overlap similarity between token lists (Ochiai coefficient, 0-1). */
export function overlapScore(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / Math.sqrt(setA.size * setB.size);
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

interface Unit {
  text: string;
  startsParagraph: boolean;
}

/**
 * Splits a document into retrieval chunks of at most `maxChars`, preferring
 * paragraph, line and sentence boundaries. Each chunk repeats the tail of the
 * previous one (`overlapChars`) so facts that straddle a boundary stay findable.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  // ~900 characters fits one topic (a rule, an event, an FAQ answer): small enough to
  // retrieve precisely, big enough to keep the context of the sentences around a fact.
  const maxChars = options.maxChars ?? 900;
  const overlapChars = Math.min(options.overlapChars ?? 150, Math.floor(maxChars / 3));
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];

  // 1. Cut the text into natural units: paragraphs, or for very long paragraphs their
  //    lines, sentences and finally word groups. Units never exceed maxChars.
  const units: Unit[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      units.push({ text: trimmed, startsParagraph: true });
      continue;
    }
    let first = true;
    for (const piece of splitLong(trimmed, maxChars)) {
      units.push({ text: piece, startsParagraph: first });
      first = false;
    }
  }

  // 2. Pack units greedily into chunks: keep adding while the chunk still fits.
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const separator = unit.startsParagraph ? "\n\n" : " ";
    const candidate = current ? `${current}${separator}${unit.text}` : unit.text;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // 3. Start the next chunk with the tail of the previous one (overlap), so a fact
    //    that straddles the boundary is still complete in at least one chunk.
    const overlap = current ? tail(current, overlapChars) : "";
    current = overlap && overlap.length + 1 + unit.text.length <= maxChars ? `${overlap} ${unit.text}` : unit.text;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Breaks an over-long paragraph into lines, then sentences, then word groups. */
function splitLong(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  for (const line of paragraph.split("\n").map(value => value.trim()).filter(Boolean)) {
    if (line.length <= maxChars) {
      pieces.push(line);
      continue;
    }
    const sentences = line.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [line];
    for (const sentence of sentences.map(value => value.trim()).filter(Boolean)) {
      if (sentence.length <= maxChars) pieces.push(sentence);
      else pieces.push(...splitWords(sentence, maxChars));
    }
  }
  return pieces;
}

function splitWords(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of sentence.split(" ")) {
    if (word.length > maxChars) {
      if (current) pieces.push(current);
      for (let start = 0; start < word.length; start += maxChars) pieces.push(word.slice(start, start + maxChars));
      current = "";
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** The last ~`length` characters of a chunk, starting at a word boundary. */
function tail(text: string, length: number): string {
  if (length <= 0) return "";
  const slice = text.slice(-length);
  const firstBreak = slice.search(/\s/);
  return (firstBreak > 0 ? slice.slice(firstBreak + 1) : slice).trim();
}
