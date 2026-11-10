import type { Bot } from "mineflayer";
import { loadFeaturesConfig, type FeaturesConfig } from "./config";
import { tickAutoEat } from "./autoEat";
import { tickServerTriggerBot } from "./serverTriggerBot";
import { tickAutoFollow } from "./autoFollow";
import { tickLockPosition } from "./lockPosition";
import { tickAutoTool } from "./autoTool";
import { initAttackLog } from "./attackLog";
import { sharedState } from "../events/connection";

export { loadFeaturesConfig, saveFeaturesConfig, type FeaturesConfig } from "./config";

// Global reference to the current active features config
export let featuresConfig: FeaturesConfig;

export function initFeatures(bot: Bot): void {
  // Load configuration from features.json
  featuresConfig = loadFeaturesConfig(bot.username);
  (bot as any).featuresConfig = featuresConfig;

  // Initialize attack log event listeners
  initAttackLog(bot);

  // Bind lightweight features to physicsTick. AimMobs and AutoSkill are
  // intentionally not registered: they used to scan every entity for every
  // account and were the largest avoidable CPU consumer.
  bot.on("physicsTick", () => {
    // Delay feature ticks until auto login and spawn commands have finished running
    if (sharedState.isAutoCmdRunning && !sharedState.allowFeaturesDuringAutoCmd) {
      return;
    }
    
    // Wrap each feature call in its own try-catch block to prevent one failing feature from blocking others
    try { tickAutoEat(bot, featuresConfig); } catch (err) {}
    try { void tickServerTriggerBot(bot, featuresConfig); } catch (err) {}
    try { tickAutoFollow(bot, featuresConfig); } catch (err) {}
    try { tickLockPosition(bot, featuresConfig); } catch (err) {}
    try { tickAutoTool(bot, featuresConfig); } catch (err) {}
  });
}

export function reloadFeaturesConfig(bot: Bot | null): FeaturesConfig {
  const newFeatures = loadFeaturesConfig(bot?.username);
  for (const key in newFeatures) {
    (featuresConfig as any)[key] = (newFeatures as any)[key];
  }
  if (bot) {
    (bot as any).featuresConfig = featuresConfig;
  }
  return featuresConfig;
}
