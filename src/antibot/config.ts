/**
 * ── xCord Anti-Bot Bypass Configuration ─────────────────────────────
 * Specific configuration for the anti-bot bypass module.
 * Separated from main config for easier management.
 */

export interface AntiBotConfig {
  /** Enable/disable entire antibot bypass module. Use "auto" to automatically enable. */
  enabled: boolean | "auto";

  /** ── Brand Spoofing ─────────────────────────────────────────────── */
  brand: {
    /** Client brand sent to server (default "vanilla") */
    name: string;
  };

  /** ── Client Settings ────────────────────────────────────────────── */
  clientSettings: {
    /** Spoofed locale (default "en_us") */
    locale: string;
    /** View distance sent in settings packet */
    viewDistance: number;
    /** Chat mode: 0=enabled, 1=commands only, 2=hidden */
    chatMode: number;
    /** Enable chat colors */
    chatColors: boolean;
    /** Skin parts bitmask (127 = all enabled) */
    skinParts: number;
    /** Main hand: 0=left, 1=right */
    mainHand: number;
    /** Enable text filtering */
    enableTextFiltering: boolean;
    /** Allow server listing */
    enableServerListing: boolean;
  };

  /** ── Human Behavior Simulation ──────────────────────────────────── */
  humanBehavior: {
    /** Enable real player behavior simulation */
    enabled: boolean;
    /** Random look around interval (ms between each look) */
    lookIntervalMs: number;
    /** Delay time before starting simulation after spawn (ms) */
    startDelayMs: number;
    /** Enable micro-movements to avoid being detected as AFK */
    microMovement: boolean;
  };

  /** ── Packet Guard ───────────────────────────────────────────────── */
  packetGuard: {
    /** Automatically respond to plugin channel registration */
    autoRegisterChannels: boolean;
    /** Channels to register when server requests */
    defaultChannels: string[];
    /** Respond to transaction/ping packets to simulate real client */
    respondTransactions: boolean;
    /** Optimize packets by dropping non-essential entity updates */
    optimizePackets: boolean;
  };

  /** ── Gravity/Physics ────────────────────────────────────────────── */
  physics: {
    /** Ensure physics is always enabled (anti-gravity check) */
    forceEnabled: boolean;
  };
}

/**
 * Default values for antibot config
 */
export const DEFAULT_ANTIBOT_CONFIG: AntiBotConfig = {
  enabled: "auto",

  brand: {
    name: "vanilla",
  },

  clientSettings: {
    locale: "en_us",
    viewDistance: 8,
    chatMode: 0,
    chatColors: true,
    skinParts: 127,
    mainHand: 1,
    enableTextFiltering: false,
    enableServerListing: true,
  },

  humanBehavior: {
    enabled: true,
    lookIntervalMs: 3000,
    startDelayMs: 2000,
    microMovement: true,
  },

  packetGuard: {
    autoRegisterChannels: true,
    defaultChannels: [
      "minecraft:brand",
      "minecraft:register",
    ],
    respondTransactions: true,
    optimizePackets: true,
  },

  physics: {
    forceEnabled: true,
  },
};
