import { describeError, logger } from "../logger.js";
import { truncate } from "../utils/text.js";
import { AiError } from "./errors.js";
import {
  addUsage,
  emptyUsage,
  type ChatMessage,
  type ChatProvider,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition
} from "./providers/index.js";

export interface AgentTool<TContext> {
  definition: ToolDefinition;
  /** Short human-readable label shown under answers, e.g. "server info". */
  label: string;
  execute(args: Record<string, unknown>, context: TContext): Promise<unknown>;
}

/** Thrown by a tool for invalid arguments; the message is returned to the model so it can retry. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface AgentOptions<TContext> {
  provider: ChatProvider;
  messages: ChatMessage[];
  tools?: readonly AgentTool<TContext>[];
  context: TContext;
  /** Maximum model calls; the last one is made without tools so the model must answer. */
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  toolTimeoutMs?: number;
}

export interface ToolCallRecord {
  name: string;
  label: string;
  ok: boolean;
  durationMs: number;
}

export interface AgentResult {
  text: string;
  toolCalls: ToolCallRecord[];
  usage: TokenUsage;
  provider: string;
  model: string;
  steps: number;
}

const DEFAULT_MAX_STEPS = 4;
const MAX_CALLS_PER_STEP = 4;
const MAX_TOOL_RESULT_CHARACTERS = 6_000;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

/**
 * A small tool-calling loop: the model can call tools, read their results and
 * call more, until it answers in plain text or runs out of steps.
 *
 * Each step:
 *   1. send the conversation plus the tool definitions to the model;
 *   2. if it answers in text, that is the reply;
 *   3. if it asks for tools, run them, append the results and repeat.
 * The last step is sent without tools, so the model is forced to answer.
 */
export async function runAgent<TContext>(options: AgentOptions<TContext>): Promise<AgentResult> {
  // Work on a copy so the caller's message list is never modified.
  const messages = [...options.messages];
  const tools = options.tools ?? [];
  // Lets us find the implementation for a tool name the model asks for.
  const toolsByName = new Map(tools.map(tool => [tool.definition.name, tool]));
  // Only the JSON-schema descriptions are sent to the model, never the code.
  const definitions = tools.map(tool => tool.definition);
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const usage = emptyUsage();
  const toolCalls: ToolCallRecord[] = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    const finalStep = step === maxSteps;

    // 1. Ask the model. On the final step tools are withheld, so it has to reply in text.
    const response = await options.provider.chat({
      messages,
      tools: finalStep || definitions.length === 0 ? undefined : definitions,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature
    });
    // Tokens are summed over all steps, so usage tracking shows the real cost of one answer.
    addUsage(usage, response.usage);

    // 2. A plain-text reply ends the loop (so does reaching the step budget).
    if (response.toolCalls.length === 0 || finalStep) {
      const text = response.content.trim();
      if (!text) {
        throw new AiError("EMPTY_RESPONSE", "The model finished without a text answer", {
          provider: response.provider
        });
      }
      return { text, toolCalls, usage, provider: response.provider, model: response.model, steps: step };
    }

    // 3. The model wants tools. Cap the calls per step so a confused model cannot run dozens.
    const calls = response.toolCalls.slice(0, MAX_CALLS_PER_STEP);
    // The assistant's tool request must be in the history before the results,
    // otherwise providers reject the conversation as malformed.
    messages.push({ role: "assistant", content: response.content, toolCalls: calls });

    for (const call of calls) {
      const tool = toolsByName.get(call.name);
      const outcome = await executeTool(tool, call, options.context, options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
      toolCalls.push({ name: call.name, label: tool?.label ?? call.name, ok: outcome.ok, durationMs: outcome.durationMs });
      // Each result goes back as a "tool" message, linked to the request by its call ID.
      messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: outcome.output });
    }

    // One step before the end, tell the model to wrap up instead of starting new lookups.
    if (step + 1 === maxSteps) {
      messages.push({
        role: "system",
        content: "You have used all tool calls for this message. Answer the user now with the information you have."
      });
    }
  }

  // Unreachable: the final step always returns or throws.
  throw new AiError("UNKNOWN", "Agent loop ended without an answer");
}

async function executeTool<TContext>(
  tool: AgentTool<TContext> | undefined,
  call: ToolCall,
  context: TContext,
  timeoutMs: number
): Promise<{ ok: boolean; output: string; durationMs: number }> {
  const started = Date.now();
  // The model may invent a tool name; it gets an error it can read instead of a crash.
  if (!tool) {
    return { ok: false, output: JSON.stringify({ error: `Unknown tool "${call.name}".` }), durationMs: 0 };
  }

  try {
    // Every tool has a deadline, so one slow Discord API call cannot hang the whole answer.
    const result = await withTimeout(tool.execute(call.arguments, context), timeoutMs);
    const output = typeof result === "string" ? result : JSON.stringify(result);
    // Large results are truncated so they cannot overflow the model's context window.
    return { ok: true, output: truncate(output, MAX_TOOL_RESULT_CHARACTERS), durationMs: Date.now() - started };
  } catch (error) {
    // Failures are returned to the model as data instead of failing the turn: it can
    // retry with better arguments (ToolInputError) or answer without the tool.
    const message = error instanceof ToolInputError
      ? error.message
      : "The tool failed. Answer without it, or tell the user you could not look it up.";
    if (!(error instanceof ToolInputError)) {
      logger.warn("ai.tool_failed", { tool: call.name, ...describeError(error) });
    }
    return { ok: false, output: JSON.stringify({ error: message }), durationMs: Date.now() - started };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
