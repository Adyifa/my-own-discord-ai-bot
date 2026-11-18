import "./helpers/quiet-logs.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolInputError, runAgent, type AgentTool } from "../src/ai/agent.js";
import { ScriptedProvider } from "./helpers/fake-provider.js";

interface Context {
  calls: string[];
}

const echoTool: AgentTool<Context> = {
  label: "echo",
  definition: {
    name: "echo",
    description: "Echo some text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
  },
  async execute(args, context) {
    context.calls.push(String(args.text));
    if (args.text === "bad") throw new ToolInputError("text must not be bad");
    if (args.text === "crash") throw new Error("boom");
    return { echoed: args.text };
  }
};

const ask = (content: string) => [{ role: "user" as const, content }];

describe("runAgent", () => {
  it("answers directly when no tool is needed", async () => {
    const provider = new ScriptedProvider([{ content: "  Hello!  " }]);
    const result = await runAgent({ provider, messages: ask("hi"), tools: [echoTool], context: { calls: [] } });
    assert.equal(result.text, "Hello!");
    assert.equal(result.steps, 1);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(provider.requests[0].tools?.[0].name, "echo");
  });

  it("executes tool calls and feeds the results back to the model", async () => {
    const context: Context = { calls: [] };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "echo", arguments: { text: "ping" } }] },
      { content: "The tool said ping." }
    ]);
    const result = await runAgent({ provider, messages: ask("use the tool"), tools: [echoTool], context });

    assert.deepEqual(context.calls, ["ping"]);
    assert.equal(result.text, "The tool said ping.");
    assert.deepEqual(result.toolCalls.map(call => [call.name, call.ok]), [["echo", true]]);
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });

    const followUp = provider.requests[1].messages;
    assert.deepEqual(followUp.at(-2), {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "echo", arguments: { text: "ping" } }]
    });
    assert.deepEqual(followUp.at(-1), {
      role: "tool",
      toolCallId: "c1",
      toolName: "echo",
      content: "{\"echoed\":\"ping\"}"
    });
  });

  it("returns tool errors to the model instead of failing the whole turn", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "a", name: "echo", arguments: { text: "bad" } },
          { id: "b", name: "echo", arguments: { text: "crash" } },
          { id: "c", name: "missing_tool", arguments: {} }
        ]
      },
      { content: "Sorry, I could not look that up." }
    ]);
    const result = await runAgent({ provider, messages: ask("x"), tools: [echoTool], context: { calls: [] } });

    const errors = provider.requests[1].messages
      .flatMap(message => message.role === "tool" ? [JSON.parse(message.content).error as string] : []);
    assert.deepEqual(errors, [
      "text must not be bad",
      "The tool failed. Answer without it, or tell the user you could not look it up.",
      "Unknown tool \"missing_tool\"."
    ]);
    assert.deepEqual(result.toolCalls.map(call => call.ok), [false, false, false]);
    assert.equal(result.text, "Sorry, I could not look that up.");
  });

  it("forces a final text answer when the step budget runs out", async () => {
    const again = { toolCalls: [{ id: "x", name: "echo", arguments: { text: "again" } }] };
    const provider = new ScriptedProvider([again, again, { content: "Final answer." }]);
    const result = await runAgent({ provider, messages: ask("x"), tools: [echoTool], context: { calls: [] }, maxSteps: 3 });

    assert.equal(result.text, "Final answer.");
    assert.equal(result.steps, 3);
    assert.equal(provider.requests[2].tools, undefined);
    assert.ok(provider.requests[2].messages.some(message =>
      message.role === "system" && /used all tool calls/.test(message.content)));
  });

  it("times out tools that hang", async () => {
    const hangingTool: AgentTool<Context> = {
      ...echoTool,
      label: "hang",
      definition: { ...echoTool.definition, name: "hang" },
      execute: () => new Promise(() => undefined)
    };
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "h", name: "hang", arguments: {} }] },
      { content: "ok" }
    ]);
    const result = await runAgent({
      provider,
      messages: ask("x"),
      tools: [hangingTool],
      context: { calls: [] },
      toolTimeoutMs: 20
    });
    assert.equal(result.toolCalls[0].ok, false);
    assert.equal(result.text, "ok");
  });
});
