import type { ChatProvider, ChatRequest, ChatResponse, ProviderHealth } from "../../src/ai/providers/index.js";

type ScriptStep = Partial<ChatResponse> | Error | ((request: ChatRequest) => Partial<ChatResponse>);

/** A provider that replays scripted responses and records every request it receives. */
export class ScriptedProvider implements ChatProvider {
  readonly model = "fake-model";
  readonly requests: ChatRequest[] = [];
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[], readonly id = "fake") {
    this.script = [...script];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Copy the message list: the agent keeps appending to the same array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedProvider ran out of responses");
    if (step instanceof Error) throw step;
    const partial = typeof step === "function" ? step(request) : step;
    return {
      content: "",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: this.id,
      model: this.model,
      ...partial
    };
  }

  async checkHealth(): Promise<ProviderHealth[]> {
    return [{ provider: this.id, model: this.model, state: "ready" }];
  }
}
