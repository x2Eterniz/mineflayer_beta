import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import { sharedState } from "../events/connection";

export let antiAFKTimer: ReturnType<typeof setInterval> | null = null;

export function startAntiAFK(bot: Bot, config: AppConfig): void {
  stopAntiAFK();
  if (!config.antiAFK.enabled) return;

  const intervalMs = config.antiAFK.intervalSeconds * 1000;
  const action = config.antiAFK.action;

  logger.info(
    chalk.hex("#A78BFA")("[AntiAFK]"),
    chalk.gray(`Enabled — ${action} every ${config.antiAFK.intervalSeconds}s`)
  );

  antiAFKTimer = setInterval(() => {
    if (sharedState.isAutoCmdRunning) return;
    try {
      switch (action) {
        case "sneak":
          bot.setControlState("sneak", true);
          setTimeout(() => {
            try { bot.setControlState("sneak", false); } catch { }
          }, 300);
          break;
        case "jump":
          bot.setControlState("jump", true);
          setTimeout(() => {
            try { bot.setControlState("jump", false); } catch { }
          }, 300);
          break;
        case "swing":
          bot.swingArm(undefined);
          break;
        case "rotate":
          const yaw = (Math.random() * 2 - 1) * Math.PI;
          bot.look(yaw, 0, false);
          break;
      }
    } catch {
      // Bot may have disconnected
    }
  }, intervalMs);
}

export function stopAntiAFK(): void {
  if (antiAFKTimer) {
    clearInterval(antiAFKTimer);
    antiAFKTimer = null;
  }
}
