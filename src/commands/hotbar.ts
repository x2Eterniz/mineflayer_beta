import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { getItemDisplayName, centerText } from "../utils/helpers";
import { sharedState } from "../events/connection";

export const HotbarCommand = {
  execute: (bot: Bot, args: string[]) => {
    if (!args[0]) {
      const inventory = bot.inventory;
      if (!inventory) {
        logger.system(chalk.red("Inventory not loaded yet!"));
        return;
      }
      const msSinceSpawn = Date.now() - sharedState.lastSpawnTime;
      if (msSinceSpawn < 2000 && sharedState.lastSpawnTime > 0) {
        logger.system(chalk.yellow("Hotbar may be stale (just transferred). Try again in a moment."));
      }
      logger.separator();
      logger.system(centerText(chalk.cyan.bold("[ Hotbar Grid ]")));
      logger.system("");
      let gridStr = "  ";
      const hotbarStart = inventory.hotbarStart ?? 36;
      for (let i = 0; i < 9; i++) {
        const item = inventory.slots[hotbarStart + i];
        const isHolding = bot.quickBarSlot === i;
        if (isHolding) gridStr += chalk.bgMagenta.white(` ${i} `) + " ";
        else if (item) gridStr += chalk.bgGreen.black(` ${i} `) + " ";
        else gridStr += chalk.bgWhite.black(` ${i} `) + " ";
      }
      logger.system(gridStr);
      logger.system(chalk.gray("   0   1   2   3   4   5   6   7   8"));
      logger.system("");
      for (let i = 0; i < 9; i++) {
        const item = inventory.slots[hotbarStart + i];
        if (!item) continue;
        const isHolding = bot.quickBarSlot === i;
        const count = item.count > 1 ? `x${item.count} ` : "";
        const name = getItemDisplayName(item);
        logger.system(chalk.gray(` [${i}] `) + chalk.white(`${count}${name}`) + (isHolding ? chalk.magenta(" (Holding)") : ""));
      }
      logger.separator();
      logger.system(chalk.gray(" Usage: /hotbar <slot> to equip"));
      return;
    }
    // Support both `/hotbar 4` and the more explicit
    // `/hotbar equip 4`/`/hotbar select 4` forms.
    const subcommand = args[0].toLowerCase();
    const slotArg = ["equip", "select", "hold", "slot"].includes(subcommand)
      ? args[1]
      : args[0];
    const slot = Number.parseInt(slotArg ?? "", 10);
    if (isNaN(slot) || slot < 0 || slot > 8) {
      logger.system(chalk.red("Usage: /hotbar equip <slot> (slot 0-8)."));
      return;
    }
    try {
      bot.setQuickBarSlot(slot);
      logger.system(chalk.green(`Equipped slot ${slot}.`));
    } catch (err) {
      logger.system(chalk.red(`Error: ${err}`));
    }
  },
};
