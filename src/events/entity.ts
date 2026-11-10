import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import { handleCommand } from "../commands";

import { sharedState, logFeatureStatus } from "./connection";

export function registerEntityEvents(bot: Bot, config: AppConfig) {
  bot.on("health", () => {
    // hp log removed by user preference
  });

  let hasDied = false;

  bot.on("death", () => {
    logger.warn(chalk.hex("#F87171").bold("You died!"), chalk.gray("-- waiting to respawn..."));
    hasDied = true;
    if (config.autoRespawn.enabled) {
      setTimeout(() => {
        try {
          const client = (bot as any)._client;
          if (client?.write) {
            client.write("client_command", { actionId: 0 });
          }
          logger.info(chalk.hex("#34D399")("[AutoRespawn]"), chalk.gray("Sent respawn request"));
        } catch {
          logger.error(chalk.red("[AutoRespawn]"), "Failed to auto-respawn");
        }
      }, config.autoRespawn.delay);
    }
  });

  bot.on("spawn", () => {
    if (hasDied) {
      hasDied = false;
      
      const features = (bot as any).featuresConfig;
      const isTriggerBotEnabled = features?.serverTriggerBot?.enabled === true;

      if (config.autoCommands.enabled && config.autoCommands.onDeath && config.autoCommands.onDeath.length > 0 && isTriggerBotEnabled) {
        // Execute onDeath commands sequentially with delays
        void (async () => {
          try {
            sharedState.isAutoCmdRunning = true;
            logFeatureStatus(bot, config, true);
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            
            for (const entry of config.autoCommands.onDeath!) {
              if (!bot.entity) break;
              await sleep(entry.delay);
              if (!bot.entity) break;
              try {
                if (entry.triggerFeature) {
                  const featureName = entry.triggerFeature;
                  const { featuresConfig, saveFeaturesConfig } = await import("../features");
                  let knownFeature = false;

                  if (featureName in featuresConfig) {
                    const feat = (featuresConfig as any)[featureName];
                    if (feat && typeof feat === "object" && "enabled" in feat) {
                      feat.enabled = true;
                      saveFeaturesConfig(featuresConfig);
                      knownFeature = true;
                    }
                  }

                  if (featureName === "serverTriggerBot") {
                    const { forceCheckServerTriggerBot, isServerTriggerBotBusy } = await import("../features/serverTriggerBot");
                    logger.info(chalk.hex("#A78BFA")("AutoCmd:"), chalk.gray(`Triggering feature: serverTriggerBot`));
                    forceCheckServerTriggerBot(bot);
                    sharedState.allowFeaturesDuringAutoCmd = true;

                    if (entry.awaitCompletion) {
                      const timeout = entry.timeoutMs ?? 7000;
                      const start = Date.now();
                      logger.info(chalk.hex("#A78BFA")("AutoCmd:"), chalk.gray(`Awaiting serverTriggerBot completion (max ${timeout}ms)...`));
                      
                      await sleep(200);

                      while (isServerTriggerBotBusy() && (Date.now() - start < timeout)) {
                        if (!bot.entity) break;
                        await sleep(100);
                      }
                      logger.info(chalk.hex("#A78BFA")("AutoCmd:"), chalk.gray(`serverTriggerBot execution finished or timed out.`));
                    }
                  } else if (knownFeature) {
                    sharedState.allowFeaturesDuringAutoCmd = true;
                    logger.info(chalk.hex("#A78BFA")("AutoCmd:"), chalk.gray(`Feature ${featureName} has been enabled.`));
                  } else {
                    logger.warn(chalk.red("AutoCmd:"), `Unknown feature: ${featureName}`);
                  }
                }

                if (entry.command) {
                  logger.info(chalk.hex("#A78BFA")("AutoCmd:"), chalk.gray(`Processing: ${entry.command}`));
                  if (entry.awaitCompletion) {
                    await handleCommand(entry.command, bot, config, () => { }, () => { });
                    if (entry.timeoutMs) {
                      await sleep(entry.timeoutMs);
                    }
                  } else {
                    handleCommand(entry.command, bot, config, () => { }, () => { }).catch(err => {
                      logger.error(chalk.red("AutoCmd:"), `Failed to execute ${entry.command} in background: ${(err as Error).message}`);
                    });
                  }
                }
              } catch (err) {
                logger.error(chalk.red("AutoCmd:"), `Failed to execute spawn sequence item: ${(err as Error).message}`);
              }
            }
          } finally {
            if (sharedState.isAutoCmdRunning) {
              sharedState.isAutoCmdRunning = false;
              sharedState.allowFeaturesDuringAutoCmd = false;
              logFeatureStatus(bot, config, false);
            }
          }
        })();
      }
    }
  });
}
