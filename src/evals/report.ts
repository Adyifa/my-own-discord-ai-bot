import type { ModerationEvalResult } from "./moderation-eval.js";
import type { AnswerEvalResult, RetrievalEvalResult } from "./rag-eval.js";

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const label = (provider: string, model: string) => `\`${provider}:${model}\``;

export function moderationReport(results: readonly ModerationEvalResult[]): string {
  const lines = [
    "## AI moderation",
    "",
    `Binary task: should the message be flagged (confidence ≥ ${results[0]?.threshold ?? 0.8})? ` +
      "\"Server norms\" are messages whose verdict depends on this community's own rules.",
    "",
    "| Model | Mode | Accuracy | Precision | Recall | F1 | Server-norm accuracy | Category accuracy | Unparseable | Avg / p95 latency | Tokens in / out |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map(result =>
      `| ${label(result.provider, result.model)} | ${result.mode} | ${pct(result.overall.accuracy)} | ${pct(result.overall.precision)} | ` +
      `${pct(result.overall.recall)} | **${pct(result.overall.f1)}** | ${pct(result.serverNorms.accuracy)} | ` +
      `${pct(result.categoryAccuracy)} | ${result.unparseable + result.errors} | ${result.avgLatencyMs} / ${result.p95LatencyMs} ms | ` +
      `${result.inputTokens} / ${result.outputTokens} |`)
  ];

  const effects = learningEffects(results);
  if (effects.length > 0) lines.push("", "**Effect of learning from moderator decisions (few-shot vs zero-shot):**", "", ...effects);

  for (const result of results) {
    const mistakes = result.predictions.filter(prediction => prediction.expected !== prediction.predicted).slice(0, 8);
    if (mistakes.length === 0) continue;
    lines.push(
      "",
      `<details><summary>Errors — ${result.model} (${result.mode})</summary>`,
      "",
      ...mistakes.map(prediction =>
        `- \`${prediction.id}\` expected **${prediction.expected ? prediction.expectedCategory : "fine"}**, got ` +
        `**${prediction.predicted ? prediction.predictedCategory : "fine"}** (${prediction.outcome}, confidence ${prediction.confidence.toFixed(2)}): ` +
        `${prediction.text.replace(/\s+/g, " ").slice(0, 90)}`),
      "",
      "</details>"
    );
  }
  return lines.join("\n");
}

function learningEffects(results: readonly ModerationEvalResult[]): string[] {
  const effects: string[] = [];
  for (const zeroShot of results.filter(result => result.mode === "zero-shot")) {
    const fewShot = results.find(result =>
      result.mode === "few-shot" && result.provider === zeroShot.provider && result.model === zeroShot.model);
    if (!fewShot) continue;
    const delta = (after: number, before: number) => `${after >= before ? "+" : ""}${((after - before) * 100).toFixed(1)} pts`;
    effects.push(
      `- ${label(zeroShot.provider, zeroShot.model)}: F1 ${pct(zeroShot.overall.f1)} → ${pct(fewShot.overall.f1)} ` +
      `(${delta(fewShot.overall.f1, zeroShot.overall.f1)}), server-norm accuracy ${pct(zeroShot.serverNorms.accuracy)} → ` +
      `${pct(fewShot.serverNorms.accuracy)} (${delta(fewShot.serverNorms.accuracy, zeroShot.serverNorms.accuracy)})`
    );
  }
  return effects;
}

export function retrievalReport(results: readonly RetrievalEvalResult[]): string {
  return [
    "## Knowledge retrieval (RAG)",
    "",
    "Is the document that answers the question retrieved first (Hit@1) or in the top 3 (Hit@3)?",
    "",
    "| Retrieval | Embedding model | Hit@1 | Hit@3 | MRR |",
    "|---|---|---|---|---|",
    ...results.map(result =>
      `| ${result.mode} | ${result.embeddingModel ? `\`${result.embeddingModel}\`` : "—"} | ${pct(result.hitAt1)} | ` +
      `**${pct(result.hitAt3)}** | ${result.mrr.toFixed(3)} |`)
  ].join("\n");
}

export function answerReport(results: readonly AnswerEvalResult[]): string {
  return [
    "## Grounded answers (full RAG pipeline)",
    "",
    "Answer accuracy = every required fact is present; citation rate = the answer cites the right document.",
    "",
    "| Model | Answer accuracy | Citation rate | Errors | Avg latency |",
    "|---|---|---|---|---|",
    ...results.map(result =>
      `| ${label(result.provider, result.model)} | **${pct(result.accuracy)}** | ${pct(result.citationRate)} | ${result.errors} | ${result.avgLatencyMs} ms |`)
  ].join("\n");
}
