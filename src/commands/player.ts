import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { getUptime } from "../utils/uptime";
import { getRealPlayers, stripColorCodes, isNPCPlayer, extractTextFromNbt } from "../utils/helpers";
import { getItemLine } from "./scoreboard";
import { sharedState } from "../events/connection";

// ─── Helpers ────────────────────────────────────────────────────────────

function ticksToTimeString(ticks: number): string {
  // MC time: 0=6:00, 6000=12:00, 12000=18:00, 18000=0:00
  const adjusted = (ticks + 6000) % 24000;
  const mcHour = Math.floor(adjusted / 1000);
  const mcMinute = Math.floor((adjusted % 1000) * 60 / 1000);
  return `${mcHour.toString().padStart(2, "0")}:${mcMinute.toString().padStart(2, "0")}`;
}

function getDayPhase(ticks: number): { name: string; color: string } {
  if (ticks >= 0 && ticks < 6000) return { name: "Morning", color: "#FBBF24" };
  if (ticks >= 6000 && ticks < 12000) return { name: "Noon", color: "#F59E0B" };
  if (ticks >= 12000 && ticks < 13000) return { name: "Dusk", color: "#F97316" };
  if (ticks >= 13000 && ticks < 23000) return { name: "Night", color: "#6366F1" };
  return { name: "Dawn", color: "#FB923C" };
}

function getMoonPhaseName(phase: number): string {
  const phases = ["Full Moon", "Waning Gibbous", "Last Quarter", "Waning Crescent", "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous"];
  return phases[phase] ?? `Phase ${phase}`;
}

function getEffectName(id: number): string {
  const effects: Record<number, string> = {
    1: "Speed", 2: "Slowness", 3: "Haste", 4: "Mining Fatigue", 5: "Strength",
    6: "Instant Health", 7: "Instant Damage", 8: "Jump Boost", 9: "Nausea",
    10: "Regeneration", 11: "Resistance", 12: "Fire Resistance", 13: "Water Breathing",
    14: "Invisibility", 15: "Blindness", 16: "Night Vision", 17: "Hunger",
    18: "Weakness", 19: "Poison", 20: "Wither", 21: "Health Boost",
    22: "Absorption", 23: "Saturation", 24: "Glowing", 25: "Levitation",
    26: "Luck", 27: "Unluck", 28: "Slow Falling", 29: "Conduit Power",
    30: "Dolphins Grace", 31: "Bad Omen", 32: "Hero of the Village",
    33: "Darkness",
  };
  return effects[id] ?? `Effect #${id}`;
}

function formatDuration(ticks: number): string {
  if (ticks <= 0) return "∞";
  const totalSecs = Math.floor(ticks / 20);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m${secs.toString().padStart(2, "0")}s` : `${secs}s`;
}

function extractTablistText(component: any): string {
  if (!component) return "";
  try {
    const text = component.toString();
    return text ? stripColorCodes(text).trim() : "";
  } catch {
    return "";
  }
}


// ─── Level Debug Command ───────────────────────────────────────────────
export function handleLevel(bot: Bot) {
  const xp = (bot as any).experience ?? {};
  const vanillaLevel = Number(xp.level ?? 0);
  const progress = Number(xp.progress ?? 0);
  const points = Number(xp.points ?? 0);

  logger.separator();
  logger.info(chalk.hex("#FBBF24").bold("  [ Level Debug ]"));
  logger.info(chalk.white("  bot.experience.level :"), chalk.cyan(String(vanillaLevel)));
  logger.info(chalk.white("  bot.experience.progress:"), chalk.cyan(progress.toFixed(3)));
  logger.info(chalk.white("  bot.experience.points  :"), chalk.cyan(String(points)));

  // Try to find a server-side mining/skill level from the visible scoreboard.
  const sidebar = bot.scoreboard?.sidebar;
  const candidates: string[] = [];
  if (sidebar?.items?.length) {
    for (const item of sidebar.items) {
      const line = stripColorCodes(getItemLine(item, bot)).trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      if (/(đào|dao|mine|mining|skill|level|lvl|cấp)/i.test(lower) && /\d+/.test(line)) {
        candidates.push(line);
      }
    }
  }

  if (candidates.length) {
    logger.info(chalk.white("  Possible server mining-level lines:"));
    for (const line of candidates.slice(0, 10)) {
      logger.info(chalk.gray("    ") + chalk.white(line));
    }
  } else {
    logger.info(chalk.yellow("  Mining level: not found in scoreboard"));
  }

  logger.separator();
}

// ─── Status Command (enhanced) ─────────────────────────────────────────

export function handleStatus(bot: Bot) {
  logger.separator();

  // === Connection Info ===
  logger.info(chalk.hex("#A78BFA").bold("  [ Connection ]"));
  logger.info(chalk.white("  Username :"), chalk.hex("#FBBF24").bold(bot.username ?? "N/A"));
  logger.info(chalk.white("  UUID     :"), chalk.hex("#60A5FA")(bot.player?.uuid ?? "N/A"));
  logger.info(chalk.white("  Latency  :"), chalk.hex("#F87171")(`${bot.player?.ping ?? "?"}ms`));
  logger.info(chalk.white("  Version  :"), chalk.hex("#A78BFA")(bot.version ?? "N/A"));
  logger.info(chalk.white("  Uptime   :"), chalk.hex("#34D399")(getUptime()));

  // === Health ===
  const attrs = (bot.entity as any)?.attributes;
  const vanillaMaxHp = Math.round(
    attrs?.["minecraft:max_health"]?.value ??
    attrs?.["minecraft:generic.max_health"]?.value ??
    attrs?.["generic.max_health"]?.value ??
    attrs?.["generic.maxHealth"]?.value ??
    attrs?.["max_health"]?.value ??
    20
  );
  let maxHp = vanillaMaxHp;
  let hp = bot.health ?? 0;

  const rpg = getRPGHealth(bot);
  if (rpg) {
    hp = rpg.hp;
    maxHp = rpg.maxHp;
  }
  const hpRatio = maxHp > 0 ? hp / maxHp : 0;

  logger.info(
    chalk.white("  Health   :"),
    chalk.hex(hpRatio > 0.7 ? "#34D399" : hpRatio > 0.35 ? "#FBBF24" : "#F87171")(`${Math.round(hp)}/${maxHp}`),
    chalk.gray("|"),
    chalk.white("Food:"),
    chalk.hex((bot.food ?? 0) > 14 ? "#34D399" : (bot.food ?? 0) > 7 ? "#FBBF24" : "#F87171")(`${Math.round(bot.food ?? 0)}/20`),
    chalk.gray("|"),
    chalk.white("O₂:"),
    chalk.hex((bot.oxygenLevel ?? 20) > 10 ? "#34D399" : "#F87171")(`${bot.oxygenLevel ?? 20}/20`)
  );

  // === Players ===
  const realCount = getRealPlayers(bot).length;
  logger.info(chalk.white("  Players  :"), chalk.hex("#A78BFA")(`${realCount} online`));

  // === Time ===
  if (bot.time) {
    const ticks = bot.time.timeOfDay;
    const phase = getDayPhase(ticks);
    const timeStr = ticksToTimeString(ticks);
    const day = bot.time.day;
    logger.info(chalk.hex("#A78BFA").bold("  [ Time ]"));
    logger.info(
      chalk.white("  Time     :"),
      chalk.hex(phase.color)(timeStr),
      chalk.gray(`(${phase.name})`),
      chalk.gray("|"),
      chalk.white("Day:"),
      chalk.hex("#60A5FA")(`${day}`)
    );
    if (!bot.time.isDay) {
      logger.info(chalk.white("  Moon     :"), chalk.hex("#94A3B8")(getMoonPhaseName(bot.time.moonPhase)));
    }
  }

  // === Weather ===
  logger.info(chalk.hex("#A78BFA").bold("  [ Weather ]"));
  if (bot.isRaining) {
    const thunderState = (bot as any).thunderState ?? 0;
    const rainState = (bot as any).rainState ?? 0;
    const thunder = thunderState > 0;
    logger.info(
      chalk.white("  Weather  :"),
      thunder
        ? chalk.hex("#F59E0B")("Thunderstorm") + chalk.gray(` (thunder: ${(thunderState * 100).toFixed(0)}%)`)
        : chalk.hex("#60A5FA")("Rain") + chalk.gray(` (intensity: ${(rainState * 100).toFixed(0)}%)`)
    );
  } else {
    logger.info(chalk.white("  Weather  :"), chalk.hex("#34D399")("Clear"));
  }

  // === Position & Dimension ===
  if (bot.entity) {
    const pos = bot.entity.position;
    logger.info(
      chalk.white("  Position :"),
      chalk.hex("#34D399")(`X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`),
      chalk.gray(`| ${bot.game?.dimension ?? "?"}`)
    );
  }

  // === Active Effects ===
  const effects = (bot.entity as any)?.effects;
  if (effects && Array.isArray(effects) && effects.length > 0) {
    logger.info(chalk.hex("#A78BFA").bold("  [ Effects ]"));
    for (const effect of effects) {
      const name = getEffectName(effect.id);
      const level = (effect.amplifier ?? 0) + 1;
      const dur = formatDuration(effect.duration ?? 0);
      logger.info(
        chalk.white(`  ${name}`),
        level > 1 ? chalk.hex("#FBBF24")(` ${romanNumeral(level)}`) : "",
        chalk.gray(`— ${dur}`)
      );
    }
  }

  // === Boss Bars ===
  const bossBars = (bot as any)._client?._bossBarMap ?? (bot as any).bossBars;
  // Access via internal bot.scoreboards-like approach
  const bossBarsArray: any[] = [];
  try {
    // mineflayer stores boss bars via events; we check the internal state
    if ((bot as any)._bossBarPlugin?.list) {
      for (const bar of (bot as any)._bossBarPlugin.list) {
        bossBarsArray.push(bar);
      }
    }
  } catch { }

  // === Tablist Header/Footer ===
  if (bot.tablist) {
    const header = extractTablistText(bot.tablist.header);
    const footer = extractTablistText(bot.tablist.footer);
    if (header || footer) {
      logger.info(chalk.hex("#A78BFA").bold("  [ Tablist ]"));
      if (header) {
        const lines = header.split("\n").filter(l => l.trim());
        for (const line of lines.slice(0, 5)) {
          logger.info(chalk.gray("  ▸ "), chalk.white(line.trim()));
        }
        if (lines.length > 5) logger.info(chalk.gray(`  ... +${lines.length - 5} more lines`));
      }
      if (footer) {
        const lines = footer.split("\n").filter(l => l.trim());
        for (const line of lines.slice(0, 5)) {
          logger.info(chalk.gray("  ▾ "), chalk.white(line.trim()));
        }
        if (lines.length > 5) logger.info(chalk.gray(`  ... +${lines.length - 5} more lines`));
      }
    }
  }

  logger.separator();
}

function romanNumeral(n: number): string {
  if (n <= 1) return "";
  const numerals: [number, string][] = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let result = "";
  for (const [value, symbol] of numerals) {
    while (n >= value) { result += symbol; n -= value; }
  }
  return result;
}

function getRPGHealth(bot: Bot): { hp: number; maxHp: number } | null {
  // 1. Try to parse from scoreboard sidebar
  const sidebar = bot.scoreboard?.sidebar;
  if (sidebar && sidebar.items.length > 0) {
    for (const item of sidebar.items) {
      const line = stripColorCodes(getItemLine(item, bot)).toLowerCase();
      
      // Match general patterns of numbers like "2060 / 2170" or "2060/2060" in lines containing "máu", "hp", or "❤"
      if (line.includes("máu") || line.includes("hp") || line.includes("❤") || line.includes("tim")) {
        const match = line.match(/(\d+)\s*[\/|]\s*(\d+)/);
        if (match) {
          const hp = parseInt(match[1]!, 10);
          const maxHp = parseInt(match[2]!, 10);
          if (!isNaN(hp) && !isNaN(maxHp)) {
            return { hp, maxHp };
          }
        }
        const singleMatch = line.match(/(?:máu|hp|❤)\s*:\s*(\d+)/i) || line.match(/(?:máu|hp)\s*(\d+)/i);
        if (singleMatch) {
          const hp = parseInt(singleMatch[1]!, 10);
          if (!isNaN(hp)) {
            return { hp, maxHp: hp };
          }
        }
      }
    }
  }

  // 2. Try to parse from nearby name tags (text_display or armor_stand) containing the bot's username
  if (bot.entity) {
    for (const entity of Object.values(bot.entities)) {
      if (!entity.position) continue;
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist > 5) continue; // Name tags are right at/above the bot

      const name = (entity.name || "").toLowerCase();
      if (name === "text_display" || name === "armor_stand") {
        let label = entity.displayName || (entity as any).customName || "";
        if (!label && entity.metadata) {
          for (const idx of [2, 23]) {
            const metaVal = entity.metadata[idx];
            if (metaVal !== undefined && metaVal !== null) {
              if (typeof metaVal === "string") {
                label = metaVal;
              } else if (metaVal && typeof metaVal === "object") {
                label = extractTextFromNbt(metaVal);
              }
              if (label) break;
            }
          }
        }

        if (label) {
          const cleanLabel = stripColorCodes(label).toLowerCase();
          // Check if label contains bot's username (case-insensitive)
          if (cleanLabel.includes(bot.username.toLowerCase())) {
            const match = cleanLabel.match(/(\d+)\s*[\/|]\s*(\d+)\s*(?:hp|❤)?/) ||
                          cleanLabel.match(/(\d+)\s*❤/);
            if (match) {
              const hp = parseInt(match[1]!, 10);
              const maxHp = match[2] ? parseInt(match[2]!, 10) : hp;
              if (!isNaN(hp) && !isNaN(maxHp)) {
                return { hp, maxHp };
              }
            }
          }
        }
      }
    }
  }

  // 3. Try to parse from bot's own tablist display name
  const selfPlayer = bot.players[bot.username];
  if (selfPlayer?.displayName) {
    const tabName = stripColorCodes(selfPlayer.displayName.toString()).toLowerCase();
    const match = tabName.match(/(\d+)\s*[\/|]\s*(\d+)\s*(?:hp|❤)?/) ||
                  tabName.match(/(\d+)\s*(?:hp|❤)/);
    if (match) {
      const hp = parseInt(match[1]!, 10);
      const maxHp = match[2] ? parseInt(match[2]!, 10) : hp;
      if (!isNaN(hp) && !isNaN(maxHp)) {
        return { hp, maxHp };
      }
    }
  }

  return null;
}

// ─── Health Command ─────────────────────────────────────────────────────

export function handleHealth(bot: Bot) {
  let hp = Math.round(bot.health ?? 0);
  const food = Math.round(bot.food ?? 0);
  const sat = Math.round(bot.foodSaturation ?? 0);

  const attrs = (bot.entity as any)?.attributes;
  
  let maxHp = Math.round(
    attrs?.["minecraft:max_health"]?.value ??
    attrs?.["minecraft:generic.max_health"]?.value ??
    attrs?.["generic.max_health"]?.value ??
    attrs?.["generic.maxHealth"]?.value ??
    attrs?.["max_health"]?.value ??
    20
  );

  const rpg = getRPGHealth(bot);
  if (rpg) {
    hp = rpg.hp;
    maxHp = rpg.maxHp;
  }
  
  if (sharedState.currentHp > 0) {
    hp = sharedState.currentHp;
    maxHp = sharedState.maxHp > 0 ? sharedState.maxHp : hp;
  }
  
  const hpRatio = maxHp > 0 ? hp / maxHp : 0;
  const hpColor = hpRatio > 0.7 ? "#34D399" : hpRatio > 0.35 ? "#FBBF24" : "#F87171";
  const foodColor = food > 14 ? "#34D399" : food > 7 ? "#FBBF24" : "#F87171";

  logger.separator();
  logger.info(chalk.white("  Health      :"), chalk.hex(hpColor).bold(`${hp}/${maxHp}`));
  logger.info(chalk.white("  Food        :"), chalk.hex(foodColor).bold(`${food}/20`));
  logger.info(chalk.white("  Saturation  :"), chalk.hex("#A78BFA").bold(`${sat}`));
  logger.info(chalk.white("  Oxygen      :"), chalk.hex("#60A5FA").bold(`${bot.oxygenLevel ?? 20}/20`));
  const xp = bot.experience?.level ?? 0;
  const xpProg = Math.round((bot.experience?.progress ?? 0) * 100);
  logger.info(chalk.white("  Level       :"), chalk.hex("#FBBF24").bold(`${xp}`), chalk.gray(`(${xpProg}% to next)`));

  // Show active effects
  const effects = (bot.entity as any)?.effects;
  if (effects && Array.isArray(effects) && effects.length > 0) {
    logger.info(chalk.hex("#A78BFA").bold("  Active Effects:"));
    for (const effect of effects) {
      const name = getEffectName(effect.id);
      const level = (effect.amplifier ?? 0) + 1;
      const dur = formatDuration(effect.duration ?? 0);
      logger.info(
        chalk.white(`    ${name}`),
        level > 1 ? chalk.hex("#FBBF24")(` ${romanNumeral(level)}`) : "",
        chalk.gray(`— ${dur}`)
      );
    }
  }

  logger.separator();
}

// ─── Time Command ───────────────────────────────────────────────────────

export function handleTime(bot: Bot) {
  if (!bot.time) {
    logger.warn("Time data not available yet");
    return;
  }

  const ticks = bot.time.timeOfDay;
  const phase = getDayPhase(ticks);
  const timeStr = ticksToTimeString(ticks);
  const day = bot.time.day;
  const age = bot.time.age;

  logger.separator();
  logger.info(chalk.hex("#A78BFA").bold("  [ World Time ]"));
  logger.info(
    chalk.white("  Time     :"),
    chalk.hex(phase.color).bold(timeStr),
    chalk.hex(phase.color)(`(${phase.name})`)
  );
  logger.info(chalk.white("  Day      :"), chalk.hex("#60A5FA").bold(`${day}`));
  logger.info(chalk.white("  Ticks    :"), chalk.gray(`${ticks}/24000`));
  logger.info(chalk.white("  Moon     :"), chalk.hex("#94A3B8")(getMoonPhaseName(bot.time.moonPhase)));
  logger.info(chalk.white("  Daylight :"), bot.time.doDaylightCycle ? chalk.green("Cycling") : chalk.yellow("Fixed"));
  if (age) {
    const realMinutes = Math.floor(age / 20 / 60);
    const realHours = Math.floor(realMinutes / 60);
    logger.info(
      chalk.white("  World Age:"),
      chalk.gray(realHours > 0 ? `${realHours}h ${realMinutes % 60}m (real time)` : `${realMinutes}m (real time)`)
    );
  }
  logger.separator();
}

// ─── Tab Complete Command ───────────────────────────────────────────────

export async function handleTabComplete(bot: Bot, args: string[]) {
  const query = args.join(" ").trim();
  if (!query) {
    logger.system(chalk.yellow("Usage: /tab <partial command>"));
    logger.system(chalk.gray("  Example: /tab /gamemode"));
    return;
  }

  const searchStr = query.startsWith("/") ? query : `/${query}`;

  logger.startSpinner(`Tab completing: ${searchStr}...`);
  try {
    const matches = await bot.tabComplete(searchStr, true, false, 5000);
    logger.stopSpinner();

    if (!matches || matches.length === 0) {
      logger.info(chalk.yellow("No completions found for:"), chalk.white(searchStr));
      return;
    }

    logger.separator();
    logger.info(chalk.hex("#A78BFA").bold(`  Tab Complete: ${searchStr}`), chalk.gray(`(${matches.length} results)`));
    for (const match of matches.slice(0, 30)) {
      const matchStr = typeof match === "string" ? match : (match as any)?.match ?? String(match);
      const tooltip = typeof match === "object" && (match as any)?.tooltip ? ` — ${(match as any).tooltip}` : "";
      logger.info(chalk.white(`    ${matchStr}`), tooltip ? chalk.gray(tooltip) : "");
    }
    if (matches.length > 30) {
      logger.info(chalk.gray(`    ... +${matches.length - 30} more`));
    }
    logger.separator();
  } catch (err) {
    logger.stopSpinner("Tab complete failed", false);
    logger.error(chalk.red("Tab complete error:"), (err as Error).message);
  }
}

// ─── Weather Command ────────────────────────────────────────────────────

export function handleWeather(bot: Bot) {
  logger.separator();
  logger.info(chalk.hex("#A78BFA").bold("  [ Weather ]"));

  if (bot.isRaining) {
    const rainState = (bot as any).rainState ?? 0;
    const thunderState = (bot as any).thunderState ?? 0;
    const rainIntensity = (rainState * 100).toFixed(0);
    const thunderIntensity = (thunderState * 100).toFixed(0);
    const thunder = thunderState > 0;

    logger.info(chalk.white("  Status   :"), chalk.hex("#60A5FA")("Raining"));
    logger.info(chalk.white("  Rain     :"), chalk.hex("#38BDF8")(`${rainIntensity}% intensity`));
    if (thunder) {
      logger.info(chalk.white("  Thunder  :"), chalk.hex("#F59E0B")(`${thunderIntensity}% intensity`));
    }
  } else {
    logger.info(chalk.white("  Status   :"), chalk.hex("#34D399")("Clear skies"));
    logger.info(chalk.white("  Rain     :"), chalk.gray("None"));
  }

  logger.separator();
}

// ─── Tablist Command ────────────────────────────────────────────────────

export function handleTablist(bot: Bot) {
  logger.separator();
  logger.info(chalk.hex("#A78BFA").bold("  [ Tablist Header/Footer ]"));

  const header = bot.tablist?.header;
  const footer = bot.tablist?.footer;

  if (header) {
    let headerAnsi = "";
    try { headerAnsi = header.toAnsi?.() ?? header.toString(); } catch {}
    if (!headerAnsi.trim()) {
      try { headerAnsi = JSON.stringify(header.json ?? header, null, 2); } catch {}
    }
    if (headerAnsi.trim()) {
      logger.info(chalk.hex("#60A5FA").bold("  Header:"));
      for (const line of headerAnsi.split("\n")) {
        if (line.trim()) logger.info(`    ${line}`);
      }
    }
  }

  logger.system("");
  logger.info(chalk.hex("#A78BFA").bold("  [ Tablist Players ]"));

  const players = Object.values(bot.players);
  if (players.length === 0) {
    logger.info(chalk.gray("    No player data available"));
  } else {
    // Sort players alphabetically by username
    const sortedPlayers = [...players].sort((a, b) => a.username.localeCompare(b.username));
    for (const p of sortedPlayers) {
      const ping = p.ping !== undefined ? `${p.ping}ms` : "??ms";
      let displayName = p.username;
      if (p.displayName) {
        try {
          displayName = p.displayName.toAnsi?.() ?? p.displayName.toString();
        } catch {
          displayName = p.displayName.toString();
        }
      }
      
      const cleanName = stripColorCodes(displayName).trim();
      const isNpc = cleanName.includes("[NPC]") || cleanName.includes("CIT-") || isNPCPlayer(p.username, ["CIT-", "[NPC]"]);
      const typeStr = isNpc ? chalk.gray(" [NPC]") : "";
      
      logger.info(
        chalk.gray("   ▸ "),
        displayName,
        chalk.gray(`— Ping: ${ping}${typeStr}`)
      );
    }
  }

  logger.system("");
  if (footer) {
    let footerAnsi = "";
    try { footerAnsi = footer.toAnsi?.() ?? footer.toString(); } catch {}
    if (!footerAnsi.trim()) {
      try { footerAnsi = JSON.stringify(footer.json ?? footer, null, 2); } catch {}
    }
    if (footerAnsi.trim()) {
      logger.info(chalk.hex("#60A5FA").bold("  Footer:"));
      for (const line of footerAnsi.split("\n")) {
        if (line.trim()) logger.info(`    ${line}`);
      }
    }
  }

  if (!header?.toString()?.trim() && !footer?.toString()?.trim() && !header?.json && !footer?.json) {
    logger.info(chalk.gray("  No tablist header/footer set by server"));
  }

  logger.separator();
}

// ─── Effects Command ────────────────────────────────────────────────────

export function handleEffects(bot: Bot) {
  const effects = (bot.entity as any)?.effects;

  logger.separator();
  logger.info(chalk.hex("#A78BFA").bold("  [ Active Effects ]"));

  if (!effects || !Array.isArray(effects) || effects.length === 0) {
    logger.info(chalk.gray("  No active effects"));
  } else {
    for (const effect of effects) {
      const name = getEffectName(effect.id);
      const level = (effect.amplifier ?? 0) + 1;
      const dur = formatDuration(effect.duration ?? 0);
      const levelStr = level > 1 ? chalk.hex("#FBBF24")(` ${romanNumeral(level)}`) : "";
      logger.info(
        chalk.white(`  ${name}`),
        levelStr,
        chalk.gray(`— ${dur}`)
      );
    }
  }

  logger.separator();
}

// ─── Existing Commands ──────────────────────────────────────────────────

export function handleList(bot: Bot) {
  const realPlayers = getRealPlayers(bot).sort();
  const npcCount = Object.keys(bot.players).length - realPlayers.length;

  logger.separator();
  logger.info(chalk.hex("#A78BFA").bold(`  Online Players (${realPlayers.length} real, ${npcCount} NPCs):`));
  if (realPlayers.length > 0) {
    for (let i = 0; i < realPlayers.length; i += 5) {
      const chunk = realPlayers.slice(i, i + 5);
      logger.info("   ", chunk.map((n) => (n === bot.username ? chalk.hex("#FBBF24").bold(n) : chalk.white(n))).join(chalk.gray(", ")));
    }
  } else {
    logger.info("   ", chalk.gray("No real players visible"));
  }
  logger.separator();
}

export function handlePos(bot: Bot) {
  if (bot.entity) {
    const pos = bot.entity.position;
    logger.info(
      chalk.white("Position:"),
      chalk.hex("#34D399").bold(`X: ${Math.round(pos.x)} Y: ${Math.round(pos.y)} Z: ${Math.round(pos.z)}`),
      chalk.gray(`| Dimension: ${bot.game?.dimension ?? "?"}`)
    );
  } else {
    logger.warn("Not spawned");
  }
}

export function handleAfk(bot: Bot) {
  logger.info(chalk.hex("#A78BFA")("[AntiAFK]"), chalk.white("Performing manual anti-AFK action..."));
  try {
    bot.setControlState("sneak", true);
    setTimeout(() => {
      try { bot.setControlState("sneak", false); } catch {}
    }, 300);
  } catch {}
}
