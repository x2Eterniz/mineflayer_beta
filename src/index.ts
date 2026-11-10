import { loadConfig, saveConfig } from "./config";
import { readdirSync } from "fs";
import { proxyType } from "./utils/proxy";
import { logger } from "./logger";
import { initDiscord, shutdownDiscord } from "./discord";
import { createBotClient } from "./client";
import { handleCommand, startCommandLoop } from "./commands";
import { resetUptime } from "./utils/uptime";
import { initLogWebhook } from "./webhook";

process.on("uncaughtException", (err) => {
  const errMsg = String(err?.message ?? err ?? "");
  const errName = String(err?.name ?? "");

  const isPartialRead =
    errName === "PartialReadError" ||
    errMsg.includes("PartialReadError") ||
    errMsg.includes("Read error for");

  if (isPartialRead) return;
  logger.error("Uncaught exception:", errMsg);
});

process.on("unhandledRejection", (reason) => {
  const errMsg = String(reason ?? "");
  // Suppress known transient network / protocol errors — these are
  // already handled by the bot's "error" + "end" → reconnect flow.
  const SUPPRESSED = [
    "PartialReadError", "Read error for",
    "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED",
    "EPIPE", "Channel closed",
  ];
  if (SUPPRESSED.some(s => errMsg.includes(s))) return;
  logger.error("Unhandled rejection:", errMsg);
});

let globalBotClient: ReturnType<typeof createBotClient> | null = null;
const multiBotClients: Array<ReturnType<typeof createBotClient>> = [];

process.on("SIGINT", () => {
  logger.info("Received SIGINT -- shutting down...");
  shutdownDiscord();
  for (const client of multiBotClients) client.disconnect();
  if (globalBotClient && !multiBotClients.includes(globalBotClient)) globalBotClient.disconnect();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM -- shutting down...");
  shutdownDiscord();
  for (const client of multiBotClients) client.disconnect();
  if (globalBotClient && !multiBotClients.includes(globalBotClient)) globalBotClient.disconnect();
  process.exit(0);
});

async function bootstrap() {
  const args = process.argv.slice(2);
  const multiMode = args[0]?.toLowerCase() === "--multi" || args[0]?.toLowerCase() === "-m";
  const requestedAccounts = multiMode ? args.slice(1).filter(Boolean) : [];
  const config = loadConfig(multiMode ? undefined : args[0]);

  if (multiMode) {
    await startMultiAccountMode(requestedAccounts);
    return;
  }
  if (args[0]) config.bot.username = args[0];
  if (args[1]) config.server.host = args[1];
  if (args[2]) {
    const authMethod = args[2].toLowerCase();
    if (["offline", "microsoft", "mojang"].includes(authMethod)) {
      config.bot.auth = authMethod as any;
    }
  }

  if (!config.bot.username) {
    config.bot.username = await logger.ask("Please enter the Bot Username/Account:");
  }

  logger.banner();
  logger.setTitle("Minecraft Bot Console - Initializing...");

  if (!config.server.host) {
    config.server.host = await logger.ask("Please enter the server IP/Host:");
    if (!config.server.host) {
      logger.error("Host is required to start the bot!");
      process.exit(1);
    }
  }

  // Let each account choose whether this session should use its saved proxy.
  // Saying "no" only disables the proxy for the current run; the saved
  // credentials remain available for the next startup.
  const savedProxy = config.proxy?.host && config.proxy?.port;
  const proxyQuestion = savedProxy
    ? `Use saved ${config.proxy.type} proxy ${config.proxy.host}:${config.proxy.port}? (y/n)`
    : "Use proxy for this account? (y/n)";
  const useProxy = (await logger.ask(proxyQuestion)).trim().toLowerCase();

  if (useProxy === "y" || useProxy === "yes" || useProxy === "có" || useProxy === "co") {
    if (!savedProxy) {
      const type = proxyType((await logger.ask("Proxy type (socks5/socks4/http/https):")).trim());
      const host = (await logger.ask("Proxy host/IP:")).trim();
      const port = Number((await logger.ask("Proxy port:")).trim());
      if (!type || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
        logger.warn("Proxy không hợp lệ, tiếp tục kết nối trực tiếp.");
        config.proxy.enabled = false;
      } else {
        config.proxy.type = type;
        config.proxy.host = host;
        config.proxy.port = port;
        config.proxy.username = (await logger.ask("Proxy username (bỏ trống nếu không có):")).trim();
        config.proxy.password = config.proxy.username
          ? await logger.ask("Proxy password:")
          : "";
        config.proxy.enabled = true;
        saveConfig(config);
        logger.info(`[Proxy] Đã lưu proxy riêng cho ${config.bot.username}.`);
      }
    } else {
      config.proxy.enabled = true;
      logger.info(`[Proxy] Đang dùng proxy đã lưu cho ${config.bot.username}.`);
    }
  } else {
    config.proxy.enabled = false;
    logger.info("[Proxy] Tắt — kết nối trực tiếp.");
  }

  resetUptime();
  logger.setDisableSpinner(!!config.debug.disableSpinner);
  initLogWebhook(config);
  logger.initChatLog(config.chatLog.enabled, config.chatLog.directory, config.bot.username);

  // Only try GC occasionally and only when heap is actually high.
  if (!(global as any)._gcIntervalStarted) {
    (global as any)._gcIntervalStarted = true;
    const gcJitter = Math.floor(Math.random() * 10000);
    setTimeout(() => {
      setInterval(() => {
        try {
          const heapUsedMb = process.memoryUsage().heapUsed / 1024 / 1024;
          if (heapUsedMb < 256) return;

          if (typeof global.gc === "function") {
            global.gc();
          }

          if (heapUsedMb > 384) {
            logger.warn(`High heap usage detected: ${Math.round(heapUsedMb)}MB`);
          }
        } catch {}
      }, 120000);
    }, gcJitter);
  }

  globalBotClient = createBotClient(config);
  globalBotClient.connect();

  initDiscord(config, () => globalBotClient?.bot ?? null, {
    disconnect: () => globalBotClient?.disconnect(),
    reconnect: () => globalBotClient?.reconnect(),
  });

  const globalRl = logger.getReadline();
  startCommandLoop(
    globalRl,
    () => globalBotClient!.bot,
    () => globalBotClient!.disconnect(),
    () => globalBotClient!.reconnect(),
    config
  );
}

function accountNamesFromDisk(): string[] {
  try {
    return readdirSync("./accounts", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .filter((name) => name && !name.toLowerCase().startsWith("features-"));
  } catch {
    return [];
  }
}

async function startMultiAccountMode(requestedAccounts: string[]): Promise<void> {
  const names = requestedAccounts.length ? requestedAccounts : accountNamesFromDisk();
  if (!names.length) {
    logger.error("[Multi] Không tìm thấy account trong thư mục accounts.");
    process.exit(1);
  }

  const base = loadConfig(names[0]);
  const accountConfigs = new Map<string, ReturnType<typeof loadConfig>>();
  const accountClients = new Map<string, ReturnType<typeof createBotClient>>();
  if (!base.server.host) {
    base.server.host = await logger.ask("Please enter the server IP/Host:");
    if (!base.server.host) {
      logger.error("Host is required to start multi-account mode!");
      process.exit(1);
    }
  }

  logger.banner();
  logger.setAccountLabels(true);
  logger.setSelectedAccount(names[0]);
  logger.setTitle(`Minecraft Bot Console - Multi (${names.length} accounts)`);
  logger.info(`[Multi] Starting ${names.length} account(s) in one Node.js process.`);
  logger.info(`[Multi] Accounts: ${names.join(", ")}`);

  resetUptime();
  logger.setDisableSpinner(!!base.debug.disableSpinner);
  initLogWebhook(base);
  logger.initChatLog(base.chatLog.enabled, base.chatLog.directory, "multi");

  for (const name of names) {
    const accountConfig = loadConfig(name);
    accountConfigs.set(name.toLowerCase(), accountConfig);
    // Shared server settings provide a fallback, while account-specific
    // server/proxy/features remain independent.
    if (!accountConfig.server.host) accountConfig.server.host = base.server.host;
    if (!accountConfig.server.port) accountConfig.server.port = base.server.port;
    if (accountConfig.server.version === false && base.server.version !== false) {
      accountConfig.server.version = base.server.version;
    }

    const client = createBotClient(accountConfig);
    accountClients.set(name.toLowerCase(), client);
    multiBotClients.push(client);
    if (!globalBotClient) globalBotClient = client;

    // Stagger handshakes to avoid a CPU/network burst when many accounts start.
    await new Promise<void>((resolve) => setTimeout(resolve, multiBotClients.length === 1 ? 0 : 750));
    logger.withAccount(name, () => client.connect());
  }

  // Safety net for multi mode: if a client loses its bot and its reconnect
  // timer was cleared by an unusual transfer/error path, restore only that
  // account. The client-level guard prevents duplicate connections.
  setInterval(() => {
    for (const [name, client] of accountClients) {
      logger.withAccount(name, () => client.ensureConnected());
    }
  }, 10000);

  const primaryConfig = loadConfig(names[0]);
  let activeName = names[0];
  let activeClient = accountClients.get(activeName.toLowerCase())!;
  let activeConfig = accountConfigs.get(activeName.toLowerCase())!;
  initDiscord(primaryConfig, () => globalBotClient?.bot ?? null, {
    disconnect: () => globalBotClient?.disconnect(),
    reconnect: () => globalBotClient?.reconnect(),
  });

  logger.info(`[Multi] Terminal commands control primary account: ${names[0]}`);
  const globalRl = logger.getReadline();
  startCommandLoop(
    globalRl,
    () => activeClient?.bot ?? null,
    () => activeClient?.disconnect(),
    () => activeClient?.reconnect(),
    primaryConfig,
    async (accountName, command) => {
      const targets = accountName.toLowerCase() === "all"
        ? names
        : names.filter((name) => name.toLowerCase() === accountName.toLowerCase());
      if (!targets.length) {
        logger.warn(`[Multi] Không tìm thấy account: ${accountName}`);
        return;
      }

      await Promise.all(targets.map(async (name) => {
        const targetClient = accountClients.get(name.toLowerCase());
        const targetConfig = accountConfigs.get(name.toLowerCase());
        if (!targetClient || !targetConfig) return;

        const chatMatch = command.match(/^(?:\/)?(?:chat|say)\s+([\s\S]+)$/i);
        if (chatMatch?.[1]) {
          targetClient.bot?.chat(chatMatch[1]);
          logger.info("chat:", chatMatch[1]);
          return;
        }

        // Text without a slash is treated as normal Minecraft chat.
        if (!command.startsWith("/")) {
          targetClient.bot?.chat(command);
          logger.info("chat:", command);
          return;
        }

        await handleCommand(
            command,
            targetClient.bot,
            targetConfig,
            () => targetClient.disconnect(),
            () => targetClient.reconnect(),
          );
      }));
    },
    names[0],
    () => activeConfig,
    (accountName) => {
      const selected = names.find((name) => name.toLowerCase() === accountName.toLowerCase());
      if (!selected) return false;
      activeName = selected;
      activeClient = accountClients.get(selected.toLowerCase())!;
      activeConfig = accountConfigs.get(selected.toLowerCase())!;
      logger.setSelectedAccount(selected);
      logger.info(`[Multi] Selected account: ${activeName}`);
      return true;
    }
  );
}

bootstrap().catch((err) => {
  logger.error("Startup error:", String(err));
});
