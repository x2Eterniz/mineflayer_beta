import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { type AntiBotConfig, DEFAULT_ANTIBOT_CONFIG } from "./config";
import { initBrandSpoof } from "./brandSpoof";
import { initClientSettings } from "./clientSettings";
import { initPacketGuard } from "./packetGuard";
import { initHumanBehavior, stopHumanBehavior } from "./humanBehavior";
import { initGravityFix } from "./gravityFix";

export type { AntiBotConfig } from "./config";
export { DEFAULT_ANTIBOT_CONFIG } from "./config";

// Anti-bot lifecycle is per bot. A process can host multiple accounts; a
// process-wide boolean used to make only the first account initialize these
// compatibility listeners.
const activeBots = new WeakSet<Bot>();
export let debugLogging = false;

export function initAntiBot(bot: Bot, antibotConfig?: Partial<AntiBotConfig>, debugEnabled: boolean = false): void {
  if (activeBots.has(bot)) return;
  debugLogging = debugEnabled;
  const config: AntiBotConfig = mergeConfig(antibotConfig);

  if (config.enabled === false) {
    return;
  }

  if (config.enabled === "auto") {
    const client = (bot as any)._client;
    if (!client) return;

    let detected = false;
    const triggerDetection = (reason: string) => {
      if (detected || activeBots.has(bot)) return;
      detected = true;
      if (debugLogging) {
        logger.separator();
        logger.info(
          chalk.hex("#F59E0B").bold("[Compat]"),
          chalk.white(`Server guard detected (${reason}) -> passive module`),
          chalk.hex("#34D399").bold("ENABLED")
        );
      }
      activateAntiBot(bot, config, false);
    };

    client.on("login_plugin_request", () => {
      triggerDetection("login_plugin");
    });

    client.on("custom_payload", (packet: any) => {
      const channel = packet?.channel ?? "";
      if (channel === "minecraft:brand" || channel === "MC|Brand") {
        triggerDetection("brand_query");
      } else if (channel === "minecraft:register" || channel === "REGISTER") {
        triggerDetection("channel_register");
      }
    });

    return;
  }

  activateAntiBot(bot, config, true);
}

function activateAntiBot(bot: Bot, config: AntiBotConfig, showBanner: boolean): void {
  if (activeBots.has(bot)) return;
  activeBots.add(bot);
  bot.once("end", () => {
    activeBots.delete(bot);
    stopHumanBehavior();
  });

  if (showBanner && debugLogging) {
    logger.separator();
    logger.info(
      chalk.hex("#F59E0B").bold("[Compat]"),
      chalk.white("Server compatibility module"),
      chalk.hex("#34D399").bold("ENABLED")
    );
  }

  const modules = [
    { name: "Brand Spoof", init: () => initBrandSpoof(bot, config) },
    { name: "Client Settings", init: () => initClientSettings(bot, config) },
    { name: "Packet Guard", init: () => initPacketGuard(bot, config) },
    { name: "Human Behavior", init: () => initHumanBehavior(bot, config) },
    { name: "Gravity Fix", init: () => initGravityFix(bot, config) },
  ];

  let loadedCount = 0;
  for (const mod of modules) {
    try {
      mod.init();
      loadedCount++;
    } catch (err) {
      if (debugLogging) {
        logger.error(
          chalk.hex("#F87171")("[Compat]"),
          chalk.gray(`Failed to load ${mod.name}:`),
          (err as Error).message
        );
      }
    }
  }

  if (showBanner && debugLogging) {
    logger.info(
      chalk.hex("#A78BFA")("[Compat]"),
      chalk.gray(`${loadedCount}/${modules.length} modules loaded`)
    );
    logger.info(
      chalk.hex("#A78BFA")("[Compat]"),
      chalk.gray("Passive mode active: relying on plugins for login/custom payload handling")
    );
    logger.separator();
  }
}

export function stopAntiBot(): void {
  stopHumanBehavior();
}

function mergeConfig(partial?: Partial<AntiBotConfig>): AntiBotConfig {
  if (!partial) return { ...DEFAULT_ANTIBOT_CONFIG };

  return {
    enabled: partial.enabled ?? DEFAULT_ANTIBOT_CONFIG.enabled,
    brand: {
      ...DEFAULT_ANTIBOT_CONFIG.brand,
      ...partial.brand,
    },
    clientSettings: {
      ...DEFAULT_ANTIBOT_CONFIG.clientSettings,
      ...partial.clientSettings,
    },
    humanBehavior: {
      ...DEFAULT_ANTIBOT_CONFIG.humanBehavior,
      ...partial.humanBehavior,
    },
    packetGuard: {
      ...DEFAULT_ANTIBOT_CONFIG.packetGuard,
      ...partial.packetGuard,
    },
    physics: {
      ...DEFAULT_ANTIBOT_CONFIG.physics,
      ...partial.physics,
    },
  };
}
