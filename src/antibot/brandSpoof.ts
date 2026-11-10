import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AntiBotConfig } from "./config";
import { debugLogging } from "./index";

export function initBrandSpoof(bot: Bot, config: AntiBotConfig): void {
  const client = (bot as any)._client;
  if (!client) return;

  const brandName = config.brand.name;
  let loggedQuery = false;

  client.on("custom_payload", (packet: any) => {
    const channel = packet?.channel ?? "";
    if (!loggedQuery && (channel === "minecraft:brand" || channel === "MC|Brand")) {
      loggedQuery = true;
      if (debugLogging) {
        logger.info(
          chalk.hex("#A78BFA")("[Compat]"),
          chalk.gray(`Observed brand query on ${channel}; configured brand="${brandName}"`)
        );
      }
    }
  });

  if (debugLogging) {
    logger.info(
      chalk.hex("#A78BFA")("[Compat]"),
      chalk.gray(`Brand ready: "${brandName}"`)
    );
  }
}
