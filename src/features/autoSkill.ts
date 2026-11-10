import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import { logger } from "../logger";
import chalk from "chalk";
import { getItemLore, getItemDisplayName } from "../utils/helpers";
import { isCurrentlyEating } from "./autoEat";
import { sharedState, hasUsableCurrentWindow, resetGuiState, closeRawGui } from "../events/connection";

const cooldownTicks: any = [0, 0, 0, 0];
let isUsingSkill = false;
let originalSlot = -1;
let skillTargetSlot = -1;
let skillState: "IDLE" | "SWITCHING" | "CASTING" = "IDLE";
let stateTicks = 0;

function getCooldown(item: any): number {
  if (!item) return -1;
  const lore = getItemLore(item);
  const pattern = /(?:hồi\s*chiêu|cooldown)\s*:\s*([\d.]+)\s*(?:giây|giay|s|sec|seconds?)/i;
  for (const line of lore) {
    const match = line.match(pattern);
    if (match) {
      return parseFloat(match[1]!);
    }
  }
  return -1;
}

function shouldCheckSlot(index: number, config: FeaturesConfig): boolean {
  if (index === 0) return config.autoSkill.useSkill1;
  if (index === 1) return config.autoSkill.useSkill2;
  if (index === 2) return config.autoSkill.useSkill3;
  if (index === 3) return config.autoSkill.useSkill4;
  return false;
}

export function tickAutoSkill(bot: Bot, config: FeaturesConfig): void {
  // If not enabled or bot is dead, clean up and return
  if (!config.autoSkill.enabled || bot.health === 0 || !bot.entity) {
    if (isUsingSkill) {
      try {
        bot.deactivateItem();
      } catch {}
      isUsingSkill = false;
      if (originalSlot !== -1) {
        try {
          bot.setQuickBarSlot(originalSlot);
        } catch {}
      }
      originalSlot = -1;
      skillState = "IDLE";
    }
    return;
  }

  // If currently eating, wait to avoid conflict
  if (isCurrentlyEating()) {
    return;
  }

  const guiIsOpen = hasUsableCurrentWindow(bot) || sharedState.hasRawGui;

  // Decrement cooldowns (run 20 times per second)
  for (let i = 0; i < 4; i++) {
    if (cooldownTicks[i] > 0) {
      cooldownTicks[i]--;
    }
  }

  // ── State machine: ALWAYS runs to completion even if a GUI opened ──
  // If we block the state machine when GUI is open, the skill gets stuck
  // mid-cast and never transitions back to IDLE.
  if (isUsingSkill) {
    if (skillState === "SWITCHING") {
      stateTicks--;
      if (stateTicks <= 0) {
        skillState = "CASTING";
        stateTicks = 3; // Hold activation for 3 ticks (150ms)
        // Only activate if no GUI is currently open
        if (!guiIsOpen) {
          try {
            // Suppress any GUI the server opens as a side-effect of activateItem
            sharedState.suppressGuiUntil = Date.now() + 1500;
            bot.activateItem(false);
          } catch (err) {
            isUsingSkill = false;
            skillState = "IDLE";
            sharedState.suppressGuiUntil = 0;
            if (originalSlot !== -1) {
              try { bot.setQuickBarSlot(originalSlot); } catch {}
              originalSlot = -1;
            }
          }
        }
      }
      return;
    }

    if (skillState === "CASTING") {
      stateTicks--;
      if (stateTicks <= 0) {
        // Finished casting — stop activation and switch back
        try { bot.deactivateItem(); } catch {}
        isUsingSkill = false;
        skillState = "IDLE";
        if (originalSlot !== -1) {
          try { bot.setQuickBarSlot(originalSlot); } catch {}
        }
        originalSlot = -1;

        // FIX: Auto-close any GUI that the server opened as a side-effect
        // of activateItem() (e.g. "Xác nhận ăn trái ác quỷ" confirmation).
        // Without this, the GUI stays open and the cycle repeats:
        //   cast → GUI opens → something closes it → cast again → GUI opens...
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch {}
        }
        if (sharedState.hasRawGui) {
          closeRawGui(bot);
          resetGuiState("autoSkill_cleanup");
        }
      } else {
        // Keep holding/activating — but only if no GUI is open
        if (!guiIsOpen) {
          try {
            sharedState.suppressGuiUntil = Date.now() + 1500;
            bot.activateItem(false);
          } catch {}
        }
      }
      return;
    }
  }

  // ── Don't start NEW skills if a GUI window is currently open ──
  if (guiIsOpen) {
    return;
  }

  // Optimize: Check if there are hostiles nearby FIRST to avoid heavy NBT parsing every tick
  let hasMobsNearby = false;
  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || !entity.position) continue;
    
    const type = entity.type;
    if (
      type !== "mob" && 
      type !== "monster" && 
      type !== "hostile" && 
      type !== "player" && 
      type !== "passive" && 
      type !== "living" &&
      type !== "object" // object added to match aimMobs
    ) {
      continue;
    }

    if (entity.type === "player") {
      const isRealPlayer = entity.username ? bot.players[entity.username] !== undefined : false;
      if (isRealPlayer) continue;
    }
    
    const name = (entity.name || "").toLowerCase();
    const displayName = (entity.displayName || "").toLowerCase();
    if (
      name === "item" || displayName === "item" || name === "item_stack" || name === "arrow" ||
      name === "experience_orb" || name === "potion" || name === "trident" || name === "firework_rocket" ||
      name === "armor_stand" || displayName === "armor stand" || name === "text_display" ||
      displayName === "text display" || name === "item_frame" || name === "glow_item_frame" ||
      name === "block_display" || name === "item_display" || name === "interaction" ||
      name === "area_effect_cloud" || name === "fishing_bobber" || name === "evoker_fangs" ||
      name === "leash_knot" || name === "painting" || name === "chest_minecart" ||
      name === "minecart" || name === "boat" || name === "chest_boat"
    ) {
      continue;
    }

    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= config.autoSkill.range) {
      hasMobsNearby = true;
      break;
    }
  }

  if (!hasMobsNearby) {
    return; // No mobs nearby, do not trigger skill
  }

  // Check if any configured skill is ready and exists
  // We cache the parsed cooldown on the item object to avoid NBT/Regex parsing every tick
  let anySkillReady = false;
  let targetSlot = -1;
  let targetCd = -1;
  let targetItem: any = null;

  for (let i = 0; i < 4; i++) {
    if (shouldCheckSlot(i, config) && cooldownTicks[i] === 0) {
      const item = bot.inventory.slots[36 + i];
      if (item) {
        let cd = (item as any)._cachedCd;
        if (cd === undefined) {
          cd = getCooldown(item);
          (item as any)._cachedCd = cd; // Cache it!
        }
        if (cd > 0) {
          anySkillReady = true;
          targetSlot = i;
          targetCd = cd;
          targetItem = item;
          break; // only cast one skill at a time
        }
      }
    }
  }

  if (!anySkillReady) {
    return;
  }

  // Start sequence: switch to the slot first
  originalSlot = bot.quickBarSlot;
  try {
    bot.setQuickBarSlot(targetSlot);
  } catch {}
  
  isUsingSkill = true;
  skillState = "SWITCHING";
  stateTicks = 2; // Wait 2 ticks (100ms) for the slot switch packet to process before activating

  // Set local cooldown (cooldown in seconds * 20 ticks/sec + random humanized delay)
  cooldownTicks[targetSlot] = Math.ceil(targetCd * 20) + 10 + Math.floor(Math.random() * 15);

  logger.info(
    chalk.hex("#8B5CF6")("[AutoSkill]"),
    chalk.gray(`Switching to slot ${targetSlot + 1} (${targetItem.name}) - CD: ${targetCd}s`)
  );
}

export function isCurrentlyUsingSkill(): boolean {
  return isUsingSkill;
}
