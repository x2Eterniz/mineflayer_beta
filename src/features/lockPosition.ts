import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";
import pkg from "mineflayer-pathfinder";
const { goals } = pkg;
import { logger } from "../logger";
import chalk from "chalk";

let isReturningToLock = false;
let lastLockedLogTime = 0;

export function tickLockPosition(bot: Bot, config: FeaturesConfig): void {
  const enabled =
    config.lockPosition.enabled &&
    config.lockPosition.x !== null &&
    config.lockPosition.y !== null &&
    config.lockPosition.z !== null;

  if (!enabled || bot.health === 0 || !bot.entity) {
    if (isReturningToLock) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      isReturningToLock = false;
    }
    return;
  }

  const { x, y, z, range } = config.lockPosition;
  const pos = bot.entity.position;
  const dx = pos.x - x!;
  const dy = pos.y - y!;
  const dz = pos.z - z!;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (dist <= range) {
    if (isReturningToLock) {
      try {
        bot.pathfinder.setGoal(null);
      } catch {}
      isReturningToLock = false;
      logger.info(
        chalk.hex("#F59E0B")("[LockPosition]"),
        chalk.gray("Returned to locked position.")
      );
    }

    // Active position locking (anti-knockback style)
    if (dist > 0.05) {
      bot.entity.position.x = x!;
      bot.entity.position.z = z!;
      bot.entity.velocity.x = 0;
      bot.entity.velocity.z = 0;
      
      const now = Date.now();
      if (now - lastLockedLogTime > 5000) {
        lastLockedLogTime = now;
        logger.info(
          chalk.hex("#F59E0B")("[LockPosition]"),
          chalk.gray(`Position locked to: ${x?.toFixed(1)}, ${y?.toFixed(1)}, ${z?.toFixed(1)}`)
        );
      }
    }
  } else {
    // Pushed beyond range, pathfind back
    if (!isReturningToLock || !bot.pathfinder.goal) {
      isReturningToLock = true;
      try {
        const goal = new goals.GoalBlock(Math.floor(x!), Math.floor(y!), Math.floor(z!));
        bot.pathfinder.setGoal(goal);
        logger.warn(
          chalk.hex("#F59E0B")("[LockPosition]"),
          chalk.gray(`Pushed away by ${dist.toFixed(1)}m. Returning back to lock...`)
        );
      } catch (err) {
        logger.error(
          chalk.hex("#EF4444")("[LockPosition]"),
          chalk.gray(`Failed to pathfind to locked position: ${(err as Error).message}`)
        );
      }
    }
  }
}
