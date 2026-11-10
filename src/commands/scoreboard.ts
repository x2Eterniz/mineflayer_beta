import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import prismarineChatLoader from "prismarine-chat";

const chatMessageClassCache = new WeakMap<object, any>();

function getChatMessageClass(registry: any): any {
  if (!registry) return null;
  let clazz = chatMessageClassCache.get(registry);
  if (!clazz) {
    clazz = prismarineChatLoader(registry);
    chatMessageClassCache.set(registry, clazz);
  }
  return clazz;
}

// ─── PROTOCOL NOTES ───────────────────────────────────────────────────────────
//
//  ≤ 1.20.2  scoreboard_score: { action, itemName, scoreName, value }
//            action=0 → add/update,  action=1 → remove
//
//  ≥ 1.20.3  scoreboard_score: { itemName, scoreName, value, display_name? }
//            NO action field — mineflayer checks `packet.action === 0`
//            which is `undefined === 0` = false → items are NEVER added  ← BUG
//            removal → separate reset_score / score_reset packet
//
//  TIMING BUG: scoreboard packets arrive during login, BEFORE the 'spawn'
//  event fires.  Any patch registered inside bot.on('spawn') misses them all.
//  patchScoreboard() must be called immediately after createBot().
//
//  FAKE PLAYER PATTERN: many servers encode each sidebar row as a unique
//  §-code string e.g. "§0§1§r".  Actual text is in team prefix + suffix.
//  item.displayName = prefix + placeholder + suffix  ← placeholder is noise.

// ─── VERSION HELPER ───────────────────────────────────────────────────────────

function isNewProtocol(bot: Bot): boolean {
  const p = ((bot as any).version ?? "").split(".").map(Number);
  // 1.20.3+ removed action field from scoreboard_score
  return p[1] > 20 || (p[1] === 20 && (p[2] ?? 0) >= 3);
}

// ─── NBT → CHAT COMPONENT ────────────────────────────────────────────────────

function nbtToChat(nbt: any): Record<string, any> {
  if (nbt == null) return { text: "" };
  if (typeof nbt === "string") {
    try { const p = JSON.parse(nbt); if (p && typeof p === "object") return p; } catch {}
    return { text: nbt };
  }
  if (typeof nbt !== "object") return { text: String(nbt) };
  if (nbt.type === "compound" && nbt.value && typeof nbt.value === "object") {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(nbt.value as Record<string, any>))
      result[k] = nbtTagToJs(v);
    return result;
  }
  return nbt;
}

function nbtTagToJs(tag: any): any {
  if (!tag || typeof tag !== "object" || !("type" in tag && "value" in tag)) return tag;
  const { type, value } = tag as { type: string; value: any };
  if (type === "compound") return nbtToChat(tag);
  if (type === "list") {
    if (value?.type === "compound" && Array.isArray(value.value))
      return value.value.map((i: any) => nbtToChat({ type: "compound", value: i }));
    if (Array.isArray(value.value)) return value.value.map(nbtTagToJs);
    if (Array.isArray(value)) return value.map(nbtTagToJs);
    return value;
  }
  return value;
}

// ─── TEXT EXTRACTION ──────────────────────────────────────────────────────────

function extractText(raw: any, bot: Bot): string {
  if (raw == null) return "";
  if (typeof raw === "object" && raw.constructor?.name === "ChatMessage")
    return raw.toString();
  const chatObj = nbtToChat(raw);
  try {
    const ChatMessage = getChatMessageClass((bot as any).registry);
    if (!ChatMessage) return flatText(chatObj);
    return new ChatMessage(chatObj).toString();
  } catch {
    return flatText(chatObj);
  }
}

function flatText(obj: any): string {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return String(obj);
  let out = "";
  if (typeof obj.text === "string") out += obj.text;
  else if (obj.text != null) out += flatText(obj.text);
  if (typeof obj.translate === "string") out += obj.translate;
  if (Array.isArray(obj.extra)) out += obj.extra.map(flatText).join("");
  return out;
}

function cleanText(s: string): string {
  s = s.replace(/§[0-9a-z]/gi, "");
  // Server resource packs often use Private Use Area glyphs for icons.
  // A normal terminal does not have that font, so render a safe placeholder
  // instead of leaking unreadable glyphs into the scoreboard output.
  s = s.replace(/[\uE000-\uF8FF]/g, "•");
  s = s.replace(/[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, "•");
  // U+FFFD means the original byte sequence could not be decoded. It is not
  // useful in terminal output and usually represents another missing icon.
  s = s.replace(/\uFFFD+/g, "");
  s = s.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  return s.replace(/\s{2,}/g, " ").trim();
}

// ─── FAKE PLAYER ─────────────────────────────────────────────────────────────

const FAKE_PLAYER_RE = /^(§[\da-z])+§[a-z]$/i;

export function getItemLine(item: any, bot: Bot): string {
  const name: string = item.name ?? "";
  if (FAKE_PLAYER_RE.test(name)) {
    const team = (bot as any).teamMap?.[name];
    if (!team) return "";
    return cleanText(extractText(team.prefix, bot) + extractText(team.suffix, bot));
  }
  return cleanText(extractText(item.displayName, bot) || name);
}

// ─── PATCH ────────────────────────────────────────────────────────────────────
//
// Call IMMEDIATELY after createBot() — before any event handlers, before spawn.
// Safe on all versions: isNewProtocol() guards 1.20.3+ specific logic.

export function patchScoreboard(bot: Bot): void {
  // Queue for score packets that arrive before their objective is registered.
  // Flushed whenever a new scoreboard is created.
  const pendingScores: Array<any> = [];

  function applyScore(packet: any): void {
    // 1.20.3+ packets do not have `action`. Older packets are already handled
    // by Mineflayer's scoreboard plugin, so only patch the new shape here.
    // Do not rely on bot.version: scoreboard packets can arrive before it is
    // populated during the login phase.
    if (packet?.action !== undefined) return;

    const scoreboards = (bot as any).scoreboards as Record<string, any> | undefined;
    if (!scoreboards) {
      if (pendingScores.length < 200) pendingScores.push(packet);
      return;
    }

    const scoreboard = scoreboards[packet.scoreName];
    if (!scoreboard) {
      // Objective not yet created — queue for later (capped to prevent memory leak)
      if (pendingScores.length < 200) {
        pendingScores.push(packet);
      }
      return;
    }

    const item = scoreboard.add(packet.itemName, packet.value);
    if (item) {
      item.value = packet.value; // keep value updated on subsequent packets
      if (packet.display_name) {
        const ChatMessage = getChatMessageClass((bot as any).registry);
        if (ChatMessage) {
          const msg = new ChatMessage(nbtToChat(packet.display_name));
          Object.defineProperty(item, "displayName", { get: () => msg, configurable: true });
        }
      }
    }
    // Don't emit scoreUpdated — mineflayer's own handler already tried (and failed
    // due to action check), so we emit it ourselves only when item is new or changed.
    bot.emit("scoreUpdated" as any, scoreboard, item);
  }

  // Intercept scoreboard_score — runs alongside mineflayer's handler (which no-ops
  // on 1.20.3+ due to missing action field, so there's no double-add).
  bot._client.on("scoreboard_score" as any, applyScore);

  // Flush pending scores whenever a new objective is registered
  bot.on("scoreboardCreated" as any, () => {
    const pending = pendingScores.splice(0);
    for (const p of pending) applyScore(p);
  });

  // 1.20.3+ removal packets
  const onReset = (packet: any) => {
    const scoreboards = (bot as any).scoreboards as Record<string, any> | undefined;
    if (!scoreboards) return;
    const targets = packet.objective_name
      ? [scoreboards[packet.objective_name]].filter(Boolean)
      : Object.values(scoreboards);
    for (const sb of targets as any[]) {
      if (packet.entity_name in sb.itemsMap) {
        const removed = sb.remove(packet.entity_name);
        bot.emit("scoreRemoved" as any, sb, removed);
      }
    }
  };
  bot._client.on("reset_score" as any, onReset);
  bot._client.on("score_reset" as any, onReset);

  // 1.20.3+ team prefix and suffix NBT fix
  bot._client.on("teams" as any, (packet: any) => {
    const teams = (bot as any).teams;
    if (!teams) return;

    const team = teams[packet.team];
    if (!team) return;

    const ChatMessage = getChatMessageClass((bot as any).registry);
    if (ChatMessage) {
      if (packet.prefix) {
        try { team.prefix = new ChatMessage(nbtToChat(packet.prefix)); } catch {}
      }
      if (packet.suffix) {
        try { team.suffix = new ChatMessage(nbtToChat(packet.suffix)); } catch {}
      }
    }
  });
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

function visiblePad(text: string, width: number): string {
  const value = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
  return value + " ".repeat(Math.max(0, width - value.length));
}

export function handleScoreboard(bot: Bot, args: string[] = []): void {
  const sidebar = bot.scoreboard.sidebar;
  if (!sidebar) {
    logger.warn("No scoreboard sidebar is currently visible.");
    return;
  }

  const title = cleanText(extractText(sidebar.title, bot)) || "Scoreboard";
  const width = 48;
  const items = sidebar.items
    .map((item: any) => ({
      label: getItemLine(item, bot),
      value: String(item.value ?? ""),
    }))
    .filter((item: { label: string }) => item.label !== "");

  // `/scoreboard raw` keeps the old compact output useful for debugging.
  if (args[0]?.toLowerCase() === "raw") {
    logger.separator();
    logger.info(chalk.hex("#FBBF24").bold(`  [ ${title} ]`));
    for (const item of items) logger.info(`    ${chalk.white(item.label)} ${chalk.gray(item.value)}`);
    logger.separator();
    return;
  }

  const border = (left: string, fill: string, right: string) =>
    chalk.hex("#64748B")(left + fill.repeat(width + 2) + right);

  logger.system(border("╔", "═", "╗"));
  logger.system(chalk.hex("#FBBF24")("║ ") + chalk.hex("#FBBF24").bold(visiblePad(title, width)) + chalk.hex("#FBBF24")(" ║"));
  logger.system(border("╠", "═", "╣"));

  if (items.length === 0) {
    logger.system(chalk.gray("║ ") + chalk.gray(visiblePad("No scoreboard data", width)) + chalk.gray(" ║"));
  } else {
    for (const item of items) {
      const score = item.value.length > 8 ? item.value.slice(-8) : item.value;
      const labelWidth = Math.max(1, width - score.length - 1);
      const row = `${visiblePad(item.label, labelWidth)} ${score}`;
      logger.system(chalk.white("║ ") + visiblePad(row, width) + chalk.white(" ║"));
    }
  }

  logger.system(border("╚", "═", "╝"));
}

// ─── DEBUG ────────────────────────────────────────────────────────────────────

export function debugScoreboard(bot: Bot): void {
  const sidebar = bot.scoreboard.sidebar;
  if (!sidebar) { console.log("[debug] No sidebar"); return; }

  console.log("[debug] version       :", (bot as any).version);
  console.log("[debug] new protocol  :", isNewProtocol(bot));
  console.log("[debug] sidebar.name  :", sidebar.name);
  console.log("[debug] title         :", extractText(sidebar.title, bot));
  console.log("[debug] items         :", sidebar.items.length);

  for (const item of sidebar.items) {
    const fake = FAKE_PLAYER_RE.test(item.name ?? "");
    const team = fake ? (bot as any).teamMap?.[item.name] : null;
    console.log(
      `[debug]  ${String(item.value).padStart(3)}`,
      `"${item.name}"`,
      fake
        ? `[fake] p="${extractText(team?.prefix, bot)}" s="${extractText(team?.suffix, bot)}"`
        : `→ "${getItemLine(item, bot)}"`
    );
  }
}

// ─── SNIFFER ──────────────────────────────────────────────────────────────────

export function setupScoreboardSniffer(bot: Bot): void {
  console.log("[sniffer] ready");

  bot._client.on("scoreboard_objective" as any, (p: any) =>
    console.log(`[scoreboard_objective] action=${p.action} name="${p.name}"`,
      p.displayText ? `title=${JSON.stringify(p.displayText).slice(0, 80)}` : ""));

  bot._client.on("scoreboard_display_objective" as any, (p: any) =>
    console.log(`[scoreboard_display] position=${["list","sidebar","belowName"][p.position]??p.position}(${p.position}) name="${p.name}"`));

  bot._client.on("scoreboard_score" as any, (p: any) =>
    console.log(`[scoreboard_score] itemName="${p.itemName}" scoreName="${p.scoreName}" value=${p.value}`,
      p.display_name ? `display_name=${JSON.stringify(p.display_name).slice(0,60)}` : "",
      p.action !== undefined ? `action=${p.action}` : "[no action - 1.20.3+]"));

  bot._client.on("reset_score" as any, (p: any) =>
    console.log(`[reset_score] entity="${p.entity_name}"`, p.objective_name ? `obj="${p.objective_name}"` : "(all)"));

  bot._client.on("score_reset" as any, (p: any) =>
    console.log(`[score_reset]`, JSON.stringify(p)));

  bot.on("scoreboardCreated"  as any, (b: any) =>
    console.log(`[event:scoreboardCreated] name="${b.name}"`));

  bot.on("scoreboardPosition" as any, (pos: number, b: any) =>
    console.log(`[event:scoreboardPosition] pos=${["list","sidebar","belowName"][pos]??pos} board="${b.name}" items=${b.items.length}`));

  bot.on("scoreUpdated" as any, (b: any, i: any) =>
    console.log(`[event:scoreUpdated] board="${b.name}" item="${i?.name}" value=${i?.value}`));

  bot.on("scoreRemoved" as any, (b: any, i: any) =>
    console.log(`[event:scoreRemoved] board="${b.name}" item="${i?.name}"`));
}
