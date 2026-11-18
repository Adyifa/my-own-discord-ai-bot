import type { ProviderConfig } from "../../config.js";
import { FallbackProvider } from "./fallback.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ChatProvider } from "./types.js";

export * from "./types.js";
export { FallbackProvider } from "./fallback.js";
export { OllamaProvider } from "./ollama.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";

/** Builds the provider chain from config: one provider, or a fallback chain of several. */
export function createChatProvider(configs: readonly ProviderConfig[]): ChatProvider | undefined {
  const providers = configs.map(config =>
    config.kind === "ollama" ? new OllamaProvider(config) : new OpenAICompatibleProvider(config)
  );
  if (providers.length === 0) return undefined;
  return providers.length === 1 ? providers[0] : new FallbackProvider(providers);
}
