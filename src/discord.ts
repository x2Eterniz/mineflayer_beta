import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import type { Bot } from "mineflayer";
import type { AppConfig } from "./config";
import { logger } from "./logger";
import { stripAnsiCodes, stripColorCodes } from "./utils/helpers";
import { handleCommand } from "./commands";

let discordClient: Client | null = null;
let targetChannel: TextChannel | null = null;
let currentConfig: AppConfig | null = null;
let activeBotGetter: (() => Bot | null) | null = null;
let bridgeCallbacks: { disconnect: () => void; reconnect: () => void } | null = null;

export function initDiscord(
  config: AppConfig,
  getBot: () => Bot | null,
  callbacks: { disconnect: () => void; reconnect: () => void }
) {
  if (!config.discord || !config.discord.enabled) {
    return;
  }

  currentConfig = config;
  activeBotGetter = getBot;
  bridgeCallbacks = callbacks;

  const { token, channelId } = config.discord;

  if (!token || !channelId) {
    logger.error("[Discord] Discord integration is enabled but token or channelId is missing in config.json.");
    return;
  }

  logger.info("[Discord] Initializing Discord Bot...");

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.on("clientReady", () => {
    logger.info(`[Discord] Logged in as ${discordClient?.user?.tag}`);
    void (async () => {
      try {
        const channel = await discordClient?.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          targetChannel = channel as TextChannel;
          await targetChannel.send(`🟢 **Minecraft Bot Bridge Online**\nBot username: \`${config.bot.username}\`\nConnecting to: \`${config.server.host}:${config.server.port}\``);
        } else {
          logger.error("[Discord] Provided Channel ID is not a text channel or is unreachable.");
        }
      } catch (err) {
        logger.error(`[Discord] Failed to fetch channel: ${(err as Error).message}`);
      }
    })();
  });

  discordClient.on("messageCreate", async (message) => {
    if (!discordClient || message.author.bot || !targetChannel || message.channel.id !== channelId) {
      return;
    }

    const content = message.content.trim();
    if (!content) return;

    const bot = activeBotGetter?.();

    // Verify authorized users if allowedUsers list is configured
    if (config.discord.allowedUsers && config.discord.allowedUsers.length > 0) {
      if (!config.discord.allowedUsers.includes(message.author.id)) {
        await message.reply("❌ You are not authorized to interact with this bot.");
        return;
      }
    }

    if (!config.discord.bridgeCommands) {
      // If commands are disabled, we can still allow normal chat, but since we feed directly,
      // we only want to chat. If they type something, we send it to bot.chat directly.
      if (bot) {
        try {
          let chatMsg = content;
          if (chatMsg.length > 256) {
            chatMsg = chatMsg.slice(0, 253) + "...";
          }
          bot.chat(chatMsg);
        } catch (err) {
          logger.error(`[Discord] Failed to send chat to Minecraft: ${(err as Error).message}`);
        }
      }
      return;
    }

    // Intercept logger outputs for the duration of the command execution
    const logs: string[] = [];
    const interceptor = (msg: string) => {
      const cleanMsg = stripAnsiCodes(stripColorCodes(msg));
      logs.push(cleanMsg);
    };

    logger.setInterceptor(interceptor);

    const onQuit = () => {
      if (bridgeCallbacks) {
        bridgeCallbacks.disconnect();
      }
      process.exit(0);
    };

    const onReconnect = () => {
      if (bridgeCallbacks) {
        bridgeCallbacks.reconnect();
      }
    };

    try {
      handleCommand(
        content,
        bot ?? null,
        config,
        onQuit,
        onReconnect,
        async () => {
          logger.setInterceptor(null);

          if (logs.length > 0) {
            const replyText = logs.join("\n").trim();
            if (replyText) {
              if (replyText.length > 1900) {
                await message.reply("```\n" + replyText.slice(0, 1900) + "\n... (truncated)```");
              } else {
                await message.reply("```\n" + replyText + "```");
              }
            }
          }
        }
      );
    } catch (err) {
      logger.setInterceptor(null);
      await message.reply(`❌ Error: ${(err as Error).message}`);
    }
  });

  discordClient.login(token).catch((err) => {
    logger.error(`[Discord] Login failed: ${(err as Error).message}`);
  });
}

export function sendToDiscord(message: string) {
  if (!discordClient || !targetChannel || !currentConfig?.discord?.enabled) {
    return;
  }

  if (!currentConfig.discord.bridgeChat) {
    return;
  }

  const cleanMsg = stripAnsiCodes(stripColorCodes(message)).trim();
  if (!cleanMsg) return;

  // Avoid echoing bridged messages that the bot itself sent
  const botUsername = currentConfig.bot.username;
  if (cleanMsg.includes(`<${botUsername}>`) || cleanMsg.startsWith(`${botUsername} `)) {
    return;
  }

  void targetChannel.send(cleanMsg).catch(() => {
    // Ignore sending errors
  });
}

export function shutdownDiscord() {
  if (discordClient) {
    try {
      discordClient.destroy();
    } catch {}
    discordClient = null;
    targetChannel = null;
  }
}
