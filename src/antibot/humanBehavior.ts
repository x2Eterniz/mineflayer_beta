import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AntiBotConfig } from "./config";
import { debugLogging } from "./index";

export function initHumanBehavior(bot: Bot, config: AntiBotConfig): void {
  if (!config.humanBehavior.enabled) return;

  bot.on("end", () => {
    stopHumanBehavior();
  });

  if (debugLogging) {
    logger.info(
      chalk.hex("#A78BFA")("[Compat]"),
      chalk.gray("Behavior simulation disabled in passive mode")
    );
  }
}

export function stopHumanBehavior(): void {
  // No timers to clear in passive mode.
}
