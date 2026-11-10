import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";

export interface DebugConfig {
  /** Master switch — when false, ALL debug output is suppressed. */
  enabled: boolean;
  /** Log every incoming/outgoing packet name (very noisy). */
  logAllPackets: boolean;
  /** Log detailed transfer / configuration-phase events. */
  logTransfers: boolean;
  /** Log connection lifecycle (login, spawn, end, kick). */
  logConnection: boolean;
  /** Log latency (keep-alive round-trip). */
  logLatency: boolean;
  /** Periodically print memory / uptime stats. */
  logStats: boolean;
  /** Interval (ms) for periodic stats when logStats is true. */
  statsIntervalMs: number;
  /** Log inventory/GUI events (window_items, set_slot, windowOpen/Close, clicks). */
  logInventory: boolean;
  /** Disable the ora terminal spinner and use standard text logging instead. */
  disableSpinner: boolean;
}

export const DEFAULT_DEBUG_CONFIG: DebugConfig = {
  enabled: false,
  logAllPackets: false,
  logTransfers: true,
  logConnection: true,
  logLatency: false,
  logStats: false,
  statsIntervalMs: 60000,
  logInventory: true,
  disableSpinner: false,
};

// ─── Helpers ────────────────────────────────────────────────────────────

const TAG = chalk.hex("#C084FC").bold("[Debug]");

function debugLog(...args: any[]): void {
  logger.debug(TAG, ...args.map((a) => chalk.gray(String(a))));
}

function debugWarn(...args: any[]): void {
  logger.warn(TAG, ...args.map((a) => chalk.gray(String(a))));
}

function briefJson(obj: any): string {
  try {
    const s = JSON.stringify(obj);
    return s.length > 150 ? s.slice(0, 150) + "..." : s;
  } catch {
    return String(obj);
  }
}

function elapsedSince(startMs: number): string {
  return `${(Date.now() - startMs).toLocaleString()}ms`;
}

// ─── Main registration ─────────────────────────────────────────────────
// NOTE: client.emit and client.write are already wrapped once in client.ts.
// This module must NOT re-wrap them. Instead, it uses event listeners and
// hooks into the existing wrappers via stored references (_botOrigEmit, _botOrigWrite).

export function registerDebugEvents(bot: Bot, cfg: DebugConfig): void {
  if (!cfg.enabled) return; // Master switch OFF → no-op

  const client = (bot as any)._client;
  if (!client) return;

  // State tracking
  let lastServerSignal = "none";
  let inTransferMode = false;
  let transferStartMs = 0;
  let loginStartMs = Date.now();
  let packetCountIn = 0;
  let packetCountOut = 0;
  let lastKeepAliveMs = 0;
  let statsTimer: ReturnType<typeof setInterval> | null = null;

  const markSignal = (name: string, detail?: string) => {
    lastServerSignal = detail ? `${name}:${detail}` : name;
  };

  // ─── Connection lifecycle ───────────────────────────────────────────

  if (cfg.logConnection) {
    client.on("kick_disconnect", (packet: any) => {
      markSignal("kick_disconnect");
      debugWarn(`[Kick] kick_disconnect ${briefJson(packet)}`);
    });

    client.on("disconnect", (packet: any) => {
      markSignal("disconnect");
      debugWarn(`[Disconnect] disconnect ${briefJson(packet)}`);
    });

    client.on("error", (err: any) => {
      const message = String(err?.message ?? err ?? "");
      debugWarn(`[Error] client error: ${message}`);
    });

    client.on("login_plugin_request", (packet: any) => {
      markSignal("login_plugin_request", String(packet?.messageId ?? "?"));
      debugLog(`[LoginPlugin] login_plugin_request id=${packet?.messageId ?? "?"} channel=${packet?.channel ?? "?"}`);
    });

    client.on("cookie_request", (packet: any) => {
      markSignal("cookie_request", String(packet?.key ?? "?"));
      debugLog(`[Cookie] cookie_request key=${packet?.key ?? "unknown"}`);
    });

    bot.once("spawn", () => {
      const elapsed = elapsedSince(loginStartMs);
      debugLog(`[Spawn] Bot spawned -- login->spawn took ${elapsed}`);

      setTimeout(() => {
        debugLog(`[Spawn] Bot alive for 2s after spawn -- connection stable`);
      }, 2000);
    });

    bot.on("end", () => {
      debugLog(`[End] Connection ended -- last signal: ${lastServerSignal}`);
      debugLog(
        `   Packets received: ${packetCountIn.toLocaleString()} | sent: ${packetCountOut.toLocaleString()}`
      );
      inTransferMode = false;

      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
    });
  }

  // ─── Transfer / configuration-phase debugging ─────────────────────
  // Instead of wrapping client.emit again, we use standard event listeners.
  // The transfer-phase packet logging is done via a 'packet' listener below.

  if (cfg.logTransfers) {
    client.on("transfer", (packet: any) => {
      markSignal("transfer", `${packet?.host ?? "unknown"}:${packet?.port ?? "?"}`);
      debugLog(`[Transfer] transfer -> ${packet?.host ?? "unknown"}:${packet?.port ?? "?"}`);
    });

    client.on("start_configuration", () => {
      inTransferMode = true;
      transferStartMs = Date.now();
      markSignal("start_configuration");
      debugLog(`[Config] start_configuration (state=${client.state})`);
    });

    client.on("select_known_packs", (packet: any) => {
      markSignal("select_known_packs");
      const count = Array.isArray(packet?.packs) ? packet.packs.length : "?";
      debugLog(`[Config] select_known_packs (${count} packs from server)`);
    });

    client.on("registry_data", (packet: any) => {
      if (inTransferMode) {
        const codec = packet?.codec;
        const keys = codec ? Object.keys(codec).slice(0, 5).join(", ") : "?";
        debugLog(`[Config] registry_data (keys: ${keys}...)`);
      }
    });

    client.on("finish_configuration", () => {
      markSignal("finish_configuration");
      const elapsed = inTransferMode ? ` [${elapsedSince(transferStartMs)}]` : "";
      debugLog(`[Config] finish_configuration (state=${client.state})${elapsed}`);
    });

    client.on("login", (packet: any) => {
      markSignal("login");
      debugLog(
        `[Login] login (entityId=${packet?.entityId ?? "?"}, gameMode=${packet?.gameMode ?? "?"}, state=${client.state})`
      );
      if (inTransferMode) {
        debugLog(`[Success] Transfer complete in ${elapsedSince(transferStartMs)} -- now in new server`);
        inTransferMode = false;
      }
    });

    // Resource pack events during transfer
    bot.on("resourcePack", (url: string, uuidOrHash?: any) => {
      if (inTransferMode) {
        debugLog(`[ResourcePack] resourcePack (url=${String(url).slice(0, 60)}..., uuid=${uuidOrHash})`);
      }
    });
  }

  // ─── Packet counting via event listener (NOT by re-wrapping emit) ──
  // Use a 'packet' listener for incoming packet counting — this is the
  // standard minecraft-protocol event and avoids wrapping client.emit.
  client.on("packet", () => {
    packetCountIn++;
  });

  // ─── Outgoing packet counting ─────────────────────────────────────
  // Instead of re-wrapping client.write, we hook into the EXISTING wrapper
  // from client.ts by augmenting it. We intercept via a pre-write listener.
  // Since minecraft-protocol doesn't have a native 'writePacket' event,
  // we patch write ONE time using the stored original reference.
  const existingWrite = client.write; // This is already the client.ts wrapper
  const _botOrigWrite = client._botOrigWrite; // The true original
  if (_botOrigWrite) {
    client.write = function (name: string, data: any) {
      packetCountOut++;

      // Latency tracking
      if (cfg.logLatency && name === "keep_alive" && lastKeepAliveMs > 0) {
        const rtt = Date.now() - lastKeepAliveMs;
        debugLog(`[Latency] Keep-alive RTT: ${rtt}ms`);
        lastKeepAliveMs = 0;
      }

      // Outgoing packet logging
      if (cfg.logAllPackets || (inTransferMode && cfg.logTransfers)) {
        const brief = data ? briefJson(data) : "{}";
        debugLog(`  -> [${client.state ?? "?"}] ${name} ${brief}`);
      }

      // Delegate to the existing client.ts wrapper (which handles the config guard)
      return existingWrite.call(client, name, data);
    };
  }

  // ─── Latency tracking (keep-alive incoming) ────────────────────────
  if (cfg.logLatency) {
    client.on("keep_alive", () => {
      lastKeepAliveMs = Date.now();
    });
  }

  // ─── Custom payload / plugin channels ───────────────────────────────

  client.on("custom_payload", (packet: any) => {
    const channel = packet?.channel ?? "unknown";
    markSignal("custom_payload", channel);
    if (cfg.logAllPackets || (cfg.logTransfers && inTransferMode)) {
      debugLog(`[Payload] custom_payload channel=${channel}`);
    }
  });

  // ─── Full packet logging (very verbose) ─────────────────────────────

  if (cfg.logAllPackets) {
    client.on("packet", (data: any, meta: any) => {
      const name = meta?.name ?? "unknown";
      const state = meta?.state ?? client.state ?? "?";
      debugLog(`  <- [${state}] ${name} ${briefJson(data)}`);
    });
  }

  // ─── Periodic stats ─────────────────────────────────────────────────

  if (cfg.logStats) {
    statsTimer = setInterval(() => {
      const mem = process.memoryUsage();
      const rss = (mem.rss / 1024 / 1024).toFixed(1);
      const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
      const uptime = (process.uptime() / 60).toFixed(1);

      debugLog(
        `[Stats] RSS: ${rss}MB | Heap: ${heap}MB | Uptime: ${uptime}min | ` +
          `Packets IN: ${packetCountIn.toLocaleString()} OUT: ${packetCountOut.toLocaleString()}`
      );
    }, cfg.statsIntervalMs);
  }

  debugLog(
    `Debug logging enabled -- ` +
      `transfers=${cfg.logTransfers} connection=${cfg.logConnection} ` +
      `latency=${cfg.logLatency} allPackets=${cfg.logAllPackets} stats=${cfg.logStats}`
  );
}
