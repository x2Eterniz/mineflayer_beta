import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import { logger } from "../logger";
import chalk from "chalk";
import { stripColorCodes, extractTextFromNbt } from "../utils/helpers";

const lastHealthMap = new Map<number, number>();

export function initAttackLog(bot: Bot): void {
  // Clear health map on spawn/respawn
  bot.on("spawn", () => {
    lastHealthMap.clear();
  });

  bot.on("entityGone", (entity) => {
    lastHealthMap.delete(entity.id);
  });

  bot.on("entitySpawn", (entity) => {
    const config = (bot as any).featuresConfig as FeaturesConfig;
    if (!config || !config.attackLog || !config.attackLog.enabled) {
      return;
    }

    if (entity === bot.entity || !entity.position) return;

    // Must be close to the bot
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist > 6) {
      return;
    }

    // Capture damage indicators (usually armor stands, text displays or area effect clouds)
    const name = entity.name || "";
    if (name === "armor_stand" || name === "text_display" || name === "area_effect_cloud" || entity.type === "decoration") {
      let label = entity.displayName || (entity as any).customName || "";
      if (!label && entity.metadata) {
        // Try index 2 (custom name) and index 23 (text_display text)
        for (const idx of [2, 23]) {
          const metaVal = entity.metadata[idx];
          if (metaVal !== undefined && metaVal !== null) {
            if (typeof metaVal === "string") {
              label = metaVal;
            } else if (metaVal && typeof metaVal === "object") {
              label = extractTextFromNbt(metaVal);
            }
            if (label) break;
          }
        }
      }

      if (label) {
        if (label.startsWith("{") && label.endsWith("}")) {
          try {
            const parsed = JSON.parse(label);
            if (parsed.text !== undefined) {
              label = parsed.text;
              if (Array.isArray(parsed.extra)) {
                label += parsed.extra.map((e: any) => e.text || "").join("");
              }
            }
          } catch {}
        }

        const cleanLabel = stripColorCodes(label).trim();
        const hasNumber = /\d+/.test(cleanLabel);
        if (hasNumber && cleanLabel.length < 20) {
          logger.info(
            chalk.hex("#EF4444")("[AttackLog]"),
            chalk.gray(`Ghi nhận sát thương: `) + chalk.red.bold(cleanLabel)
          );
        }
      }
    }
  });

  bot.on("entityUpdate", (entity) => {
    // Check if feature is enabled
    const config = (bot as any).featuresConfig as FeaturesConfig;
    if (!config || !config.attackLog || !config.attackLog.enabled) {
      return;
    }

    if (entity === bot.entity || !entity.position) return;

    const type = entity.type;
    // Allow mob, monster, hostile, player, passive, living types, object
    if (
      type !== "mob" &&
      type !== "monster" &&
      type !== "hostile" &&
      type !== "player" &&
      type !== "passive" &&
      type !== "living" &&
      type !== "object"
    ) {
      return;
    }

    const name = (entity.name || "").toLowerCase();
    const displayName = (entity.displayName || "").toLowerCase();

    // Exclude decorations, text displays, projectiles, items, vehicles, etc.
    if (
      name === "item" ||
      displayName === "item" ||
      name === "item_stack" ||
      name === "arrow" ||
      name === "experience_orb" ||
      name === "potion" ||
      name === "trident" ||
      name === "firework_rocket" ||
      name === "armor_stand" ||
      displayName === "armor stand" ||
      name === "text_display" ||
      displayName === "text display" ||
      name === "item_frame" ||
      name === "glow_item_frame" ||
      name === "block_display" ||
      name === "item_display" ||
      name === "interaction" ||
      name === "area_effect_cloud" ||
      name === "fishing_bobber" ||
      name === "evoker_fangs" ||
      name === "leash_knot" ||
      name === "painting" ||
      name === "chest_minecart" ||
      name === "minecart" ||
      name === "boat" ||
      name === "chest_boat"
    ) {
      return;
    }

    if (entity.type === "player") {
      const isRealPlayer = entity.username ? bot.players[entity.username] !== undefined : false;
      if (isRealPlayer) return;
    }

    // Must be close to the bot (within attack/combat range, e.g. 6 blocks)
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist > 6) {
      return;
    }

    const currentHealth = entity.health;
    if (currentHealth === undefined || currentHealth === null) {
      return;
    }

    const prevHealth = lastHealthMap.get(entity.id);
    if (prevHealth !== undefined && currentHealth < prevHealth) {
      const damage = prevHealth - currentHealth;
      if (damage > 0) {
        const mobName = entity.username || entity.displayName || entity.name || "Quái vật";
        logger.info(
          chalk.hex("#EF4444")("[AttackLog]"),
          chalk.gray(`Gây `) +
          chalk.red.bold(damage.toFixed(1)) +
          chalk.gray(` sát thương cho `) +
          chalk.yellow(mobName) +
          chalk.gray(` (HP còn lại: ${currentHealth.toFixed(1)})`)
        );
      }
    }

    lastHealthMap.set(entity.id, currentHealth);
  });
}
