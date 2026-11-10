import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { sharedState, hasUsableCurrentWindow, resetGuiState, closeRawGui } from "../events/connection";
import { getItemDisplayName } from "../utils/helpers";

const DBG_TAG = chalk.hex("#C084FC")("[InvDbg]");

async function waitForSynchronizedWindow(bot: Bot, timeoutMs = 4000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!sharedState.inventorySyncPending && hasUsableCurrentWindow(bot)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !sharedState.inventorySyncPending && hasUsableCurrentWindow(bot);
}

export const ClickCommand = {
  name: "click",
  description: "Click an item in the currently opened menu/window",
  usage: "/click <slot_number> [left|right]",
  execute: async (bot: Bot, args: string[]) => {
    if (!args[0]) {
      logger.system(chalk.red("Usage: /click <slot_number> [left|right]"));
      return;
    }

    const slot = parseInt(args[0], 10);
    if (isNaN(slot)) {
      logger.system(chalk.red("Slot must be a number."));
      return;
    }

    if (sharedState.inventorySyncPending || !hasUsableCurrentWindow(bot)) {
      const synchronized = await waitForSynchronizedWindow(bot);
      if (synchronized) {
        // Continue with the click after the menu/inventory has synchronized.
      } else if (sharedState.inventorySyncPending) {
      logger.system(
        chalk.red(
          `Refusing click while inventory sync is pending (${sharedState.inventorySyncSource}). Wait for backend sync first.`
        )
      );
      return;
      } else {
        logger.system(chalk.red("No synchronized menu/window is currently opened."));
        return;
      }
    }

    if (!hasUsableCurrentWindow(bot)) {
      logger.system(chalk.red("No synchronized menu/window is currently opened."));
      return;
    }

    const clickType = args[1] === "right" ? 1 : 0;
    const currentWindow = bot.currentWindow;
    if (!currentWindow) {
      logger.system(
        chalk.yellow("Menu exists but is not synchronized by mineflayer yet. Try /close then reopen menu.")
      );
      return;
    }
    const totalSlots = currentWindow.slots?.length ?? 0;

    if (slot < 0 || slot >= totalSlots) {
      logger.system(chalk.red(`Slot must be between 0 and ${Math.max(0, totalSlots - 1)} for the current window.`));
      return;
    }

    if (sharedState.debugInventory) {
      const windowId = (currentWindow as any).id ?? "?";
      const windowType = (currentWindow as any).type ?? "?";
      const containerSlots = (currentWindow as any).inventoryStart ?? "?";
      const targetItem = currentWindow.slots[slot];
      const itemName = targetItem ? getItemDisplayName(targetItem) : "empty";
      logger.debug(
        DBG_TAG,
        chalk.gray(`clickWindow wid=${windowId} type=${windowType} slot=${slot} clickType=${clickType === 0 ? "left" : "right"} containerSlots=${containerSlots} totalSlots=${totalSlots} targetItem="${itemName}"`)
      );
    }

    try {
      logger.system(chalk.cyan(`Clicking slot ${slot}...`));
      await bot.clickWindow(slot, clickType, 0);
      logger.system(chalk.green(`Successfully clicked slot ${slot}.`));
    } catch (err) {
      logger.system(chalk.red(`Failed to click slot ${slot}: ${err}`));
    }
  },
};

export const CloseCommand = {
  name: "close",
  description: "Close the currently opened menu/window",
  usage: "/close",
  execute: async (bot: Bot, args: string[]) => {
    const currentWindow = bot.currentWindow;
    if (!hasUsableCurrentWindow(bot)) {
      resetGuiState();
      logger.system(chalk.gray("No synchronized window is open."));
      return;
    }

    if (!currentWindow) {
      closeRawGui(bot);
      logger.system(chalk.green("Raw GUI close packet sent."));
      return;
    }

    if (sharedState.debugInventory) {
      const windowId = (currentWindow as any).id ?? "?";
      const windowType = (currentWindow as any).type ?? "?";
      logger.debug(
        DBG_TAG,
        chalk.gray(`closeWindow wid=${windowId} type=${windowType}`)
      );
    }

    try {
      bot.closeWindow(currentWindow);
      resetGuiState();
      logger.system(chalk.green("Window closed manually."));
    } catch (err) {
      logger.system(chalk.red(`Failed to close window: ${err}`));
    }
  },
};
