import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { logger } from "../logger";
import chalk from "chalk";

let wasFollowing = false;
let lastTargetName = "";
let warnThrottler = 0;

export function tickAutoFollow(bot: Bot, config: FeaturesConfig): void {
  const enabled = config.autoFollow.enabled && !!config.autoFollow.target;

  if (!enabled || bot.health === 0 || !bot.entity) {
    if (wasFollowing) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      wasFollowing = false;
      lastTargetName = "";
      logger.info(chalk.hex("#3B82F6")("[AutoFollow]"), chalk.gray("Stopped following."));
    }
    return;
  }

  const targetName = config.autoFollow.target;
  const player = bot.players[targetName];

  if (!player || !player.entity) {
    if (wasFollowing) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      wasFollowing = false;
    }
    
    if (warnThrottler <= 0) {
      logger.warn(
        chalk.hex("#EAB308")("[AutoFollow]"),
        chalk.gray(`Target '${targetName}' is not in range or not online. Waiting...`)
      );
      warnThrottler = 200; // Log warning every 10 seconds (200 ticks)
    } else {
      warnThrottler--;
    }
    return;
  }

  warnThrottler = 0; // reset warning throttler since target is found

  // Set goal if we weren't following, or target name changed, or pathfinder goal was cleared
  const currentGoal = bot.pathfinder.goal;
  const needUpdate = !wasFollowing || targetName !== lastTargetName || !currentGoal;

  if (needUpdate) {
    try {
      // Follow the player within 2 blocks
      const goal = new goals.GoalFollow(player.entity, 2);
      bot.pathfinder.setGoal(goal, true);
      wasFollowing = true;
      lastTargetName = targetName;
      logger.info(
        chalk.hex("#3B82F6")("[AutoFollow]"),
        chalk.gray(`Now following player: ${targetName}`)
      );
    } catch (err) {
      logger.error(
        chalk.hex("#EF4444")("[AutoFollow]"),
        chalk.gray(`Failed to set follow goal: ${(err as Error).message}`)
      );
    }
  }
}
