import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import { logger } from "../logger";
import chalk from "chalk";
import { getItemDisplayName, getItemLore, stripColorCodes, extractChatText } from "../utils/helpers";

type State = "IDLE" | "WAITING_GUI" | "CHECKING_GUI";

let currentState: State = "IDLE";
let lastCheckTime = 0;
let timeoutTimer = 0;
let actionDelayTicks = 0;
let commandSent = false;
let isClicking = false;
let hasInitialized = false;

export async function tickServerTriggerBot(bot: Bot, config: FeaturesConfig): Promise<void> {
  // If not enabled or bot is dead, clean up and return
  if (!config.serverTriggerBot.enabled || bot.health === 0 || !bot.entity) {
    currentState = "IDLE";
    commandSent = false;
    isClicking = false;
    hasInitialized = false;
    return;
  }

  if (!hasInitialized) {
    // Trì hoãn lần kiểm tra đầu tiên khi bot vừa vào server hoặc vừa bật tính năng
    lastCheckTime = Date.now() + config.serverTriggerBot.initialDelayMs - config.serverTriggerBot.checkIntervalMs;
    hasInitialized = true;
  }

  if (isClicking) {
    return;
  }

  if (actionDelayTicks > 0) {
    actionDelayTicks--;
    return;
  }

  if (timeoutTimer > 0) {
    timeoutTimer--;
    if (timeoutTimer === 0) {
      currentState = "IDLE";
      commandSent = false;
      if (bot.currentWindow) {
        try {
          bot.closeWindow(bot.currentWindow);
        } catch {}
      }
      return;
    }
  }

  const now = Date.now();

  switch (currentState) {
    case "IDLE":
      // Periodically check if active. If not active, trigger checking GUI.
      if (now - lastCheckTime >= config.serverTriggerBot.checkIntervalMs) {
        lastCheckTime = now;

        // Check if a BossBar containing "TriggerBot" exists
        const isTriggerBotActive = Object.values((bot as any).bossBars ?? {}).some((bar: any) => 
          bar.title && bar.title.toString().includes("TriggerBot")
        );

        if (!isTriggerBotActive && !bot.currentWindow) {
          currentState = "WAITING_GUI";
          commandSent = false;
          timeoutTimer = 120; // 6 seconds timeout (120 ticks)
          actionDelayTicks = 40; // Wait 2 seconds (40 ticks) before sending command
        }
      }
      break;

    case "WAITING_GUI":
      if (!commandSent) {
        try {
          bot.chat("/" + config.serverTriggerBot.command);
          commandSent = true;
          actionDelayTicks = 20; // Wait 1 second for screen to open
        } catch (err) {
          currentState = "IDLE";
          commandSent = false;
        }
      } else {
        if (bot.currentWindow && bot.currentWindow.type !== "minecraft:inventory") {
          currentState = "CHECKING_GUI";
          actionDelayTicks = 5; // Brief wait for client-side slots to sync
        }
      }
      break;

    case "CHECKING_GUI":
      if (!bot.currentWindow || bot.currentWindow.type === "minecraft:inventory") {
        currentState = "IDLE";
        commandSent = false;
        return;
      }

      const window = bot.currentWindow;
      const title = (window as any).title || (window as any).jsonTitle;
      const titleText = title ? stripColorCodes(extractChatText(title)).toLowerCase() : "";
      
      const hasTriggerBotItems = window.slots.some(item => {
        if (!item) return false;
        const name = getItemDisplayName(item).toLowerCase();
        return name.includes("tự động") || name.includes("triggerbot");
      });

      const isTriggerBotGui = titleText.includes("trigger") || 
                              titleText.includes("tấn công") || 
                              titleText.includes("taf") || 
                              hasTriggerBotItems;

      if (!isTriggerBotGui) {
        currentState = "IDLE";
        commandSent = false;
        return;
      }

      const containerSlots = window.inventoryStart; // number of slots in the chest/menu container

      let itemFound = false;
      for (let i = 0; i < containerSlots; i++) {
        const item = window.slots[i];
        if (item) {
          const displayName = getItemDisplayName(item);
          if (displayName.includes("Tự Động Tấn Công") || displayName.includes("TriggerBot")) {
            itemFound = true;
            const lore = getItemLore(item);
            let isOff = false;

            for (const line of lore) {
              if (line.includes("TẮT") || line.toLowerCase().includes("off")) {
                isOff = true;
                break;
              }
            }

            if (isOff) {
              isClicking = true;
              try {
                // Click the slot (left click, standard mode)
                await bot.clickWindow(i, 0, 0);
                logger.info(
                  chalk.hex("#10B981")("[ServerTriggerBot]"),
                  chalk.gray("Enabled server TriggerBot!")
                );
              } catch (err) {
                logger.error(
                  chalk.hex("#EF4444")("[ServerTriggerBot]"),
                  chalk.gray(`Failed to click slot ${i}: ${(err as Error).message}`)
                );
              } finally {
                isClicking = false;
              }
            } else {
              logger.info(
                chalk.hex("#10B981")("[ServerTriggerBot]"),
                chalk.gray("Server TriggerBot is already active.")
              );
            }

            try {
              bot.closeWindow(window);
            } catch {}
            currentState = "IDLE";
            commandSent = false;
            return;
          }
        }
      }

      if (!itemFound && timeoutTimer < 20) {
        try {
          bot.closeWindow(window);
        } catch {}
        currentState = "IDLE";
        commandSent = false;
      }
      break;
  }
}

export function forceCheckServerTriggerBot(bot: Bot): void {
  const isTriggerBotActive = Object.values((bot as any).bossBars ?? {}).some((bar: any) => 
    bar.title && bar.title.toString().includes("TriggerBot")
  );
  if (isTriggerBotActive) {
    currentState = "IDLE";
    hasInitialized = true;
    return;
  }

  lastCheckTime = 0;
  currentState = "WAITING_GUI";
  commandSent = false;
  isClicking = false;
  hasInitialized = true;
  actionDelayTicks = 0;
  timeoutTimer = 120;
}

export function isServerTriggerBotBusy(): boolean {
  return currentState !== "IDLE" || isClicking;
}
