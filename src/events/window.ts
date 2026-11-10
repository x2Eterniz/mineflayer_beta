import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import { stripColorCodes, getItemDisplayName, extractChatText, dumpItemJson } from "../utils/helpers";
import { sharedState, markGuiOpen, resetGuiState } from "./connection";

const DBG_TAG = chalk.hex("#C084FC")("[InvDbg]");
const GUI_SYNC_TIMEOUT_MS = 200;
const GUI_POST_SPAWN_SYNC_TIMEOUT_MS = 800;
const POST_SPAWN_WINDOW_GRACE_MS = 2000;

export function registerWindowEvents(bot: Bot, config: AppConfig) {
  let hasOpenedGUI = false;
  let pendingWindow: any = null;
  let inventoryReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let rawRenderTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForWindow = false;
  let cleanupWindowListener: (() => void) | null = null;
  let botAlive = true;
  bot.on("end", () => { botAlive = false; });

  function renderWindow(window: any) {
    try {
      let title = "Inventory";
      const rawTitle = (window as any).title || (window as any).jsonTitle;
      if (rawTitle) {
        try {
          const extracted = extractChatText(rawTitle);
          if (extracted && extracted !== "[object Object]") {
            title = extracted;
          } else if (typeof rawTitle === "string") {
            title = rawTitle;
          }
        } catch {
          title = typeof rawTitle === "string" ? rawTitle : "Inventory";
        }
      }
      title = stripColorCodes(title);

      // Always render the GUI grid when a window is opened so the user can interact
      const containerSlotsCount = window.inventoryStart ?? 0;
      const totalSlots = window.slots?.length ?? 0;
      const filledSlots = window.slots?.filter((s: any) => s != null).length ?? 0;
      
      logger.separator();
      logger.system(chalk.hex("#60A5FA").bold(`[ GUI ] ${title}`));
      logger.system("");

      const rows = Math.ceil(containerSlotsCount / 9);
      if (containerSlotsCount > 0) {
        for (let r = 0; r < rows; r++) {
          let rowStr = "  ";
          for (let c = 0; c < 9; c++) {
            const slotIdx = r * 9 + c;
            if (slotIdx >= containerSlotsCount) break;
            const item = window.slots[slotIdx];
            rowStr += (item ? chalk.bgGreen.black(` ${slotIdx.toString().padStart(2, "0")} `) : chalk.bgWhite.black(` ${slotIdx.toString().padStart(2, "0")} `)) + " ";
          }
          logger.system(rowStr);
        }
        logger.system("");
      }

      const items = window.slots.filter((item: any, idx: number) => item != null && idx < containerSlotsCount);
      if (items.length > 0) {
        items.forEach((item: any) => {
          const count = item.count > 1 ? `x${item.count} ` : "";
          logger.system(chalk.gray(` [${item.slot.toString().padStart(2, "0")}] `) + chalk.white(`${count}${getItemDisplayName(item)}`));
        });
      }
      logger.separator();
    } catch (err) {
    }
  }

  function flushPendingWindow(trigger: string = "unknown") {
    clearTimers();
    waitingForWindow = false;
    if (!botAlive) return;
    if (pendingWindow) {
      const win = pendingWindow;
      pendingWindow = null;
      renderWindow(win);
    }
  }

  function clearTimers() {
    if (inventoryReadyTimer) { clearTimeout(inventoryReadyTimer); inventoryReadyTimer = null; }
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (cleanupWindowListener) { cleanupWindowListener(); cleanupWindowListener = null; }
    if (rawRenderTimer) { clearTimeout(rawRenderTimer); rawRenderTimer = null; }
  }

  function cancelPending() { clearTimers(); pendingWindow = null; waitingForWindow = false; }

  bot.on("windowOpen", (window) => {
    if (!window) return;
    if (sharedState.debugInventory) {
      logger.system(chalk.hex("#34D399")(`[GuiDbg] windowOpen event: id=${window.id} type=${window.type} slotsCount=${window.slots?.length}`));
    }

    // If AutoSkill (or other features) set a suppress window, auto-close this GUI
    // without rendering. This handles the async case where activateItem() triggers
    // a server-side GUI (e.g. "Xác nhận ăn trái ác quỷ") that arrives after the
    // skill has already finished casting.
    if (sharedState.suppressGuiUntil > 0 && Date.now() < sharedState.suppressGuiUntil) {
      if (sharedState.debugInventory) {
        logger.system(chalk.hex("#F87171")(`[GuiDbg] Suppressing GUI (suppressGuiUntil active)`));
      }
      try { bot.closeWindow(window); } catch {}
      resetGuiState("suppressed_gui");
      return;
    }

    hasOpenedGUI = true;
    cancelPending();
    markGuiOpen(window);
    pendingWindow = window;
    waitingForWindow = true;

    const isPostSpawn = (Date.now() - sharedState.lastSpawnTime) < POST_SPAWN_WINDOW_GRACE_MS;
    const syncTimeout = isPostSpawn ? GUI_POST_SPAWN_SYNC_TIMEOUT_MS : GUI_SYNC_TIMEOUT_MS;

    let slotUpdateCount = 0;
    const onWindowSlotUpdate = () => {
      if (!pendingWindow || pendingWindow !== window) return;
      slotUpdateCount++;
      if (slotUpdateCount === 1) {
        if (batchTimer) clearTimeout(batchTimer);
        batchTimer = setTimeout(() => {
          batchTimer = null;
          if (pendingWindow === window) flushPendingWindow("slotUpdate-batch");
        }, 50);
      }
    };

    if (typeof window.on === "function") {
      (window as any).on("updateSlot", onWindowSlotUpdate);
      cleanupWindowListener = () => { try { (window as any).removeListener("updateSlot", onWindowSlotUpdate); } catch {} };
    }

    inventoryReadyTimer = setTimeout(() => {
      if (pendingWindow) flushPendingWindow("fallback-timeout");
    }, syncTimeout);
  });

  bot.on("windowClose", (window) => {
    const wId = window?.id ?? "null";
    if (sharedState.debugInventory) {
      logger.system(chalk.hex("#F87171")(`[GuiDbg] windowClose event: id=${wId}, current rawId=${sharedState.rawGuiWindowId}`));
    }
    if (window && sharedState.rawGuiWindowId !== null && window.id !== sharedState.rawGuiWindowId) {
      if (sharedState.debugInventory) {
        logger.system(chalk.gray(`[GuiDbg] Ignoring windowClose event for mismatching id ${window.id}`));
      }
      return;
    }
    cancelPending();
    resetGuiState("windowClose_event");
    if (hasOpenedGUI) {
      hasOpenedGUI = false;
    }
  });

  bot.on("end", () => { cancelPending(); hasOpenedGUI = false; resetGuiState("end_event_window"); });
}
