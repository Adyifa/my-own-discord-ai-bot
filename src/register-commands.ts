import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
if (!config.discordToken || !config.clientId) {
  console.error("DISCORD_TOKEN and CLIENT_ID are required in .env");
  process.exit(1);
}

const body = commands.map(command => command.data.toJSON());
const route = config.devGuildId
  ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
  : Routes.applicationCommands(config.clientId);

await new REST().setToken(config.discordToken).put(route, { body });
console.log(
  `Registered ${body.length} slash commands ${config.devGuildId ? `in guild ${config.devGuildId}` : "globally"}.`
);
