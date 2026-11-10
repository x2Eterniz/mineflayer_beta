import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import chalk from "chalk";
import { logger } from "../logger";
import type { AppConfig } from "../config";
import { saveConfig } from "../config";
import { queueBlockDig } from "../utils/digPacketLimiter";

const { Movements, goals } = pkg;
const { GoalNear } = goals;

type FarmMode = "farmer" | "harvest" | "plant" | "multi";

type Zone = {
  name: string;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  minutes: number;
};

const CROP_NAMES = new Set([
  "wheat", "carrots", "potatoes", "beetroots", "nether_wart", "cocoa", "sweet_berry_bush",
  "sugar_cane", "cactus", "pumpkin", "melon", "bamboo", "bamboo_sapling",
]);

const AUTO_WITHDRAW_ITEM: Record<string, string> = {
  wheat: "WHEAT_SEEDS",
  carrots: "CARROT",
  potatoes: "POTATO",
  beetroots: "BEETROOT_SEEDS",
  nether_wart: "NETHER_WART",
};

const AUTO_WITHDRAW_AMOUNT = 64;

const SEED_FOR_CROP: Record<string, string[]> = {
  wheat: ["wheat_seeds"],
  carrots: ["carrot"],
  potatoes: ["potato"],
  beetroots: ["beetroot_seeds"],
  nether_wart: ["nether_wart"],
};

const state = new WeakMap<Bot, AutoFarm>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function blockAge(block: any): number {
  try {
    const props = typeof block.getProperties === "function" ? block.getProperties() : null;
    if (props && props.age !== undefined) {
      const age = Number(props.age);
      if (Number.isFinite(age)) return age;
    }
  } catch {}

  for (const value of [block?.age, block?.metadata]) {
    const age = Number(value);
    if (Number.isFinite(age) && age >= 0) return age;
  }

  return 0;
}

function isMature(block: any): boolean {
  if (!block) return false;
  const name = block.name;
  if (name === "sugar_cane" || name === "cactus" || name === "bamboo") return true;
  if (name === "pumpkin" || name === "melon") return true;
  if (name === "sweet_berry_bush") return blockAge(block) >= 3;
  if (name === "nether_wart") return blockAge(block) >= 3;
  if (name === "cocoa") return blockAge(block) >= 2;
  const maxAge: Record<string, number> = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
  return maxAge[name] !== undefined && blockAge(block) >= maxAge[name];
}

function cropMatches(name: string, filters: Set<string>): boolean {
  return filters.has("all") || filters.has(name);
}

function isSugarCaneHarvestable(bot: Bot, block: any): boolean {
  if (!block?.position || block.name !== "sugar_cane") return false;

  // Keep the bottom segment. Every cane block that has another cane block
  // directly underneath it is above the base and can be harvested. This is
  // deliberately simple because some custom servers expose unusual age
  // values and block metadata.
  const below = bot.blockAt(block.position.offset(0, -1, 0));
  return below?.name === "sugar_cane";
}

export class AutoFarm {
  // Serverbound use_item_on packets carry a block-change sequence.
  // Reusing 0 for every placement can make strict/custom 1.21.x servers
  // reject the interaction or disconnect the client.
  private placeSequence = 0;

  private readonly bot: Bot;
  private readonly config: AppConfig;
  private enabled = false;
  private mode: FarmMode = "multi";
  private radius = 128;
  private pathRadius = 128;
  private pathMode = true;
  private harvestDelay = 1;
  private plantDelay = 1;
  private filters = new Set<string>(["all"]);
  private busy = false;
  private nextActionAt = 0;
  private lastTargetKey = "";
  private lastTargetAt = 0;
  private cachedTarget: any | null = null;
  private stuckSince = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanAt = 0;
  private scanInterval = 500;
  private scanExpansion = 0;
  private currentGoalKey = "";
  private movementsReady = false;
  private pathEventsReady = false;
  private goalStartedAt = 0;
  private lastProgressAt = 0;
  private lastProgressPos: { x: number; y: number; z: number } | null = null;
  private replanCooldownUntil = 0;
  private directMoveUntil = 0;
  private directTargetKey = "";
  private zones: Zone[] = [];
  private zoneIndex = 0;
  private zoneStartedAt = 0;
  private zoneMode = false;
  private debugEnabled = false;
  private debugLastLogAt = 0;
  private debugLastPos: { x: number; y: number; z: number } | null = null;
  private debugLastPosAt = 0;
  private debugLastState = "";
  private debugLastScanReportAt = 0;

  constructor(bot: Bot, config: AppConfig) {
    this.bot = bot;
    this.config = config;
    const saved = (config as any).autoFarm;
    if (saved) {
      this.enabled = !!saved.enabled;
      this.mode = saved.mode ?? "multi";
      this.radius = clamp(Number(saved.radius) || 128, 1, 256);
      this.pathRadius = clamp(Number(saved.pathRadius) || 128, 8, 256);
      this.pathMode = saved.pathMode ?? true;
      this.harvestDelay = Math.max(0, Number(saved.harvestDelay) || 1);
      this.plantDelay = Math.max(0, Number(saved.plantDelay) || 1);
      this.filters = new Set(Array.isArray(saved.crops) && saved.crops.length ? saved.crops : ["all"]);
      this.zones = Array.isArray(saved.zones) ? saved.zones : [];
      this.zoneMode = !!saved.zoneMode;
      this.zoneIndex = Number(saved.zoneIndex) || 0;
      this.debugEnabled = !!saved.debug;
    }
    try { (this.bot.pathfinder as any).searchRadius = this.pathRadius; } catch {}
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[AutoFarm] Tick error: ${message}`);
        this.busy = false;
      });
    }, 100);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    try { this.bot.pathfinder.setGoal(null); } catch {}
    this.stopDirectMove();
    this.currentGoalKey = "";
    this.goalStartedAt = 0;
    this.lastProgressAt = 0;
    this.lastProgressPos = null;
    this.cachedTarget = null;
    this.busy = false;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.save();
    if (value) {
      this.start();
    } else {
      this.stop();
      try { this.bot.pathfinder.setGoal(null); } catch {}
    }
    logger.info(chalk.green("[AutoFarm]"), value ? "Enabled." : "Disabled.");
  }

  toggle(): void { this.setEnabled(!this.enabled); }
  isEnabled(): boolean { return this.enabled; }
  setMode(mode: string): void {
    if (!["farmer", "harvest", "plant", "multi"].includes(mode.toLowerCase())) {
      logger.warn("Usage: /af mode <farmer|harvest|plant|multi>"); return;
    }
    this.mode = mode.toLowerCase() as FarmMode; this.save();
    logger.info(`[AutoFarm] Mode: ${this.mode}`);
  }
  setRadius(radius: number): void { this.radius = clamp(radius, 1, 256); this.save(); logger.info(`[AutoFarm] Radius: ${this.radius}`); }
  setPathRadius(radius: number): void {
    this.pathRadius = clamp(radius, 8, 256);
    try { (this.bot.pathfinder as any).searchRadius = this.pathRadius; } catch {}
    this.save();
    logger.info(`[AutoFarm] Path radius: ${this.pathRadius}`);
  }
  setPathMode(value: boolean): void { this.pathMode = value; this.save(); logger.info(`[AutoFarm] Pathfinder: ${value ? "ON" : "OFF"}`); }
  togglePathMode(): void { this.setPathMode(!this.pathMode); }
  setDebug(value: boolean): void {
    this.debugEnabled = value;
    this.save();
    logger.info(`[AutoFarm] Debug: ${value ? "ON" : "OFF"}`);
    if (value) this.debug("debug session started");
  }
  setMultiSpeed(ms: number): void { this.harvestDelay = Math.max(0, ms); this.plantDelay = Math.max(0, ms); this.mode = "multi"; this.save(); logger.info(`[AutoFarm] Multi delay: ${ms}ms`); }
  inspectNearby(): void {
    const pos = this.bot.entity?.position;
    if (!pos) { logger.warn("[AutoFarm] No bot position."); return; }
    const base = pos.floored();
    const seen = new Map<string, number>();
    const samples: string[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 3; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const b = this.bot.blockAt(base.offset(dx, dy, dz));
          if (!b || b.name === "air" || b.name === "cave_air" || b.name === "void_air") continue;
          const key = `${b.name}#${b.type}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          if (samples.length < 20 && !samples.some((x) => x.startsWith(`${b.name}#${b.type} `))) {
            let props: any = null;
            try { props = typeof b.getProperties === "function" ? b.getProperties() : null; } catch {}
            samples.push(`${b.name}#${b.type} pos=${b.position.x},${b.position.y},${b.position.z} props=${props ? JSON.stringify(props) : "none"}`);
          }
        }
      }
    }
    logger.info(`[AF INSPECT] around=${base.x},${base.y},${base.z} blocks=${[...seen.entries()].map(([k,v]) => `${k}x${v}`).join(" ") || "none"}`);
    for (const sample of samples) logger.info(`[AF INSPECT] ${sample}`);
  }

  setCropFilter(raw: string): void {
    const crops = raw.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!crops.length) return;
    if (crops.includes("all")) this.filters = new Set(["all"]);
    else this.filters = new Set(crops.filter((x) => CROP_NAMES.has(x)));
    if (!this.filters.size) this.filters.add("all");
    this.save();
    logger.info(`[AutoFarm] Crops: ${[...this.filters].join(", ")}`);
  }

  status(): string {
    const zone = this.zones.length ? ` | Zone ${this.zoneIndex + 1}/${this.zones.length}` : "";
    return `enabled=${this.enabled} mode=${this.mode} radius=${this.radius} path=${this.pathMode} pathRadius=${this.pathRadius} debug=${this.debugEnabled} crops=${[...this.filters].join(",")} delay=${this.harvestDelay}/${this.plantDelay}ms${zone}`;
  }

  setZonePos(slot: 1 | 2): void {
    const pos = this.bot.entity?.position;
    if (!pos) return;
    const saved = (this.config as any).autoFarm ?? {};
    saved[`zonePos${slot}`] = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    (this.config as any).autoFarm = saved;
    this.save();
    logger.info(`[AutoFarm] Zone pos${slot}: ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`);
  }

  addZone(name: string, minutes: number): void {
    const saved = (this.config as any).autoFarm ?? {};
    const a = saved.zonePos1, b = saved.zonePos2;
    if (!a || !b) { logger.warn("Set /af zone pos1 and /af zone pos2 first."); return; }
    this.zones = this.zones.filter((z) => z.name.toLowerCase() !== name.toLowerCase());
    this.zones.push({
      name, minX: Math.min(a.x,b.x), minY: Math.min(a.y,b.y), minZ: Math.min(a.z,b.z),
      maxX: Math.max(a.x,b.x), maxY: Math.max(a.y,b.y), maxZ: Math.max(a.z,b.z), minutes: clamp(minutes,1,1440),
    });
    this.save(); logger.info(`[AutoFarm] Zone added: ${name} (${minutes} min)`);
  }

  removeZone(name: string): void { this.zones = this.zones.filter((z) => z.name.toLowerCase() !== name.toLowerCase()); this.zoneIndex = 0; this.save(); logger.info(`[AutoFarm] Zone removed: ${name}`); }
  listZones(): void {
    if (!this.zones.length) { logger.info("[AutoFarm] No zones."); return; }
    this.zones.forEach((z,i) => logger.info(`${i+1}. ${z.name} | ${z.minutes} min | ${z.minX},${z.minY},${z.minZ} -> ${z.maxX},${z.maxY},${z.maxZ}`));
  }
  startZones(): void { if (!this.zones.length) { logger.warn("[AutoFarm] No zones."); return; } this.zoneMode = true; this.enabled = true; this.zoneStartedAt = 0; this.start(); this.save(); logger.info("[AutoFarm] Zone rotation ON."); }
  stopZones(): void { this.zoneMode = false; this.save(); logger.info("[AutoFarm] Zone rotation OFF."); }
  setZoneTime(minutes: number): void { this.zones = this.zones.map((z) => ({...z, minutes: clamp(minutes,1,1440)})); this.save(); logger.info(`[AutoFarm] Zone time: ${minutes} min`); }
  zoneStatus(): string { return this.zones.length ? `zone=${this.zones[this.zoneIndex]?.name} ${this.zoneIndex+1}/${this.zones.length} rotation=${this.zoneMode}` : "zones=0"; }

  private save(): void {
    (this.config as any).autoFarm = {
      enabled: this.enabled, mode: this.mode, radius: this.radius, pathRadius: this.pathRadius,
      pathMode: this.pathMode, harvestDelay: this.harvestDelay, plantDelay: this.plantDelay,
      crops: [...this.filters], zones: this.zones, zoneMode: this.zoneMode, zoneIndex: this.zoneIndex,
      zonePos1: (this.config as any).autoFarm?.zonePos1, zonePos2: (this.config as any).autoFarm?.zonePos2,
      debug: this.debugEnabled,
    };
    saveConfig(this.config);
  }

  private debug(message: string, force = false): void {
    if (!this.debugEnabled) return;
    const now = Date.now();
    if (!force && now - this.debugLastLogAt < 150) return;
    this.debugLastLogAt = now;
    logger.info(`[AF DEBUG] ${message}`);
  }

  private debugMovementSnapshot(now: number): void {
    if (!this.debugEnabled || !this.bot.entity?.position) return;
    const pos = this.bot.entity.position;
    const velocity = this.bot.entity.velocity;
    if (!this.debugLastPos) {
      this.debugLastPos = { x: pos.x, y: pos.y, z: pos.z };
      this.debugLastPosAt = now;
    }
    const dx = pos.x - this.debugLastPos.x;
    const dy = pos.y - this.debugLastPos.y;
    const dz = pos.z - this.debugLastPos.z;
    if (now - this.debugLastPosAt >= 750) {
      const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const state = `pos=${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} moved=${moved.toFixed(2)} ` +
        `vel=${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)} ` +
        `pfMoving=${this.bot.pathfinder.isMoving()} goal=${this.currentGoalKey || "none"}`;
      if (state !== this.debugLastState || moved < 0.05) {
        this.debug(state, true);
      }
      this.debugLastState = state;
      this.debugLastPos = { x: pos.x, y: pos.y, z: pos.z };
      this.debugLastPosAt = now;
    }
  }

  private async tick(): Promise<void> {
    const entity = this.bot.entity;
    if (!this.enabled || this.busy || !entity?.position || !this.bot.world) return;
    const now = Date.now();
    if (now < this.nextActionAt) return;

    if (this.zoneMode && this.zones.length) {
      await this.tickZone(now);
      if (this.busy) return;
    }

    const target = this.findTarget();
    if (target?.position) this.debug(`target=${target.name} @ ${this.blockKey(target)} distance=${this.bot.entity.position.distanceTo(target.position).toFixed(2)}`);
    else this.debug("target=NONE");
    if (!target?.position || !this.bot.entity?.position) {
      this.updateMovementWatchdog();
      return;
    }

    // Never walk through a crop just because it has a collision box.
    // Mature crops are targets; immature crops are avoided.
    const distance = this.bot.entity.position.distanceTo(target.position.offset(0.5, 0.5, 0.5));
    if (distance > 3.5) {
      this.updateMovementWatchdog();
      if (this.pathMode) this.goTo(target);
      else this.directMoveTo(target);
      return;
    }

    this.clearGoal();
    await this.harvest(target);
  }

  private async tickZone(now: number): Promise<void> {
    const zone = this.zones[this.zoneIndex];
    if (!zone || !this.bot.entity) return;
    const inside = this.bot.entity.position.x >= zone.minX && this.bot.entity.position.x <= zone.maxX + 1 &&
      this.bot.entity.position.y >= zone.minY - 2 && this.bot.entity.position.y <= zone.maxY + 2 &&
      this.bot.entity.position.z >= zone.minZ && this.bot.entity.position.z <= zone.maxZ + 1;
    if (!inside) {
      const x = (zone.minX + zone.maxX) / 2, y = zone.minY, z = (zone.minZ + zone.maxZ) / 2;
      try {
        this.ensureMovements();
        (this.bot.pathfinder as any).searchRadius = this.pathRadius;
        this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 2));
      } catch {}
      return;
    }
    if (!this.zoneStartedAt) this.zoneStartedAt = now;
    if (now - this.zoneStartedAt >= zone.minutes * 60000) {
      this.zoneIndex = (this.zoneIndex + 1) % this.zones.length;
      this.zoneStartedAt = 0;
      this.save();
      const nextZone = this.zones[this.zoneIndex];
      if (nextZone) logger.info(`[AutoFarm] Zone -> ${nextZone.name}`);
    }
  }

  private findTarget(): any | null {
    const center = this.bot.entity?.position;
    if (!center) return null;

    const now = Date.now();
    if (now - this.lastScanAt < this.scanInterval) {
      if (this.isValidTarget(this.cachedTarget)) return this.cachedTarget;
      this.cachedTarget = null;
    }
    this.lastScanAt = now;

    const names = this.filters.has("all") ? [...CROP_NAMES] : [...this.filters];

    // The radius follows the bot. When the current area is empty, widen the
    // search in small steps so a crop just beyond the current edge can become
    // the next destination. After the bot moves, the same radius is centered
    // on its new position automatically.
    const scanRadius = Math.min(256, this.radius + this.scanExpansion);

    // First find crop blocks without applying maturity. This separates
    // "there are no crops nearby" from "crops exist but maturity detection
    // rejected them", which is critical when debugging custom/server blocks.
    const cropIds = names
      .map((name) => this.bot.registry.blocksByName?.[name]?.id)
      .filter((id): id is number => Number.isInteger(id));

    let nearbyCrops = cropIds.length
      ? this.bot.findBlocks({ matching: cropIds, maxDistance: scanRadius, count: 1000 })
      : this.bot.findBlocks({
          matching: (b: any) => !!b?.position && names.includes(b.name),
          maxDistance: scanRadius,
          count: 1000,
        });

    // Some servers/worlds expose unusual block data to Mineflayer. Always do
    // a small local blockAt scan as a fallback so a crop directly around the
    // bot cannot result in target=NONE just because findBlocks missed it.
    if (!nearbyCrops.length) {
      const localRadius = Math.min(12, this.radius);
      const localY = 4;
      const found = new Map<string, Vec3>();
      const base = center.floored();
      for (let dx = -localRadius; dx <= localRadius; dx++) {
        for (let dy = -localY; dy <= localY; dy++) {
          for (let dz = -localRadius; dz <= localRadius; dz++) {
            const b = this.bot.blockAt(base.offset(dx, dy, dz));
            if (!b || !names.includes(b.name)) continue;
            const key = `${b.position.x},${b.position.y},${b.position.z}`;
            found.set(key, b.position.clone());
          }
        }
      }
      nearbyCrops = [...found.values()];
    }

    let matureCount = 0;
    let filteredCount = 0;
    let sugarTopRejected = 0;
    const samples: string[] = [];
    const maturePositions: any[] = [];
    const seenPositions = new Set<string>();

    // findBlocks() has a hard result count. In a dense sugar-cane farm it can
    // return mostly one layer, even though the upper layers are the blocks
    // we actually want to harvest. Expand every discovered cane column
    // vertically before selecting targets.
    const expandedCrops: any[] = [];
    for (const pos of nearbyCrops) {
      const b = this.bot.blockAt(pos);
      if (!b) continue;

      if (b.name === "sugar_cane") {
        for (let dy = -32; dy <= 32; dy++) {
          const cane = this.bot.blockAt(b.position.offset(0, dy, 0));
          if (!cane || cane.name !== "sugar_cane") continue;
          const key = this.blockKey(cane);
          if (!seenPositions.has(key)) {
            seenPositions.add(key);
            expandedCrops.push(cane.position.clone());
          }
        }
      } else {
        const key = this.blockKey(b);
        if (!seenPositions.has(key)) {
          seenPositions.add(key);
          expandedCrops.push(b.position.clone());
        }
      }
    }

    for (const pos of expandedCrops) {
      const b = this.bot.blockAt(pos);
      if (!b) continue;
      const mature = isMature(b);
      const matched = cropMatches(b.name, this.filters);
      const sugarTop = b.name === "sugar_cane" ? isSugarCaneHarvestable(this.bot, b) : true;
      if (mature) matureCount++;
      if (matched) filteredCount++;
      if (b.name === "sugar_cane" && !sugarTop) sugarTopRejected++;
      if (samples.length < 8) {
        let props: any = null;
        try { props = typeof b.getProperties === "function" ? b.getProperties() : null; } catch {}
        const age = blockAge(b);
        const propsText = props ? JSON.stringify(props) : "none";
        samples.push(`${b.name}@${Math.round(b.position.x)},${Math.round(b.position.y)},${Math.round(b.position.z)} age=${age} mature=${mature} props=${propsText}`);
      }
      if (mature && matched && sugarTop) maturePositions.push(b.position.clone());
    }

    if (this.debugEnabled && now - this.debugLastScanReportAt >= 2000) {
      this.debugLastScanReportAt = now;
      this.debug(`SCAN radius=${this.radius} activeRadius=${scanRadius} expansion=${this.scanExpansion} crops=${nearbyCrops.length} mature=${matureCount} filterMatch=${filteredCount} sugarTopRejected=${sugarTopRejected} names=${names.join(",")}`, true);
      if (samples.length) this.debug(`SCAN samples: ${samples.join(" | ")}`, true);
    }

    if (!maturePositions.length) {
      this.cachedTarget = null;
      this.lastTargetKey = "";
      // No target in the current area: widen the next scan around the bot.
      this.scanExpansion = Math.min(128, this.scanExpansion + 32);
      return null;
    }

    const blocks = maturePositions;
    blocks.sort((a, b) => {
      if (!a?.position) return 1;
      if (!b?.position) return -1;

      const aBlock = this.bot.blockAt(a);
      const bBlock = this.bot.blockAt(b);
      const aCane = aBlock?.name === "sugar_cane";
      const bCane = bBlock?.name === "sugar_cane";

      const aDistance = center.distanceTo(a);
      const bDistance = center.distanceTo(b);

      // Pathfinder still chooses the nearest crop globally. For sugar cane,
      // when two candidates belong to the same column, harvest the highest
      // segment first, then the next one down. The bottom segment is never a
      // target.
      if (aCane && bCane && a.x === b.x && a.z === b.z) {
        return b.y - a.y;
      }

      return aDistance - bDistance;
    });

    // Prefer a target that is already reachable without crossing crop blocks.
    // The pathfinder still decides the actual route; this only avoids stale/invalid targets.
    for (const pos of blocks) {
      const target = this.bot.blockAt(pos);
      if (this.isValidTarget(target)) {
        const key = this.blockKey(target);
        this.lastTargetKey = key;
        this.lastTargetAt = now;
        this.cachedTarget = target;
        this.scanExpansion = 0;
        return target;
      }
    }

    this.cachedTarget = null;
    return null;
  }

  private blockKey(block: any): string {
    return block?.position ? `${block.position.x},${block.position.y},${block.position.z}` : "";
  }

  private isCrop(block: any): boolean {
    return !!block?.name && CROP_NAMES.has(block.name);
  }

  private isSolidObstacle(block: any): boolean {
    return !!block && block.boundingBox === "block" && !this.isCrop(block);
  }

  private isValidTarget(block: any): boolean {
    if (!block?.position || !this.isCrop(block)) return false;
    if (!cropMatches(block.name, this.filters) || !isMature(block)) return false;
    if (block.name === "sugar_cane" && !isSugarCaneHarvestable(this.bot, block)) return false;
    return true;
  }

  private ensureMovements(): void {
    if (this.movementsReady) return;
    const movement = new Movements(this.bot);
    movement.canDig = false;
    movement.allow1by1towers = false;
    movement.allowParkour = false;

    // Do not put crops in blocksToAvoid. Most farm crops are passable or have
    // small collision boxes, and marking every crop as forbidden can make a
    // dense farm completely unreachable to the pathfinder. canDig=false is
    // enough to prevent pathfinder from breaking crops.
    try {
      const avoid = (movement as any).blocksToAvoid;
      if (avoid && typeof avoid.clear === "function") avoid.clear();
    } catch {}

    try { (this.bot.pathfinder as any).searchRadius = this.pathRadius; } catch {}
    this.bot.pathfinder.setMovements(movement);

    if (!this.pathEventsReady) {
      this.pathEventsReady = true;
      this.bot.on("path_update", (result: any) => {
        const status = result?.status ?? "unknown";
        this.debug(`PATH_UPDATE status=${status} goal=${this.currentGoalKey || "none"} pathLength=${result?.path?.length ?? "?"}`, true);
        if (!this.enabled || !this.pathMode) return;
        if (status !== "noPath" && status !== "timeout" && status !== "thinkTimeout" && status !== "pathError") return;

        const key = this.currentGoalKey;
        if (!key) return;
        const target = this.bot.blockAt(this.parseGoalKey(key));
        if (!this.isValidTarget(target)) {
          this.currentGoalKey = "";
          this.cachedTarget = null;
          this.lastScanAt = 0;
          return;
        }

        // Do not leave the bot waiting on a failed path. Switch to the
        // lightweight controller immediately and let the next scan/replan
        // choose a better route.
        try { this.bot.pathfinder.setGoal(null); } catch {}
        this.currentGoalKey = "";
        this.goalStartedAt = 0;
        this.lastProgressAt = Date.now();
        this.directMoveTo(target);
      });
      this.bot.on("goal_updated", (goal: any) => {
        this.debug(`GOAL_UPDATED ${goal ? JSON.stringify(goal) : "null"}`, true);
      });
      this.bot.on("path_reset", (reason: any) => {
        this.debug(`PATH_RESET reason=${reason ?? "unknown"}`, true);
      });
      this.bot.on("path_stop", () => {
        this.debug("PATH_STOP", true);
      });
    }

    this.movementsReady = true;
  }

  private goTo(block: any): void {
    if (!block?.position) return;
    const now = Date.now();
    if (now < this.replanCooldownUntil) return;

    const key = `${block.position.x},${block.position.y},${block.position.z}`;
    try {
      this.ensureMovements();

      // Keep the existing path only while the bot is genuinely progressing.
      // isMoving() can remain true even after a path has stalled on a server,
      // so a stalled target is allowed to be replanned.
      if (key === this.currentGoalKey && this.bot.pathfinder.isMoving() &&
          now - this.lastProgressAt < 700) return;

      const goal = new GoalNear(block.position.x, block.position.y, block.position.z, 2);
      this.debug(`GOAL set ${key} distance=${this.bot.entity?.position?.distanceTo(block.position).toFixed(2) ?? "?"}`, true);
      this.stopDirectMove();
      this.bot.pathfinder.setGoal(goal, false);
      this.debug(`GOAL accepted moving=${this.bot.pathfinder.isMoving()}`, true);
      this.currentGoalKey = key;
      this.goalStartedAt = now;
      this.lastProgressAt = now;
      const pos = this.bot.entity?.position;
      this.lastProgressPos = pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
    } catch (err) {
      logger.warn("[AutoFarm] Pathfinder error:", (err as Error).message);
      this.currentGoalKey = "";
      this.replanCooldownUntil = now + 250;
      this.directMoveTo(block);
    }
  }

  private updateMovementWatchdog(): void {
    if (!this.currentGoalKey || !this.bot.entity?.position) return;
    const now = Date.now();
    const pos = this.bot.entity.position;

    if (!this.lastProgressPos) {
      this.lastProgressPos = { x: pos.x, y: pos.y, z: pos.z };
      this.lastProgressAt = now;
      return;
    }

    const dx = pos.x - this.lastProgressPos.x;
    const dy = pos.y - this.lastProgressPos.y;
    const dz = pos.z - this.lastProgressPos.z;
    if ((dx * dx + dy * dy + dz * dz) >= 0.04) {
      this.lastProgressPos = { x: pos.x, y: pos.y, z: pos.z };
      this.lastProgressAt = now;
      return;
    }

    // Pathfinder can fail silently on servers with unusual collision/world data.
    // After a short stall without progress, stop waiting for it and use direct movement.
    if (now - this.lastProgressAt >= 700) {
      this.debug(`WATCHDOG STUCK goal=${this.currentGoalKey} elapsed=${now - this.lastProgressAt}ms pfMoving=${this.bot.pathfinder.isMoving()}`, true);
      const target = this.currentGoalKey ? this.bot.blockAt(this.parseGoalKey(this.currentGoalKey)) : null;
      if (this.isValidTarget(target)) {
        try { this.bot.pathfinder.setGoal(null); } catch {}
        this.currentGoalKey = "";
        this.goalStartedAt = 0;
        this.directMoveTo(target);
      } else {
        try { this.bot.pathfinder.setGoal(null); } catch {}
        this.currentGoalKey = "";
        this.cachedTarget = null;
        this.lastScanAt = 0;
      }
      this.lastProgressAt = now;
      this.replanCooldownUntil = now + 100;
    }
  }

  private clearGoal(): void {
    if (!this.currentGoalKey) return;
    try { this.bot.pathfinder.setGoal(null); } catch {}
    this.currentGoalKey = "";
    this.goalStartedAt = 0;
    this.lastProgressAt = 0;
    this.lastProgressPos = null;
    this.stopDirectMove();
  }

  private parseGoalKey(key: string): Vec3 {
    const [x = 0, y = 0, z = 0] = key.split(",").map(Number);
    return new Vec3(x, y, z);
  }

  private stopDirectMove(): void {
    try {
      this.bot.clearControlStates();
    } catch {}
    this.directMoveUntil = 0;
    this.directTargetKey = "";
  }

  private directMoveTo(block: any): void {
    if (!block?.position || !this.bot.entity?.position) return;

    const target = block.position.offset(0.5, 0.5, 0.5);
    const key = this.blockKey(block);
    const now = Date.now();
    const pos = this.bot.entity.position;
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const horizontal = Math.hypot(dx, dz);

    if (horizontal <= 2.8) {
      this.stopDirectMove();
      return;
    }

    try {
      // Use a direct look packet instead of awaiting lookAt() every farm tick.
      // Repeated async lookAt calls can pile up while the bot is stalled.
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(-(target.y - (pos.y + 1.62)), horizontal);
      this.bot.look(yaw, pitch, true).catch(() => {});

      const forwardX = Math.round(-Math.sin(yaw));
      const forwardZ = Math.round(-Math.cos(yaw));
      const ahead = this.bot.blockAt(pos.offset(forwardX, 0, forwardZ));
      const above = this.bot.blockAt(pos.offset(forwardX, 1, forwardZ));
      this.debug(`DIRECT ahead=${ahead?.name ?? "null"} crop=${this.isCrop(ahead)} solid=${this.isSolidObstacle(ahead)} above=${above?.name ?? "null"}`);

      // A mature crop in front is the destination, never a jump obstacle.
      if (this.isValidTarget(ahead)) {
        this.bot.setControlState("forward", false);
        this.bot.setControlState("sprint", false);
        this.bot.setControlState("jump", false);
        this.stopDirectMove();
        return;
      }

      // Crops are not treated as solid obstacles. If an immature crop is in
      // front, steer sideways instead of stopping forever or jumping over it.
      const aheadIsCrop = this.isCrop(ahead);
      let side = 0;
      if (aheadIsCrop) {
        const left = this.bot.blockAt(pos.offset(-forwardZ, 0, forwardX));
        const right = this.bot.blockAt(pos.offset(forwardZ, 0, -forwardX));
        const leftBlocked = this.isSolidObstacle(left);
        const rightBlocked = this.isSolidObstacle(right);
        if (!leftBlocked) side = -1;
        else if (!rightBlocked) side = 1;
      }

      this.bot.setControlState("forward", true);
      this.bot.setControlState("back", false);
      this.bot.setControlState("left", side < 0);
      this.bot.setControlState("right", side > 0);
      this.bot.setControlState("sprint", horizontal > 5 && side === 0);

      const obstacle = !aheadIsCrop && this.isSolidObstacle(ahead);
      const aboveBlocked = this.isSolidObstacle(above);

      // A one-block obstacle is jumpable: feet are blocked but the space
      // above it is free. A two-block wall is not jumpable, so steer around.
      if (obstacle && !aboveBlocked) {
        this.bot.setControlState("jump", true);
      } else {
        this.bot.setControlState("jump", false);
        if (obstacle && aboveBlocked && side === 0) {
          const left = this.bot.blockAt(pos.offset(-forwardZ, 0, forwardX));
          const right = this.bot.blockAt(pos.offset(forwardZ, 0, -forwardX));
          if (!this.isSolidObstacle(left)) {
            this.bot.setControlState("left", true);
            this.bot.setControlState("right", false);
          } else if (!this.isSolidObstacle(right)) {
            this.bot.setControlState("right", true);
            this.bot.setControlState("left", false);
          }
        }
      }

      this.directTargetKey = key;
      this.directMoveUntil = now + 1500;
    } catch {}
  }

  private async harvest(block: any): Promise<void> {
    if (this.busy || !this.isValidTarget(block)) return;

    const targetKey = this.blockKey(block);
    const targetPos = block.position.offset(0.5, 0.5, 0.5);
    this.busy = true;

    try {
      this.stopDirectMove();
      try { this.bot.pathfinder.setGoal(null); } catch {}

      const distance = this.bot.entity?.position?.distanceTo(targetPos) ?? 999;
      this.debug(`HARVEST_START block=${block.name} pos=${targetKey} distance=${distance.toFixed(2)}`, true);

      if (distance > 4.5) {
        this.debug(`HARVEST_SKIP out_of_reach distance=${distance.toFixed(2)}`, true);
        return;
      }

      await this.bot.lookAt(targetPos, true);
      this.debug(`HARVEST_LOOKED block=${block.name} pos=${targetKey}`, true);

      let current = this.bot.blockAt(block.position);
      if (!current || !this.isValidTarget(current)) {
        this.debug(`HARVEST_CANCEL target_changed pos=${targetKey}`, true);
        return;
      }

      // Sugar cane: always keep the bottom segment. For a 2-block cane
      // harvest the top block; for a 3-block cane harvest the top 2 blocks.
      if (current.name === "sugar_cane" && !isSugarCaneHarvestable(this.bot, current)) {
        this.debug(`HARVEST_CANCEL sugar_cane_bottom pos=${this.blockKey(current)}`, true);
        this.cachedTarget = null;
        this.lastScanAt = 0;
        return;
      }

      // Do not use bot.dig() here. Some custom-server item data can make
      // Mineflayer's normal dig path throw before the packet is sent
      // (for example: "enchantments.concat is not a function").
      // AutoFarm uses the raw block_dig sequence instead, which avoids the
      // item-enchantment parser entirely.
      this.debug(`HARVEST_DIG block=${current.name} pos=${targetKey}`, true);
      await this.rawDig(current);

      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      const after = this.bot.blockAt(current.position);
      const changed = !after || after.name === "air" || after.name === "cave_air" || after.name === "void_air";
      this.debug(`HARVEST_RESULT block=${current.name} pos=${targetKey} changed=${changed} after=${after?.name ?? "null"}`, true);

      if (!changed) {
        this.stuckSince = Date.now();
        this.debug(`HARVEST_FAILED block_not_changed pos=${targetKey}`, true);
        this.cachedTarget = null;
        this.lastScanAt = 0;
        return;
      }

      if ((this.mode === "farmer" || this.mode === "multi") && current.name !== "sugar_cane") {
        await this.replant(current);
      }
      this.nextActionAt = Date.now() + this.harvestDelay;
      this.stuckSince = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.debug(`HARVEST_ERROR block=${block.name} pos=${targetKey} error=${message}`, true);
      this.cachedTarget = null;
      this.lastScanAt = 0;
      this.stuckSince = Date.now();
    } finally {
      this.stopDirectMove();
      this.busy = false;
    }
  }

  private findSugarCaneTop(start: Vec3): any | null {
    let pos = start.clone();
    let block = this.bot.blockAt(pos);
    if (!block || block.name !== "sugar_cane") return null;

    // Move upward until the first non-cane block. This always resolves the
    // actual highest segment immediately before harvest.
    for (let i = 0; i < 32; i++) {
      const abovePos = pos.offset(0, 1, 0);
      const above = this.bot.blockAt(abovePos);
      if (!above || above.name !== "sugar_cane") break;
      pos = abovePos;
      block = above;
    }
    return block?.name === "sugar_cane" ? block : null;
  }

  private isSugarCaneTopStrict(block: any): boolean {
    if (!block?.position || block.name !== "sugar_cane") return false;
    const above = this.bot.blockAt(block.position.offset(0, 1, 0));
    return !above || above.name !== "sugar_cane";
  }

  private async rawDig(block: any): Promise<void> {
    const client = (this.bot as any)._client;
    if (!client?.write) throw new Error("Cannot access internal client");
    if (!block?.position) throw new Error("Invalid dig block");

    const position = block.position;
    const face = 1;
    try { this.bot.swingArm(undefined); } catch {}

    await queueBlockDig(client, 0, position, face, 0);

    let digTime = 50;
    try {
      digTime = Number(this.bot.digTime(block));
      if (!Number.isFinite(digTime) || digTime < 0) digTime = 50;
    } catch {
      const hardness = Number(block?.hardness ?? 0);
      digTime = hardness < 0 ? 50 : Math.max(50, Math.round(hardness * 800));
    }
    digTime = Math.min(Math.max(50, digTime), 5000);

    const started = Date.now();
    while (Date.now() - started < digTime) {
      try { this.bot.swingArm(undefined); } catch {}
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(150, Math.max(1, digTime - (Date.now() - started))))
      );
    }

    await queueBlockDig(client, 2, position, face, 0);
  }

  private async replant(block: any): Promise<void> {
    const seedNames = SEED_FOR_CROP[block?.name];
    if (!block?.position || !seedNames?.length) return;

    const below = this.bot.blockAt(block.position.offset(0, -1, 0));
    if (!below || !["farmland", "soul_sand"].includes(below.name)) {
      this.debug(`REPLANT_SKIP no_soil crop=${block?.name ?? "unknown"}`, true);
      return;
    }

    const current = this.bot.blockAt(block.position);
    if (current && current.name !== "air" && current.name !== "cave_air" && current.name !== "void_air") {
      this.debug(`REPLANT_SKIP_NOT_EMPTY crop=${block.name} block=${current.name}`, true);
      return;
    }

    let seed = this.bot.inventory.items().find((item) => seedNames.includes(item.name));
    if (!seed) {
      const withdrawItem = AUTO_WITHDRAW_ITEM[block.name];
      if (!withdrawItem) {
        this.debug(`REPLANT_SKIP_NO_SEED crop=${block.name} need=${seedNames.join("|")}`, true);
        return;
      }

      this.debug(`REPLANT_WITHDRAW crop=${block.name} item=${withdrawItem} amount=${AUTO_WITHDRAW_AMOUNT}`, true);
      try {
        this.bot.chat(`/kho withdraw ${withdrawItem} ${AUTO_WITHDRAW_AMOUNT}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.debug(`REPLANT_WITHDRAW_ERROR crop=${block.name} error=${message}`, true);
        return;
      }

      // Give the server a moment to update the inventory, then check again.
      for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        seed = this.bot.inventory.items().find((item) => seedNames.includes(item.name));
        if (seed) break;
      }
    }

    if (!seed) {
      this.debug(`REPLANT_SKIP_NO_SEED_AFTER_WITHDRAW crop=${block.name} need=${seedNames.join("|")}`, true);
      return;
    }

    try {
      this.debug(`REPLANT_START crop=${block.name} pos=${this.blockKey(block)} seed=${seed.name} count=${seed.count} hand=offhand`, true);

      await this.bot.equip(seed, "off-hand");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await this.bot.lookAt(below.position.offset(0.5, 1, 0.5), true);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      // Do not use bot.placeBlock() here. On this server/protocol combo
      // Mineflayer reaches its internal _genericPlace helper, which is not
      // available in the running client and causes: _genericPlace is not a function.
      // Send the 1.21.x use_item_on packet directly instead.
      const client = (this.bot as any)._client;
      if (!client?.write) throw new Error("client_not_available");

      const placePosition = below.position;
      const sequence = this.placeSequence++;
      if (this.placeSequence > 0x7fffffff) this.placeSequence = 0;

      // minecraft-protocol calls the 1.21.x USE_ITEM_ON packet
      // "block_place". Send exactly one packet per replant; retrying a
      // placement packet can make strict/custom servers process the same
      // interaction twice and throw a server-side exception.
      client.write("block_place", {
        hand: 1,
        location: placePosition,
        direction: 1,
        cursorX: 0.5,
        cursorY: 1.0,
        cursorZ: 0.5,
        insideBlock: false,
        worldBorderHit: false,
        sequence,
      });

      // Wait for the world update instead of sending duplicate packets.
      let placed = this.bot.blockAt(block.position);
      for (let attempt = 0; attempt < 8 && (!placed || placed.name !== block.name); attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        placed = this.bot.blockAt(block.position);
      }

      if (!placed || placed.name !== block.name) {
        throw new Error(`place_not_confirmed after=${placed?.name ?? "null"}`);
      }

      this.nextActionAt = Date.now() + this.plantDelay;
      this.debug(`REPLANT_OK crop=${block.name} pos=${this.blockKey(block)} placed=${placed.name}`, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.debug(`REPLANT_ERROR crop=${block.name} pos=${this.blockKey(block)} error=${message}`, true);
    }
  }}

export function getAutoFarm(bot: Bot, config: AppConfig): AutoFarm {
  let farm = state.get(bot);
  if (!farm) {
    farm = new AutoFarm(bot, config);
    if (farm.isEnabled()) farm.start();
    state.set(bot, farm);
    bot.once("end", () => farm?.stop());
  }
  return farm;
}
