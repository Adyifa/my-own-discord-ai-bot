import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Embedder, createEmbeddingProvider } from "../ai/embeddings.js";
import { DEFAULT_PERSONA } from "../ai/persona.js";
import { createChatProvider, type ChatProvider } from "../ai/providers/index.js";
import { EmbeddingIndexer } from "../ai/rag/indexer.js";
import { buildEmbeddingConfig, buildProviderConfig, loadConfig, type AppConfig } from "../config.js";
import { initDatabase } from "../db/database.js";
import { configureLogger } from "../logger.js";
import { loadKnowledgeFiles, loadModerationDataset, loadModerationExamples, loadRagDataset } from "./datasets.js";
import { runModerationEval, type ModerationEvalResult } from "./moderation-eval.js";
import { EVAL_GUILD_ID, ingestKnowledgeFiles, runAnswerEval, runRetrievalEval, type AnswerEvalResult } from "./rag-eval.js";
import { answerReport, moderationReport, retrievalReport } from "./report.js";

const USAGE = `Usage: npm run eval -- <moderation|rag|all> [options]

  --models ollama:qwen3:4b,openai:gpt-5-mini   chat models to compare (default: providers in .env)
  --embed ollama:bge-m3                        embedding model for semantic retrieval (default: .env)
  --limit 20                                   only use the first N dataset items
  --concurrency 2                              parallel requests per model
  --threshold 0.8                              moderation confidence needed to flag
  --retrieval-only                             RAG: skip answer generation (no chat model needed)`;

type Env = Record<string, string | undefined>;

function parseModelSpec(spec: string): { kind: string; model: string } {
  const separator = spec.indexOf(":");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Invalid model "${spec}". Use provider:model, e.g. ollama:qwen3:4b or openai:gpt-5-mini.`);
  }
  return { kind: spec.slice(0, separator), model: spec.slice(separator + 1) };
}

function chatProviders(specs: string | undefined, config: AppConfig, env: Env): ChatProvider[] {
  const configs = specs
    ? specs.split(",").map(spec => spec.trim()).filter(Boolean).map(spec => {
        const { kind, model } = parseModelSpec(spec);
        return buildProviderConfig(kind, env, model);
      })
    : config.ai.providers;
  return configs.flatMap(providerConfig => createChatProvider([providerConfig]) ?? []);
}

function embedderFrom(spec: string | undefined, config: AppConfig, env: Env): Embedder | undefined {
  const embeddingConfig = spec
    ? (() => {
        const { kind, model } = parseModelSpec(spec);
        return buildEmbeddingConfig(kind, env, model);
      })()
    : config.ai.embedding;
  const provider = createEmbeddingProvider(embeddingConfig);
  return provider ? new Embedder(provider, 0) : undefined;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      models: { type: "string" },
      embed: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      threshold: { type: "string" },
      "retrieval-only": { type: "boolean", default: false },
      help: { type: "boolean", default: false }
    }
  });
  const suite = positionals[0] ?? "all";
  if (values.help || !["moderation", "rag", "all"].includes(suite)) {
    console.log(USAGE);
    return;
  }

  configureLogger({ level: "error" });
  const env = process.env;
  const config = loadConfig(env);
  const limit = values.limit ? Number(values.limit) : undefined;
  const concurrency = values.concurrency ? Number(values.concurrency) : 2;
  const take = <T>(items: T[]) => (limit ? items.slice(0, limit) : items);
  const datasets = path.resolve("evals", "datasets");
  const providers = chatProviders(values.models, config, env);
  const embedder = embedderFrom(values.embed, config, env);

  const sections = [`# Carl Lite eval report`, "", `Generated ${new Date().toISOString()}`];
  const json: Record<string, unknown> = {};

  if (suite === "moderation" || suite === "all") {
    if (providers.length === 0) throw new Error("No chat model: pass --models or configure AI_PROVIDER in .env.");
    const items = take(loadModerationDataset(path.join(datasets, "moderation.jsonl")));
    const examplePool = loadModerationExamples(path.join(datasets, "moderation-examples.jsonl"));
    const results: ModerationEvalResult[] = [];
    for (const provider of providers) {
      for (const mode of ["zero-shot", "few-shot"] as const) {
        console.error(`moderation · ${provider.id}:${provider.model} · ${mode} · ${items.length} messages…`);
        results.push(await runModerationEval({
          provider,
          items,
          mode,
          examplePool,
          embedder,
          concurrency,
          threshold: values.threshold ? Number(values.threshold) : undefined
        }));
      }
    }
    sections.push("", moderationReport(results));
    json.moderation = results;
  }

  if (suite === "rag" || suite === "all") {
    initDatabase(":memory:");
    ingestKnowledgeFiles(loadKnowledgeFiles(path.join(datasets, "knowledge")));
    if (embedder) {
      console.error(`rag · embedding knowledge with ${embedder.id}…`);
      await new EmbeddingIndexer(embedder).runOnce();
    }
    const items = take(loadRagDataset(path.join(datasets, "rag.jsonl")));
    const retrieval = await runRetrievalEval({ items, embedder, minSimilarity: config.ai.ragMinSimilarity, guildId: EVAL_GUILD_ID });
    sections.push("", retrievalReport(retrieval));
    json.retrieval = retrieval;

    if (!values["retrieval-only"]) {
      if (providers.length === 0) throw new Error("No chat model: pass --models, configure AI_PROVIDER, or use --retrieval-only.");
      const answers: AnswerEvalResult[] = [];
      for (const provider of providers) {
        console.error(`rag · answers · ${provider.id}:${provider.model} · ${items.length} questions…`);
        answers.push(await runAnswerEval({
          items,
          concurrency,
          runtime: {
            provider,
            embedder,
            persona: DEFAULT_PERSONA,
            settings: { ...config.ai, toolsEnabled: false, learningEnabled: false, visionEnabled: false },
            timezone: config.timezone,
            problems: []
          }
        }));
      }
      sections.push("", answerReport(answers));
      json.answers = answers;
    }
  }

  const report = sections.join("\n");
  console.log(report);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDirectory = path.resolve("evals", "results");
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, `${suite}-${stamp}.md`), `${report}\n`);
  fs.writeFileSync(path.join(outputDirectory, `${suite}-${stamp}.json`), JSON.stringify(json, null, 2));
  console.error(`\nSaved evals/results/${suite}-${stamp}.md (+ .json with every prediction)`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
