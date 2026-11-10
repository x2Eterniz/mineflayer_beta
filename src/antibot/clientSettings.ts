import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AntiBotConfig } from "./config";
import { debugLogging } from "./index";

export function initClientSettings(bot: Bot, config: AntiBotConfig): void {
  const client = (bot as any)._client;
  if (!client) return;

  const settings = config.clientSettings;

  try {
    (bot as any).settings = {
      chat: settings.chatMode === 0 ? "enabled" : settings.chatMode === 1 ? "commandsOnly" : "disabled",
      colorsEnabled: settings.chatColors,
      viewDistance: settings.viewDistance as any,
      skinParts: {
        showCape: !!(settings.skinParts & 0x01),
        showJacket: !!(settings.skinParts & 0x02),
        showLeftSleeve: !!(settings.skinParts & 0x04),
        showRightSleeve: !!(settings.skinParts & 0x08),
        showLeftPants: !!(settings.skinParts & 0x10),
        showRightPants: !!(settings.skinParts & 0x20),
        showHat: !!(settings.skinParts & 0x40),
      },
      mainHand: settings.mainHand === 0 ? "left" : "right",
      locale: settings.locale || "en_us",
      enableTextFiltering: !!settings.enableTextFiltering,
      enableServerListing: !!settings.enableServerListing,
    };
  } catch {
    // Ignore settings overrides on versions where mineflayer does not expose them.
  }

  client.on("login_plugin_request", (packet: any) => {
    if (debugLogging) {
      logger.info(
        chalk.hex("#A78BFA")("[Compat]"),
        chalk.gray(`Observed login plugin request (id: ${packet?.messageId ?? "?"})`)
      );
    }
  });

  if (debugLogging) {
    logger.info(
      chalk.hex("#A78BFA")("[Compat]"),
      chalk.gray(`Settings configured (locale=${settings.locale}, viewDist=${settings.viewDistance})`)
    );
  }
}
