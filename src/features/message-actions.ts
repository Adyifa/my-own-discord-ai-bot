import type { GuildTextBasedChannel, Message } from "discord.js";

const NOTICE_LIFETIME_MS = 5_000;

/**
 * Deletes a message and posts a short notice to its author that removes
 * itself after a few seconds. Returns whether the message was deleted.
 */
export async function removeWithNotice(message: Message<true>, reason: string): Promise<boolean> {
  const deleted = await message.delete().then(() => true, () => false);
  if (!deleted) return false;

  const notice = await message.channel.send({
    content: `${message.author}, your message was removed: **${reason}**.`,
    allowedMentions: { users: [message.author.id] }
  }).catch(() => null);
  if (notice) setTimeout(() => void notice.delete().catch(() => undefined), NOTICE_LIFETIME_MS);
  return true;
}

/** Threads inherit the NSFW flag from their parent channel. */
export function isNsfwChannel(channel: GuildTextBasedChannel): boolean {
  if (channel.isThread()) return Boolean(channel.parent && "nsfw" in channel.parent && channel.parent.nsfw);
  return "nsfw" in channel && channel.nsfw;
}
