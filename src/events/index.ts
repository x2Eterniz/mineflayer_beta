import type { Bot } from "mineflayer";
import type { AppConfig } from "../config";

import { registerConnectionEvents } from "./connection";
import { registerChatEvents } from "./chat";
import { registerPlayerEvents } from "./player";
import { registerEntityEvents } from "./entity";
import { registerWindowEvents } from "./window";
import { registerGameEvents } from "./games";
import { updateConsoleTitle } from "../utils/helpers";
import { stopAllActions } from "../commands/action";

export function registerEvents(bot: Bot, config: AppConfig, onReconnect?: () => void): void {
  registerConnectionEvents(bot, config);

  // Register ChatGame BEFORE the normal chat renderer.
  // This lets the ToolTitle fast-path receive the raw message first, solve
  // it synchronously, and send a zero-delay answer before chat formatting,
  // Discord bridging, logging, and other chat UI work runs.
  registerGameEvents(bot, config);

  registerChatEvents(bot, config, onReconnect);
  registerPlayerEvents(bot, config);
  registerEntityEvents(bot, config);
  registerWindowEvents(bot, config);

  // A reconnect creates a completely new Mineflayer instance. Stop any
  // command-owned timers/abort controllers before the old instance becomes
  // unreachable; otherwise hold commands can keep references alive.
  bot.once("end", () => {
    try { stopAllActions(bot); } catch { }
  });

  // Dynamic Title Updates
  bot.on("spawn", () => updateConsoleTitle(bot));
}
