import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import chalk from "chalk";
import { logger } from "../logger";
import { installDigTimeFix } from "../utils/digTimeFix";
import { queueBlockDig, getPacketIntervalMs, setPacketIntervalMs } from "../utils/digPacketLimiter";
import { loadConfig, saveConfig } from "../config";

// ── updatePrompt import (lazy, tránh circular dependency) ──────────────────
let _updatePrompt: (() => void) | null = null;
export function registerUpdatePrompt(fn: () => void) {
  _updatePrompt = fn;
}
function callUpdatePrompt() {
  try {
    if (_updatePrompt) _updatePrompt();
  } catch { /* ignore */ }
}

// ── State tracking ─────────────────────────────────────────────────────────
let isHoldingUse = false;
let isHoldingSwing = false;
let isHoldingAttack = false;
let isDigging = false;

let useInterval: ReturnType<typeof setInterval> | null = null;
let swingInterval: ReturnType<typeof setInterval> | null = null;
let attackInterval: ReturnType<typeof setInterval> | null = null;
let digAbortController: AbortController | null = null;

// ── Safe blockAtCursor: kiểm tra world sẵn sàng trước khi raycast ──────────
// bot.blockAtCursor() là hàm ĐỒNG BỘ dùng RaycastIterator. Nếu chunks chưa
// load (sau server transfer), vòng lặp raycast chạy qua hàng triệu vị trí
// trống mà không bao giờ tìm thấy block → block hoàn toàn event loop → treo cmd.
function safeBlockAtCursor(bot: Bot, maxRange: number) {
  // 1. Kiểm tra entity tồn tại và yaw/pitch hợp lệ
  if (
    !bot.entity ||
    typeof bot.entity.yaw !== "number" ||
    typeof bot.entity.pitch !== "number" ||
    Number.isNaN(bot.entity.yaw) ||
    Number.isNaN(bot.entity.pitch)
  ) {
    return null;
  }

  // 2. Kiểm tra world & chunk tại vị trí bot đã load chưa
  //    Nếu chunk ngay dưới chân bot chưa load thì chắc chắn raycast sẽ fail
  try {
    const pos = bot.entity.position;
    const world = (bot as any).world;
    if (!world) return null;

    // getColumnAt trả null nếu chunk chưa load
    const column = world.getColumnAt?.(pos) ?? world.async?.getLoadedColumnAt?.(pos);
    if (!column) return null;
  } catch {
    return null;
  }

  // 3. Gọi blockAtCursor bình thường — chunk đã load nên raycast sẽ nhanh
  try {
    return bot.blockAtCursor(maxRange);
  } catch {
    return null;
  }
}

function getLookTarget(bot: Bot, maxRange = 5) {
  if (
    !bot.entity ||
    typeof bot.entity.yaw !== "number" ||
    typeof bot.entity.pitch !== "number" ||
    Number.isNaN(bot.entity.yaw) ||
    Number.isNaN(bot.entity.pitch)
  ) {
    return null;
  }

  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  const eyePos = bot.entity.position.offset(0, bot.entity.height, 0);
  const lookDir = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  );

  const entity = bot.nearestEntity((e) => {
    if (e.type !== "player" && e.type !== "mob" && e.type !== "object") return false;
    const entityPos = e.position.offset(0, e.height / 2, 0);
    const dist = eyePos.distanceTo(entityPos);
    if (dist > maxRange) return false;
    const toEntity = entityPos.minus(eyePos).normalize();
    return lookDir.dot(toEntity) > 0.95;
  });

  if (entity) return { type: "entity" as const, target: entity };
  const block = safeBlockAtCursor(bot, maxRange);
  if (block) return { type: "block" as const, target: block };
  return null;
}

// ── /use command ───────────────────────────────────────────────────────────
export const UseCommand = {
  execute: async (bot: Bot, args: string[]) => {
    // Reconnect có thể làm socket/entity biến mất ngay giữa lúc lệnh được
    // gửi. Mineflayer's activateItem() đọc bot.entity.yaw trực tiếp, nên
    // phải chặn race này trước khi gọi use.
    if (!bot.entity || !(bot as any)._client) {
      logger.warn(chalk.yellow("Use:"), "Bot chưa ở trạng thái play, bỏ qua /use.");
      return;
    }
    const isHold = args[0]?.toLowerCase() === "hold";
    const slotArg = isHold ? args[1] : args[0];
    if (slotArg !== undefined && /^\d+$/.test(slotArg)) {
      const slot = Number(slotArg);
      if (!Number.isInteger(slot) || slot < 0 || slot > 8) {
        logger.system(chalk.red("Hotbar slot must be 0-8."));
        return;
      }
      bot.setQuickBarSlot(slot);
    }
    try {
      const look = getLookTarget(bot);

      if (look?.type === "entity") {
        bot.activateEntity(look.target);
        logger.system(chalk.green("Executed Right Click (Entity)."));
      } else if (look?.type === "block") {
        bot.activateBlock(look.target);
        logger.system(chalk.green("Executed Right Click (Block)."));
      } else if (bot.entity) {
        bot.activateItem();
        logger.system(chalk.green("Executed Right Click (Item)."));
      }
    } catch (err) {
      logger.warn(chalk.yellow("Use:"), `Bỏ qua /use do reconnect: ${(err as Error)?.message ?? err}`);
      return;
    }

    if (isHold) {
      if (isHoldingUse) return;
      isHoldingUse = true;

      useInterval = setInterval(() => {
        try {
          const target = getLookTarget(bot);
          if (target?.type === "entity") {
            bot.activateEntity(target.target);
          } else if (target?.type === "block") {
            bot.activateBlock(target.target);
          } else {
            bot.activateItem();
          }
        } catch {
          UseCommand.stop(bot);
        }
      }, 250);

      logger.system(chalk.green("Started holding Use."));
    }
  },
  stop: (bot: Bot) => {
    if (!isHoldingUse) return;
    isHoldingUse = false;
    if (useInterval) {
      clearInterval(useInterval);
      useInterval = null;
    }
    bot.deactivateItem();
    logger.system(chalk.yellow("Stopped holding Use."));
  },
};

// ── /swing command ─────────────────────────────────────────────────────────
export const SwingCommand = {
  execute: async (bot: Bot, args: string[]) => {
    const isHold = args[0]?.toLowerCase() === "hold";

    bot.swingArm(undefined);
    logger.system(chalk.green("Swung arm."));

    if (isHold) {
      if (isHoldingSwing) return;
      isHoldingSwing = true;

      swingInterval = setInterval(() => {
        try {
          bot.swingArm(undefined);
        } catch {
          SwingCommand.stop(bot);
        }
      }, 250);

      logger.system(chalk.green("Started holding Swing."));
    }
  },
  stop: (bot: Bot) => {
    if (!isHoldingSwing) return;
    isHoldingSwing = false;
    if (swingInterval) {
      clearInterval(swingInterval);
      swingInterval = null;
    }
    logger.system(chalk.yellow("Stopped holding Swing."));
  },
};

// ── /attack command ────────────────────────────────────────────────────────
export const AttackCommand = {
  execute: async (bot: Bot, args: string[]) => {
    const isHold = args[0]?.toLowerCase() === "hold";

    const look = getLookTarget(bot);
    if (look?.type === "entity") {
      bot.attack(look.target);
      logger.system(chalk.green("Attacked entity."));
    } else {
      bot.swingArm(undefined);
      logger.system(chalk.yellow("No entity in range — swung arm."));
    }

    if (isHold) {
      if (isHoldingAttack) return;
      isHoldingAttack = true;

      attackInterval = setInterval(() => {
        try {
          const target = getLookTarget(bot);
          if (target?.type === "entity") {
            bot.attack(target.target);
          } else {
            bot.swingArm(undefined);
          }
        } catch {
          AttackCommand.stop(bot);
        }
      }, 600);

      logger.system(chalk.green("Started holding Attack."));
    }
  },
  stop: (bot: Bot) => {
    if (!isHoldingAttack) return;
    isHoldingAttack = false;
    if (attackInterval) {
      clearInterval(attackInterval);
      attackInterval = null;
    }
    logger.system(chalk.yellow("Stopped holding Attack."));
  },
};

// ── /dig command ───────────────────────────────────────────────────────────
const digTimePatchedBots = new WeakSet<Bot>();
function patchDigTime(bot: Bot) {
  if (digTimePatchedBots.has(bot)) return;
  digTimePatchedBots.add(bot);
  installDigTimeFix(bot);
}

async function rawDig(bot: Bot, block: any, signal: AbortSignal): Promise<void> {
  const client = (bot as any)._client;
  if (!client?.write) throw new Error("Cannot access internal client");

  const pos = block.position;
  const face = 1;

  bot.swingArm(undefined);
  await queueBlockDig(client, 0, pos, face, 0);

  let digTime = 50;
  try {
    digTime = bot.digTime(block);
    if (Number.isNaN(digTime) || !isFinite(digTime)) digTime = 2000;
  } catch {
    const hardness = block?.hardness ?? 1;
    digTime = hardness < 0 ? 50 : Math.max(50, Math.round(hardness * 800));
  }
  digTime = Math.min(Math.max(50, digTime), 10000);

  const startTime = Date.now();
  while (Date.now() - startTime < digTime) {
    if (signal.aborted) {
      await queueBlockDig(client, 1, pos, face, 0);
      throw new Error("Dig interrupted");
    }
    bot.swingArm(undefined);
    await new Promise((r) =>
      setTimeout(r, Math.min(200, digTime - (Date.now() - startTime)))
    );
  }

  bot.swingArm(undefined);
  await queueBlockDig(client, 2, pos, face, 0);
}

// FIX CHÍNH: Wrap bot.dig() với forceLook=true + cleanup abort listener đúng cách
async function digOneBlock(bot: Bot, block: any, signal: AbortSignal): Promise<void> {
  let digTimeEst = 50;
  try {
    digTimeEst = bot.digTime(block);
    if (Number.isNaN(digTimeEst) || !isFinite(digTimeEst)) digTimeEst = 2000;
  } catch {
    const hardness = (block as any)?.hardness ?? 1;
    digTimeEst = hardness < 0 ? 50 : Math.max(50, Math.round(hardness * 800));
  }
  digTimeEst = Math.min(Math.max(50, digTimeEst), 10000);

  // Buffer 2s thay vì 3s — tránh treo quá lâu
  const timeoutMs = digTimeEst + 2000;

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("abort"));
      return;
    }

    let isDone = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      isDone = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // FIX: Luôn remove abort listener để tránh memory leak
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (isDone) return;
      cleanup();
      try { bot.stopDigging(); } catch { /* ignore */ }
      reject(new Error("abort"));
    };

    signal.addEventListener("abort", onAbort);

    timer = setTimeout(() => {
      if (isDone) return;
      cleanup();
      try { bot.stopDigging(); } catch { /* ignore */ }
      reject(new Error("timeout"));
    }, timeoutMs);

    // FIX CHÍNH: forceLook=true — bot tự nhìn vào block, không bị treo chờ
    bot.dig(block, true)
      .then(() => {
        if (isDone) return;
        cleanup();
        resolve();
      })
      .catch((err: Error) => {
        if (isDone) return;
        cleanup();
        reject(err);
      });
  });
}

export const DigCommand = {
  execute: async (bot: Bot, args: string[]) => {
    const firstArg = args[0]?.toLowerCase();
    const isHold = firstArg === "hold";
    const blockCount = !isHold && firstArg ? parseInt(firstArg, 10) : 1;
    const maxBlocks = isHold
      ? Infinity
      : isNaN(blockCount)
      ? 1
      : Math.min(Math.max(blockCount, 1), 6);

    if (isDigging) {
      logger.system(chalk.yellow("Already digging! Use /stop to cancel."));
      return;
    }

    patchDigTime(bot);

    // FIX: set isDigging=false trước khi abort trong stop() — đặt true ở đây
    digAbortController = new AbortController();
    const signal = digAbortController.signal;
    isDigging = true;

    // FIX: Chỉ khai báo tag 1 lần
    const tag = chalk.hex("#F59E0B")("[Dig]");

    try {
      let blocksDigged = 0;

      while (blocksDigged < maxBlocks) {
        if (signal.aborted || !bot.entity) break;

        const block = safeBlockAtCursor(bot, 6);
        if (
          !block ||
          block.name === "air" ||
          block.name === "cave_air" ||
          block.name === "void_air"
        ) {
          if (isHold) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          logger.system(chalk.yellow(`${tag} No breakable block in range.`));
          break;
        }

        try {
          await digOneBlock(bot, block, signal);
          blocksDigged++;
          if (isHold) await new Promise((r) => setTimeout(r, 100));
        } catch (digErr) {
          const msg = (digErr as Error).message ?? "";
          if (msg === "abort" || msg.includes("interrupt") || signal.aborted) break;

          // Fallback: raw packets
          try {
            await rawDig(bot, block, signal);
            blocksDigged++;
            if (isHold) await new Promise((r) => setTimeout(r, 100));
          } catch (rawErr) {
            const rawMsg = (rawErr as Error).message ?? "";
            if (rawMsg.includes("interrupt") || rawMsg.includes("abort") || signal.aborted) break;
            // Server từ chối — chờ 1s rồi thử lại
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }

      if (blocksDigged > 0 && !signal.aborted) {
        logger.system(chalk.green(`${tag} Finished — broke ${blocksDigged} block(s).`));
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.system(chalk.red(`${tag} Error: ${(err as Error).message}`));
      }
    } finally {
      isDigging = false;
      digAbortController = null;
      // FIX: Không dùng require() trong finally nữa — gọi qua hàm đã register
      callUpdatePrompt();
    }
  },

  stop: (bot: Bot) => {
    if (!isDigging && !digAbortController) return;
    // FIX: Set isDigging=false TRƯỚC khi abort để tránh race condition
    isDigging = false;
    if (digAbortController) {
      digAbortController.abort();
      digAbortController = null;
    }
    try {
      bot.stopDigging();
    } catch { /* ignore */ }
    logger.system(chalk.yellow("Stopped digging."));
  },
};


// Mineflayer expects item.enchants to be an array. Some custom 1.21.x
// servers expose the enchantments component as an object instead, which
// makes bot.dig() fail with "enchantments.concat is not a function".
function normalizeHeldEnchantments(bot: Bot): void {
  const item: any = bot.heldItem;
  if (!item) return;

  const raw = item.enchants ?? item.enchantments;
  if (Array.isArray(raw)) return;
  if (!raw || typeof raw !== "object") return;

  const source = (raw.levels && typeof raw.levels === "object") ? raw.levels : raw;
  const normalized = Object.entries(source)
    .map(([name, level]: [string, any]) => {
      const lvl = Number(level?.lvl ?? level?.level ?? level?.value ?? level);
      if (!Number.isFinite(lvl)) return null;
      return { name: name.startsWith("minecraft:") ? name : `minecraft:${name}`, lvl };
    })
    .filter(Boolean);

  item.enchants = normalized;
}

// ── /mine command ───────────────────────────────────────────────────────────
// Máy farm: giữ nguyên hướng nhìn và đào 5 block liên tiếp ngay phía trước.
// QUAN TRỌNG: 5 START packet được gửi liên tiếp trước khi chờ STOP packet,
// nên không còn kiểu B1 xong -> B2 -> B3 như bản cũ.
type MineState = {
  isMining: boolean;
  abort: AbortController | null;
  lv50Busy: boolean;
  lv50HandledLevel: number | null;
  blocksAhead: number;
  capdaoEnabled: boolean;
  capdaoLevel: number;
  capdaoGeneration: number;
  pendingBlocks: Map<string, ReturnType<typeof setTimeout>>;
};

const mineStates = new WeakMap<object, MineState>();

function getMineState(bot: Bot): MineState {
  let state = mineStates.get(bot as object);
  if (!state) {
    state = {
      isMining: false,
      abort: null,
      lv50Busy: false,
      lv50HandledLevel: null,
      blocksAhead: 5,
      capdaoEnabled: true,
      capdaoLevel: 50,
      capdaoGeneration: 0,
      pendingBlocks: new Map(),
    };
    mineStates.set(bot as object, state);
  }
  return state;
}

export function getMineStatus(bot: Bot) {
  const state = getMineState(bot);
  loadMineSettings(state, bot.username);
  return {
    isMining: state.isMining,
    capdaoEnabled: state.capdaoEnabled,
    blocksAhead: state.blocksAhead,
    lv50Busy: state.lv50Busy,
    capdaoLevel: state.capdaoLevel,
  };
}

// ── Capdao mining-exp flow ──────────────────────────────────────────────────
// When the server-side mining level reaches the configured capdao level while
// /mine is running:
//   1) pause the mining loop
//   2) sell the configured ores
//   3) run /capdaoexp
//   4) click slot 19 ([Phổ Thông] [+1])
//   5) close the GUI (ESC equivalent)
//   6) resume mining
//
// Trigger rule:
//   - level < capdaoLevel: normal mining
//   - level >= capdaoLevel: run the flow once whenever the XP level CHANGES
//   - staying at the same level never repeats the flow
//   - if /mine starts while already at LV100, LV100 is treated as a new level
function loadMineSettings(state: MineState, username: string): void {
  try {
    // Each bot process/account must read its own accounts/<username>.json.
    // Loading only the shared config here made one account's capdao setting
    // leak into the next bot when the command module was initialized.
    const mineConfig = loadConfig(username).mine;
    state.capdaoEnabled = mineConfig.capdaoEnabled;
    state.capdaoLevel = mineConfig.capdaoLevel;
  } catch {
    state.capdaoEnabled = true;
    state.capdaoLevel = 50;
  }
}

function setMineCapdaoEnabled(state: MineState, enabled: boolean, username?: string): void {
  state.capdaoEnabled = enabled;
  state.capdaoGeneration++;
  try {
    const config = loadConfig(username);
    config.mine.capdaoEnabled = enabled;
    saveConfig(config);
  } catch (err) {
    logger.system(chalk.red(`[Mine] Failed to save capdao setting: ${(err as Error)?.message ?? err}`));
  }
}

function setMineCapdaoLevel(state: MineState, level: number, username: string): void {
  state.capdaoLevel = level;
  state.lv50HandledLevel = null;
  state.capdaoGeneration++;
  try {
    const config = loadConfig(username);
    config.mine.capdaoLevel = level;
    saveConfig(config);
  } catch (err) {
    logger.system(chalk.red("[Mine] Failed to save capdao level: " + ((err as Error)?.message ?? err)));
  }
}

const LV50_SELL_COMMANDS = [
  "/kho sell COBBLESTONE 100000",
  "/kho sell REDSTONE 100000",
  "/kho sell LAPIS_LAZULI 100000",
  "/kho sell COAL 100000",
] as const;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function waitForWindowOpen(bot: Bot, timeoutMs = 4000): Promise<any | null> {
  if (bot.currentWindow) return Promise.resolve(bot.currentWindow);

  return new Promise((resolve) => {
    let done = false;
    const finish = (window: any | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { bot.off("windowOpen", onOpen as any); } catch {}
      resolve(window);
    };
    const onOpen = (window: any) => finish(window);
    const timer = setTimeout(() => finish(null), timeoutMs);
    bot.once("windowOpen", onOpen as any);
  });
}

async function runMineLevel50Flow(bot: Bot, state: MineState): Promise<void> {
  // When disabled, do not enter/pause the LV50 flow at all.
  if (!state.capdaoEnabled) return;
  if (state.lv50Busy) return;
  const generation = state.capdaoGeneration;
  const shouldContinue = () => state.capdaoEnabled && state.capdaoGeneration === generation;
  state.lv50Busy = true;

  try {
    logger.system(chalk.hex("#FBBF24").bold("[Mine] LV" + state.capdaoLevel + " reached — starting cap EXP flow."));

    // Send the five server commands in order. A small gap prevents them from
    // arriving as one same-tick chat burst while still keeping the flow fast.
    for (const command of LV50_SELL_COMMANDS) {
      if (!shouldContinue()) return;
      try {
        bot.chat(command);
        logger.system(chalk.gray(`[Mine] ${command}`));
      } catch (err) {
        logger.system(chalk.red(`[Mine] Failed to send ${command}: ${(err as Error)?.message ?? err}`));
      }
      await waitMs(120);
    }

    if (!shouldContinue()) return;

    try {
      bot.chat("/capdaoexp");
      logger.system(chalk.cyan("[Mine] /capdaoexp"));
    } catch (err) {
      logger.system(chalk.red(`[Mine] Failed to send /capdaoexp: ${(err as Error)?.message ?? err}`));
      return;
    }

    // Wait for the server menu. If it is already open, use it immediately.
    const window = await waitForWindowOpen(bot, 4000);
    if (!shouldContinue()) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
      return;
    }
    if (!window && !bot.currentWindow) {
      logger.system(chalk.red("[Mine] /capdaoexp did not open a GUI within 4s."));
      return;
    }

    const currentWindow: any = bot.currentWindow ?? window;
    if (!currentWindow) return;

    // Give the first inventory update a chance to arrive so slot 19 is not
    // clicked against an empty/un-synchronised slot.
    await waitMs(80);
    if (!shouldContinue()) {
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
      return;
    }

    const slot = 19;
    const item = currentWindow.slots?.[slot];
    const itemName = item?.name ?? "empty";
    logger.system(chalk.gray(`[Mine] Slot 19: ${itemName} — clicking...`));

    try {
      await bot.clickWindow(slot, 0, 0);
      logger.system(chalk.green("[Mine] Clicked slot 19 [Phổ Thông] [+1]."));
    } catch (err) {
      logger.system(chalk.red(`[Mine] Failed to click slot 19: ${(err as Error)?.message ?? err}`));
    }

    // ESC equivalent: close the current Mineflayer window.
    await waitMs(50);
    try {
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      else if (currentWindow) bot.closeWindow(currentWindow);
      logger.system(chalk.green("[Mine] Closed GUI — resuming mining."));
    } catch (err) {
      logger.system(chalk.red(`[Mine] Failed to close GUI: ${(err as Error)?.message ?? err}`));
    }
  } finally {
    state.lv50Busy = false;
  }
}

/**
 * Manually upgrade the island cap level one step at a time.
 * The server exposes the upgrade through /capdaoexp and slot 19 (+1).
 */
async function runManualCapdaoLevel(bot: Bot, state: MineState, targetLevel: number): Promise<void> {
  if (state.lv50Busy) {
    logger.system(chalk.yellow("[Mine] Capdao is already busy."));
    return;
  }

  state.lv50Busy = true;
  try {
    for (let level = 1; level <= targetLevel; level++) {
      if (bot._client?.ended) break;

      try {
        bot.chat("/capdaoexp");
      } catch (err) {
        logger.system(chalk.red(`[Mine] Failed to send /capdaoexp: ${(err as Error)?.message ?? err}`));
        break;
      }

      const opened = await waitForWindowOpen(bot, 4000);
      const window = bot.currentWindow ?? opened;
      if (!window) {
        logger.system(chalk.red(`[Mine] Capdao GUI did not open at step ${level}/${targetLevel}.`));
        break;
      }

      await waitMs(100);
      try {
        await bot.clickWindow(19, 0, 0);
        logger.system(chalk.green(`[Mine] Capdao +1: ${level}/${targetLevel}`));
      } catch (err) {
        logger.system(chalk.red(`[Mine] Failed to click capdao slot 19 at ${level}/${targetLevel}: ${(err as Error)?.message ?? err}`));
        break;
      }

      await waitMs(100);
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
      await waitMs(250);
    }

    logger.system(chalk.cyan(`[Mine] Capdao level setup finished: ${targetLevel} upgrade step(s).`));
  } finally {
    state.lv50Busy = false;
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAirBlock(block: any): boolean {
  return !block || block.name === "air" || block.name === "cave_air" || block.name === "void_air";
}

function blockKey(block: any): string {
  const p = block?.position;
  return p ? `${p.x},${p.y},${p.z}` : "";
}

/**
 * Lấy 1..10 block bắt đầu ĐÚNG tại block dưới tâm crosshair.
 *
 * B1 được lấy bằng blockAtCursor/raycast theo hướng nhìn hiện tại.
 * Không raycast lại cho từng block và không tự đổi pitch/yaw. Sau B1,
 * lấy B2..Bn theo trục ngang chính của hướng nhìn để giữ hàng thẳng.
 * theo trục ngang chính của yaw. Vì vậy cấu trúc mục tiêu là:
 *
 *   [BOT] -> [B1] [B2] [B3] [B4] [B5]
 */
function scanStraightBlocks(bot: Bot, maxBlocks: number): any[] {
  if (!bot.entity || !bot.world) return [];

  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return [];

  const eye = bot.entity.position.offset(0, bot.entity.height, 0);
  const direction = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  );

  // B1 MUST come from the exact crosshair/raycast hit.  Do not search a
  // generic block in front of the player first. Mineflayer's blockAtCursor
  // uses the same eye position + look direction concept as the player's
  // crosshair. Keep a world.raycast fallback for versions where the helper
  // is unavailable.
  let first: any = null;
  try {
    const blockAtCursor = (bot as any).blockAtCursor;
    if (typeof blockAtCursor === "function") {
      first = blockAtCursor.call(bot, 6.5);
    }
  } catch {}

  // blockAtCursor() may return an actual `air` block object rather than null.
  // Treat both cases as a miss so the world raycast fallback can find the
  // block the bot is looking at after transfers/chunk updates.
  if (!first || isAirBlock(first)) {
    try {
      first = (bot.world as any).raycast(
        eye,
        direction,
        6.5,
        (block: any) => !isAirBlock(block)
      );
    } catch {
      return [];
    }
  }

  if (!first?.position || isAirBlock(first)) return [];

  // Chỉ chọn trục ngang mà bot đang nhìn mạnh nhất.
  // Không dùng pitch để tạo đường chéo; đây là máy farm nên B1..B5
  // phải nằm cùng hàng với B1.
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const stepX = Math.abs(fx) >= Math.abs(fz) ? (fx >= 0 ? 1 : -1) : 0;
  const stepZ = stepX === 0 ? (fz >= 0 ? 1 : -1) : 0;

  const p = first.position;
  const found: any[] = [];

  for (let i = 0; i < Math.max(1, Math.min(10, maxBlocks)); i++) {
    const block = bot.blockAt(
      new Vec3(p.x + stepX * i, p.y, p.z + stepZ * i),
      false
    );
    if (!block?.position || isAirBlock(block)) break;
    found.push(block);
  }

  return found;
}

/**
 * ZERO-DELAY mining burst.
 *
 * The farm machine wants packets in the same event-loop turn:
 * START B1..B5 -> STOP B1..B5, with no digTime/sleep/await between them.
 * The server is responsible for deciding whether/how many of these digs it
 * accepts. We keep the keys pending until the world actually changes so the
 * client does not spam the same five coordinates every scan.
 */
// Short-lived de-duplication only. Do not wait for blockUpdate: some servers
// do not emit a client-side blockUpdate for rejected/instant dig packets.
function markMinePending(state: MineState, key: string, ttlMs = 90): void {
  const old = state.pendingBlocks.get(key);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => state.pendingBlocks.delete(key), ttlMs);
  state.pendingBlocks.set(key, timer);
}

function clearMinePending(state: MineState, key: string): void {
  const timer = state.pendingBlocks.get(key);
  if (timer) clearTimeout(timer);
  state.pendingBlocks.delete(key);
}

function sendBlockDig(client: any, status: string, pos: any): Promise<void> {
  return queueBlockDig(client, status, pos, 1, 0);
}

/**
 * Fast-natural configurable mining (1-10 blocks).
 *
 * We deliberately do NOT burst START/STOP for all five blocks in one tick.
 * Instead the five targets are issued in a tight, stable cadence while yaw/pitch
 * stays unchanged. This keeps the visual/network rhythm much closer to normal
 * mining while avoiding the old B1-await-B2-B3 queue.
 */
async function mineBatchFastNatural(bot: Bot, state: MineState, blocks: any[], signal: AbortSignal): Promise<void> {
  const client: any = (bot as any)._client;
  if (!client?.write || signal.aborted) return;

  const jobs = blocks
    .filter((block) => {
      const key = blockKey(block);
      return key && block?.position && !isAirBlock(block) && !state.pendingBlocks.has(key);
    })
    .slice(0, state.blocksAhead);

  if (!jobs.length) return;
  for (const block of jobs) markMinePending(state, blockKey(block));

  // A small fixed cadence is enough to avoid a START/STOP x5 same-tick burst.
  // It is intentionally much shorter than normal block-breaking time.
  for (const block of jobs) {
    if (signal.aborted) return;
    bot.swingArm(undefined);
    await sendBlockDig(client, "start_destroy_block", block.position);
    await sendBlockDig(client, "stop_destroy_block", block.position);
  }
}

export const MineCommand = {
  execute: async (bot: Bot, args: string[]) => {
    const state = getMineState(bot);
    loadMineSettings(state, bot.username);
    const first = args[0]?.toLowerCase();

    // Runtime settings:
    //   /mine packet <ms>  -> delay between PLAYER_DIGGING packets
    //   /mine blocks <1-10> -> number of blocks in front to target
    //   /mine capdaolevel <level> -> set the automatic trigger level
    //   /mine settings -> show current values
    if (first === "packet" || first === "packets") {
      const value = Number(args[1]);
      if (!Number.isFinite(value) || value < 1) {
        logger.system(chalk.yellow(`Usage: /mine packet <ms> (>= 1). Current: ${getPacketIntervalMs()}ms`));
        return;
      }
      const applied = setPacketIntervalMs(value);
      logger.system(chalk.green(`[Mine] Packet interval: ${applied}ms`));
      return;
    }

    if (first === "blocks" || first === "block") {
      const value = Number(args[1]);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        logger.system(chalk.yellow(`Usage: /mine blocks <1-10>. Current: ${state.blocksAhead}`));
        return;
      }
      state.blocksAhead = value;
      logger.system(chalk.green(`[Mine] Blocks ahead: ${state.blocksAhead}`));
      return;
    }

    if (first === "capdao") {
      const value = args[1]?.toLowerCase();
      if (value !== "on" && value !== "off") {
        logger.system(chalk.yellow(`Usage: /mine capdao <on|off>. Current: ${state.capdaoEnabled ? "on" : "off"}`));
        return;
      }
      setMineCapdaoEnabled(state, value === "on", bot.username);
      logger.system(chalk.green(`[Mine] Capdao flow: ${state.capdaoEnabled ? "ON" : "OFF"}`));
      return;
    }

    if (first === "capdaolevel" || first === "capdao-level") {
      const targetLevel = Number(args[1]);
      if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 100) {
        logger.system(chalk.yellow("[Mine] Usage: /mine capdaolevel <1-100>. Current: " + state.capdaoLevel));
        return;
      }
      setMineCapdaoLevel(state, targetLevel, bot.username);
      logger.system(chalk.green("[Mine] Capdao trigger level: " + state.capdaoLevel));
      return;
    }

    if (first === "settings" || first === "config" || first === "status") {
      logger.system(chalk.cyan(
        `[Mine] ${state.isMining ? "RUNNING" : "STOPPED"} | Packet: ${getPacketIntervalMs()}ms | Blocks ahead: ${state.blocksAhead} | Capdao: ${state.capdaoEnabled ? "ON" : "OFF"}`
      ));
      return;
    }

    if (first === "stop") {
      MineCommand.stop(bot);
      return;
    }
    if (state.isMining) {
      logger.system(chalk.yellow("Already mining! Use /mine stop."));
      return;
    }

    try { bot.pathfinder?.setGoal(null); } catch {}
    try { bot.clearControlStates(); } catch {}

    state.isMining = true;
    state.lv50Busy = false;
    // Reset the handled-level marker when /mine starts. This means that if
    // the bot is already at LV50+ (for example LV100), that current level is
    // immediately eligible for the flow.
    state.lv50HandledLevel = null;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    const startYaw = bot.entity?.yaw;
    const startPitch = bot.entity?.pitch;

    logger.system(chalk.hex("#F59E0B")(
      "[Mine] Start"
    ));

    // Clear pending coordinates when the server/world actually changes them.
    const onBlockUpdate = (oldBlock: any, newBlock: any) => {
      try {
        const key = blockKey(newBlock?.position ? newBlock : oldBlock);
        if (key && isAirBlock(newBlock)) clearMinePending(state, key);
      } catch {}
    };
    bot.on("blockUpdate", onBlockUpdate as any);

    try {
      while (state.isMining && bot.entity && !signal.aborted) {
        // Keep the machine facing exactly where it started; do not turn per block.
        if (typeof startYaw === "number" && typeof startPitch === "number") {
          const yawChanged = Math.abs((bot.entity.yaw ?? startYaw) - startYaw) > 0.01;
          const pitchChanged = Math.abs((bot.entity.pitch ?? startPitch) - startPitch) > 0.01;
          if (yawChanged || pitchChanged) {
            try { bot.look(startYaw, startPitch, true); } catch {}
          }
        }

        // XP trigger: once the configured capdao level is reached, run the flow whenever the player's
        // Minecraft XP level changes. The same level is never spammed.
        // Example with trigger LV45: 44 -> 45 runs; 45 -> 45 does not;
        // 45 -> 46 runs. Starting above the trigger also runs immediately.
        const miningLevel = Number((bot as any).experience?.level ?? 0);
        const levelChanged = state.lv50HandledLevel === null || miningLevel !== state.lv50HandledLevel;
        if (miningLevel >= state.capdaoLevel && levelChanged && !state.lv50Busy) {
          state.lv50HandledLevel = miningLevel;
          try {
            await runMineLevel50Flow(bot, state);
          } catch (err) {
            // Capdao must never be able to terminate /mine.
            logger.system(chalk.red(
              `[Mine] Capdao flow error (mining continues): ${(err as Error)?.message ?? err}`
            ));
            state.lv50Busy = false;
          }
          if (signal.aborted || !state.isMining) break;
        } else if (miningLevel !== state.lv50HandledLevel && miningLevel < state.capdaoLevel) {
          // Keep the current level marker in sync while below the threshold;
          // crossing back to >=50 will then trigger normally.
          state.lv50HandledLevel = miningLevel;
        }

        const blocks = scanStraightBlocks(bot, state.blocksAhead).filter((block) => {
          const key = blockKey(block);
          return key && !state.pendingBlocks.has(key);
        });
        if (blocks.length) {
          await mineBatchFastNatural(bot, state, blocks, signal);
        }

        // Do not spin with setImmediate here. When the server has not sent a
        // block update yet, a tight loop repeatedly raycasts and scans the
        // world, driving one bot to a full CPU core. A short idle yield keeps
        // mining responsive while leaving time for network/world updates.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    } catch (err) {
      if (state.isMining) logger.system(chalk.red(
        `[Mine] Error: ${(err as Error)?.message ?? "unknown error"}`
      ));
    } finally {
      try { bot.off("blockUpdate", onBlockUpdate as any); } catch {}
      try { state.abort?.abort(); } catch {}
      for (const timer of state.pendingBlocks.values()) clearTimeout(timer);
      state.pendingBlocks.clear();
      state.abort = null;
      state.isMining = false;
      state.lv50Busy = false;
      state.lv50HandledLevel = null;
      try { bot.clearControlStates(); } catch {}
      callUpdatePrompt();
    }
  },

  stop: (bot: Bot) => {
    const state = getMineState(bot);
    if (!state.isMining) return;
    state.isMining = false;
    try { state.abort?.abort(); } catch {}
    for (const timer of state.pendingBlocks.values()) clearTimeout(timer);
    state.pendingBlocks.clear();
    state.abort = null;
    try { bot.stopDigging(); } catch {}
    try { bot.clearControlStates(); } catch {}
    logger.system(chalk.yellow("[Mine] Stopped."));
    callUpdatePrompt();
  },
};


// ── Stop all action commands ───────────────────────────────────────────────
export function stopAllActions(bot: Bot) {
  UseCommand.stop(bot);
  SwingCommand.stop(bot);
  AttackCommand.stop(bot);
  DigCommand.stop(bot);
  MineCommand.stop(bot);
}
