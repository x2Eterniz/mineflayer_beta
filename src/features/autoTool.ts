import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import { logger } from "../logger";
import chalk from "chalk";

let lastEquipTime = 0;
let lastCheckTime = 0;

export function equipBestTool(bot: Bot, type: "sword" | "pickaxe"): boolean {
  if (!bot.inventory) return false;
  
  // Prevent spamming inventory updates
  const now = Date.now();
  if (now - lastEquipTime < 1000) return false;

  const items = bot.inventory.items();
  let bestItem = null;
  let highestScore = -1;

  for (const item of items) {
    if (!item) continue;
    const name = item.name.toLowerCase();
    let score = 0;

    if (type === "sword") {
      if (name.includes("sword")) score += 1000;
      else if (name.includes("axe") && !name.includes("pickaxe")) score += 500;
      
      if (name.includes("netherite")) score += 60;
      else if (name.includes("diamond")) score += 50;
      else if (name.includes("iron")) score += 40;
      else if (name.includes("stone")) score += 30;
      else if (name.includes("wooden")) score += 20;
      else if (name.includes("golden")) score += 10;
    } else if (type === "pickaxe") {
      if (name.includes("pickaxe")) score += 1000;
      
      if (name.includes("netherite")) score += 60;
      else if (name.includes("diamond")) score += 50;
      else if (name.includes("iron")) score += 40;
      else if (name.includes("stone")) score += 30;
      else if (name.includes("wooden")) score += 20;
      else if (name.includes("golden")) score += 10;
    }

    if (score > highestScore && score > 0) {
      highestScore = score;
      bestItem = item;
    }
  }

  if (bestItem) {
    const held = bot.inventory.slots[bot.getEquipmentDestSlot("hand")];
    if (!held || held.type !== bestItem.type) {
      bot.equip(bestItem, "hand").catch(() => {});
      lastEquipTime = now;
      return true;
    }
  }

  return false;
}

export function tickAutoTool(bot: Bot, config: FeaturesConfig): void {
  // Inventory scans do not need to run at physics-tick frequency.
  const now = Date.now();
  if (now - lastCheckTime < 250) return;
  lastCheckTime = now;
  if (config.autoTool.autoSword) {
    equipBestTool(bot, "sword");
  } else if (config.autoTool.autoPickaxe) {
    equipBestTool(bot, "pickaxe");
  }
}
