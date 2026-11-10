import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { type AntiBotConfig, DEFAULT_ANTIBOT_CONFIG } from "./antibot";
import { type DebugConfig, DEFAULT_DEBUG_CONFIG } from "./debug/client";

export interface ServerConfig {
  host: string;
  port: number;
  version: string | false;
  viewDistance: "tiny" | "short" | "normal" | "far" | number;
  pingBeforeConnect: boolean;
}

export type ProxyType = "socks5" | "socks4" | "http" | "https";

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface BotConfig {
  username: string;
  auth: "offline" | "microsoft" | "mojang";
  hideErrors: boolean;
  profilesFolder: string;
  promptBeforeJoin: boolean;
}

export interface ReconnectConfig {
  enabled: boolean;
  delay: number;
  maxAttempts: number;
}

export interface ChatConfig {
  prefix: string;
  logPackets: boolean;
}

export type ResourcePackAction = "accept" | "decline" | "prompt";

export interface ResourcePackConfig {
  action: ResourcePackAction;
}

export interface FiltersConfig {
  hideNPCJoinLeave: boolean;
  npcPatterns: string[];
  hideEmptyMessages: boolean;
}

export interface AutoLoginConfig {
  enabled: boolean;
  command: string;
  delay: number;
}

export interface AutoCommandEntry {
  command: string;
  delay: number;
  awaitCompletion?: boolean;
  timeoutMs?: number;
  triggerFeature?: string;
}

export interface AutoCommandsConfig {
  enabled: boolean;
  onSpawn: AutoCommandEntry[];
  onDeath?: AutoCommandEntry[];
}

export type AntiAFKAction = "sneak" | "jump" | "rotate" | "swing";

export interface AntiAFKConfig {
  enabled: boolean;
  intervalSeconds: number;
  action: AntiAFKAction;
}

export interface AutoRespawnConfig {
  enabled: boolean;
  delay: number;
}

export interface ChatLogConfig {
  enabled: boolean;
  directory: string;
}

export interface MineConfig {
  capdaoEnabled: boolean;
  capdaoLevel: number;
}

export interface CoopConfig {
  enabled: boolean;
  owner: string;
  members: string[];
}

export interface ToolTitleConfig {
  enabled: boolean;
  normalEnabled: boolean;
  multiplyEnabled: boolean;
  wordEnabled: boolean;
  normalMinDelayMs: number;
  normalMaxDelayMs: number;
  multiplyMinDelayMs: number;
  multiplyMaxDelayMs: number;
  wordMinDelayMs: number;
  wordMaxDelayMs: number;
  benchmark: boolean;
  debug: boolean;
}

export interface ChatGamesConfig {
  enabled: boolean;
  delayMs: number;
  disabledAccounts: string[];
  toolTitle: ToolTitleConfig;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  channelId: string;
  bridgeChat: boolean;
  bridgeCommands: boolean;
  allowedUsers: string[];
  logWebhookUrl: string;
  logWebhookEnabled: boolean;
}

export interface AppConfig {
  server: ServerConfig;
  proxy: ProxyConfig;
  bot: BotConfig;
  reconnect: ReconnectConfig;
  chat: ChatConfig;
  resourcePack: ResourcePackConfig;
  filters: FiltersConfig;
  autoLogin: AutoLoginConfig;
  autoCommands: AutoCommandsConfig;
  antiAFK: AntiAFKConfig;
  autoRespawn: AutoRespawnConfig;
  chatLog: ChatLogConfig;
  mine: MineConfig;
  coop: CoopConfig;
  chatGames: ChatGamesConfig;
  antiBot: AntiBotConfig;
  debug: DebugConfig;
  discord: DiscordConfig;
}

function accountFileName(username: string): string {
  const safe = username.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "default";
}

function getAccountConfigPath(username: string): string {
  return join(process.cwd(), "accounts", `${accountFileName(username)}.json`);
}

export function saveConfig(config: AppConfig): void {
  const username = config.bot?.username?.trim();
  const configPath = username ? getAccountConfigPath(username) : join(process.cwd(), "config.json");
  try {
    if (username) mkdirSync(join(process.cwd(), "accounts"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[config] Failed to save ${configPath}:`, err);
  }
}

export function loadConfig(accountUsername?: string): AppConfig {
  const configPath = join(process.cwd(), "config.json");
  let config: Partial<AppConfig> = {};
  let fileExists = true;
  let accountFileExists = false;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      config = parsed as Partial<AppConfig>;
    }
  } catch (err) {
    fileExists = false;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[config] Failed to load config.json, using defaults: ${reason}`);
  }

  // Account-specific settings override the shared config. The account name
  // may come from the CLI before the base config's username is applied.
  const selectedUsername = accountUsername?.trim() || config.bot?.username?.trim() || "";
  if (selectedUsername) {
    const accountPath = getAccountConfigPath(selectedUsername);
    try {
      const raw = readFileSync(accountPath, "utf-8");
      const accountConfig = JSON.parse(raw);
      accountFileExists = true;
      if (accountConfig && typeof accountConfig === "object") {
        config = {
          ...config,
          ...accountConfig,
          bot: { ...(config.bot ?? {}), ...(accountConfig.bot ?? {}), username: selectedUsername },
        } as Partial<AppConfig>;
      }
    } catch {
      // First run for this account: use shared defaults until a setting is saved.
    }
  }

  const merged: AppConfig = {
    server: {
      host: config.server?.host ?? "",
      port: config.server?.port ?? 25565,
      version: config.server?.version ?? false,
      viewDistance: config.server?.viewDistance ?? "tiny",
      pingBeforeConnect: config.server?.pingBeforeConnect ?? true,
    },
    proxy: {
      enabled: (config as any).proxy?.enabled ?? false,
      type: (["socks5", "socks4", "http", "https"] as string[]).includes((config as any).proxy?.type)
        ? (config as any).proxy.type
        : "socks5",
      host: (config as any).proxy?.host ?? "",
      port: Number((config as any).proxy?.port ?? 1080),
      username: (config as any).proxy?.username ?? "",
      password: (config as any).proxy?.password ?? "",
    },
    bot: {
      // When starting a new account from the CLI, the requested username
      // must win over config.json so the first auto-save creates the correct
      // accounts/<username>.json file instead of overwriting another account.
      username: selectedUsername || config.bot?.username || "",
      auth: config.bot?.auth ?? "offline",
      hideErrors: config.bot?.hideErrors ?? false,
      profilesFolder: config.bot?.profilesFolder ?? "./nmp-cache",
      promptBeforeJoin: config.bot?.promptBeforeJoin ?? false,
    },
    reconnect: {
      enabled: config.reconnect?.enabled ?? true,
      delay: config.reconnect?.delay ?? 5000,
      maxAttempts: config.reconnect?.maxAttempts ?? 10,
    },
    chat: {
      prefix: config.chat?.prefix ?? "!",
      logPackets: config.chat?.logPackets ?? false,
    },
    resourcePack: {
      action: config.resourcePack?.action ?? "accept",
    },
    filters: {
      hideNPCJoinLeave: config.filters?.hideNPCJoinLeave ?? true,
      npcPatterns: config.filters?.npcPatterns ?? ["CIT-", "[NPC]"],
      hideEmptyMessages: config.filters?.hideEmptyMessages ?? true,
    },
    autoLogin: {
      enabled: config.autoLogin?.enabled ?? false,
      command: config.autoLogin?.command ?? "",
      delay: config.autoLogin?.delay ?? 1500,
    },
    autoCommands: {
      enabled: config.autoCommands?.enabled ?? false,
      onSpawn: config.autoCommands?.onSpawn ?? [],
      onDeath: config.autoCommands?.onDeath ?? [],
    },
    antiAFK: {
      enabled: config.antiAFK?.enabled ?? false,
      intervalSeconds: config.antiAFK?.intervalSeconds ?? 120,
      action: (config.antiAFK?.action as AntiAFKAction) ?? "sneak",
    },
    autoRespawn: {
      enabled: config.autoRespawn?.enabled ?? true,
      delay: config.autoRespawn?.delay ?? 1000,
    },
    chatLog: {
      enabled: config.chatLog?.enabled ?? false,
      directory: config.chatLog?.directory ?? "logs",
    },
    mine: {
      capdaoEnabled: (config as any).mine?.capdaoEnabled ?? true,
      capdaoLevel: Number.isInteger((config as any).mine?.capdaoLevel)
        ? Math.max(1, (config as any).mine.capdaoLevel)
        : 50,
    },
    coop: {
      enabled: (config as any).coop?.enabled ?? false,
      owner: (config as any).coop?.owner ?? "",
      members: Array.isArray((config as any).coop?.members) ? (config as any).coop.members : [],
    },
    chatGames: {
      enabled: (config as any).chatGames?.enabled ?? true,
      delayMs: (config as any).chatGames?.delayMs ?? 1000,
      disabledAccounts: (config as any).chatGames?.disabledAccounts ?? [],
      toolTitle: {
        enabled: (config as any).chatGames?.toolTitle?.enabled ?? true,
        normalEnabled: (config as any).chatGames?.toolTitle?.normalEnabled ?? true,
        multiplyEnabled: (config as any).chatGames?.toolTitle?.multiplyEnabled ?? true,
        wordEnabled: (config as any).chatGames?.toolTitle?.wordEnabled ?? true,
        normalMinDelayMs: (config as any).chatGames?.toolTitle?.normalMinDelayMs ?? 0,
        normalMaxDelayMs: (config as any).chatGames?.toolTitle?.normalMaxDelayMs ?? 0,
        multiplyMinDelayMs: (config as any).chatGames?.toolTitle?.multiplyMinDelayMs ?? 0,
        multiplyMaxDelayMs: (config as any).chatGames?.toolTitle?.multiplyMaxDelayMs ?? 0,
        wordMinDelayMs: (config as any).chatGames?.toolTitle?.wordMinDelayMs ?? 0,
        wordMaxDelayMs: (config as any).chatGames?.toolTitle?.wordMaxDelayMs ?? 0,
        benchmark: (config as any).chatGames?.toolTitle?.benchmark ?? false,
        debug: (config as any).chatGames?.toolTitle?.debug ?? false,
      },
    },
    antiBot: {
      ...DEFAULT_ANTIBOT_CONFIG,
      ...(config as any).antiBot,
      brand: { ...DEFAULT_ANTIBOT_CONFIG.brand, ...(config as any).antiBot?.brand },
      clientSettings: { ...DEFAULT_ANTIBOT_CONFIG.clientSettings, ...(config as any).antiBot?.clientSettings },
      humanBehavior: { ...DEFAULT_ANTIBOT_CONFIG.humanBehavior, ...(config as any).antiBot?.humanBehavior },
      packetGuard: { ...DEFAULT_ANTIBOT_CONFIG.packetGuard, ...(config as any).antiBot?.packetGuard },
      physics: { ...DEFAULT_ANTIBOT_CONFIG.physics, ...(config as any).antiBot?.physics },
    },
    debug: {
      ...DEFAULT_DEBUG_CONFIG,
      ...(config as any).debug,
    },
    discord: {
      enabled: (config as any).discord?.enabled ?? false,
      token: (config as any).discord?.token ?? "",
      channelId: (config as any).discord?.channelId ?? "",
      bridgeChat: (config as any).discord?.bridgeChat ?? true,
      bridgeCommands: (config as any).discord?.bridgeCommands ?? true,
      allowedUsers: (config as any).discord?.allowedUsers ?? [],
      logWebhookUrl: (config as any).discord?.logWebhookUrl ?? "",
      logWebhookEnabled: (config as any).discord?.logWebhookEnabled ?? false,
    },
  };

  // Create a per-account file on first launch even when the shared
  // config.json is already complete.
  let needsSave = !fileExists || (!!selectedUsername && !accountFileExists);
  if (fileExists) {
    for (const key of Object.keys(merged) as Array<keyof AppConfig>) {
      if (!(key in config)) {
        needsSave = true;
        break;
      }
      const subConfig = config[key];
      const subMerged = merged[key];
      if (typeof subMerged === "object" && subMerged !== null && !Array.isArray(subMerged)) {
        if (typeof subConfig !== "object" || subConfig === null) {
          needsSave = true;
          break;
        }
        for (const subKey of Object.keys(subMerged)) {
          if (!(subKey in subConfig)) {
            needsSave = true;
            break;
          }
        }
      }
    }
  }

  if (needsSave) {
    saveConfig(merged);
  }

  return merged;
}
