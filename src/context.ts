import type { AiRuntime } from "./ai/runtime.js";
import type { AppConfig } from "./config.js";

/** Dependencies shared by event handlers and slash commands. */
export interface AppContext {
  config: AppConfig;
  ai: AiRuntime;
}
