import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface AutoEatConfig {
  enabled: boolean;
  minFood: number;
  useFeedCmd: boolean;
}

export interface AutoSkillConfig {
  enabled: boolean;
  range: number;
  useSkill1: boolean;
  useSkill2: boolean;
  useSkill3: boolean;
  useSkill4: boolean;
}

export interface ServerTriggerBotConfig {
  enabled: boolean;
  checkIntervalMs: number;
  command: string;
  initialDelayMs: number;
}

export interface AutoFollowConfig {
  enabled: boolean;
  target: string;
}

export interface LockPositionConfig {
  enabled: boolean;
  x: number | null;
  y: number | null;
  z: number | null;
  range: number;
}

export interface AimMobsConfig {
  enabled: boolean;
  range: number;
  aimPlayers: boolean;
  playerRange: number;
}

export interface AutoToolConfig {
  autoSword: boolean;
  autoPickaxe: boolean;
}

export interface AttackLogConfig {
  enabled: boolean;
}

export interface FeaturesConfig {
  autoEat: AutoEatConfig;
  autoSkill: AutoSkillConfig;
  serverTriggerBot: ServerTriggerBotConfig;
  autoFollow: AutoFollowConfig;
  lockPosition: LockPositionConfig;
  aimMobs: AimMobsConfig;
  autoTool: AutoToolConfig;
  attackLog: AttackLogConfig;
}

let activeAccountName = "";

function accountFileName(username: string): string {
  const safe = username.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "default";
}

function getFeaturesConfigPath(username?: string): string {
  return username
    ? join(process.cwd(), "accounts", `features-${accountFileName(username)}.json`)
    : join(process.cwd(), "features.json");
}

export function loadFeaturesConfig(accountUsername?: string): FeaturesConfig {
  activeAccountName = accountUsername?.trim() ?? "";
  const configPath = getFeaturesConfigPath(activeAccountName);
  let fileExists = true;
  let config: Partial<FeaturesConfig> = {};

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      config = parsed as Partial<FeaturesConfig>;
    }
  } catch (err) {
    fileExists = false;
  }

  const merged: FeaturesConfig = {
    autoEat: {
      enabled: config.autoEat?.enabled ?? false,
      minFood: config.autoEat?.minFood ?? 14,
      useFeedCmd: config.autoEat?.useFeedCmd ?? true,
    },
    autoSkill: {
      enabled: config.autoSkill?.enabled ?? false,
      range: config.autoSkill?.range ?? 15,
      useSkill1: config.autoSkill?.useSkill1 ?? true,
      useSkill2: config.autoSkill?.useSkill2 ?? true,
      useSkill3: config.autoSkill?.useSkill3 ?? true,
      useSkill4: config.autoSkill?.useSkill4 ?? true,
    },
    serverTriggerBot: {
      enabled: config.serverTriggerBot?.enabled ?? false,
      checkIntervalMs: config.serverTriggerBot?.checkIntervalMs ?? 5000,
      command: config.serverTriggerBot?.command ?? "taf",
      initialDelayMs: config.serverTriggerBot?.initialDelayMs ?? 3000,
    },
    autoFollow: {
      enabled: config.autoFollow?.enabled ?? false,
      target: config.autoFollow?.target ?? "",
    },
    lockPosition: {
      enabled: config.lockPosition?.enabled ?? false,
      x: config.lockPosition?.x ?? null,
      y: config.lockPosition?.y ?? null,
      z: config.lockPosition?.z ?? null,
      range: config.lockPosition?.range ?? 2.0,
    },
    aimMobs: {
      enabled: config.aimMobs?.enabled ?? false,
      range: config.aimMobs?.range ?? 30,
      aimPlayers: config.aimMobs?.aimPlayers ?? false,
      playerRange: config.aimMobs?.playerRange ?? 30,
    },
    autoTool: {
      autoSword: config.autoTool?.autoSword ?? false,
      autoPickaxe: config.autoTool?.autoPickaxe ?? false,
    },
    attackLog: {
      enabled: config.attackLog?.enabled ?? false,
    },
  };

  let needsSave = !fileExists;
  if (fileExists) {
    for (const key of Object.keys(merged) as Array<keyof FeaturesConfig>) {
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
    saveFeaturesConfig(merged);
  }

  return merged;
}

export function saveFeaturesConfig(config: FeaturesConfig): void {
  const configPath = getFeaturesConfigPath(activeAccountName);
  try {
    if (activeAccountName) mkdirSync(join(process.cwd(), "accounts"), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    console.error(`[FeaturesConfig] Failed to save ${configPath}:`, err);
  }
}
