import {
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel
} from "discord.js";
import { listWarnings } from "../db/warnings.js";
import { extractUserId, truncate } from "../utils/text.js";
import { ToolInputError, type AgentTool } from "./agent.js";
import type { CitationRegistry } from "./rag/citations.js";
import type { KnowledgeHit } from "./rag/knowledge.js";

/** Lets the agent search the knowledge base itself (e.g. with a reformulated query). */
export interface KnowledgeToolAccess {
  search(query: string): Promise<KnowledgeHit[]>;
  citations: CitationRegistry;
}

export interface DiscordToolContext {
  guild: Guild;
  channel: GuildTextBasedChannel;
  /** The member asking; tool access is decided from their permissions. */
  requester: GuildMember | null;
  timezone: string;
  /** The message that triggered the request, excluded from "recent messages". */
  triggerMessageId?: string;
  /** Present when the server has a knowledge base. */
  knowledge?: KnowledgeToolAccess;
}

type DiscordTool = AgentTool<DiscordToolContext>;

const currentTime: DiscordTool = {
  label: "clock",
  definition: {
    name: "get_current_time",
    description: "Get the current date and time. Use it for questions about today, the time or the day of the week.",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "Optional IANA time zone such as Asia/Jakarta. Defaults to the server's time zone."
        }
      }
    }
  },
  async execute(args, context) {
    const timezone = optionalString(args, "timezone", 64) ?? context.timezone;
    const now = new Date();
    try {
      const formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long"
      }).format(now);
      return { timezone, iso: now.toISOString(), formatted };
    } catch {
      throw new ToolInputError(`Unknown time zone "${timezone}". Use an IANA name like Asia/Jakarta.`);
    }
  }
};

const serverInfo: DiscordTool = {
  label: "server info",
  definition: {
    name: "get_server_info",
    description: "Get facts about this Discord server: name, description, member count, creation date, boosts, channel and role counts.",
    parameters: { type: "object", properties: {} }
  },
  async execute(_args, { guild }) {
    return {
      name: guild.name,
      description: guild.description,
      memberCount: guild.memberCount,
      createdAt: guild.createdAt.toISOString(),
      ownerId: guild.ownerId,
      boostTier: guild.premiumTier,
      boostCount: guild.premiumSubscriptionCount ?? 0,
      channelCount: guild.channels.cache.size,
      roleCount: Math.max(0, guild.roles.cache.size - 1),
      preferredLocale: guild.preferredLocale
    };
  }
};

const memberInfo: DiscordTool = {
  label: "member lookup",
  definition: {
    name: "get_member_info",
    description: "Look up a member of this server by user ID, mention, username or display name. Returns their roles and join date.",
    parameters: {
      type: "object",
      properties: {
        user: { type: "string", description: "User ID, a mention like <@123>, a username or a display name." }
      },
      required: ["user"]
    }
  },
  async execute(args, { guild }) {
    const member = await resolveMember(guild, requiredString(args, "user", 100));
    if (!member) return { found: false };
    const roles = [...member.roles.cache.values()]
      .filter(role => role.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .slice(0, 15)
      .map(role => role.name);
    return {
      found: true,
      id: member.id,
      mention: `<@${member.id}>`,
      username: member.user.username,
      displayName: member.displayName,
      isBot: member.user.bot,
      isServerOwner: member.id === guild.ownerId,
      joinedAt: member.joinedAt?.toISOString() ?? null,
      accountCreatedAt: member.user.createdAt.toISOString(),
      roles
    };
  }
};

const recentMessages: DiscordTool = {
  label: "recent messages",
  definition: {
    name: "get_recent_messages",
    description: "Read the latest messages in the current channel, e.g. to answer \"what did I miss?\" or to follow an ongoing discussion.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many messages to read (1-50, default 20)." }
      }
    }
  },
  async execute(args, { channel, triggerMessageId }) {
    const limit = optionalInteger(args, "limit", 1, 50) ?? 20;
    const fetched = await channel.messages.fetch({ limit: Math.min(100, limit + 1) });
    const messages = [...fetched.values()]
      .filter(message => message.id !== triggerMessageId)
      .slice(0, limit)
      .reverse()
      .map(message => ({
        author: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        authorId: message.author.id,
        isBot: message.author.bot,
        sentAt: message.createdAt.toISOString(),
        content: truncate(
          message.content || (message.attachments.size > 0 ? "[attachment]" : message.embeds.length > 0 ? "[embed]" : ""),
          300
        )
      }));
    return { channel: channel.name, messages };
  }
};

const memberWarnings: DiscordTool = {
  label: "warnings",
  definition: {
    name: "get_member_warnings",
    description: "Moderators only: list the most recent moderation warnings of a member.",
    parameters: {
      type: "object",
      properties: {
        user: { type: "string", description: "User ID, a mention like <@123>, a username or a display name." }
      },
      required: ["user"]
    }
  },
  async execute(args, { guild }) {
    const query = requiredString(args, "user", 100);
    const member = await resolveMember(guild, query);
    const userId = member?.id ?? extractUserId(query);
    if (!userId) return { found: false };
    return {
      userId,
      displayName: member?.displayName ?? null,
      warnings: listWarnings(guild.id, userId, 10)
    };
  }
};

const knowledgeSearch: DiscordTool = {
  label: "knowledge base",
  definition: {
    name: "search_knowledge_base",
    description: "Search this server's knowledge base (rules, FAQs, guides and corrections taught by moderators). " +
      "Use it for server-specific questions. Results are numbered; cite them like [3].",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in a few keywords or a short question." }
      },
      required: ["query"]
    }
  },
  async execute(args, { knowledge }) {
    if (!knowledge) throw new ToolInputError("This server has no knowledge base.");
    const hits = await knowledge.search(requiredString(args, "query", 300));
    if (hits.length === 0) return { results: [], note: "Nothing relevant found. Do not guess server-specific facts." };
    return {
      results: hits.map(hit => ({
        cite: `[${knowledge.citations.register(hit)}]`,
        title: hit.title,
        excerpt: truncate(hit.content, 700)
      }))
    };
  }
};

/**
 * Returns only the tools this requester may use (least privilege). All tools
 * are read-only: the assistant can look things up but never act on its own.
 */
export function getDiscordTools(context: DiscordToolContext): DiscordTool[] {
  // Public, harmless information is available to everyone.
  const tools: DiscordTool[] = [currentTime, serverInfo, memberInfo];
  const { requester, channel, guild } = context;
  if (context.knowledge) tools.push(knowledgeSearch);
  const readHistory = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const botMember = guild.members.me;

  // The model must never see more than the person asking could see themselves:
  // channel history only when both the requester and the bot can read it…
  if (requester?.permissionsIn(channel).has(readHistory) && botMember?.permissionsIn(channel).has(readHistory)) {
    tools.push(recentMessages);
  }
  // …and moderation history only for moderators. A tool that is not offered cannot be
  // called, which is safer than checking permissions after the model asked for it.
  if (requester?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    tools.push(memberWarnings);
  }
  return tools;
}

async function resolveMember(guild: Guild, input: string): Promise<GuildMember | null> {
  const id = extractUserId(input);
  if (id) return guild.members.fetch(id).catch(() => null);

  const query = input.replace(/^@/, "").trim().toLowerCase();
  if (!query) return null;
  const cached = guild.members.cache.find(member =>
    [member.displayName, member.user.username, member.user.globalName]
      .some(name => name?.toLowerCase() === query)
  );
  if (cached) return cached;
  const results = await guild.members.search({ query, limit: 1 }).catch(() => null);
  return results?.first() ?? null;
}

function requiredString(args: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(args, key, maxLength);
  if (!value) throw new ToolInputError(`Missing required argument "${key}".`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function optionalInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const raw = args[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}
