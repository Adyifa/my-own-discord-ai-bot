import { Client, Events, GatewayIntentBits, Partials, type ClientEvents } from "discord.js";
import { handleAiMessage } from "./ai/chat-handler.js";
import { handleInteraction } from "./commands/index.js";
import type { AppContext } from "./context.js";
import { runAutomod } from "./features/automod.js";
import { applyReactionRole } from "./features/reaction-roles.js";
import { logMemberLeft, logMessageDeleted, logMessageEdited } from "./features/server-log.js";
import { welcomeMember } from "./features/welcome.js";
import { describeError, logger } from "./logger.js";

export function createBot(context: AppContext): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
  });

  client.once(Events.ClientReady, ready => {
    logger.info("bot.ready", {
      user: ready.user.tag,
      guilds: ready.guilds.cache.size,
      ai: context.ai.provider ? `${context.ai.provider.id} (${context.ai.provider.model})` : "off",
      persona: context.ai.persona.name
    });
  });

  on(client, Events.InteractionCreate, interaction => handleInteraction(interaction, context));

  // Rule-based AutoMod runs first; only clean messages reach the AI assistant.
  on(client, Events.MessageCreate, async message => {
    if (!message.inGuild() || message.author.bot) return;
    const removed = await runAutomod(message, context.ai);
    if (!removed) await handleAiMessage(message, context.ai);
  });

  on(client, Events.GuildMemberAdd, welcomeMember);
  on(client, Events.GuildMemberRemove, logMemberLeft);
  on(client, Events.MessageDelete, logMessageDeleted);
  on(client, Events.MessageUpdate, logMessageEdited);
  on(client, Events.MessageReactionAdd, (reaction, user) => applyReactionRole(reaction, user, true));
  on(client, Events.MessageReactionRemove, (reaction, user) => applyReactionRole(reaction, user, false));

  client.on(Events.Error, error => logger.error("discord.client_error", describeError(error)));
  client.on(Events.Warn, message => logger.warn("discord.client_warning", { message }));

  return client;
}

/** Subscribes an async handler; failures are logged instead of becoming unhandled rejections. */
function on<Event extends keyof ClientEvents>(
  client: Client,
  event: Event,
  handler: (...args: ClientEvents[Event]) => unknown
): void {
  client.on(event, (...args: ClientEvents[Event]) => {
    Promise.resolve()
      .then(() => handler(...args))
      .catch(error => logger.error("event.handler_failed", { event: String(event), ...describeError(error) }));
  });
}
