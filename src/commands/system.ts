import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { getUptime } from "../utils/uptime";
import { hasUsableCurrentWindow, sharedState } from "../events/connection";

export function handleHelp() {
  logger.separator();
  logger.info(chalk.hex("#A78BFA").bold("  Core Commands:"));
  logger.info(chalk.white("    /tooltitle  "), chalk.gray("ToolTitle settings: delay, multi, word, status, history, debug, benchmark"));
  logger.info(chalk.white("    /status     "), chalk.gray("Connection, health, time, weather, effects, tablist"));
  logger.info(chalk.white("    /list       "), chalk.gray("Online players (filtered)"));
  logger.info(chalk.white("    /health     "), chalk.gray("HP, food, XP, saturation, effects"));
  logger.info(chalk.white("    /healthcheck"), chalk.gray("Connection, mine, capdao, actionbar, RAM, CPU"));
  logger.info(chalk.white("    /coop       "), chalk.gray("Auto-coop after account joins: /coop owner member..."));
  logger.info(chalk.white("    /pos        "), chalk.gray("Current coordinates & dimension"));
  logger.info(chalk.white("    /ping       "), chalk.gray("Current latency (ms)"));
  logger.info(chalk.white("    /uptime     "), chalk.gray("Session duration"));
  logger.info(chalk.white("    /version    "), chalk.gray("Server/Client version info"));

  logger.info(chalk.hex("#A78BFA").bold("  World Info:"));
  logger.info(chalk.white("    /time       "), chalk.gray("World time, day count, moon phase"));
  logger.info(chalk.white("    /weather    "), chalk.gray("Weather status (rain, thunder)"));
  logger.info(chalk.white("    /effects    "), chalk.gray("Active potion effects on bot"));
  logger.info(chalk.white("    /tablist    "), chalk.gray("Server tablist header/footer"));

  logger.info(chalk.hex("#A78BFA").bold("  Inventory & Items:"));
  logger.info(chalk.white("    /inv        "), chalk.gray("Show inventory grid"));
  logger.info(chalk.white("    /inv info <slot>"), chalk.gray("View item lore & details"));
  logger.info(chalk.white("    /inv search <q> "), chalk.gray("Find items by name"));
  logger.info(chalk.white("    /inv move <f> <t>"), chalk.gray("Move item from slot to slot"));
  logger.info(chalk.white("    /hotbar <0-8>   "), chalk.gray("Equip slot to main hand"));
  logger.info(chalk.white("    /click <slot>   "), chalk.gray("Click slot in opened menu"));
  logger.info(chalk.white("    /close          "), chalk.gray("Close current menu"));

  logger.info(chalk.hex("#A78BFA").bold("  Interaction:"));
  logger.info(chalk.white("    /use [hold] "), chalk.gray("Right-click once (or hold if specified)"));
  logger.info(chalk.white("    /attack [hold]"), chalk.gray("Attack entity in crosshair (or hold)"));
  logger.info(chalk.white("    /swing [hold]"), chalk.gray("Swing arm (or hold to spam swing)"));
  logger.info(chalk.white("    /dig [hold|1-5]"), chalk.gray("Break block at crosshair (hold or up to 5)"));
  logger.info(chalk.white("    /goto <x y z> [right|left]"), chalk.gray("Move to coordinates, then click/use"));
  logger.info(chalk.white("    /goto <name> [right|left] "), chalk.gray("Move to visible player/NPC/entity by name"));
  logger.info(chalk.white("    /goto npc <name> [right|left]"), chalk.gray("Force NPC/entity name lookup"));
  logger.info(chalk.white("    /npcs [query]"), chalk.gray("List visible NPC/entity targets with type/details"));
  logger.info(chalk.white("    /stop       "), chalk.gray("Stop all movement, digging, attacking, swinging"));
  logger.info(chalk.white("    /transfer <server>"), chalk.gray("Transfer to sub-server via BungeeCord"));
  logger.info(chalk.white("    /afk        "), chalk.gray("Perform anti-AFK action"));

  logger.info(chalk.hex("#A78BFA").bold("  System:"));
  logger.info(chalk.white("    /tab <cmd>  "), chalk.gray("Tab-complete server command"));
  logger.info(chalk.white("    /debug json <slot>"), chalk.gray("Print raw item NBT (JSON)"));
  logger.info(chalk.white("    /debugentities"), chalk.gray("Display details of nearby entities"));
  logger.info(chalk.white("    /reload     "), chalk.gray("Reload config.json"));
  logger.info(chalk.white("    /clear      "), chalk.gray("Clear terminal screen"));
  logger.info(chalk.white("    /reconnect  "), chalk.gray("Force reconnect"));
  logger.info(chalk.white("    /quit       "), chalk.gray("Disconnect and exit"));
  logger.info(chalk.white("    /actionbar  "), chalk.gray("Toggle actionbar visibility"));
  logger.info(chalk.white("    /scoreboard "), chalk.gray("Show character UI scoreboard (raw for compact view)"));

  logger.info(chalk.hex("#A78BFA").bold("  Automation Features:"));
  logger.info(chalk.white("    /autoeat [on|off|lvl]"), chalk.gray("Toggle auto-eat / set min food level"));
  logger.info(chalk.white("    /autoskill [on|off|r]"), chalk.gray("Toggle auto-skill / set detection range"));
  logger.info(chalk.white("    /servertrigger [on|off]"), chalk.gray("Toggle auto-activation of server triggerbot"));
  logger.info(chalk.white("    /autofollow [name|off]"), chalk.gray("Follow player/NPC by name, or disable"));
  logger.info(chalk.white("    /lockpos [here|off|x y z]"), chalk.gray("Lock bot to coordinates (anti-knockback)"));
  logger.info(chalk.white("    /aimmobs [on|off|range]"), chalk.gray("Toggle auto-aim / set maximum mob aim range"));
  logger.info(chalk.white("    /aimmobs player [on|off]"), chalk.gray("Toggle auto-aim on real players"));
  logger.info(chalk.white("    /aimmobs playerrange [r]"), chalk.gray("Set maximum player aim range"));
  logger.info(chalk.white("    /autotool [on|off] [sword|pick]"), chalk.gray("Toggle auto equip sword or pickaxe"));
  logger.info(chalk.white("    /attacklog [on|off]"), chalk.gray("Toggle logging dealt damage in terminal"));

  logger.info(chalk.hex("#A78BFA").bold("  Chat:"));
  logger.info(chalk.white("    <message>   "), chalk.gray("Send chat message"));
  logger.info(chalk.white("    /cmd <cmd>  "), chalk.gray("Send Minecraft command"));
  logger.separator();
}

import { debugScoreboard } from "./scoreboard";

export function handleDebug(bot: Bot, parts: string[]) {
  const type = parts[1]?.toLowerCase();
  if (type === "json") {
    const slotRaw = parts[2] ?? "";
    const slot = parseInt(slotRaw, 10);
    if (isNaN(slot)) {
      logger.system(chalk.red("Usage: /debug json <slot>"));
      return;
    }
    const item = hasUsableCurrentWindow(bot) ? bot.currentWindow?.slots?.[slot] : bot.inventory.slots[slot];
    if (!item) {
      logger.system(chalk.red(`No item in slot ${slot}`));
      return;
    }
    logger.separator();
    logger.system(chalk.cyan.bold(`[ Debug - Raw JSON - Slot ${slot} ]`));
    logger.system("");
    console.log(JSON.stringify(item, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value, 2
    ));
    logger.separator();
  } else if (type === "scoreboard") {
    debugScoreboard(bot);
  } else if (type === "inv" || type === "inventory" || type === "chat" || type === "on") {
    sharedState.debugChat = !sharedState.debugChat;
    logger.system(
      chalk.cyan("Chat Debug: ") +
      (sharedState.debugChat ? chalk.green("ENABLED") : chalk.red("DISABLED"))
    );
  } else {
    logger.system(chalk.yellow("Available debug types: json, scoreboard, inv (or on)"));
  }
}

export function handlePing(bot: Bot) {
  logger.info(chalk.white("Latency:"), chalk.hex("#34D399").bold(`${bot.player?.ping ?? "?"}ms`));
}

export function handleVersion(bot: Bot) {
  logger.info(chalk.white("MC version:"), chalk.hex("#A78BFA").bold(String(bot.version ?? "?")));
}

export function handleUptime() {
  logger.info(chalk.white("Session uptime:"), chalk.hex("#34D399").bold(getUptime()));
}

export function handleActionBar(args: string[] = [], bot: Bot | null = null) {
  const sub = args[0]?.toLowerCase();

  // Keep visibility per bot. The shared state remains as a fallback for
  // commands issued while disconnected, but connected bots must not affect
  // each other's actionbar output.
  const currentHidden = bot
    ? Boolean((bot as any).hideActionBar)
    : sharedState.hideActionBar;
  let hideActionBar = currentHidden;

  // Bare /actionbar keeps the original toggle behavior. Explicit on/off/status
  // are also supported for scripts and easier control.
  if (sub === undefined) {
    hideActionBar = !currentHidden;
  } else if (sub === "on" || sub === "show") {
    hideActionBar = false;
  } else if (sub === "off" || sub === "hide") {
    hideActionBar = true;
  } else if (sub !== "status") {
    logger.info(chalk.yellow("Usage: /actionbar [on|off|status]"));
    return;
  }

  if (sub !== "status") {
    if (bot) (bot as any).hideActionBar = hideActionBar;
    else sharedState.hideActionBar = hideActionBar;
  }

  logger.info(
    chalk.hex("#60A5FA")("Actionbar visibility:"),
    hideActionBar ? chalk.red("OFF (Hidden)") : chalk.green("ON (Visible)")
  );
}

/**
 * Send a BungeeCord/Velocity "Connect" plugin message to transfer to a sub-server.
 * This bypasses NPC interaction entirely — works if the proxy forwards plugin messages.
 */
export function handleTransfer(bot: Bot, args: string[]) {
  const serverName = args.join(" ").trim();
  if (!serverName) {
    logger.warn("Usage: /transfer <server>   (e.g. /transfer SkyFree)");
    return;
  }

  const client = (bot as any)._client;
  if (!client?.write) {
    logger.error("Cannot access internal client for plugin messaging.");
    return;
  }

  // Build BungeeCord "Connect" payload (Java DataOutputStream format):
  // writeUTF("Connect") + writeUTF(serverName)
  // writeUTF = 2-byte big-endian length prefix + UTF-8 string bytes
  function writeUTF(str: string): Buffer {
    const strBuf = Buffer.from(str, "utf-8");
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(strBuf.length, 0);
    return Buffer.concat([lenBuf, strBuf]);
  }

  const payload = Buffer.concat([writeUTF("Connect"), writeUTF(serverName)]);

  // Try both channel names — BungeeCord uses "bungeecord:main",
  // older versions use "BungeeCord", Velocity uses "bungeecord:main" too.
  const channels = ["bungeecord:main", "BungeeCord"];

  for (const channel of channels) {
    try {
      client.write("custom_payload", {
        channel,
        data: payload,
      });
    } catch {
      // Channel might not be registered; try next
    }
  }

  logger.info(
    chalk.hex("#A78BFA")("[Transfer]"),
    chalk.gray(`Sent Connect request to server: ${chalk.white(serverName)}`)
  );
  logger.info(
    chalk.hex("#A78BFA")("[Transfer]"),
    chalk.gray("If nothing happens, the proxy may not support client-side plugin messaging.")
  );
}

