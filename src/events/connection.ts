import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import { startAntiAFK, stopAntiAFK } from "../utils/antiAfk";
import { handleCommand } from "../commands";
import { centerText, dumpItemJson } from "../utils/helpers";

const SUPPRESSED_PACKET_ERRORS = ["world_particles", "particle", "explosion", "map", "map_chunk", "entity_metadata", "sculk_vibration_signal"];
const TEMPORARY_KICK_PATTERNS = ["thu lai sau", "ket noi that bai", "try again", "later", "unexpected error"];

export let autoCommandTimers: ReturnType<typeof setTimeout>[] = [];
const spawnedBots = new WeakSet<Bot>();
const autoCommandRunningBots = new WeakSet<Bot>();

export function isFirstSpawn(bot: Bot): boolean {
  return !spawnedBots.has(bot);
}

export const reconnectState = {
  temporaryKickStreak: 0,
  nextReconnectDelayMs: null as number | null,
  lastKickReason: "",
};

export const sharedState = {
  isJoinApproved: false,
  messageBuffer: [] as string[],
  lastSpawnTime: 0,
  lastWindowItemsTime: 0,
  lastInventoryPacketTime: 0,
  hideActionBar: false,
  debugChat: false,
  inventorySyncPending: true,
  inventorySyncSource: "startup",
  guiWindowId: null as number | null,
  guiWindowType: null as string | null,
  guiUsable: false,
  maxBufferSize: 100,
  rawGuiWindowId: null as number | null,
  rawGuiTitle: "" as string,
  rawGuiType: null as number | null,
  rawGuiSlots: [] as any[],
  rawGuiContainerSlots: 0,
  hasRawGui: false,
  lastStableInventoryItems: [] as any[],
  lastStableInventorySlots: [] as any[],
  isAutoCmdRunning: false,
  allowFeaturesDuringAutoCmd: false,
  debugInventory: false,
  currentHp: 0,
  maxHp: 0,
  suppressGuiUntil: 0,
};

// --- Utilities ---

import { extractChatText } from "../utils/helpers";

export function logFeatureStatus(bot: Bot, config: AppConfig, isPaused: boolean) {
  const features = (bot as any).featuresConfig;
  const status = isPaused ? chalk.yellow("PAUSED") : chalk.green("ACTIVE");
  logger.info(chalk.hex("#A78BFA")("[System]"), chalk.gray(`AutoCommands ${isPaused ? "started" : "finished"}. Feature status:`));
  
  if (config.antiAFK?.enabled) {
    logger.info(chalk.hex("#A78BFA")(" ├─"), chalk.cyan("[AntiAFK]"), status);
  }
  
  if (features) {
    for (const [key, val] of Object.entries(features)) {
      if (val && typeof val === "object" && (val as any).enabled) {
        logger.info(chalk.hex("#A78BFA")(" ├─"), chalk.cyan(`[${key}]`), status);
      }
    }
  }
}

function formatMcText(obj: any): string {
  return extractChatText(obj);
}

// --- Reconnect Logic ---

export function consumeReconnectDelayOverride() {
  const delay = reconnectState.nextReconnectDelayMs;
  reconnectState.nextReconnectDelayMs = null;
  return delay;
}

export function resetReconnectBackoff() {
  reconnectState.temporaryKickStreak = 0;
  reconnectState.nextReconnectDelayMs = null;
}

export function markReconnectCooldown(reason: string, baseDelay: number): number | null {
  reconnectState.lastKickReason = reason;
  const folded = reason.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!TEMPORARY_KICK_PATTERNS.some(p => folded.includes(p))) {
    resetReconnectBackoff();
    return null;
  }
  reconnectState.temporaryKickStreak++;
  reconnectState.nextReconnectDelayMs = Math.min(Math.max(baseDelay, 5000) * (reconnectState.temporaryKickStreak > 3 ? 2 : 1), 60000);
  return reconnectState.nextReconnectDelayMs;
}

// --- GUI & Inventory State ---

export function resetGuiState(reason: string = "unknown") {
  if (sharedState.debugInventory) {
    const stack = new Error().stack?.split("\n").slice(2, 4).map(s => s.trim()).join(" -> ");
    logger.system(
      chalk.hex("#F87171")(`[GuiDbg] resetGuiState reason=${reason} stack=[${stack}] rawId=${sharedState.rawGuiWindowId} guiUsable=${sharedState.guiUsable}`)
    );
  }
  sharedState.guiWindowId = sharedState.rawGuiWindowId = null;
  sharedState.guiUsable = sharedState.hasRawGui = false;
  sharedState.rawGuiSlots = [];
}

export function markGuiOpen(window: any) {
  sharedState.guiWindowId = window?.id ?? null;
  sharedState.guiWindowType = window?.type ?? null;
  sharedState.guiUsable = true;
}

export function markInventorySyncPending(source: string) {
  sharedState.inventorySyncPending = true;
  sharedState.inventorySyncSource = source;
}

export function markInventorySyncComplete(source: string) {
  sharedState.inventorySyncPending = false;
  sharedState.inventorySyncSource = source;
}

export function hasUsableCurrentWindow(bot: Bot): boolean {
  return (!!(bot as any).currentWindow && sharedState.guiUsable) || sharedState.hasRawGui;
}

export function closeRawGui(bot: Bot): void {
  const wid = sharedState.rawGuiWindowId;
  if (wid != null) {
    try {
      const client = (bot as any)._client;
      if (client) client.write("close_window", { windowId: wid });
    } catch { }
  }
}

// --- Main Event Handlers ---

export function registerConnectionEvents(bot: Bot, config: AppConfig) {
  const client = (bot as any)._client;
  if (!client) return;

  sharedState.debugChat = !!config.debug?.enabled;
  sharedState.debugInventory = !!config.debug?.enabled && !!config.debug?.logInventory;
  resetGuiState("init");

  // Patch close_window listener on the raw client to prevent mineflayer's bug
  // where a close_window packet for an OLD window closes the NEW window.
  const closeWindowListeners = client.listeners("close_window");
  for (const listener of closeWindowListeners) {
    client.removeListener("close_window", listener);
    client.on("close_window", (packet: any) => {
      const packetWid = packet.windowId ?? packet.id;
      if (bot.currentWindow && packetWid !== undefined && packetWid !== bot.currentWindow.id) {
        if (config.debug?.enabled) {
          logger.debug(
            chalk.hex("#C084FC")("[InvDbg] ") +
            chalk.gray(`Ignoring close_window packet for window ID ${packetWid} (current is ${bot.currentWindow.id})`)
          );
        }
        return;
      }
      listener(packet);
    });
  }

  // Packet Listeners
  client.on("window_items", (packet: any) => {
    const now = Date.now();
    sharedState.lastInventoryPacketTime = now;
    if (packet.windowId === 0) {
      sharedState.lastWindowItemsTime = now;
      markInventorySyncComplete("window_items");
    }
    if (sharedState.hasRawGui && packet.windowId === sharedState.rawGuiWindowId) {
      const limit = Math.min(packet.items.length, sharedState.rawGuiContainerSlots);
      for (let i = 0; i < limit; i++) sharedState.rawGuiSlots[i] = packet.items[i];
    }
  });

  client.on("set_slot", (packet: any) => {
    sharedState.lastInventoryPacketTime = Date.now();
    if (packet.windowId === 0) markInventorySyncComplete(`set_slot:${packet.slot}`);
    if (sharedState.hasRawGui && packet.windowId === sharedState.rawGuiWindowId && packet.slot < sharedState.rawGuiContainerSlots) {
      sharedState.rawGuiSlots[packet.slot] = packet.item;
    }
  });

  const onOpen = (packet: any) => {
    const wid = packet.windowId ?? packet.syncId ?? packet.id;
    if (typeof wid === "number" && wid > 0) {
      if (sharedState.suppressGuiUntil > 0 && Date.now() < sharedState.suppressGuiUntil) {
        if (sharedState.debugInventory) {
          logger.system(chalk.hex("#F87171")(`[GuiDbg] Suppressing raw GUI (suppressGuiUntil active) for wid=${wid}`));
        }
        try {
          client.write("close_window", { windowId: wid });
        } catch {}
        return;
      }
      if (sharedState.debugInventory) {
        logger.system(chalk.hex("#34D399")(`[GuiDbg] open_window/open_screen packet: wid=${wid} title="${formatMcText(packet.windowTitle ?? packet.title ?? packet.name)}" slots=${packet.slotCount ?? packet.slots ?? 0}`));
      }
      sharedState.rawGuiWindowId = wid;
      sharedState.rawGuiTitle = formatMcText(packet.windowTitle ?? packet.title ?? packet.name);
      sharedState.rawGuiContainerSlots = packet.slotCount ?? packet.slots ?? 0;
      sharedState.rawGuiSlots = new Array(sharedState.rawGuiContainerSlots).fill(null);
      sharedState.hasRawGui = sharedState.guiUsable = true;
    }
  };
  client.on("open_window", onOpen);
  client.on("open_screen", onOpen);
  client.on("close_window", (p: any) => { 
    const pWid = p.windowId ?? p.id;
    if (sharedState.debugInventory) {
      logger.system(chalk.hex("#F87171")(`[GuiDbg] close_window packet: wid=${pWid}`));
    }
    if (pWid === sharedState.rawGuiWindowId) resetGuiState("close_window_packet"); 
  });

  // Lifecycle Events
  bot.on("login", async () => {
    logger.stopSpinner("Authenticated successfully");
    logger.info(chalk.white("Logged in as"), chalk.hex("#FBBF24").bold(bot.username));
    markInventorySyncPending("bot_login");
    resetGuiState("login_event");

    if (config.bot.promptBeforeJoin) {
      const answer = (await logger.ask("Ready to join the world? (y/n/skip)")).toLowerCase();
      if (answer === "n" || answer === "no") {
        logger.info(chalk.yellow("Join cancelled. Disconnecting..."));
        bot.end();
        process.exit(0);
      }
      sharedState.isJoinApproved = true;
      replayBufferedMessages();
    } else {
      sharedState.isJoinApproved = true;
      sharedState.messageBuffer = [];
    }
  });

  bot.on("spawn", () => {
    if (isFirstSpawn(bot)) {
      spawnedBots.add(bot);
      handleFirstSpawn(bot, config);
    }
    sharedState.lastSpawnTime = Date.now();

    if (!config.bot.promptBeforeJoin && sharedState.messageBuffer.length > 0) {
      replayBufferedMessages();
    }
  });

  bot.on("kicked", (reason) => {
    // Debug raw reason as requested
    console.log(chalk.red.bold("\n[KICK DEBUG RAW]"), JSON.stringify(reason, null, 2));

    const displayReason = formatMcText(reason);
    logger.warn(chalk.red("Kicked:"), chalk.yellow(displayReason));
    markReconnectCooldown(displayReason, config.reconnect.delay);
    stopAntiAFK();
    resetGuiState("kicked_event");
    sharedState.isJoinApproved = false;
    sharedState.messageBuffer = [];
  });

  bot.on("end", (reason) => {
    logger.warn(chalk.yellow("Connection ended:"), chalk.gray(reason ?? "unknown"));
    stopAntiAFK();
    resetGuiState("end_event");
    // Do not retain item/NBT snapshots from the previous bot lifecycle.
    // They are only a fallback for a briefly stale inventory after transfer.
    sharedState.lastStableInventoryItems = [];
    sharedState.lastStableInventorySlots = [];
    spawnedBots.delete(bot);
    sharedState.isJoinApproved = false;
    sharedState.messageBuffer = [];
    sharedState.isAutoCmdRunning = false; // Reset to prevent race condition on reconnect
  });
}

function replayBufferedMessages() {
  if (sharedState.messageBuffer.length === 0) return;
  logger.separator();
  logger.system(centerText(chalk.hex("#A78BFA").bold(`[ Replaying Missed Messages (${sharedState.messageBuffer.length}) ]`)));
  sharedState.messageBuffer.forEach(msg => {
    if (msg.startsWith("\x00")) logger.system(msg.slice(1));
    else logger.chat(msg);
  });
  logger.separator();
  sharedState.messageBuffer = [];
  sharedState.isJoinApproved = true;
}

function waitForSkyblockReady(bot: Bot, signal: AbortSignal, timeoutMs = 60000): Promise<boolean> {
  const readyMarkers = [
    "[skyblock free]",
    "xin chào!",
    "hay xay dung the gioi cua ban",
    "hãy xây dựng thế giới của bạn",
  ];

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const finish = (value?: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      bot.removeListener("message", onMessage);
      bot.removeListener("messagestr", onMessageString);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value === true);
    };
    const matches = (value: unknown): boolean => {
      const text = String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      return readyMarkers.some((marker) => text.includes(marker));
    };
    const armTimeout = (duration: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(false), duration);
    };
    const onMessage = (message: any, position?: any) => {
      if (position === "game_info" || position === "actionbar" || position === 2) return;
      const text = formatMcText(message);
      if (matches(text)) {
        finish(true);
        return;
      }
      // Queue countdowns can last longer than the normal transfer timeout.
      // Keep waiting while the server is still actively reporting the queue.
      const folded = text.toLowerCase();
      if (folded.includes("[freeskyblock]") && (folded.includes("[#") || folded.includes("hàng đợi") || folded.includes("queue"))) {
        armTimeout(60000);
      }
    };
    const onMessageString = (message: string, position?: any) => {
      if (position === "game_info" || position === "actionbar" || position === 2) return;
      if (matches(message)) {
        finish(true);
        return;
      }
      const folded = message.toLowerCase();
      if (folded.includes("[freeskyblock]") && (folded.includes("[#") || folded.includes("hàng đợi") || folded.includes("queue"))) {
        armTimeout(60000);
      }
    };
    const onAbort = () => finish(undefined, new Error("aborted"));

    bot.on("message", onMessage);
    bot.on("messagestr", onMessageString);
    signal.addEventListener("abort", onAbort, { once: true });
    armTimeout(timeoutMs);
  });
}

function waitForMenuReady(bot: Bot, signal: AbortSignal, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: boolean) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const poll = () => {
      if (signal.aborted || !bot.entity) return finish(false);
      const window = bot.currentWindow as any;
      const slots = window?.slots;
      if (window && Array.isArray(slots) && slots.length > 0) return finish(true);
      if (Date.now() - startedAt >= timeoutMs) return finish(false);
      timer = setTimeout(poll, 50);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    poll();
  });
}

async function handleFirstSpawn(bot: Bot, config: AppConfig) {
  if (autoCommandRunningBots.has(bot)) return;
  autoCommandRunningBots.add(bot);
  sharedState.isAutoCmdRunning = true;

  // Abort controller: cancels all pending sleeps immediately when bot disconnects.
  // Prevents zombie timeouts from blocking the next connection attempt.
  const ac = new AbortController();
  const { signal } = ac;

  bot.once("end", () => { ac.abort(); });

  const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });

  try {
    if (config.autoLogin.enabled && config.autoLogin.command) {
      await sleep(config.autoLogin.delay);
      if (!bot.entity || signal.aborted) return;
      bot.chat(config.autoLogin.command);
      logger.info(chalk.hex("#A78BFA")("AutoLogin:"), chalk.gray("Sent login command"));
    }

    if (config.autoCommands.enabled) {
      logFeatureStatus(bot, config, true);
      // Initial delay after login/spawn
      await sleep(1000);

      for (let entryIndex = 0; entryIndex < config.autoCommands.onSpawn.length; entryIndex++) {
        const entry = config.autoCommands.onSpawn[entryIndex];
        if (!bot.entity || signal.aborted) break;
        await sleep(entry.delay);
        if (!bot.entity || signal.aborted) break;
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
                  if (!bot.entity || signal.aborted) break;
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
              // /use 4 opens the lobby selector asynchronously. Wait for the
              // actual synchronized Mineflayer window before /click 20.
              if (entry.command.trim().toLowerCase() === "/click 20") {
                const clickCurrentMenuSlot20 = async (): Promise<boolean> => {
                  try {
                    const window = bot.currentWindow as any;
                    if (!window?.slots || window.slots.length <= 20) throw new Error("slot 20 chưa đồng bộ");
                    await bot.clickWindow(20, 0, 0);
                    logger.info(chalk.green("AutoCmd:"), "Clicked slot 20 for this account.");
                    return true;
                  } catch (err) {
                    logger.warn(chalk.yellow("AutoCmd:"), `Không click được slot 20: ${(err as Error)?.message ?? err}`);
                    return false;
                  }
                };

                let menuReady = await waitForMenuReady(bot, signal, 6000);
                for (let menuAttempt = 1; !menuReady && menuAttempt <= 3; menuAttempt++) {
                  if (!bot.entity || signal.aborted) break;
                  logger.warn(chalk.yellow("AutoCmd:"), `Menu chưa đồng bộ, gửi lại /use 4 (${menuAttempt}/3)`);
                  await handleCommand("/use 4", bot, config, () => { }, () => { });
                  menuReady = await waitForMenuReady(bot, signal, 6000);
                }
                if (!menuReady) {
                  logger.warn(chalk.yellow("AutoCmd:"), "Không mở được menu lobby sau 3 lần; chưa click slot 20.");
                  break;
                }

                // Do not route this automatic click through the interactive
                // ClickCommand. It uses shared GUI state for the terminal;
                // in multi mode another account can overwrite that state.
                // Click the window owned by this bot instance directly.
                let clicked = false;
                for (let clickAttempt = 1; clickAttempt <= 3 && !clicked; clickAttempt++) {
                  if (!bot.entity || signal.aborted) break;
                  clicked = await clickCurrentMenuSlot20();
                  if (!clicked && clickAttempt < 3) {
                    await handleCommand("/use 4", bot, config, () => { }, () => { });
                    await waitForMenuReady(bot, signal, 6000);
                  }
                }
                if (!clicked) break;
              } else {
                await handleCommand(entry.command, bot, config, () => { }, () => { });
              }
              if (entry.timeoutMs) {
                await sleep(entry.timeoutMs);
              }

              // /click 20 transfers from the lobby to the selected cluster.
              // A fixed delay is unreliable: the server may still be in its
              // queue/transfer screen. Confirm the cluster welcome text before
              // allowing the next command (normally /home) to run.
              if (entry.command.trim().toLowerCase() === "/click 20") {
                let ready = false;
                for (let attempt = 1; attempt <= 10 && !ready; attempt++) {
                  ready = await waitForSkyblockReady(bot, signal, 60000);
                  if (!ready && attempt < 10 && bot.entity && !signal.aborted) {
                    logger.warn(chalk.yellow("AutoCmd:"), `Chưa xác nhận vào cụm, retry click slot 20 (${attempt}/10)`);
                    const retryMenuReady = await waitForMenuReady(bot, signal, 6000);
                    if (retryMenuReady) await clickCurrentMenuSlot20();
                    else await handleCommand("/use 4", bot, config, () => { }, () => { });
                  }
                }
                if (!ready) {
                  logger.warn(chalk.yellow("AutoCmd:"), "Không nhận được tín hiệu SKYBLOCK FREE sau 10 lần click; bỏ qua /home lần này.");
                  break;
                }
                logger.info(chalk.green("AutoCmd:"), "Đã xác nhận vào SKYBLOCK FREE; tiếp tục chuỗi lệnh.");
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
    }
  } catch (err) {
    // AbortError is expected when bot disconnects during command chain
    if ((err as Error).message !== "aborted") {
      logger.error(chalk.red("AutoCmd:"), `Unexpected error: ${(err as Error).message}`);
    }
  } finally {
    autoCommandRunningBots.delete(bot);
    if (sharedState.isAutoCmdRunning) {
      sharedState.isAutoCmdRunning = false;
      sharedState.allowFeaturesDuringAutoCmd = false;
      logFeatureStatus(bot, config, false);
    }
  }

  // Only start anti-AFK and intervals if bot is still alive
  if (signal.aborted || !bot.entity) return;

  startAntiAFK(bot, config);

  // Periodic Memory Cleanup & Auto-Clear Console
  // Guard: only create ONE set of intervals per bot lifecycle
  const gcInterval = setInterval(() => {
    try {
      if (typeof global.gc === "function") {
        global.gc();
      }
    } catch { }
  }, 5 * 60 * 1000); // Every 5 minutes

  const clearTimer = setInterval(() => {
    logger.info(chalk.gray("Periodic console cleanup..."));
    logger.clear();
  }, 60 * 60 * 1000); // Every 1 hour

  // Use once() to ensure cleanup happens exactly once and intervals are not leaked
  bot.once("end", () => {
    clearInterval(gcInterval);
    clearInterval(clearTimer);
    sharedState.isAutoCmdRunning = false; // Ensure reset even if async code is still pending
  });
}
