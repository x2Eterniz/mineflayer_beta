import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import { logger } from "../logger";
import chalk from "chalk";
import { sharedState, hasUsableCurrentWindow } from "../events/connection";

let isEating = false;
let previousSlot = -1;
let delayTicks = 0;
let eatingStartTime = 0;
let lastFeedTime = 0;

function isFood(bot: Bot, item: any): boolean {
  if (!item) return false;
  return !!bot.registry.foodsByName?.[item.name];
}

export function tickAutoEat(bot: Bot, config: FeaturesConfig): void {
  // If not enabled or bot is dead, clean up and return
  if (!config.autoEat.enabled || bot.health === 0 || !bot.entity) {
    if (isEating) {
      try {
        bot.deactivateItem();
      } catch {}
      isEating = false;
      if (previousSlot !== -1) {
        try {
          bot.setQuickBarSlot(previousSlot);
        } catch {}
      }
      previousSlot = -1;
    }
    return;
  }

  if (delayTicks > 0) {
    delayTicks--;
    return;
  }

  const currentFood = bot.food;

  // Don't start eating when a GUI window is open — activateItem() can trigger server GUIs
  if (!isEating && hasUsableCurrentWindow(bot)) {
    return;
  }

  if (!isEating && currentFood <= config.autoEat.minFood) {
    const now = Date.now();
    // Use /feed command if enabled and cooldown has passed
    if ((config.autoEat as any).useFeedCmd !== false && now - lastFeedTime >= 60000) {
      lastFeedTime = now;
      try {
        bot.chat("/feed");
        logger.info(chalk.hex("#34D399")("[AutoEat]"), chalk.gray("Used /feed command."));
      } catch {}
      // Wait for 1 second before doing anything else (allow time for food to update)
      delayTicks = 20;
      return;
    }

    // Find food in hotbar (slots 36 to 44)
    let foodSlotIndex = -1;
    for (let i = 0; i < 9; i++) {
      const item = bot.inventory.slots[36 + i];
      if (item && isFood(bot, item)) {
        foodSlotIndex = i;
        break;
      }
    }

    if (foodSlotIndex !== -1) {
      previousSlot = bot.quickBarSlot;
      try {
        bot.setQuickBarSlot(foodSlotIndex);
      } catch {}
      isEating = true;
      eatingStartTime = Date.now();
      
      // Hold right click
      try {
        bot.activateItem(false);
        logger.info(
          chalk.hex("#34D399")("[AutoEat]"),
          chalk.gray(`Eating ${bot.inventory.slots[36 + foodSlotIndex]?.name}...`)
        );
      } catch (err) {
        isEating = false;
        if (previousSlot !== -1) {
          try {
            bot.setQuickBarSlot(previousSlot);
          } catch {}
        }
        previousSlot = -1;
      }
      
      delayTicks = 6; // wait a few ticks for client state sync
    }
  } else if (isEating) {
    const elapsed = Date.now() - eatingStartTime;
    const finished = elapsed > 2000 || currentFood >= 20;

    if (finished) {
      try {
        bot.deactivateItem();
      } catch {}
      isEating = false;
      if (previousSlot !== -1) {
        try {
          bot.setQuickBarSlot(previousSlot);
        } catch {}
        previousSlot = -1;
      }
      delayTicks = 20; // cooldown of 1 second before checking again
      logger.info(chalk.hex("#34D399")("[AutoEat]"), chalk.gray("Finished eating."));
    } else {
      // Re-trigger activation if needed (some servers might cancel it)
      try {
        bot.activateItem(false);
      } catch {}
    }
  }
}

export function isCurrentlyEating(): boolean {
  return isEating;
}
