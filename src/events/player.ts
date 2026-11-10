import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import { isNPCPlayer, stripColorCodes } from "../utils/helpers";

import { isFirstSpawn, sharedState } from "./connection";

/**
 * Burst detection: hub-navigation NPCs (SkyFree, BoxPVP, Prison, etc.) all
 * join and leave on the exact same tick.  When we see ≥ BURST_THRESHOLD events
 * in a BURST_WINDOW_MS window, we treat the whole burst as NPC noise.
 */
const BURST_WINDOW_MS  = 500;   // half-second window
const BURST_THRESHOLD  = 3;     // 3+ events in that window → burst

// In multi-account mode every bot receives the same presence broadcast.
// Suppress identical join/leave logs for a very short window so one event is
// not printed once per account.
const recentPresenceLogs = new Map<string, number>();
const PRESENCE_DEDUPE_MS = 1000;

function isDuplicatePresence(event: "join" | "leave", username: string): boolean {
  const key = `${event}:${username.toLowerCase()}`;
  const now = Date.now();
  const previous = recentPresenceLogs.get(key) ?? 0;
  recentPresenceLogs.set(key, now);
  if (recentPresenceLogs.size > 200) {
    for (const [cachedKey, timestamp] of recentPresenceLogs) {
      if (now - timestamp > PRESENCE_DEDUPE_MS) recentPresenceLogs.delete(cachedKey);
    }
  }
  return now - previous < PRESENCE_DEDUPE_MS;
}

interface BurstTracker {
  timestamps: number[];
  suppressed: Set<string>; // usernames suppressed during the current burst
}

function createBurstTracker(): BurstTracker {
  return { timestamps: [], suppressed: new Set() };
}

function recordBurstEvent(tracker: BurstTracker, username: string): boolean {
  const now = Date.now();
  // Prune old timestamps outside the window
  tracker.timestamps = tracker.timestamps.filter(t => now - t < BURST_WINDOW_MS);
  tracker.timestamps.push(now);

  if (tracker.timestamps.length >= BURST_THRESHOLD) {
    tracker.suppressed.add(username);
    // Cap suppressed set to prevent memory leak on busy servers
    if (tracker.suppressed.size > 50) tracker.suppressed.clear();
    return true; // burst → suppress
  }

  // If this username was already flagged in an ongoing burst, keep suppressing
  if (tracker.suppressed.has(username)) return true;

  // Not a burst — clear any stale suppression set
  if (tracker.timestamps.length <= 1) {
    tracker.suppressed.clear();
  }
  return false;
}

export function registerPlayerEvents(bot: Bot, config: AppConfig) {
  // Single combined tracker — hub NPCs produce a mix of joins + leaves on
  // the same tick, so we need to count them together.
  const playerBurst = createBurstTracker();

  const isInSilencePeriod = () => {
    // Silence for 5 seconds after spawning to avoid initial mass join spam
    return (Date.now() - sharedState.lastSpawnTime) < 5000;
  };

  bot.on("playerJoined", (player) => {
    if (isFirstSpawn(bot)) return;
    if (isInSilencePeriod()) return; // Silent during server transitions
    const cleanName = stripColorCodes(player.username);
    if (cleanName === bot.username) return;
    if (config.filters.hideNPCJoinLeave && isNPCPlayer(cleanName, config.filters.npcPatterns)) {
      return;
    }
    // Suppress hub-NPC burst (many entities joining on the same tick)
    if (config.filters.hideNPCJoinLeave && recordBurstEvent(playerBurst, cleanName)) {
      return;
    }
    
    const msg = chalk.green(`${cleanName} joined the game`);
    if (isDuplicatePresence("join", cleanName)) return;
    if (!sharedState.isJoinApproved) {
      sharedState.messageBuffer.push(`\x00${msg}`); // Hidden marker for system style
      return;
    }
    logger.system(msg);
  });

  bot.on("playerLeft", (player) => {
    if (isInSilencePeriod()) return; // Silent during server transitions
    const cleanName = stripColorCodes(player.username);
    if (cleanName === bot.username) return;
    if (config.filters.hideNPCJoinLeave && isNPCPlayer(cleanName, config.filters.npcPatterns)) {
      return;
    }
    // Suppress hub-NPC burst (many entities leaving on the same tick)
    if (config.filters.hideNPCJoinLeave && recordBurstEvent(playerBurst, cleanName)) {
      return;
    }
    
    const msg = chalk.yellow(`${cleanName} left the game`);
    if (isDuplicatePresence("leave", cleanName)) return;
    if (!sharedState.isJoinApproved) {
      sharedState.messageBuffer.push(`\x00${msg}`); // Hidden marker for system style
      return;
    }
    logger.system(msg);
  });
}
