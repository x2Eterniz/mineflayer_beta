import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AntiBotConfig } from "./config";
import { debugLogging } from "./index";

export function initPacketGuard(bot: Bot, config: AntiBotConfig): void {
  const client = (bot as any)._client;
  if (!client) return;

  const guard = config.packetGuard;

  if (guard.autoRegisterChannels) {
    bot.once("login", () => {
      if (debugLogging) {
        logger.info(
          chalk.hex("#A78BFA")("[Compat]"),
          chalk.gray("Automatic channel registration disabled; relying on plugins defaults")
        );
      }
    });
  }

  if (guard.respondTransactions) {
    let loggedTransaction = false;
    client.on("transaction", (packet: any) => {
      if (loggedTransaction) return;
      loggedTransaction = true;
      if (debugLogging) {
        logger.info(
          chalk.hex("#A78BFA")("[Compat]"),
          chalk.gray(`Observed legacy transaction packet (window=${packet?.windowId ?? 0})`)
        );
      }
    });
  }

  client.on("custom_payload", (packet: any) => {
    const channel = packet?.channel ?? "";
    if (channel !== "minecraft:register" && channel !== "REGISTER") return;

    try {
      const serverChannels = packet.data?.toString("utf-8") ?? "";
      const channelList = serverChannels.split("\0").filter(Boolean);
      if (channelList.length > 0 && debugLogging) {
        logger.info(
          chalk.hex("#A78BFA")("[Compat]"),
          chalk.gray(`Server registered ${channelList.length} channels`)
        );
      }
    } catch {
      // Ignore malformed payloads and keep the connection alive.
    }
  });

  if (debugLogging) {
    logger.info(
      chalk.hex("#A78BFA")("[Compat]"),
      chalk.gray("Packet observer initialized")
    );
  }
}
