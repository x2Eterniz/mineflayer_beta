/**
 * ── Gravity & Physics Compliance Module ─────────────────────────────
 * Ensures the bot complies with xCord physics/gravity checks.
 * 
 * IMPORTANT: Mineflayer ALREADY handles physics simulation completely.
 * This module DOES NOT send extra flying/position packets (which would be detected).
 * 
 * Instead, this module:
 * - Disables physics immediately on spawn, re-enables AFTER the packet buffer
 *   window in client.ts (500ms) expires. This ensures physics and packet output
 *   start together, preventing onGround=false packets from being sent to GRIM
 *   before the bot's position has stabilized on the loaded chunk.
 * - Properly cleans up listeners on each spawn/transfer to avoid stale handlers
 * - Prevents any code from disabling physics after it's been enabled
 * - Logs a warning if physics is disabled unexpectedly
 *
 * TIMING NOTE: client.ts blocks outgoing position packets for POST_CHUNK_BUFFER_MS
 * (currently 500ms) after the first map_chunk. Physics must resume AFTER this
 * window to avoid sending stale onGround=false data.
 *   map_chunk received → +500ms packets unblocked → +1200ms physics resumed
 *   (700ms margin ensures physics has correct chunk data + warmup period active)
 */

import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import type { AntiBotConfig } from "./config";

export function initGravityFix(bot: Bot, config: AntiBotConfig): void {
  if (!config.physics.forceEnabled) return;

  const client = (bot as any)._client;

  // ── Track active timers for cleanup ───────────────────────────────
  let activeChunkListener: ((...args: any[]) => void) | null = null;
  let activeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let activeResumeTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanupPendingPhysicsResume() {
    if (activeChunkListener) {
      try { client?.removeListener("map_chunk", activeChunkListener); } catch {}
      activeChunkListener = null;
    }
    if (activeFallbackTimer) {
      clearTimeout(activeFallbackTimer);
      activeFallbackTimer = null;
    }
    if (activeResumeTimer) {
      clearTimeout(activeResumeTimer);
      activeResumeTimer = null;
    }
  }

  // ── Disable physics on spawn, re-enable after first chunk ─────────
  // Mineflayer starts its physics loop immediately on spawn, but chunks
  // haven't arrived yet → bot is "floating" → sends onGround=false → GRIM flags.
  // Fix: pause physics until the first map_chunk packet arrives.
  //
  // FIX 6: Dùng bot.on("spawn") để xử lý MỌI spawn bao gồm sub-server transfer.
  // Code cũ dùng one-shot chunk listener → chỉ hoạt động lần đầu.
  // Giờ cleanup listener cũ trước khi đăng ký mới mỗi lần spawn.
  bot.on("spawn", () => {
    // Cleanup any pending physics resume from previous spawn/transfer
    cleanupPendingPhysicsResume();

    // Temporarily disable physics to stop the flying packet burst
    try { (bot as any).physicsEnabled = false; } catch { }

    if (!client) {
      // No client reference — just re-enable after a short delay
      activeResumeTimer = setTimeout(() => ensurePhysics(bot), 1500);
      return;
    }

    // Re-enable as soon as the first chunk arrives
    let chunkReceived = false;
    activeFallbackTimer = setTimeout(() => {
      activeFallbackTimer = null;
      if (!chunkReceived) ensurePhysics(bot);
    }, 10000);

    const onFirstChunk = () => {
      if (chunkReceived) return;
      chunkReceived = true;
      if (activeFallbackTimer) { clearTimeout(activeFallbackTimer); activeFallbackTimer = null; }
      try { client.removeListener("map_chunk", onFirstChunk); } catch {}
      activeChunkListener = null;
      // QUAN TRỌNG: Phải đợi SAU buffer trước khi enable physics.
      // client.ts block tất cả position packets trong 500ms sau map_chunk đầu tiên.
      //
      // FIX 5: Tăng delay từ 600ms → 1200ms.
      // Lý do: 600ms quá sát buffer 500ms — physics resume ngay khi packets vừa
      // được unblock → burst ngắn khi physics tính toán với chunk data chưa đầy đủ.
      // 1200ms = 500ms buffer + 700ms margin → physics có đủ thời gian để:
      //   1. Chunks tại vị trí bot load xong (server gửi theo spiral)
      //   2. Warmup period (1000ms) đang active → rate limit thấp (8/s)
      //   3. onGround override (6s) đang force onGround=true
      // Kết hợp cả 3 → GRIM không thể detect TickTimer.
      activeResumeTimer = setTimeout(() => {
        activeResumeTimer = null;
        ensurePhysics(bot);
      }, 1200);
    };
    activeChunkListener = onFirstChunk;
    client.on("map_chunk", onFirstChunk);
  });

  // ── Ensure physics is not disabled after respawn ──────────────────
  bot.on("respawn", () => {
    ensurePhysics(bot);
  });

  // ── Periodic check (in case other code disables physics) ──────────
  const checkInterval = setInterval(() => {
    if (!bot.entity) return;
    if ((bot as any).physicsEnabled === false) {
      logger.warn(
        chalk.hex("#F59E0B")("[AntiBot]"),
        chalk.gray("Physics was disabled! Re-enabling...")
      );
      ensurePhysics(bot);
    }
  }, 5000);

  // Cleanup
  bot.on("end", () => {
    clearInterval(checkInterval);
    cleanupPendingPhysicsResume();
  });

  logger.info(
    chalk.hex("#A78BFA")("[AntiBot]"),
    chalk.gray("Physics guard active")
  );
}

function ensurePhysics(bot: Bot): void {
  try {
    if (bot.physicsEnabled !== undefined) {
      (bot as any).physicsEnabled = true;
    }
  } catch { }
}
