import type { MessageReaction, PartialMessageReaction, PartialUser, User } from "discord.js";
import { findReactionRole } from "../db/reaction-roles.js";
import { describeError, logger } from "../logger.js";

/** Custom emoji are stored by ID (`<:name:123>` → `123`), Unicode emoji as-is. */
export function emojiKey(input: string): string {
  const trimmed = input.trim();
  return trimmed.match(/^<a?:\w+:(\d+)>$/)?.[1] ?? trimmed;
}

export async function applyReactionRole(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  add: boolean
): Promise<void> {
  if (user.bot) return;
  if (reaction.partial) {
    const fetched = await reaction.fetch().catch(() => null);
    if (!fetched) return;
  }

  const guild = reaction.message.guild;
  const key = reaction.emoji.id ?? reaction.emoji.name;
  if (!guild || !key) return;

  const binding = findReactionRole(guild.id, reaction.message.id, key);
  if (!binding) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    if (add) await member.roles.add(binding.roleId, "Reaction role");
    else await member.roles.remove(binding.roleId, "Reaction role removed");
  } catch (error) {
    logger.warn("reaction_role.update_failed", { guildId: guild.id, roleId: binding.roleId, ...describeError(error) });
  }
}
