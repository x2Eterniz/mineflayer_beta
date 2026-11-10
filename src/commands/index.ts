import * as readline from "readline";
import { cpus } from "os";
import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { type AppConfig, saveConfig } from "../config";

import { handleInv } from "./inv";
import { handleStatus, handleHealth, handleList, handlePos, handleAfk, handleTime, handleTabComplete, handleWeather, handleTablist, handleEffects, handleLevel } from "./player";
import { handleHelp, handlePing, handleVersion, handleUptime, handleDebug, handleActionBar, handleTransfer } from "./system";
import { handleScoreboard } from "./scoreboard";
import { getRealPlayers } from "../utils/helpers";

import { ClickCommand, CloseCommand } from "./click";
import { UseCommand, SwingCommand, AttackCommand, DigCommand, MineCommand, getMineStatus, stopAllActions } from "./action";
import { HotbarCommand } from "./hotbar";
import { MoveCommand, GoCommand } from "./move";
import { featuresConfig, saveFeaturesConfig } from "../features";
import { loadConfig } from "../config";
import { proxyType } from "../utils/proxy";
import { getToolTitleSolver } from "../events/games";
import { getAutoFarm } from "../features/autoFarm";

const COMMANDS = [
  "/help", "/quit", "/exit", "/reconnect", "/clear", "/boost", "/reload",
  "/status", "/level", "/list", "/health", "/pos", "/ping", "/uptime", "/version",
  "/healthcheck", "/perf",
  "/time", "/weather", "/effects", "/tablist",
  "/inv", "/hotbar", "/click", "/close",
  "/use", "/swing", "/attack", "/dig", "/mine", "/go", "/goto", "/stop", "/npcs",
  "/afk", "/actionbar", "/transfer", "/scoreboard",
  "/coop",
  "/proxy",
  "/tab", "/debug", "/tooltitle",
  "/autoeat", "/autoskill", "/servertrigger", "/autofollow", "/lockpos", "/aimmobs", "/attacklog", "/debugentities",
  "/af", "/auto", "/autofarm", "/asr",
];

let _getBot: (() => Bot | null) | null = null;
let _rl: readline.Interface | null = null;

async function handleHealthcheck(bot: Bot): Promise<void> {
  const client = (bot as any)._client;
  const connectionState = String(client?.state ?? "disconnected");
  const connected = !!client && !client.ended && connectionState !== "disconnected";
  const mine = getMineStatus(bot);
  const hidden = Boolean((bot as any).hideActionBar);
  const actionbarText = String((bot as any).currentActionBar ?? "").replace(/\s+/g, " ").trim();

  const beforeCpu = process.cpuUsage();
  const beforeTime = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterCpu = process.cpuUsage(beforeCpu);
  const elapsedMs = Number(process.hrtime.bigint() - beforeTime) / 1e6;
  const cpuMs = (afterCpu.user + afterCpu.system) / 1000;
  const cpuPercent = elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0;
  const memory = process.memoryUsage();
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  logger.separator();
  logger.info(chalk.hex("#60A5FA").bold(`[ Healthcheck: ${bot.username} ]`));
  logger.info(
    "Connection:",
    connected ? chalk.green("CONNECTED") : chalk.red("DISCONNECTED"),
    chalk.gray(`state=${connectionState}`)
  );
  logger.info(
    "Mine:",
    mine.isMining ? chalk.green("RUNNING") : chalk.gray("STOPPED"),
    chalk.gray(`blocks=${mine.blocksAhead}`),
    chalk.gray(`capdao=${mine.capdaoEnabled ? "ON" : "OFF"}`),
    mine.lv50Busy ? chalk.yellow("capdao-flow=BUSY") : ""
  );
  logger.info(
    "Actionbar:",
    hidden ? chalk.red("OFF") : chalk.green("ON"),
    actionbarText ? chalk.gray(`last="${actionbarText.slice(0, 60)}"`) : chalk.gray("no data")
  );
  logger.info(
    "Process:",
    chalk.cyan(`RSS ${mb(memory.rss)} MB`),
    chalk.gray(`heap ${mb(memory.heapUsed)}/${mb(memory.heapTotal)} MB`),
    chalk.yellow(`CPU ${cpuPercent.toFixed(1)}%`),
    chalk.gray(`cores=${cpus().length}`)
  );
  logger.separator();
}

async function handlePerf(bot: Bot, config: AppConfig): Promise<void> {
  const beforeCpu = process.cpuUsage();
  const before = process.hrtime.bigint();
  let eventLoopLag = 0;
  const timerStarted = performance.now();
  await new Promise<void>((resolve) => setTimeout(() => {
    eventLoopLag = Math.max(0, performance.now() - timerStarted - 100);
    resolve();
  }, 100));
  await new Promise<void>((resolve) => setTimeout(resolve, 400));

  const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
  const cpu = process.cpuUsage(beforeCpu);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const cpuPercent = elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0;
  const memory = process.memoryUsage();
  const mb = (value: number) => (value / 1024 / 1024).toFixed(1);
  const featureConfig = (bot as any).featuresConfig ?? {};
  const farm = getAutoFarm(bot, config);
  const client = (bot as any)._client;

  logger.separator();
  logger.info(chalk.hex("#60A5FA").bold(`[ Perf: ${bot.username} ]`));
  logger.info(
    "Process:",
    chalk.yellow(`CPU ${cpuPercent.toFixed(1)}%`),
    chalk.gray(`event-loop lag ${eventLoopLag.toFixed(1)}ms`),
    chalk.cyan(`RSS ${mb(memory.rss)} MB`),
    chalk.gray(`heap ${mb(memory.heapUsed)}/${mb(memory.heapTotal)} MB`)
  );
  logger.info(
    "World:",
    chalk.gray(`entities=${Object.keys(bot.entities ?? {}).length}`),
    chalk.gray(`players=${Object.keys(bot.players ?? {}).length}`),
    chalk.gray(`chunks=${Object.keys((bot as any).world?.loadedChunks ?? {}).length}`),
    chalk.gray(`window=${client?.ended ? "closed" : bot.currentWindow ? "open" : "none"}`)
  );
  logger.info(
    "Features:",
    `mine=${getMineStatus(bot).isMining ? "ON" : "OFF"}`,
    `autofarm=${farm.isEnabled() ? "ON" : "OFF"}`,
    `path=${bot.pathfinder?.isMoving?.() ? "MOVING" : "IDLE"}`,
    `autoeat=${featureConfig.autoEat?.enabled ? "ON" : "OFF"}`,
    `autotool=${featureConfig.autoTool?.autoSword || featureConfig.autoTool?.autoPickaxe ? "ON" : "OFF"}`
  );
  logger.separator();
}

function handleCleanCommand(): void {
  const before = process.memoryUsage();
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;

  if (typeof gc !== "function") {
    logger.warn("[Clean] V8 GC chưa bật. Hãy chạy bằng Node với --expose-gc để dọn heap thật sự.");
    logger.info(
      `[Clean] RSS ${(before.rss / 1024 / 1024).toFixed(1)} MB | heap ${(before.heapUsed / 1024 / 1024).toFixed(1)} MB`
    );
    return;
  }

  try {
    gc();
    const after = process.memoryUsage();
    const mb = (value: number) => (value / 1024 / 1024).toFixed(1);
    logger.info(
      chalk.green("[Clean] Đã dọn heap an toàn:"),
      `RSS ${mb(before.rss)} -> ${mb(after.rss)} MB,`,
      `heap ${mb(before.heapUsed)} -> ${mb(after.heapUsed)} MB`
    );
  } catch (err) {
    logger.warn(`[Clean] Không thể chạy GC: ${(err as Error)?.message ?? err}`);
  }
}

export function updatePrompt() {
  if (!_rl || (_rl as readline.Interface & { closed?: boolean }).closed === true) return;
  const now = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  _rl.setPrompt(chalk.gray("| ") + chalk.gray(now) + " " + chalk.hex("#FBBF24").bold("ASK") + chalk.gray(" | ") + chalk.cyan("> "));
  _rl.prompt(true);
}

export function setBotGetter(getter: () => Bot | null) {
  _getBot = getter;
}

export function completer(line: string): [string[], string] {
  if (line.startsWith("/")) {
    const hits = COMMANDS.filter((c) => c.startsWith(line.toLowerCase()));
    return [hits.length ? hits : COMMANDS, line];
  }

  const bot = _getBot?.();
  if (bot && Object.keys(bot.players).length > 0) {
    const words = line.split(" ");
    const lastWord = words[words.length - 1] ?? "";
    if (lastWord.length >= 1) {
      const playerNames = getRealPlayers(bot)
        .filter((n) => n.toLowerCase().startsWith(lastWord.toLowerCase()));
      if (playerNames.length > 0) {
        const prefix = words.slice(0, -1).join(" ");
        const completions = playerNames.map((n) => (prefix ? prefix + " " + n : n));
        return [completions, line];
      }
    }
  }

  return [[], line];
}

export function startCommandLoop(
  rl: readline.Interface,
  getBot: () => Bot | null,
  onQuit: () => void,
  onReconnect: () => void,
  config: AppConfig,
  routeAccountCommand?: (account: string, command: string) => Promise<void> | void,
  accountLabel?: string,
  getActiveConfig?: () => AppConfig,
  selectAccount?: (account: string) => boolean,
): void {
  setBotGetter(getBot);
  logger.setCompleter(completer);

  const updatePrompt = () => {
    if ((rl as readline.Interface & { closed?: boolean }).closed === true) return;
    const now = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    rl.setPrompt(chalk.gray("| ") + chalk.gray(now) + " " + chalk.hex("#FBBF24").bold("ASK") + chalk.gray(" | ") + chalk.cyan("> "));
    rl.prompt(true);
  };

  _rl = rl;
  setTimeout(updatePrompt, 500);

  rl.on("line", (input: string) => {
    const line = input.trim();
    if (!line) {
      updatePrompt();
      return;
    }

    if (selectAccount && line.toLowerCase().startsWith("/select ")) {
      const account = line.slice("/select ".length).trim();
      if (!account || !selectAccount(account)) {
        logger.warn("Usage: /select <account>");
      }
      updatePrompt();
      return;
    }

    // Multi-account command routing:
    //   /acc Res2 /mine
    //   /acc Res3 /tooltitle status
    //   /acc all /autofarm off
    if (routeAccountCommand && line.toLowerCase().startsWith("/acc ")) {
      const parts = line.split(/\s+/);
      const account = parts[1] ?? "";
      const command = parts.slice(2).join(" ").trim();
      if (!account || !command) {
        logger.info("Usage: /acc <account|all> <command> | /acc <account|all> chat <message>");
        updatePrompt();
        return;
      }
      void Promise.resolve(routeAccountCommand(account, command)).catch((err) => {
        logger.error("Account command failed:", String((err as Error)?.message ?? err));
      });
      return;
    }

    const bot = getBot();
    const activeConfig = getActiveConfig?.() ?? config;
    void handleCommand(line, bot, activeConfig, onQuit, onReconnect, () => updatePrompt());
  });

  rl.on("close", () => {
    logger.info(chalk.yellow("Input stream closed."));
  });

  rl.on("SIGINT", () => {
    logger.info(chalk.yellow("Caught interrupt -- disconnecting..."));
    onQuit();
    rl.close();
    setTimeout(() => process.exit(0), 500);
  });
}

function handleAutoFarmCommand(args: string[], bot: Bot | null, config: AppConfig): void {
  if (!bot) { logger.warn("Not connected"); return; }
  const farm = getAutoFarm(bot, config);
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === "status") { logger.info(chalk.hex("#34D399")("[AutoFarm]"), farm.status()); return; }
  const onOff = (value?: string) => value === "on" || value === "enable" ? true : value === "off" || value === "disable" ? false : null;
  switch (sub) {
    case "on": farm.setEnabled(true); break;
    case "off": farm.setEnabled(false); break;
    case "toggle": farm.toggle(); break;
    case "setup": farm.setMode("multi"); farm.setRadius(128); farm.setPathRadius(128); farm.setPathMode(true); farm.setEnabled(true); logger.info("[AutoFarm] Setup complete: Multi, radius 128, Pathfinder ON, Farm ON."); break;
    case "multi": {
      const ms = Number(args[1]);
      if (!Number.isFinite(ms) || ms < 0) logger.warn("Usage: /af multi <ms>");
      else farm.setMultiSpeed(ms);
      break;
    }
    case "mode": farm.setMode(args[1] ?? ""); break;
    case "radius": {
      const n = Number(args[1]);
      if (!Number.isFinite(n)) logger.warn("Usage: /af radius <1-256>"); else farm.setRadius(n);
      break;
    }
    case "crop": farm.setCropFilter(args.slice(1).join(" ")); break;
    case "path": {
      const v = args[1]?.toLowerCase();
      if (v === "toggle") farm.togglePathMode(); else { const state = onOff(v); if (state === null) logger.warn("Usage: /af path on/off"); else farm.setPathMode(state); }
      break;
    }
    case "debug": {
      const v = onOff(args[1]?.toLowerCase());
      if (v === null) logger.warn("Usage: /af debug on/off");
      else farm.setDebug(v);
      break;
    }
    case "inspect": farm.inspectNearby(); break;
    case "pathradius": {
      const n = Number(args[1]);
      if (!Number.isFinite(n)) logger.warn("Usage: /af pathradius <8-256>"); else farm.setPathRadius(n);
      break;
    }
    case "zone": {
      const z = args[1]?.toLowerCase();
      if (z === "pos1" || z === "pos2") farm.setZonePos(z === "pos1" ? 1 : 2);
      else if (z === "add") { const mins = Number(args[3]); if (!args[2] || !Number.isFinite(mins)) logger.warn("Usage: /af zone add <name> <minutes>"); else farm.addZone(args[2], mins); }
      else if (z === "remove") { if (!args[2]) logger.warn("Usage: /af zone remove <name>"); else farm.removeZone(args[2]); }
      else if (z === "list") farm.listZones();
      else if (z === "start") farm.startZones();
      else if (z === "stop") farm.stopZones();
      else if (z === "time") { const mins = Number(args[2]); if (!Number.isFinite(mins)) logger.warn("Usage: /af zone time <minutes>"); else farm.setZoneTime(mins); }
      else if (z === "status") logger.info("[AutoFarm]", farm.zoneStatus());
      else logger.info("Usage: /af zone pos1|pos2|add|remove|list|start|stop|time|status");
      break;
    }
    default:
      logger.info("Usage: /af on|off|toggle|setup|multi <ms>|mode <farmer|harvest|plant|multi>|radius <1-256>|crop <crop...|all>|path on/off|pathradius <8-256>|zone ...|debug on/off|status");
  }
}

function handleToolTitleCommand(args: string[], config: AppConfig): void {
  const tool = config.chatGames.toolTitle;
  const sub = args[0]?.toLowerCase();
  const solver = getToolTitleSolver();

  if (!sub) {
    const s = solver?.getStatus();
    logger.info(chalk.hex("#FBBF24").bold("[ToolTitle]"));
    logger.info(`Enabled: ${tool.enabled ? chalk.green("ON") : chalk.red("OFF")}`);
    logger.info(`Normal: ${tool.normalEnabled ? chalk.green("ON") : chalk.red("OFF")} | Delay: ${tool.normalMinDelayMs}-${tool.normalMaxDelayMs}ms`);
    logger.info(`Multiply: ${tool.multiplyEnabled ? chalk.green("ON") : chalk.red("OFF")} | Delay: ${tool.multiplyMinDelayMs}-${tool.multiplyMaxDelayMs}ms`);
    logger.info(`Word: ${tool.wordEnabled ? chalk.green("ON") : chalk.red("OFF")} | Delay: ${tool.wordMinDelayMs}-${tool.wordMaxDelayMs}ms`);
    logger.info(`Debug: ${tool.debug ? chalk.green("ON") : chalk.red("OFF")} | Benchmark: ${tool.benchmark ? chalk.green("ON") : chalk.red("OFF")}`);
    if (s) logger.info(`State: ${s.state}`);
    return;
  }

  const state = (value: string | undefined): boolean | null => {
    if (value === "on" || value === "enable" || value === "enabled") return true;
    if (value === "off" || value === "disable" || value === "disabled") return false;
    return null;
  };

  const parseDelayMs = (input: string | undefined): number => {
    if (!input) return Number.NaN;
    const value = input.trim().toLowerCase().replace(",", ".");
    if (value.endsWith("ms")) return Number(value.slice(0, -2));
    if (value.endsWith("s")) return Number(value.slice(0, -1)) * 1000;
    // Bare values remain milliseconds for backward compatibility.
    return Number(value);
  };

  const setRange = (name: string, minArg: string | undefined, maxArg: string | undefined) => {
    const min = parseDelayMs(minArg);
    const max = parseDelayMs(maxArg ?? minArg);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || max < min) {
      logger.warn(`Usage: /tooltitle ${name} <min[ms|s]> <max[ms|s]>`);
      return;
    }
    if (name === "delay") {
      tool.normalMinDelayMs = Math.floor(min);
      tool.normalMaxDelayMs = Math.floor(max);
    } else if (name === "multidelay") {
      tool.multiplyMinDelayMs = Math.floor(min);
      tool.multiplyMaxDelayMs = Math.floor(max);
    } else {
      tool.wordMinDelayMs = Math.floor(min);
      tool.wordMaxDelayMs = Math.floor(max);
    }
    saveConfig(config);
    logger.info(chalk.green(`[ToolTitle] ${name}: ${Math.floor(min)}-${Math.floor(max)}ms`));
  };

  switch (sub) {
    case "delay":
      setRange("delay", args[1], args[2]);
      break;
    case "multidelay":
      setRange("multidelay", args[1], args[2]);
      break;
    case "worddelay":
      setRange("worddelay", args[1], args[2]);
      break;
    case "multi": {
      const value = state(args[1]);
      if (value === null) logger.warn("Usage: /tooltitle multi on/off");
      else { tool.multiplyEnabled = value; saveConfig(config); logger.info(`[ToolTitle] Multi ${value ? "enabled" : "disabled"}.`); }
      break;
    }
    case "normal": {
      const value = state(args[1]);
      if (value === null) logger.warn("Usage: /tooltitle normal on/off");
      else { tool.normalEnabled = value; saveConfig(config); logger.info(`[ToolTitle] Normal ${value ? "enabled" : "disabled"}.`); }
      break;
    }
    case "word": {
      const value = state(args[1]);
      if (value === null) logger.warn("Usage: /tooltitle word on/off");
      else { tool.wordEnabled = value; saveConfig(config); logger.info(`[ToolTitle] Word ${value ? "enabled" : "disabled"}.`); }
      break;
    }
    case "debug": {
      const value = state(args[1]);
      if (value === null) logger.warn("Usage: /tooltitle debug on/off");
      else { tool.debug = value; saveConfig(config); logger.info(`[ToolTitle] Debug ${value ? "enabled" : "disabled"}.`); }
      break;
    }
    case "benchmark": {
      const value = state(args[1]);
      if (value === null) logger.warn("Usage: /tooltitle benchmark on/off");
      else { tool.benchmark = value; saveConfig(config); logger.info(`[ToolTitle] Benchmark ${value ? "enabled" : "disabled"}.`); }
      break;
    }
    case "status": {
      if (!solver) { logger.warn("[ToolTitle] Solver is not initialized yet."); break; }
      const s = solver.getStatus();
      logger.info(chalk.hex("#FBBF24").bold("[ToolTitle] Status"));
      logger.info(`Enabled: ${s.enabled ? "ON" : "OFF"} | State: ${s.state}`);
      logger.info(`Normal: ${s.normal ? "ON" : "OFF"} | ${s.delay[0]}-${s.delay[1]}ms`);
      logger.info(`Multiply: ${s.multiply ? "ON" : "OFF"} | ${s.multiplyDelay[0]}-${s.multiplyDelay[1]}ms`);
      logger.info(`Word: ${s.word ? "ON" : "OFF"} | ${s.wordDelay[0]}-${s.wordDelay[1]}ms`);
      logger.info(`Debug: ${s.debug ? "ON" : "OFF"} | Benchmark: ${s.benchmark ? "ON" : "OFF"}`);
      break;
    }
    case "history": {
      if (!solver) { logger.warn("[ToolTitle] Solver is not initialized yet."); break; }
      const history = solver.getHistory();
      if (history.length === 0) { logger.info("[ToolTitle] History is empty."); break; }
      logger.info(chalk.hex("#FBBF24").bold("[ToolTitle] Recent history"));
      for (const item of history.slice(0, 20)) {
        logger.info(`${item.time} | ${item.type} | ${item.question} -> ${item.answer} | ${item.status}`);
      }
      break;
    }
    default:
      logger.info("Usage: /tooltitle <delay|multidelay|multi|normal|status|history|word|worddelay|debug|benchmark>");
  }
}

function handleAutoReconnectSetupCommand(args: string[], config: AppConfig): void {
  const sub = args[0]?.toLowerCase();
  if (sub !== "on" && sub !== "off" && sub !== "status") {
    logger.info("Usage: /asr on|off|status");
    return;
  }

  if (sub === "status") {
    logger.info(
      chalk.hex("#60A5FA")("Auto reconnect setup:"),
      config.autoCommands.enabled ? chalk.green("ON") : chalk.red("OFF")
    );
    return;
  }

  config.autoCommands.enabled = sub === "on";
  saveConfig(config);
  logger.info(
    chalk.hex("#60A5FA")("Auto reconnect setup:"),
    config.autoCommands.enabled ? chalk.green("ON") : chalk.red("OFF")
  );
}

function handleProxyCommand(args: string[], config: AppConfig): void {
  const sub = args[0]?.toLowerCase();
  const proxy = config.proxy;
  if (!sub || sub === "status") {
    logger.info(
      chalk.hex("#60A5FA")("Proxy:"),
      proxy.enabled ? chalk.green("ON") : chalk.red("OFF"),
      chalk.gray(`${proxy.type}://${proxy.host || "-"}:${proxy.port || "-"}`),
      chalk.gray(proxy.username ? "auth=ON" : "auth=OFF")
    );
    logger.info("Usage: /proxy set <socks5|socks4|http|https> <host> <port> [username] [password] | /proxy on|off");
    return;
  }

  if (sub === "off") {
    proxy.enabled = false;
    saveConfig(config);
    logger.info(chalk.hex("#60A5FA")("Proxy:"), chalk.red("OFF"));
    return;
  }

  if (sub === "on") {
    if (!proxy.host || !proxy.port) {
      logger.warn("Proxy chưa được cấu hình. Dùng: /proxy set <type> <host> <port> [username] [password]");
      return;
    }
    proxy.enabled = true;
    saveConfig(config);
    logger.info(chalk.hex("#60A5FA")("Proxy:"), chalk.green("ON"));
    return;
  }

  if (sub === "set") {
    const type = proxyType(args[1]);
    const host = args[2]?.trim();
    const port = Number(args[3]);
    if (!type || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      logger.warn("Usage: /proxy set <socks5|socks4|http|https> <host> <port> [username] [password]");
      return;
    }
    proxy.type = type;
    proxy.host = host;
    proxy.port = port;
    proxy.username = args[4] ?? "";
    proxy.password = args[5] ?? "";
    proxy.enabled = true;
    saveConfig(config);
    logger.info(chalk.green(`[Proxy] ${type}://${host}:${port} đã lưu cho account ${config.bot.username} và bật.`));
    return;
  }

  logger.info("Usage: /proxy status | /proxy set <type> <host> <port> [username] [password] | /proxy on|off");
}

function handleCoopCommand(args: string[], config: AppConfig, bot: Bot | null): void {
  const sub = args[0]?.toLowerCase();
  if (sub === "off") {
    config.coop.enabled = false;
    saveConfig(config);
    logger.info(chalk.hex("#60A5FA")("Auto coop:"), chalk.red("OFF"));
    return;
  }
  if (sub === "status" || args.length === 0) {
    logger.info(
      chalk.hex("#60A5FA")("Auto coop:"),
      config.coop.enabled ? chalk.green("ON") : chalk.red("OFF"),
      chalk.gray(`owner=${config.coop.owner || "-"}`),
      chalk.gray(`members=${config.coop.members.join(", ") || "-"}`)
    );
    return;
  }

  const names = args.map((name) => name.trim()).filter(Boolean);
  const owner = names.shift();
  if (!owner || names.length === 0) {
    logger.info("Usage: /coop <owner> <account1> <account2> ... | /coop off | /coop status");
    return;
  }

  config.coop.enabled = true;
  config.coop.owner = owner;
  config.coop.members = [...new Set(names.map((name) => name.replace(/[^a-zA-Z0-9_]/g, "")))];
  saveConfig(config);

  // Configure every listed account in one command. Each process reads its
  // own account file on startup, so all member bots can react independently
  // when the owner joins again.
  const participants = [...new Set([owner, ...config.coop.members])];
  for (const username of participants) {
    try {
      const accountConfig = loadConfig(username);
      accountConfig.coop = {
        enabled: true,
        owner,
        members: [...config.coop.members],
      };
      saveConfig(accountConfig);
    } catch (err) {
      logger.warn(chalk.yellow(`[Coop] Failed to save ${username}: ${(err as Error)?.message ?? err}`));
    }
  }
  logger.info(
    chalk.green("Auto coop enabled:"),
    chalk.white(`/is coop <member>`),
    chalk.gray(`owner=${owner}, members=${config.coop.members.join(", ")}`)
  );
  if (bot && config.coop.members.some((name) => name.toLowerCase() === bot.username.toLowerCase())) {
    logger.info(chalk.gray("Current account is in the coop member list; it will be handled when the owner sees its join message."));
  }
}

export async function handleCommand(
  line: string,
  bot: Bot | null,
  config: AppConfig,
  onQuit: () => void,
  onReconnect: () => void,
  onFinish?: () => void
) {
  if (line.startsWith("/")) {
    const parts = line.slice(1).split(" ");
    const cmd = parts[0]?.toLowerCase() ?? "";

    switch (cmd) {
      case "quit":
      case "exit":
        logger.info(chalk.yellow("Shutting down..."));
        onQuit();
        setTimeout(() => process.exit(0), 500);
        return;

      case "wait":
        if (parts[1]) {
          const ms = parseInt(parts[1], 10);
          if (!isNaN(ms) && ms > 0) {
            await new Promise(resolve => setTimeout(resolve, ms));
          }
        }
        break;

      case "reconnect":
        logger.info(chalk.hex("#60A5FA")("Reconnecting..."));
        onReconnect();
        break;

      case "clear":
        logger.clear();
        break;

      case "boost":
        handleCleanCommand();
        break;

      case "list":
        if (bot && Object.keys(bot.players).length > 0) handleList(bot);
        else logger.info("No player data available yet.");
        break;

      case "level":
        if (bot) handleLevel(bot);
        else logger.warn("Not connected");
        break;

      case "status":
        if (bot) handleStatus(bot);
        else logger.warn("Not connected to any server");
        break;

      case "ping":
        if (bot) handlePing(bot);
        else logger.warn("Not connected");
        break;

      case "version":
        if (bot) handleVersion(bot);
        else logger.warn("Not connected");
        break;

      case "uptime":
        handleUptime();
        break;

      case "health":
        if (bot) handleHealth(bot);
        else logger.warn("Not connected");
        break;

      case "healthcheck":
        if (bot) await handleHealthcheck(bot);
        else logger.warn("Not connected");
        break;

      case "perf":
        if (bot) await handlePerf(bot, config);
        else logger.warn("Not connected");
        break;

      case "pos":
        if (bot) handlePos(bot);
        else logger.warn("Not connected");
        break;

      case "afk":
        if (bot) handleAfk(bot);
        else logger.warn("Not connected");
        break;

      case "inv":
        if (bot) await handleInv(bot, parts);
        else logger.warn("Not connected");
        break;

      case "help":
        handleHelp();
        break;

      case "debug":
        if (bot) handleDebug(bot, parts);
        else logger.warn("Not connected");
        break;

      case "click":
        if (bot) await ClickCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "close":
        if (bot) await CloseCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "hotbar":
        if (bot) HotbarCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "use":
        if (bot) UseCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "swing":
        if (bot) SwingCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "attack":
        if (bot) AttackCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "dig":
        if (bot) await DigCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "mine":
        if (bot) await MineCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "go":
        if (bot) await GoCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "goto":
        if (bot) await MoveCommand.execute(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "stop":
        if (bot) {
          GoCommand.stop(bot);
          MoveCommand.stop(bot);
          stopAllActions(bot);
        }
        else logger.warn("Not connected");
        break;

      case "npcs":
        if (bot) MoveCommand.listTargets(bot, parts.slice(1).join(" ").trim() || undefined);
        else logger.warn("Not connected");
        break;

      case "reload":
        void (async () => {
          try {
            const { loadConfig } = await import("../config");
            const newConfig = loadConfig(config.bot.username);
            for (const key in newConfig) {
              (config as any)[key] = (newConfig as any)[key];
            }
            
            const { reloadFeaturesConfig } = await import("../features");
            reloadFeaturesConfig(bot);

            logger.info(chalk.green("✔ Configuration and features reloaded successfully!"));
          } catch (err) {
            logger.error("Error reloading configuration:", (err as Error).message);
          }
        })();
        break;

      case "actionbar":
        handleActionBar(parts.slice(1), bot);
        break;

      case "asr":
        handleAutoReconnectSetupCommand(parts.slice(1), config);
        break;

      case "proxy":
        handleProxyCommand(parts.slice(1), config);
        break;


      case "coop":
        handleCoopCommand(parts.slice(1), config, bot);
        break;

      case "transfer":
        if (bot) handleTransfer(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "scoreboard":
        if (bot) handleScoreboard(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "tooltitle":
        handleToolTitleCommand(parts.slice(1), config);
        break;

      case "tab":
        if (bot) void handleTabComplete(bot, parts.slice(1));
        else logger.warn("Not connected");
        break;

      case "time":
        if (bot) handleTime(bot);
        else logger.warn("Not connected");
        break;

      case "weather":
        if (bot) handleWeather(bot);
        else logger.warn("Not connected");
        break;

      case "tablist":
        if (bot) handleTablist(bot);
        else logger.warn("Not connected");
        break;

      case "effects":
        if (bot) handleEffects(bot);
        else logger.warn("Not connected");
        break;

      case "af":
      case "auto":
      case "autofarm":
        handleAutoFarmCommand(parts.slice(1), bot, config);
        break;

      case "autoeat":
        {
          const arg = parts[1]?.toLowerCase();
          if (!arg) {
            logger.info(
              chalk.hex("#34D399")("[AutoEat]") +
              ` Currently ${featuresConfig.autoEat.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")} (Min Food: ${featuresConfig.autoEat.minFood})`
            );
          } else if (arg === "on" || arg === "enable") {
            featuresConfig.autoEat.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#34D399")("[AutoEat]") + " Enabled auto eat.");
          } else if (arg === "off" || arg === "disable") {
            featuresConfig.autoEat.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#34D399")("[AutoEat]") + " Disabled auto eat.");
          } else {
            const val = parseInt(arg);
            if (!isNaN(val)) {
              featuresConfig.autoEat.minFood = val;
              saveFeaturesConfig(featuresConfig);
              logger.info(chalk.hex("#34D399")("[AutoEat]") + ` Set min food level to ${val}.`);
            } else {
              logger.warn("Usage: /autoeat [on|off|<minFood>]");
            }
          }
        }
        break;

      case "autoskill":
        {
          const arg = parts[1]?.toLowerCase();
          if (!arg) {
            logger.info(
              chalk.hex("#8B5CF6")("[AutoSkill]") +
              ` Currently ${featuresConfig.autoSkill.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")} (Range: ${featuresConfig.autoSkill.range}m)`
            );
          } else if (arg === "on" || arg === "enable") {
            featuresConfig.autoSkill.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#8B5CF6")("[AutoSkill]") + " Enabled auto skills.");
          } else if (arg === "off" || arg === "disable") {
            featuresConfig.autoSkill.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#8B5CF6")("[AutoSkill]") + " Disabled auto skills.");
          } else {
            const val = parseInt(arg);
            if (!isNaN(val)) {
              featuresConfig.autoSkill.range = val;
              saveFeaturesConfig(featuresConfig);
              logger.info(chalk.hex("#8B5CF6")("[AutoSkill]") + ` Set auto skill range to ${val}m.`);
            } else {
              logger.warn("Usage: /autoskill [on|off|<range>]");
            }
          }
        }
        break;

      case "servertrigger":
        {
          const arg = parts[1]?.toLowerCase();
          if (!arg) {
            logger.info(
              chalk.hex("#10B981")("[ServerTriggerBot]") +
              ` Currently ${featuresConfig.serverTriggerBot.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")} (Interval: ${featuresConfig.serverTriggerBot.checkIntervalMs}ms, Command: ${featuresConfig.serverTriggerBot.command})`
            );
          } else if (arg === "on" || arg === "enable") {
            featuresConfig.serverTriggerBot.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#10B981")("[ServerTriggerBot]") + " Enabled server triggerbot auto-activation.");
          } else if (arg === "off" || arg === "disable") {
            featuresConfig.serverTriggerBot.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#10B981")("[ServerTriggerBot]") + " Disabled server triggerbot auto-activation.");
          } else {
            logger.warn("Usage: /servertrigger [on|off]");
          }
        }
        break;

      case "autofollow":
        {
          const target = parts.slice(1).join(" ").trim();
          if (!target) {
            logger.info(
              chalk.hex("#3B82F6")("[AutoFollow]") +
              ` Currently ${featuresConfig.autoFollow.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")} (Target: '${featuresConfig.autoFollow.target || "none"}')`
            );
          } else if (target.toLowerCase() === "off" || target.toLowerCase() === "disable") {
            featuresConfig.autoFollow.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#3B82F6")("[AutoFollow]") + " Disabled auto follow.");
          } else {
            featuresConfig.autoFollow.target = target;
            featuresConfig.autoFollow.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#3B82F6")("[AutoFollow]") + ` Enabled auto follow targeting: ${target}`);
          }
        }
        break;

      case "lockpos":
        {
          const arg = parts[1]?.toLowerCase();
          if (!arg) {
            logger.info(
              chalk.hex("#F59E0B")("[LockPosition]") +
              ` Currently ${featuresConfig.lockPosition.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")} (Locked coordinates: ${featuresConfig.lockPosition.x ?? "none"}, ${featuresConfig.lockPosition.y ?? "none"}, ${featuresConfig.lockPosition.z ?? "none"})`
            );
          } else if (arg === "off" || arg === "disable") {
            featuresConfig.lockPosition.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#F59E0B")("[LockPosition]") + " Disabled lock position.");
          } else if (arg === "here" || arg === "set") {
            if (!bot || !bot.entity) {
              logger.error("Not connected or bot not spawned yet.");
              break;
            }
            const { x, y, z } = bot.entity.position;
            featuresConfig.lockPosition.x = Math.round(x);
            featuresConfig.lockPosition.y = Math.round(y);
            featuresConfig.lockPosition.z = Math.round(z);
            featuresConfig.lockPosition.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(
              chalk.hex("#F59E0B")("[LockPosition]") +
              ` Locked position set to current coordinates: ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}`
            );
          } else {
            const xVal = parseFloat(parts[1] ?? "");
            const yVal = parseFloat(parts[2] ?? "");
            const zVal = parseFloat(parts[3] ?? "");
            if (!isNaN(xVal) && !isNaN(yVal) && !isNaN(zVal)) {
              featuresConfig.lockPosition.x = xVal;
              featuresConfig.lockPosition.y = yVal;
              featuresConfig.lockPosition.z = zVal;
              featuresConfig.lockPosition.enabled = true;
              saveFeaturesConfig(featuresConfig);
              logger.info(
                chalk.hex("#F59E0B")("[LockPosition]") +
                ` Locked position set to custom coordinates: ${xVal}, ${yVal}, ${zVal}`
              );
            } else {
              logger.warn("Usage: /lockpos [here|off|<x> <y> <z>]");
            }
          }
        }
        break;

      case "aimmobs":
        {
          const arg1 = parts[1]?.toLowerCase();
          const arg2 = parts[2]?.toLowerCase();
          if (!arg1) {
            logger.info(
              chalk.hex("#EC4899")("[AimMobs]") +
              ` Currently ${featuresConfig.aimMobs.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")}` +
              ` (Mob Range: ${featuresConfig.aimMobs.range ?? 30}m, Aim Players: ${featuresConfig.aimMobs.aimPlayers ? chalk.green("ON") : chalk.red("OFF")}, Player Range: ${featuresConfig.aimMobs.playerRange ?? 30}m)`
            );
          } else if (arg1 === "player") {
            if (arg2 === "on" || arg2 === "enable") {
              featuresConfig.aimMobs.aimPlayers = true;
              saveFeaturesConfig(featuresConfig);
              logger.info(chalk.hex("#EC4899")("[AimMobs]") + " Enabled auto aim on real players.");
            } else if (arg2 === "off" || arg2 === "disable") {
              featuresConfig.aimMobs.aimPlayers = false;
              saveFeaturesConfig(featuresConfig);
              logger.info(chalk.hex("#EC4899")("[AimMobs]") + " Disabled auto aim on real players.");
            } else {
              logger.warn("Usage: /aimmobs player [on|off]");
            }
          } else if (arg1 === "playerrange") {
            const rangeVal = parseInt(arg2 || "", 10);
            if (!isNaN(rangeVal) && rangeVal > 0) {
              featuresConfig.aimMobs.playerRange = rangeVal;
              saveFeaturesConfig(featuresConfig);
              logger.info(
                chalk.hex("#EC4899")("[AimMobs]") +
                ` Set player aim range to: ${rangeVal}m`
              );
            } else {
              logger.warn("Usage: /aimmobs playerrange <range>");
            }
          } else if (arg1 === "on" || arg1 === "enable") {
            featuresConfig.aimMobs.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#EC4899")("[AimMobs]") + " Enabled auto aim feature.");
          } else if (arg1 === "off" || arg1 === "disable") {
            featuresConfig.aimMobs.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#EC4899")("[AimMobs]") + " Disabled auto aim feature.");
          } else {
            const rangeVal = parseInt(arg1, 10);
            if (!isNaN(rangeVal) && rangeVal > 0) {
              featuresConfig.aimMobs.range = rangeVal;
              featuresConfig.aimMobs.enabled = true;
              saveFeaturesConfig(featuresConfig);
              logger.info(
                chalk.hex("#EC4899")("[AimMobs]") +
                ` Enabled auto aim with mob range: ${rangeVal}m`
              );
            } else {
              logger.warn("Usage: /aimmobs [on|off|<mob_range>|player [on|off]|playerrange <range>]");
            }
          }
        }
        break;

      case "autotool":
        {
          const arg = parts[1]?.toLowerCase();
          const target = parts[2]?.toLowerCase();
          if (!arg) {
            logger.info(
              chalk.hex("#10B981")("[AutoTool]") +
              ` Sword: ${featuresConfig.autoTool.autoSword ? chalk.green("ON") : chalk.red("OFF")} | ` +
              `Pickaxe: ${featuresConfig.autoTool.autoPickaxe ? chalk.green("ON") : chalk.red("OFF")}`
            );
          } else if (arg === "on" || arg === "off") {
            const state = arg === "on";
            if (target === "sword") {
              featuresConfig.autoTool.autoSword = state;
              logger.info(chalk.hex("#10B981")("[AutoTool]") + ` Auto Sword ${state ? "enabled" : "disabled"}.`);
            } else if (target === "pickaxe") {
              featuresConfig.autoTool.autoPickaxe = state;
              logger.info(chalk.hex("#10B981")("[AutoTool]") + ` Auto Pickaxe ${state ? "enabled" : "disabled"}.`);
            } else {
              featuresConfig.autoTool.autoSword = state;
              featuresConfig.autoTool.autoPickaxe = state;
              logger.info(chalk.hex("#10B981")("[AutoTool]") + ` Auto Sword & Pickaxe ${state ? "enabled" : "disabled"}.`);
            }
            saveFeaturesConfig(featuresConfig);
          } else {
            logger.warn("Usage: /autotool [on|off] [sword|pickaxe]");
          }
        }
        break;

      case "attacklog":
        {
          const arg = parts[1]?.toLowerCase();
          if (!arg) {
            logger.info(
              chalk.hex("#EF4444")("[AttackLog]") +
              ` Currently ${featuresConfig.attackLog.enabled ? chalk.green("ENABLED") : chalk.red("DISABLED")}`
            );
          } else if (arg === "on" || arg === "enable") {
            featuresConfig.attackLog.enabled = true;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#EF4444")("[AttackLog]") + " Enabled attack log display.");
          } else if (arg === "off" || arg === "disable") {
            featuresConfig.attackLog.enabled = false;
            saveFeaturesConfig(featuresConfig);
            logger.info(chalk.hex("#EF4444")("[AttackLog]") + " Disabled attack log display.");
          } else {
            logger.warn("Usage: /attacklog [on|off]");
          }
        }
        break;

      case "debugentities":
        {
          if (!bot) {
            logger.warn("Not connected");
            break;
          }
          const entities = Object.values(bot.entities)
            .filter(e => e !== bot.entity && e.position)
            .sort((a, b) => {
              const distA = bot.entity.position.distanceTo(a.position);
              const distB = bot.entity.position.distanceTo(b.position);
              return distA - distB;
            });

          logger.info(chalk.yellow(`[DebugEntities] Total entities: ${entities.length}`));
          if (entities.length > 0) {
            const first = entities[0];
            if (!first) break;
            const dist = bot.entity.position.distanceTo(first.position);
            
            // Get prototype properties
            const proto = Object.getPrototypeOf(first);
            const protoKeys = proto ? Object.getOwnPropertyNames(proto) : [];
            logger.info(chalk.yellow(`[DebugEntities] Prototype keys: ${protoKeys.join(", ")}`));
            
            // Print all values dynamically
            const details: any = {};
            const keysToPrint = ["type", "name", "displayName", "entityType", "kind", "username"];
            for (const k of keysToPrint) {
              try { details[k] = (first as any)[k]; } catch (e) { details[k] = `Error: ${(e as Error).message}`; }
            }
            logger.info(chalk.yellow(`[DebugEntities] Properties: ${JSON.stringify(details)}`));
            
            // Print metadata
            try {
              logger.info(chalk.yellow(`[DebugEntities] Metadata: ${JSON.stringify(first.metadata)}`));
            } catch (e) {
              logger.info(chalk.yellow(`[DebugEntities] Metadata error: ${(e as Error).message}`));
            }
          }
          
          const list = entities
            .map(e => {
              const dist = bot.entity.position.distanceTo(e.position);
              return {
                id: e.id,
                name: (() => {
                  const value = (e as any).displayName ?? (e as any).name ?? (e as any).kind;
                  const text = value == null ? "" : String(value).trim();
                  return text || `entity#${e.id}`;
                })(),
                type: (e as any).type ?? (e as any).kind ??
                  ((e as any).entityType != null ? `entityType#${(e as any).entityType}` : "unknown"),
                dist: Math.round(dist),
              };
            })
            .slice(0, 10);
          
          for (const item of list) {
            logger.info(chalk.gray(`- ID: ${item.id} | Name: ${item.name} | Type: ${item.type} | Dist: ${item.dist}m`));
          }
        }
        break;

      default:
        if (bot) {
          try {
            bot.chat(line);
          } catch (e) {
            logger.error("Failed to send command:", (e as Error).message);
          }
        } else {
          logger.warn("Not connected -- command not sent");
        }

    }
  } else {
    if (bot) {
      try {
        bot.chat(line);
      } catch {
        logger.error("Failed to send message");
      }
    } else {
      logger.warn("Not connected -- message not sent");
    }
  }

  if (onFinish) onFinish();
}
