import type { Bot } from "mineflayer";
import pkg from "mineflayer-pathfinder";
const { Movements, goals } = pkg;
import chalk from "chalk";
import { logger } from "../logger";
import { stripColorCodes } from "../utils/helpers";

type NamedTarget = {
  entity: any;
  username?: string;
  displayName: string;
  customName: string | null;
  baseName: string;
  distance: number;
};

type MoveTracker = {
  goal: any | null;
  label: string | null;
  action: "left" | "right" | null;
  entity: any | null;
  lookPoint: any | null;
};

const moveTrackers = new WeakMap<Bot, MoveTracker>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMoveTracker(bot: Bot): MoveTracker {
  let tracker = moveTrackers.get(bot);
  if (!tracker) {
    tracker = { goal: null, label: null, action: null, entity: null, lookPoint: null };
    moveTrackers.set(bot, tracker);

    bot.on("goal_reached", (goal: any) => {
      const current = moveTrackers.get(bot);
      if (!current?.label) return;
      if (current.goal && goal && current.goal !== goal) return;

      logger.info(chalk.green("[Move]"), chalk.gray(`Reached destination: ${current.label}`));
      if (current.action) {
        void performArrivalAction(bot, {
          action: current.action,
          entity: current.entity,
          label: current.label,
          lookPoint: current.lookPoint,
        });
      }
      current.goal = null;
      current.label = null;
      current.action = null;
      current.entity = null;
      current.lookPoint = null;
    });

    bot.on("path_stop", () => {
      const current = moveTrackers.get(bot);
      if (!current) return;
      current.goal = null;
      current.label = null;
      current.action = null;
      current.entity = null;
      current.lookPoint = null;
    });

    bot.on("end", () => {
      const current = moveTrackers.get(bot);
      if (!current) return;
      current.goal = null;
      current.label = null;
      current.action = null;
      current.entity = null;
      current.lookPoint = null;
    });
  }

  return tracker;
}

async function performArrivalAction(
  bot: Bot,
  state: { action: "left" | "right"; entity: any | null; label: string; lookPoint: any | null }
): Promise<void> {
  const actionLabel = state.action === "right" ? "right-clicked" : "left-clicked";

  try {
    if (state.entity?.isValid) {
      const entity = state.entity;
      const lookPoint =
        state.lookPoint ??
        entity.position.offset(0, Math.min(entity.height ?? 1.6, 1.2), 0);

      logger.info(chalk.gray(`[Move] Aiming at ${state.label} (Type: ${entity.type})...`));
      await bot.lookAt(lookPoint, true);
      await wait(500); // 1.21.5 needs more time for rotation sync

      if (state.action === "right") {
        try {
          // Human-like sequence: Look -> Wait -> Swing -> Activate
          console.log(chalk.cyan("[Interaction]"), `Right-clicking ${state.label} (Type: ${entity.type})`);
          
          bot.swingArm(undefined);
          await wait(50);
          await bot.activateEntity(entity);
        } catch (activateErr) {
          const msg = (activateErr as Error).message ?? "";
          if (msg.includes("client") || msg.includes("socket") || msg.includes("end")) {
            logger.info(
              chalk.hex("#FBBF24")("[Move]"),
              chalk.gray(`${actionLabel} target: ${state.label} (server may be transferring...)`)
            );
            return;
          }
          throw activateErr;
        }
      } else {
        bot.attack(entity);
      }

      logger.info(chalk.green("[Move]"), chalk.gray(`${actionLabel} target: ${state.label}`));
      return;
    }

    if (state.lookPoint) {
      // Force the final rotation after pathfinder reaches a coordinate.
      // Without force=true, pathfinder can immediately restore its previous
      // pitch, which makes coordinate clicks aim at the ground.
      await bot.lookAt(state.lookPoint, true);
      await wait(180);
    }

    if (state.action === "right") {
      bot.activateItem(false);
    } else {
      bot.swingArm(undefined);
    }

    logger.info(chalk.green("[Move]"), chalk.gray(`${actionLabel} at destination: ${state.label}`));
  } catch (err) {
    const errMsg = (err as Error).message ?? "";
    // Don't warn about connection drops during server transfers
    if (errMsg.includes("client") || errMsg.includes("socket") || errMsg.includes("end")) {
      logger.info(
        chalk.hex("#FBBF24")("[Move]"),
        chalk.gray(`Action interrupted (server transfer likely): ${state.label}`)
      );
      return;
    }
    logger.warn(
      chalk.hex("#F59E0B")("[Move]"),
      chalk.gray(`Reached destination but failed to ${actionLabel}: ${errMsg}`)
    );
  }
}

function trackGoal(
  bot: Bot,
  goal: any,
  label: string,
  options: { action?: "left" | "right" | null; entity?: any | null; lookPoint?: any | null } = {}
): void {
  const tracker = getMoveTracker(bot);
  tracker.goal = goal;
  tracker.label = label;
  tracker.action = options.action ?? null;
  tracker.entity = options.entity ?? null;
  tracker.lookPoint = options.lookPoint ?? null;
}

function normalizeSearchText(value: string): string {
  return stripColorCodes(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getCustomEntityName(entity: any): string | null {
  try {
    const customName = typeof entity?.getCustomName === "function" ? entity.getCustomName() : null;
    if (!customName) return null;
    const rendered = stripColorCodes(customName.toString()).trim();
    return rendered || null;
  } catch {
    return null;
  }
}

function getEntityDisplayName(entity: any): string {
  const rawDisplayName =
    entity?.username ??
    getCustomEntityName(entity) ??
    entity?.displayName?.toString?.() ??
    entity?.name ??
    (entity?.id != null ? `entity#${entity.id}` : "unknown");

  return stripColorCodes(String(rawDisplayName)).trim() || "unknown";
}

function getEntityBaseName(entity: any): string {
  const rawBaseName =
    entity?.name ??
    entity?.displayName?.toString?.() ??
    entity?.kind ??
    entity?.type ??
    (entity?.entityType != null ? `entityType#${entity.entityType}` : "unknown");

  return stripColorCodes(String(rawBaseName)).trim() || "unknown";
}

function collectNamedTargets(bot: Bot): NamedTarget[] {
  const targets: NamedTarget[] = [];
  const seen = new Set<any>();

  // NPCs represented as player entities are sometimes present in bot.players
  // before (or instead of) being exposed through bot.entities. Include both
  // collections so /npcs also works after a proxy/server transfer.
  const entities: any[] = [
    ...Object.values(bot.entities),
    ...Object.values(bot.players ?? {}).map((player: any) => player?.entity),
  ];

  for (const entity of entities) {
    if (!entity || entity === bot.entity || !entity.position) continue;
    if (seen.has(entity)) continue;
    seen.add(entity);

    const anyEntity = entity as any;
    const customName = getCustomEntityName(anyEntity);

    const hasExplicitName =
      typeof entity.username === "string" ||
      anyEntity.displayName != null ||
      customName != null ||
      typeof anyEntity.name === "string" ||
      typeof anyEntity.kind === "string" ||
      Number.isFinite(anyEntity.id);
    const isPlayerLike = entity.type === "player";
    if (!hasExplicitName && !isPlayerLike) continue;

    const displayName = getEntityDisplayName(entity);
    const normalizedDisplay = normalizeSearchText(displayName);
    if (!normalizedDisplay) continue;

    let username: string | undefined;
    if (typeof entity.username === "string" && entity.username.trim()) {
      username = entity.username;
    }

    targets.push({
      entity,
      username,
      displayName,
      customName,
      baseName: getEntityBaseName(entity),
      distance: bot.entity ? bot.entity.position.distanceTo(entity.position) : Number.MAX_SAFE_INTEGER,
    });
  }

  return targets.sort((left, right) => {
    const leftPriority = (left.username || left.entity.type === "player") ? 0 : 1;
    const rightPriority = (right.username || right.entity.type === "player") ? 0 : 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.distance - right.distance;
  });
}

type TargetClassification = {
  className: string;
  priority: number;
  linkedTo: string | null;
};

function findLinkedPrimaryTarget(target: NamedTarget, targets: NamedTarget[]): NamedTarget | null {
  let best: NamedTarget | null = null;
  let bestDistance = Number.MAX_SAFE_INTEGER;

  for (const candidate of targets) {
    if (candidate.entity.id === target.entity.id) continue;
    if (candidate.entity.type !== "player" || !candidate.username) continue;

    const dx = Math.abs(candidate.entity.position.x - target.entity.position.x);
    const dy = Math.abs(candidate.entity.position.y - target.entity.position.y);
    const dz = Math.abs(candidate.entity.position.z - target.entity.position.z);
    if (dx > 4 || dz > 4 || dy > 6) continue;

    const distance = candidate.entity.position.distanceTo(target.entity.position);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function classifyTarget(target: NamedTarget, targets: NamedTarget[]): TargetClassification {
  const normalizedBase = normalizeSearchText(target.baseName);
  const linkedPrimary = findLinkedPrimaryTarget(target, targets);

  if (target.entity.type === "player" && target.username) {
    return {
      className: "player-npc",
      priority: 0,
      linkedTo: null,
    };
  }

  if (normalizedBase.includes("interaction")) {
    return {
      className: "interaction",
      priority: 1,
      linkedTo: linkedPrimary?.displayName ?? null,
    };
  }

  if (normalizedBase.includes("text display")) {
    return {
      className: "hologram",
      priority: 2,
      linkedTo: linkedPrimary?.displayName ?? null,
    };
  }

  if (normalizedBase.includes("item display")) {
    return {
      className: "item-display",
      priority: 3,
      linkedTo: linkedPrimary?.displayName ?? null,
    };
  }

  if (normalizedBase.includes("block display")) {
    return {
      className: "block-display",
      priority: 4,
      linkedTo: linkedPrimary?.displayName ?? null,
    };
  }

  if (target.entity.type === "player") {
    return {
      className: "player-like",
      priority: 5,
      linkedTo: null,
    };
  }

  if (target.entity.type === "mob" || target.entity.type === "hostile") {
    return {
      className: "mob",
      priority: 6,
      linkedTo: null,
    };
  }

  if (target.entity.type === "object") {
    return {
      className: "object",
      priority: 7,
      linkedTo: linkedPrimary?.displayName ?? null,
    };
  }

  return {
    className: target.entity.type || "named-entity",
    priority: 8,
    linkedTo: linkedPrimary?.displayName ?? null,
  };
}

function scoreTarget(target: NamedTarget, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return Number.NEGATIVE_INFINITY;

  const names = [
    normalizeSearchText(target.displayName),
    normalizeSearchText(target.username ?? ""),
    normalizeSearchText(target.customName ?? ""),
    normalizeSearchText(target.baseName),
  ].filter(Boolean);

  let score = Number.NEGATIVE_INFINITY;
  for (const name of names) {
    if (name === normalizedQuery) score = Math.max(score, 300);
    else if (name.startsWith(normalizedQuery)) score = Math.max(score, 200);
    else if (name.includes(normalizedQuery)) score = Math.max(score, 100);
  }

  if (score === Number.NEGATIVE_INFINITY) return score;
  return score - target.distance;
}

function resolveNamedTarget(bot: Bot, query: string): NamedTarget | null {
  const targets = collectNamedTargets(bot);
  const candidates = targets
    .map((target) => ({
      target,
      score: scoreTarget(target, query),
      classification: classifyTarget(target, targets),
    }))
    .filter((candidate) => candidate.score > Number.NEGATIVE_INFINITY)
    .sort((left, right) => {
      if (left.classification.priority !== right.classification.priority) {
        return left.classification.priority - right.classification.priority;
      }
      return right.score - left.score;
    });

  return candidates[0]?.target ?? null;
}

function parseArrivalAction(token?: string): "left" | "right" | null {
  const normalized = (token ?? "").toLowerCase();
  if (["right", "use", "rclick", "interact"].includes(normalized)) return "right";
  if (["left", "swing", "lclick", "attack"].includes(normalized)) return "left";
  return null;
}

function createLookPointFromCoordinates(bot: Bot, x: number, y: number, z: number): any | null {
  const currentPos = bot.entity?.position;
  if (!currentPos) return null;

  // /goto coordinates refer to the block position (its lower corner), while
  // lookAt() expects a point inside the block. Looking at the raw Y coordinate
  // makes the bot aim at the block's bottom face and appear to look downward.
  // Aim at the block center so both right/left interactions use a stable view.
  return currentPos.offset(
    x + 0.5 - currentPos.x,
    y + 0.5 - currentPos.y,
    z + 0.5 - currentPos.z,
  );
}

const manualGoTimers = new WeakMap<Bot, Map<string, ReturnType<typeof setTimeout>>>();
const GO_CONTROLS = { W: "forward", S: "back", A: "left", D: "right", SPACE: "jump" } as const;
export const GoCommand = {
  async execute(bot: Bot, args: string[]): Promise<void> {
    const key = String(args[0] ?? "").toUpperCase(); const ms = Number(args[1]);
    if (!(key in GO_CONTROLS) || !Number.isFinite(ms) || ms < 0) { logger.warn("Usage: /go W|S|A|D|SPACE <milliseconds>"); return; }
    const control = GO_CONTROLS[key as keyof typeof GO_CONTROLS]; const duration = Math.floor(ms);
    let timers = manualGoTimers.get(bot); if (!timers) { timers = new Map(); manualGoTimers.set(bot, timers); }
    const old = timers.get(control); if (old) clearTimeout(old);
    bot.setControlState(control, true); logger.info(chalk.cyan("[Go]"), `${key} ON for ${duration}ms`);
    const timer = setTimeout(() => { try { bot.setControlState(control, false); } catch {} timers?.delete(control); }, duration);
    timers.set(control, timer);
  },
  stop(bot: Bot): void { const timers=manualGoTimers.get(bot); if(timers){for(const t of timers.values())clearTimeout(t);timers.clear();} for(const c of Object.values(GO_CONTROLS)){try{bot.setControlState(c,false)}catch{}} }
};

export class MoveCommand {
  static execute(bot: Bot, args: string[]) {
    if (args.length === 0) {
      logger.warn("Usage: /goto <x> <y> <z> [left|right]  OR  /goto <name> [left|right]  OR  /goto npc <name> [left|right]");
      return;
    }

    // The installed version of mineflayer-pathfinder Movements constructor expects bot as first argument
    const defaultMovements = new Movements(bot); 
    bot.pathfinder.setMovements(defaultMovements);

    const trailingAction = parseArrivalAction(args[args.length - 1]);
    const argsWithoutAction =
      trailingAction && args.length > 1 ? args.slice(0, -1) : args;

    // Case 1: /goto <x> <y> <z> [action]
    if (argsWithoutAction.length === 3) {
      const xStr = argsWithoutAction[0];
      const yStr = argsWithoutAction[1];
      const zStr = argsWithoutAction[2];

      if (xStr === undefined || yStr === undefined || zStr === undefined) return;

      const x = parseInt(xStr);
      const y = parseInt(yStr);
      const z = parseInt(zStr);

      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        logger.info(
          chalk.cyan(
            `Pathfinding to: ${x}, ${y}, ${z}${trailingAction ? ` then ${trailingAction}-click` : ""}...`
          )
        );
        const goal = new goals.GoalBlock(x, y, z);
        trackGoal(bot, goal, `${x}, ${y}, ${z}`, {
          action: trailingAction,
          lookPoint: createLookPointFromCoordinates(bot, x, y, z),
        });
        bot.pathfinder.setGoal(goal);
        return;
      }
    }

    if (argsWithoutAction[0]?.toLowerCase() === "npc") {
      const query = argsWithoutAction.slice(1).join(" ").trim();
      if (!query) {
        logger.warn("Usage: /goto npc <name> [left|right]");
        return;
      }

      const npcTarget = resolveNamedTarget(bot, query);
      if (!npcTarget) {
        logger.error(`No visible NPC/entity matched '${query}'. Use /npcs to inspect visible targets.`);
        return;
      }

      const { x, y, z } = npcTarget.entity.position;
      const distance = bot.entity.position.distanceTo(npcTarget.entity.position);

      logger.info(
        chalk.cyan(
          `Pathfinding to NPC/entity: ${npcTarget.displayName} (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})${trailingAction ? ` then ${trailingAction}-click` : ""}`
        )
      );

      const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 2);

      // If already in range, perform action immediately
      if (distance <= 2.8 && trailingAction) {
        logger.info(chalk.green("[Move]"), chalk.gray(`Target NPC: ${npcTarget.displayName} (Type: ${npcTarget.entity.type}). Performing action...`));
        void performArrivalAction(bot, {
          action: trailingAction,
          entity: npcTarget.entity,
          label: `${npcTarget.displayName} (instant)`,
          lookPoint: npcTarget.entity.position.offset(0, Math.min(npcTarget.entity.height ?? 1.6, 1.2), 0),
        });
        return;
      }

      trackGoal(
        bot,
        goal,
        `${npcTarget.displayName} (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`,
        {
          action: trailingAction,
          entity: npcTarget.entity,
          lookPoint: npcTarget.entity.position.offset(0, Math.max(0.8, Math.min(npcTarget.entity.height ?? 1.6, 1.6)), 0),
        }
      );
      bot.pathfinder.setGoal(goal);
      return;
    }

    // Case 2: /goto <player exact>
    const targetName = argsWithoutAction.join(" ").trim();
    if (!targetName) return;

    const target = bot.players[targetName]?.entity;

    if (target) {
      logger.info(
        chalk.cyan(`Pathfinding to player: ${targetName}${trailingAction ? ` then ${trailingAction}-click` : ""}...`)
      );
      const goal = new goals.GoalFollow(target, 1);
      trackGoal(bot, goal, `${targetName}`, {
        action: trailingAction,
        entity: target,
        lookPoint: target.position.offset(0, Math.max(0.8, Math.min(target.height ?? 1.6, 1.6)), 0),
      });
      bot.pathfinder.setGoal(goal, true);
      return;
    }

    // Case 3: /goto <name fuzzy>
    const namedTarget = resolveNamedTarget(bot, targetName);
    if (!namedTarget) {
      logger.error(`No visible player/NPC/entity matched '${targetName}'. Use /npcs to inspect visible targets.`);
      return;
    }

    const { x, y, z } = namedTarget.entity.position;
    const distance = bot.entity.position.distanceTo(namedTarget.entity.position);
    
    logger.info(
      chalk.cyan(
        `Pathfinding to named target: ${namedTarget.displayName} (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})${trailingAction ? ` then ${trailingAction}-click` : ""}`
      )
    );

    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 2);
    
    // If already in range, perform action immediately
    if (distance <= 2.8 && trailingAction) {
      logger.info(chalk.green("[Move]"), chalk.gray(`Target: ${namedTarget.displayName} (Type: ${namedTarget.entity.type}). Performing action...`));
      void performArrivalAction(bot, {
        action: trailingAction,
        entity: namedTarget.entity,
        label: `${namedTarget.displayName} (instant)`,
        lookPoint: namedTarget.entity.position.offset(0, Math.min(namedTarget.entity.height ?? 1.6, 1.2), 0),
      });
      return;
    }

    trackGoal(
      bot,
      goal,
      `${namedTarget.displayName} (${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`,
      {
        action: trailingAction,
        entity: namedTarget.entity,
        lookPoint: namedTarget.entity.position.offset(0, Math.max(0.8, Math.min(namedTarget.entity.height ?? 1.6, 1.6)), 0),
      }
    );
    bot.pathfinder.setGoal(goal);
  }

  static stop(bot: Bot) {
    const tracker = getMoveTracker(bot);
    tracker.goal = null;
    tracker.label = null;
    tracker.action = null;
    tracker.entity = null;
    tracker.lookPoint = null;
    bot.pathfinder.setGoal(null);
    logger.info(chalk.yellow("Movement stopped."));
  }

  static listTargets(bot: Bot, query?: string) {
    const rawTargets = collectNamedTargets(bot);
    const targets = rawTargets
      .map((target) => ({
        target,
        classification: classifyTarget(target, rawTargets),
      }))
      .filter(({ target, classification }) => {
        if (!query) return true;

        const normalizedQuery = normalizeSearchText(query);
        if (scoreTarget(target, query) > Number.NEGATIVE_INFINITY) return true;
        if (normalizeSearchText(classification.className).includes(normalizedQuery)) return true;
        if (classification.linkedTo && normalizeSearchText(classification.linkedTo).includes(normalizedQuery)) return true;
        return false;
      })
      .sort((left, right) => {
        if (left.classification.priority !== right.classification.priority) {
          return left.classification.priority - right.classification.priority;
        }
        return left.target.distance - right.target.distance;
      })
      .slice(0, 15);

    if (targets.length === 0) {
      logger.warn(query ? `No visible NPC/entity matched '${query}'.` : "No visible NPC/entity targets found.");
      return;
    }

    logger.separator();
    logger.info(chalk.hex("#A78BFA").bold(`Visible NPC/Entity Targets (${targets.length})`));
    for (const { target, classification } of targets) {
      const pos = target.entity.position;
      const details = [
        `class=${classification.className}`,
        `type=${target.entity.type}`,
        target.username ? `user=${target.username}` : null,
        target.customName && normalizeSearchText(target.customName) !== normalizeSearchText(target.displayName)
          ? `custom=${target.customName}`
          : null,
        target.baseName && normalizeSearchText(target.baseName) !== normalizeSearchText(target.displayName)
          ? `base=${target.baseName}`
          : null,
        classification.linkedTo ? `linked=${classification.linkedTo}` : null,
        `id=${target.entity.id}`,
      ].filter(Boolean);
      const label =
        target.username && target.username !== target.displayName
          ? `${target.displayName} [${target.username}]`
          : target.displayName;
      logger.info(
        chalk.white("  -"),
        chalk.hex("#60A5FA")(label),
        chalk.gray(
          `@ ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} | ${target.distance.toFixed(1)}m | ${details.join(", ")}`
        )
      );
    }
    logger.separator();
  }
}
