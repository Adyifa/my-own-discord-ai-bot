import fs from "node:fs";
import path from "node:path";
import { MODERATION_CATEGORIES, type ModerationCategory } from "../ai/moderation.js";
import { isRecord } from "../utils/text.js";

export interface ModerationEvalItem {
  id: string;
  text: string;
  flagged: boolean;
  category: ModerationCategory;
  /** "server_norms" items depend on this community's own rules, not on general guidelines. */
  group: "general" | "server_norms";
}

/** A simulated past moderator decision (the "learning" pool). */
export interface ModerationExampleItem {
  text: string;
  flagged: boolean;
  category: ModerationCategory;
}

export interface RagEvalItem {
  id: string;
  question: string;
  /** Title of the document that answers the question. */
  expectedDocument: string;
  /** Every entry must appear in the answer; "a|b" accepts either alternative. */
  mustInclude: string[];
}

export interface KnowledgeFile {
  title: string;
  fileName: string;
  content: string;
}

export function readJsonl(filePath: string): unknown[] {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${path.basename(filePath)}:${number} is not valid JSON`);
      }
    });
}

function category(value: unknown, where: string): ModerationCategory {
  if (typeof value === "string" && (MODERATION_CATEGORIES as readonly string[]).includes(value)) {
    return value as ModerationCategory;
  }
  throw new Error(`${where}: unknown category ${JSON.stringify(value)}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
  return value;
}

export function loadModerationDataset(filePath: string): ModerationEvalItem[] {
  return readJsonl(filePath).map((row, index) => {
    const where = `${path.basename(filePath)} row ${index + 1}`;
    if (!isRecord(row) || typeof row.flagged !== "boolean") throw new Error(`${where}: needs "flagged": boolean`);
    const item: ModerationEvalItem = {
      id: text(row.id, `${where}.id`),
      text: text(row.text, `${where}.text`),
      flagged: row.flagged,
      category: category(row.category, where),
      group: row.group === "server_norms" ? "server_norms" : "general"
    };
    if (item.flagged === (item.category === "none")) throw new Error(`${where}: "flagged" contradicts category "${item.category}"`);
    return item;
  });
}

export function loadModerationExamples(filePath: string): ModerationExampleItem[] {
  return readJsonl(filePath).map((row, index) => {
    const where = `${path.basename(filePath)} row ${index + 1}`;
    if (!isRecord(row) || typeof row.flagged !== "boolean") throw new Error(`${where}: needs "flagged": boolean`);
    return { text: text(row.text, `${where}.text`), flagged: row.flagged, category: category(row.category, where) };
  });
}

export function loadRagDataset(filePath: string): RagEvalItem[] {
  return readJsonl(filePath).map((row, index) => {
    const where = `${path.basename(filePath)} row ${index + 1}`;
    if (!isRecord(row) || !Array.isArray(row.mustInclude)) throw new Error(`${where}: needs "mustInclude": string[]`);
    return {
      id: text(row.id, `${where}.id`),
      question: text(row.question, `${where}.question`),
      expectedDocument: text(row.expectedDocument, `${where}.expectedDocument`),
      mustInclude: row.mustInclude.map((entry, position) => text(entry, `${where}.mustInclude[${position}]`))
    };
  });
}

/** Markdown/text files; the title is the first "# heading", otherwise the file name. */
export function loadKnowledgeFiles(directory: string): KnowledgeFile[] {
  return fs.readdirSync(directory)
    .filter(fileName => /\.(md|txt)$/i.test(fileName))
    .sort()
    .map(fileName => {
      const content = fs.readFileSync(path.join(directory, fileName), "utf8");
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fileName.replace(/\.(md|txt)$/i, "");
      return { title, fileName, content };
    });
}
