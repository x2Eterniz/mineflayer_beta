import type { Bot } from "mineflayer";
import chalk from "chalk";

const chatTextCache = new WeakMap<object, string>();

// ── Pre-compiled regexes for hot-path functions ──────────────────────────
const RE_MC_COLOR = /§[0-9a-z]/gi;
const RE_BUKKIT_COLOR = /&[0-9a-z]/gi;
const RE_ANSI = /\x1b\[[0-9;]*m/g;
const RE_FFFD = /\uFFFD/g;
const RE_PUA_BMP = /[\uE000-\uF8FF]/g;
const RE_PUA_SUPP_A = /[\uDB80-\uDBBF][\uDC00-\uDFFF]/g;
const RE_PUA_SUPP_B = /[\uDBC0-\uDBFF][\uDC00-\uDFFF]/g;
const RE_DINGBATS = /[\u2700-\u27BF]/g;
const RE_HEX_COLOR = /<#[0-9a-fA-F]{6}>/gi;
const RE_ICONS = /[\u4E00-\u9FFF\uAC00-\uD7AF\u0B80-\u0BFF\u1100-\u11FF]/g;
const RE_MULTI_SPACE = /\s+/g;

// Translation key regexes (pre-compiled for resolveTranslationKey)
const RE_CONTAINER_KEY = /^container\.(.+)$/;
const RE_MODERN_KEY = /^(?:item|block|entity|effect|enchantment|biome|potion|advancement|stat)\.minecraft\.(.+)$/;
const RE_MODDED_KEY = /^(?:item|block|entity|effect|enchantment)\.([a-z0-9_]+)\.(.+)$/;
const RE_LEGACY_KEY = /^(?:item|tile)\.(.+?)\.name$/;
const RE_CAMEL_CASE = /([a-z])([A-Z])/g;
const RE_SPLIT_WORD = /[_.]/;

/**
 * Strip Minecraft color codes, ANSI codes, and invalid Unicode icons
 */
export function stripColorCodes(str: string): string {
  if (!str) return "";
  let clean = str.replace(RE_MC_COLOR, "");
  clean = clean.replace(RE_BUKKIT_COLOR, "");
  clean = clean.replace(RE_ANSI, "");
  clean = clean.replace(RE_HEX_COLOR, "");
  clean = cleanIcons(clean);
  return clean.trim();
}

/**
 * Strip invalid Unicode PUA icons while keeping ANSI color codes intact.
 */
export function cleanIcons(str: string): string {
  if (!str) return "";
  const cleaned = str
    .replace(RE_FFFD, "")
    .replace(RE_PUA_BMP, "")
    .replace(RE_PUA_SUPP_A, "")
    .replace(RE_PUA_SUPP_B, "")
    .replace(RE_ICONS, "")
    .replace(RE_DINGBATS, (match) => {
      const code = match.charCodeAt(0);
      if (code >= 0x2708 && code <= 0x270E) return match;
      if (code === 0x2714 || code === 0x2716) return match;
      if (code === 0x2728) return match;
      if (code >= 0x2733 && code <= 0x2734) return match;
      return "";
    })
    .replace(/[༺༻〄]/g, ""); // Remove specific server decorative icons
  return cleaned.replace(/⊱/g, ")").replace(/⊰/g, "(").trim();
}

export function stripSpecialChars(str: string): string {
  return stripColorCodes(str);
}

export function stripAnsiCodes(str: string): string {
  if (!str) return "";
  return str.replace(RE_ANSI, "");
}

/**
 * Safely serialize an item (or any object) to a compact JSON string for debug logging.
 * Handles circular references, limits depth, and caps total length.
 */
export function dumpItemJson(item: any, maxLen: number = 1200): string {
  if (item == null) return "null";
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(item, (key, value) => {
      // Skip heavy/useless fields
      if (key === "_client" || key === "_events" || key === "_eventsCount") return undefined;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      // Truncate long buffer/array data
      if (value instanceof Uint8Array || value instanceof Buffer) {
        return `[Buffer ${value.length}B]`;
      }
      return value;
    }, 1);
    if (json && json.length > maxLen) {
      return json.slice(0, maxLen) + "... [truncated]";
    }
    return json ?? "undefined";
  } catch (err) {
    return `[JSON error: ${(err as Error).message}]`;
  }
}

function simplifyNBT(data: any, depth: number = 0): any {
  if (depth > 20) return "[Deep NBT]";
  if (data === null || typeof data !== "object") return data;
  if ("type" in data && "value" in data) return simplifyNBT(data.value, depth + 1);
  if (Array.isArray(data)) return data.map((v: any) => simplifyNBT(v, depth + 1));
  const res: any = {};
  for (const key in data) res[key] = simplifyNBT(data[key], depth + 1);
  return res;
}

function extractTextContent(obj: any): string {
  if (!obj) return "";
  if (typeof obj === "string") {
    if (obj.startsWith("{") || obj.startsWith("[")) {
      try {
        return extractTextContent(JSON.parse(obj));
      } catch {
        return obj;
      }
    }
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(extractTextContent).join("").trim();
  if (typeof obj !== "object") return String(obj);

  let text = "";
  if (obj.text !== undefined) text += extractTextContent(obj.text);
  if (obj.translate !== undefined) text += extractTextContent(obj.translate);
  if (obj.extra) text += extractTextContent(obj.extra);
  if (obj.with) text += extractTextContent(obj.with);
  return text;
}

function formatTranslatedChat(translate: string, withArgs: string[]): string | null {
  switch (translate) {
    case "chat.type.text":
    case "multiplayer.player.joined":
      if (withArgs.length >= 2) return `${withArgs[0]}: ${withArgs.slice(1).join(" ")}`.trim();
      break;
    case "chat.type.announcement":
      if (withArgs.length >= 2) return `[${withArgs[0]}] ${withArgs.slice(1).join(" ")}`.trim();
      break;
    case "chat.type.emote":
      if (withArgs.length >= 2) return `* ${withArgs[0]} ${withArgs.slice(1).join(" ")}`.trim();
      break;
    case "chat.type.team.text":
      if (withArgs.length >= 3) return `[${withArgs[0]}] ${withArgs[1]}: ${withArgs.slice(2).join(" ")}`.trim();
      break;
    case "chat.type.team.sent":
      if (withArgs.length >= 3) return `-> [${withArgs[0]}] ${withArgs[1]}: ${withArgs.slice(2).join(" ")}`.trim();
      break;
    case "chat.type.team.emote":
      if (withArgs.length >= 3) return `* [${withArgs[0]}] ${withArgs[1]} ${withArgs.slice(2).join(" ")}`.trim();
      break;
    case "commands.message.display.incoming":
      if (withArgs.length >= 2) return `${withArgs[0]} -> you: ${withArgs.slice(1).join(" ")}`.trim();
      break;
    case "commands.message.display.outgoing":
      if (withArgs.length >= 2) return `you -> ${withArgs[0]}: ${withArgs.slice(1).join(" ")}`.trim();
      break;
    case "chat.type.advancement.task":
      if (withArgs.length >= 2) return `${withArgs[0]} has made the advancement [${withArgs[1]}]`.trim();
      break;
    case "chat.type.advancement.challenge":
      if (withArgs.length >= 2) return `${withArgs[0]} has completed the challenge [${withArgs[1]}]`.trim();
      break;
    case "chat.type.advancement.goal":
      if (withArgs.length >= 2) return `${withArgs[0]} has reached the goal [${withArgs[1]}]`.trim();
      break;
  }

  return null;
}

export function extractChatText(input: any): string {
  if (!input) return "";

  if (typeof input === "object" && chatTextCache.has(input)) {
    return chatTextCache.get(input) ?? "";
  }

  const raw = input?.json ?? input?.value ?? input;

  function flatten(node: any, depth: number = 0): string {
    if (depth > 15) return "";
    if (node == null) return "";
    if (typeof node === "string") {
      // Modern system_chat packets may carry the chat component as a JSON
      // string instead of an already parsed object. Parse it here so
      // actionbars from transferred sub-servers use the same renderer as
      // actionbars from the lobby.
      const trimmed = node.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return flatten(JSON.parse(trimmed), depth + 1);
        } catch {
          // It is ordinary text that happens to start with {/[.
        }
      }
      return node;
    }
    if (typeof node === "number" || typeof node === "boolean") return String(node);
    if (Array.isArray(node)) return node.map((n: any) => flatten(n, depth + 1)).join("");

    const simplified = simplifyNBT(node);
    if (Array.isArray(simplified)) return simplified.map((n: any) => flatten(n, depth + 1)).join("");
    if (simplified == null || typeof simplified !== "object") return String(simplified ?? "");

    const textPart = simplified.text !== undefined ? flatten(simplified.text, depth + 1) : "";
    const withArgs = Array.isArray(simplified.with) ? simplified.with.map((n: any) => flatten(n, depth + 1)).filter(Boolean) : [];
    const translated = typeof simplified.translate === "string"
      ? formatTranslatedChat(simplified.translate, withArgs)
      : null;

    let output = textPart;
    if (translated) {
      output += translated;
    } else if (typeof simplified.translate === "string") {
      // Try resolving as a game translation key (container, item, block, etc.)
      const resolved = resolveTranslationKey(simplified.translate);
      if (resolved) {
        output += resolved;
      } else if (withArgs.length > 0) {
        output += withArgs.join(" ");
      } else {
        // Last resort: use the raw translate key itself
        output += simplified.translate;
      }
    }

    if (Array.isArray(simplified.extra)) {
      output += simplified.extra.map((n: any) => flatten(n, depth + 1)).join("");
    } else if (simplified.extra != null) {
      output += flatten(simplified.extra, depth + 1);
    }

    if (!output && withArgs.length > 0) {
      output = withArgs.join(" ");
    }

    return output;
  }

  const extracted = stripColorCodes(flatten(raw)).replace(RE_MULTI_SPACE, " ").trim();
  if (extracted) {
    if (typeof input === "object") chatTextCache.set(input, extracted);
    return extracted;
  }

  try {
    const fallback = String(input?.toString?.() ?? "");
    const normalized = stripColorCodes(fallback).replace(RE_MULTI_SPACE, " ").trim();
    if (typeof input === "object") chatTextCache.set(input, normalized);
    return normalized;
  } catch {
    return "";
  }
}

type ItemComponent = {
  type: string;
  data: any;
};

function getItemComponents(item: any): ItemComponent[] {
  const components = item?.components;
  if (!components) return [];

  if (Array.isArray(components)) {
    return components
      .map((component) => {
        if (!component) return null;
        if (typeof component.type === "string") {
          return { type: component.type, data: component.data };
        }
        return null;
      })
      .filter(Boolean) as ItemComponent[];
  }

  if (typeof components === "object") {
    return Object.entries(components).map(([type, data]) => ({ type, data }));
  }

  return [];
}

function normalizeComponentType(type: string): string {
  return type.startsWith("minecraft:") ? type.slice("minecraft:".length) : type;
}

function getComponentData(item: any, ...names: string[]): any {
  const normalizedNames = names.map(normalizeComponentType);
  for (const component of getItemComponents(item)) {
    if (normalizedNames.includes(normalizeComponentType(component.type))) {
      return component.data;
    }
  }
  return null;
}

function toStringArray(value: any): string[] {
  if (value == null) return [];
  const simplified = simplifyNBT(value);

  if (Array.isArray(simplified)) {
    return simplified
      .map((entry) => {
        if (typeof entry === "string") return stripColorCodes(entry);
        return stripColorCodes(extractTextContent(entry));
      })
      .filter(Boolean);
  }

  if (typeof simplified === "string") return [stripColorCodes(simplified)].filter(Boolean);
  if (typeof simplified === "object") {
    return Object.values(simplified)
      .map((entry) => stripColorCodes(extractTextContent(entry)))
      .filter(Boolean);
  }

  return [stripColorCodes(String(simplified))].filter(Boolean);
}

function formatBool(value: boolean): string {
  return value ? "yes" : "no";
}

function formatNumber(value: any): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function getFallbackEnchantmentsFromComponents(item: any): { name: string; lvl: number }[] {
  const sources = [
    getComponentData(item, "enchantments"),
    getComponentData(item, "stored_enchantments"),
  ];

  for (const source of sources) {
    const simplified = simplifyNBT(source);
    if (!simplified) continue;

    if (Array.isArray(simplified)) {
      const parsed = simplified
        .map((entry: any) => {
          const id = entry?.id ?? entry?.name ?? entry?.enchantment ?? entry?.type;
          const lvl = entry?.lvl ?? entry?.level ?? entry?.value;
          if (!id) return null;
          const parsedLvl = typeof lvl === "number" ? lvl : parseInt(String(lvl ?? 1), 10);
          return { name: normalizeComponentType(String(id)), lvl: Number.isFinite(parsedLvl) ? parsedLvl : 1 };
        })
        .filter(Boolean) as { name: string; lvl: number }[];
      if (parsed.length > 0) return parsed;
    }

    if (typeof simplified === "object") {
      const levels = simplified.levels ?? simplified;
      if (levels && typeof levels === "object") {
        const parsed = Object.entries(levels)
          .map(([name, lvl]) => {
            const parsedLvl = typeof lvl === "number" ? lvl : parseInt(String(lvl ?? 1), 10);
            return { name: normalizeComponentType(String(name)), lvl: Number.isFinite(parsedLvl) ? parsedLvl : 1 };
          })
          .filter((entry) => !!entry.name);
        if (parsed.length > 0) return parsed;
      }
    }
  }

  return [];
}

/**
 * Convert a Minecraft translation key into a human-readable name.
 * Supports all versions:
 *  - 1.13+: "item.minecraft.paper", "block.minecraft.stone", "entity.minecraft.pig"
 *  - Pre-1.13: "item.paper.name", "tile.chest.name"
 *  - Container keys (all versions): "container.chest", "container.furnace"
 *  - Modded: "item.modid.xxx", "block.modid.xxx"
 * Returns null if the key doesn't look like a known translation pattern.
 */
function resolveTranslationKey(key: string): string | null {
  if (!key || typeof key !== "string") return null;

  // 1. Container titles: "container.chest" → "Chest", "container.shulkerBox" → "Shulker Box"
  const containerMatch = key.match(RE_CONTAINER_KEY);
  if (containerMatch) {
    const name = containerMatch[1]!
      .replace(RE_CAMEL_CASE, "$1 $2")
      .replace(/_/g, " ");
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // 2. Modern keys (1.13+): "item.minecraft.paper", "block.minecraft.stone", etc.
  const modernMatch = key.match(RE_MODERN_KEY);
  if (modernMatch) {
    return modernMatch[1]!
      .split(RE_SPLIT_WORD)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  // 3. Modded keys: "item.modid.xxx", "block.modid.xxx"
  const moddedMatch = key.match(RE_MODDED_KEY);
  if (moddedMatch) {
    return moddedMatch[2]!
      .split(RE_SPLIT_WORD)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  // 4. Pre-1.13 keys: "item.paper.name", "tile.chest.name"
  const legacyMatch = key.match(RE_LEGACY_KEY);
  if (legacyMatch) {
    const name = legacyMatch[1]!
      .replace(RE_CAMEL_CASE, "$1 $2")
      .replace(/_/g, " ");
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // 5. Advancement titles/descriptions: "advancements.nether.obtain_blaze_rod.title"
  const advancementMatch = key.match(/^advancements\.(?:[^.]+)\.(.+?)\.(?:title|description)$/);
  if (advancementMatch) {
    return advancementMatch[1]!
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  return null;
}


/**
 * Convert an internal Minecraft item name (e.g. "diamond_sword") into
 * a prettified display name ("Diamond Sword").
 */
function beautifyInternalName(name: string): string {
  if (!name) return "Unknown";
  // Strip "minecraft:" prefix if present
  const clean = name.replace(/^minecraft:/, "");
  return clean
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Extract a display name from a text component, resolving translation keys
 * to human-readable names when possible.
 */
function extractDisplayText(data: any): string {
  if (!data) return "";

  const simplified = simplifyNBT(data);

  if (typeof simplified === "string") {
    // Check if this is a JSON string
    if (simplified.startsWith("{") || simplified.startsWith("[")) {
      try {
        return extractDisplayText(JSON.parse(simplified));
      } catch {
        return simplified;
      }
    }
    // Check if it's a translation key itself
    const resolved = resolveTranslationKey(simplified);
    if (resolved) return resolved;
    return simplified;
  }

  if (Array.isArray(simplified)) {
    return simplified.map(extractDisplayText).join("").trim();
  }

  if (typeof simplified !== "object" || simplified === null) {
    return String(simplified ?? "");
  }

  // Object with text/translate/extra
  let text = "";

  if (simplified.text !== undefined) {
    text += typeof simplified.text === "string" ? simplified.text : extractDisplayText(simplified.text);
  }

  if (simplified.translate) {
    const resolved = resolveTranslationKey(simplified.translate);
    if (resolved) {
      text += resolved;
    } else {
      // For unrecognized translate keys, try to use 'with' args or the key itself
      if (Array.isArray(simplified.with) && simplified.with.length > 0) {
        text += simplified.with.map(extractDisplayText).join(" ");
      } else {
        text += simplified.translate;
      }
    }
  }

  if (simplified.extra) {
    text += Array.isArray(simplified.extra)
      ? simplified.extra.map(extractDisplayText).join("")
      : extractDisplayText(simplified.extra);
  }

  return text;
}

/**
 * Check if a name contains actual readable text, not just resource pack icon characters.
 * Returns false for names that are only CJK/Hangul icon chars (used by custom fonts).
 */
function isSubstantiveName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  // If ≤ 2 chars, require at least one Latin/Vietnamese/number character
  // to distinguish icon-only names (e.g. 뀁) from real short names (e.g. "HP")
  if (trimmed.length <= 2) {
    return /[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/.test(trimmed);
  }
  return true;
}

/**
 * Try to extract a display name from MMOItems custom_data NBT.
 * Returns the cleaned name or null if not found.
 */
function getMMOItemsName(item: any): string | null {
  try {
    const customData = getComponentData(item, "custom_data");
    if (!customData) return null;
    const simplified = simplifyNBT(customData);
    if (!simplified || typeof simplified !== "object") return null;
    const mmoName = simplified.MMOITEMS_NAME;
    if (typeof mmoName === "string" && mmoName) {
      const cleaned = stripColorCodes(mmoName);
      if (cleaned && isSubstantiveName(cleaned)) return cleaned;
    }
  } catch { }
  return null;
}

export function getItemDisplayName(item: any): string {
  if (!item) return "Air";

  try {
    // 1. Try custom_name first (player-renamed items, server custom items)
    const customName = getComponentData(item, "custom_name");
    if (customName) {
      const name = stripColorCodes(extractDisplayText(customName));
      if (name && isSubstantiveName(name)) return name;
    }

    if (item.customName) {
      const name = stripColorCodes(extractDisplayText(item.customName));
      if (name && isSubstantiveName(name)) return name;
    }

    // 2. Try item_name component (1.20.5+ structured components)
    //    This often contains {"translate":"item.minecraft.paper"} etc.
    const itemName = getComponentData(item, "item_name");
    if (itemName) {
      const name = stripColorCodes(extractDisplayText(itemName));
      if (name && isSubstantiveName(name)) return name;
    }

    // 3. Try MMOItems custom data (servers using MMOItems plugin)
    //    The real display name is stored in custom_data.MMOITEMS_NAME
    const mmoName = getMMOItemsName(item);
    if (mmoName) return mmoName;

    // 4. Try displayName from mineflayer (may have PUA unicode from resource packs)
    if (item.displayName) {
      const cleaned = stripColorCodes(item.displayName);
      if (cleaned && isSubstantiveName(cleaned)) return cleaned;
    }

    // 5. Fallback to internal name, but beautify it
    if (item.name) {
      return beautifyInternalName(item.name);
    }

    return "Unknown";
  } catch {
    // Last resort: try to beautify whatever name we have
    if (item?.name) return beautifyInternalName(item.name);
    return "Unknown";
  }
}

export function getItemLore(item: any): string[] {
  if (!item) return [];

  try {
    const loreComponent = getComponentData(item, "lore");
    if (loreComponent != null) {
      const lore = toStringArray(loreComponent);
      if (lore.length > 0) return lore;
    }

    if (item.customLore) {
      const lore = toStringArray(item.customLore);
      if (lore.length > 0) return lore;
    }

    if (item.nbt) {
      const simplified = simplifyNBT(item.nbt);
      const display = simplified?.display ?? simplified?.tag?.display ?? null;
      if (display?.Lore && Array.isArray(display.Lore)) {
        return display.Lore
          .map((line: any) => stripColorCodes(extractTextContent(line)))
          .filter((line: string) => line.length > 0);
      }
    }
  } catch (err) {
    console.error("[Lore] error:", err);
  }
  return [];
}

export function getItemEnchantments(item: any): string[] {
  if (!item) return [];

  const rawEnchants = Array.isArray(item.enchants) && item.enchants.length > 0
    ? item.enchants
    : getFallbackEnchantmentsFromComponents(item);

  return rawEnchants
    .map((entry: any) => {
      const name = stripColorCodes(String(entry?.name ?? "")).replace(/^minecraft:/, "");
      const lvl = entry?.lvl ?? entry?.level ?? 1;
      return name ? `${name} ${lvl}` : "";
    })
    .filter(Boolean);
}

function getComponentNumber(item: any, ...names: string[]): number | null {
  const value = getComponentData(item, ...names);
  const simplified = simplifyNBT(value);
  if (typeof simplified === "number" && Number.isFinite(simplified)) return simplified;
  if (typeof simplified === "object") {
    for (const key of ["value", "damage", "max_damage"]) {
      if (typeof simplified?.[key] === "number" && Number.isFinite(simplified[key])) {
        return simplified[key];
      }
    }
  }
  return null;
}

function getComponentBoolean(item: any, ...names: string[]): boolean | null {
  const value = getComponentData(item, ...names);
  const simplified = simplifyNBT(value);
  if (typeof simplified === "boolean") return simplified;
  if (simplified != null) return true;
  return null;
}

function getAdventureList(item: any, mode: "place" | "break"): string[] {
  try {
    if (mode === "place" && Array.isArray(item.blocksCanPlaceOn) && item.blocksCanPlaceOn.length > 0) {
      return item.blocksCanPlaceOn.flat().map((entry: any) => stripColorCodes(String(entry))).filter(Boolean);
    }
    if (mode === "break" && Array.isArray(item.blocksCanDestroy) && item.blocksCanDestroy.length > 0) {
      return item.blocksCanDestroy.flat().map((entry: any) => stripColorCodes(String(entry))).filter(Boolean);
    }
  } catch { }

  const raw = mode === "place"
    ? getComponentData(item, "can_place_on")
    : getComponentData(item, "can_break");
  const simplified = simplifyNBT(raw);

  if (!simplified) return [];
  const predicates = simplified?.predicates ?? simplified;
  if (Array.isArray(predicates)) {
    return predicates
      .flatMap((entry: any) => {
        if (Array.isArray(entry?.blocks)) return entry.blocks;
        if (entry?.blocks != null) return [entry.blocks];
        return [entry];
      })
      .map((entry: any) => stripColorCodes(String(entry)))
      .filter(Boolean);
  }

  return toStringArray(predicates);
}

export type ItemInfo = {
  name: string;
  typeName: string;
  count: number | null;
  slot: number | null;
  itemId: number | null;
  metadata: number | null;
  stackId: number | null;
  maxStackSize: number | null;
  durabilityUsed: number | null;
  durabilityMax: number | null;
  customModel: string | null;
  repairCost: number | null;
  unbreakable: boolean | null;
  lore: string[];
  enchantments: string[];
  canPlaceOn: string[];
  canBreak: string[];
  componentKeys: string[];
  // ── Plugin-specific data ──
  pluginId: string | null;        // MMOItems ID, ItemsAdder ID, Oraxen ID, etc.
  pluginType: string | null;      // MMOItems item type (e.g. "MATERIAL", "SWORD")
  pluginSource: string | null;    // Which plugin: "MMOItems", "ItemsAdder", "Oraxen", etc.
  tier: string | null;            // MMOItems tier / rarity
  pluginLore: string[];           // Plugin-specific lore (cleaned)
  pluginEnchants: string[];       // Plugin-specific enchantments
  attributes: string[];           // Attribute modifiers
  customDataKeys: string[];       // All keys in custom_data (for debugging)
};

/**
 * Extract MMOItems, ItemsAdder, Oraxen, and other plugin data from custom_data.
 */
function extractPluginData(item: any): {
  pluginId: string | null;
  pluginType: string | null;
  pluginSource: string | null;
  tier: string | null;
  pluginLore: string[];
  pluginEnchants: string[];
  customDataKeys: string[];
} {
  const result = {
    pluginId: null as string | null,
    pluginType: null as string | null,
    pluginSource: null as string | null,
    tier: null as string | null,
    pluginLore: [] as string[],
    pluginEnchants: [] as string[],
    customDataKeys: [] as string[],
  };

  try {
    const customData = getComponentData(item, "custom_data");
    if (!customData) return result;
    const data = simplifyNBT(customData);
    if (!data || typeof data !== "object") return result;

    result.customDataKeys = Object.keys(data).sort();

    // ── MMOItems ──
    if (data.MMOITEMS_ITEM_ID) {
      result.pluginSource = "MMOItems";
      result.pluginId = String(data.MMOITEMS_ITEM_ID);
      result.pluginType = data.MMOITEMS_ITEM_TYPE ? String(data.MMOITEMS_ITEM_TYPE) : null;
      result.tier = data.MMOITEMS_TIER ? String(data.MMOITEMS_TIER) : null;

      // MMOItems lore
      if (data.MMOITEMS_LORE) {
        try {
          const loreArr = typeof data.MMOITEMS_LORE === "string"
            ? JSON.parse(data.MMOITEMS_LORE) : data.MMOITEMS_LORE;
          if (Array.isArray(loreArr)) {
            result.pluginLore = loreArr
              .map((line: string) => stripColorCodes(String(line)).trim())
              .filter((line: string) => line.length > 0);
          }
        } catch { }
      }

      // MMOItems enchantments
      if (data.MMOITEMS_ENCHANTS) {
        try {
          const enchArr = typeof data.MMOITEMS_ENCHANTS === "string"
            ? JSON.parse(data.MMOITEMS_ENCHANTS) : data.MMOITEMS_ENCHANTS;
          if (Array.isArray(enchArr)) {
            result.pluginEnchants = enchArr.map((e: string) => String(e).trim()).filter(Boolean);
          }
        } catch { }
      }
    }

    // ── ItemsAdder ──
    else if (data.itemsadder || data.ITEMSADDER_ITEM || data["itemsadder:id"]) {
      result.pluginSource = "ItemsAdder";
      const iaData = data.itemsadder ?? data.ITEMSADDER_ITEM ?? data;
      result.pluginId = typeof iaData === "string" ? iaData
        : iaData?.id ? String(iaData.id) : (data["itemsadder:id"] ? String(data["itemsadder:id"]) : null);
    }

    // ── Oraxen ──
    else if (data.oraxen || data.ORAXEN_ITEM || data["oraxen:id"]) {
      result.pluginSource = "Oraxen";
      const oxData = data.oraxen ?? data.ORAXEN_ITEM ?? data;
      result.pluginId = typeof oxData === "string" ? oxData
        : oxData?.id ? String(oxData.id) : (data["oraxen:id"] ? String(data["oraxen:id"]) : null);
    }

    // ── Nexo ──
    else if (data.nexo || data["nexo:id"]) {
      result.pluginSource = "Nexo";
      result.pluginId = data["nexo:id"] ? String(data["nexo:id"])
        : typeof data.nexo === "string" ? data.nexo : data.nexo?.id ? String(data.nexo.id) : null;
    }

    // ── MythicMobs ──
    else if (data.MYTHIC_TYPE || data.mythic_type) {
      result.pluginSource = "MythicMobs";
      result.pluginId = String(data.MYTHIC_TYPE ?? data.mythic_type);
    }

    // ── ExecutableItems ──
    else if (data.ei_id || data.EI_ID) {
      result.pluginSource = "ExecutableItems";
      result.pluginId = String(data.ei_id ?? data.EI_ID);
    }

  } catch { }
  return result;
}

/**
 * Extract attribute modifiers from item components.
 */
function getAttributeModifiers(item: any): string[] {
  try {
    const attrData = getComponentData(item, "attribute_modifiers");
    if (!attrData) return [];
    const simplified = simplifyNBT(attrData);
    const attrs = simplified?.attributes ?? simplified;
    if (!Array.isArray(attrs)) return [];

    return attrs.map((attr: any) => {
      const name = attr.name ?? attr.type ?? `attr#${attr.typeId ?? "?"}`;
      const cleanName = String(name).replace(/^minecraft:/, "").replace(/^mmoitems:/, "[MMO] ");
      const value = attr.value ?? 0;
      const op = attr.operation ?? "add";
      const slot = attr.slot && attr.slot !== "any" ? ` (${attr.slot})` : "";

      if (cleanName.includes("decoy") && value === 0) return ""; // Skip MMOItems placeholder

      const sign = value >= 0 ? "+" : "";
      const formatted = op === "add" ? `${sign}${value}`
        : op === "multiply_base" ? `${sign}${(value * 100).toFixed(0)}%`
          : `${sign}${(value * 100).toFixed(0)}% (mult)`;

      return `${beautifyInternalName(cleanName)} ${formatted}${slot}`;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function getItemInfo(item: any): ItemInfo {
  const componentKeys = getItemComponents(item).map((component) => normalizeComponentType(component.type));

  const durabilityUsed =
    formatNumber(item?.durabilityUsed) != null
      ? Number(item.durabilityUsed)
      : getComponentNumber(item, "damage");

  const durabilityMax =
    formatNumber(item?.maxDurability) != null
      ? Number(item.maxDurability)
      : getComponentNumber(item, "max_damage");

  const customModelRaw = item?.customModel ?? getComponentData(item, "custom_model_data");
  const simplifiedModel = simplifyNBT(customModelRaw);
  const customModel = simplifiedModel == null ? null 
    : (typeof simplifiedModel === "object" ? String(simplifiedModel.value ?? JSON.stringify(simplifiedModel)) : String(simplifiedModel));

  const repairCostRaw = item?.repairCost ?? getComponentNumber(item, "repair_cost");
  const repairCost = typeof repairCostRaw === "number" && Number.isFinite(repairCostRaw) ? repairCostRaw : null;

  let unbreakable = getComponentBoolean(item, "unbreakable");
  if (unbreakable == null && durabilityMax != null) {
    unbreakable = durabilityMax > 0 && durabilityUsed === 0 && componentKeys.includes("unbreakable");
  }

  const pluginData = extractPluginData(item);
  const attributes = getAttributeModifiers(item);

  return {
    name: getItemDisplayName(item),
    typeName: beautifyInternalName(item?.name ?? "unknown"),
    count: typeof item?.count === "number" ? item.count : null,
    slot: typeof item?.slot === "number" ? item.slot : null,
    itemId: typeof item?.type === "number" ? item.type : null,
    metadata: typeof item?.metadata === "number" ? item.metadata : null,
    stackId: typeof item?.stackId === "number" ? item.stackId : null,
    maxStackSize: typeof item?.stackSize === "number" ? item.stackSize : null,
    durabilityUsed,
    durabilityMax,
    customModel: customModel || null,
    repairCost,
    unbreakable,
    lore: getItemLore(item),
    enchantments: getItemEnchantments(item),
    canPlaceOn: getAdventureList(item, "place"),
    canBreak: getAdventureList(item, "break"),
    componentKeys,
    // Plugin data
    pluginId: pluginData.pluginId,
    pluginType: pluginData.pluginType,
    pluginSource: pluginData.pluginSource,
    tier: pluginData.tier,
    pluginLore: pluginData.pluginLore,
    pluginEnchants: pluginData.pluginEnchants,
    attributes,
    customDataKeys: pluginData.customDataKeys,
  };
}

export function isNPCPlayer(username: string, patterns: string[]): boolean {
  const clean = stripColorCodes(username);
  if (username.includes("Â§") || clean.includes("Â§")) return true;
  if (clean.trim() === "") return true;
  for (const pattern of patterns) {
    if (clean.includes(pattern)) return true;
  }
  return false;
}

export function getRealPlayers(bot: Bot, npcPatterns: string[] = ["CIT-", "[NPC]"]) {
  return Object.keys(bot.players).filter(
    (name) => !isNPCPlayer(name, npcPatterns)
  );
}

export function centerText(text: string, width: number = 45): string {
  const textLength = stripColorCodes(text).length;
  if (textLength >= width) return text;
  const sideSpace = Math.floor((width - textLength) / 2);
  return " ".repeat(sideSpace) + text;
}

export function updateConsoleTitle(bot: Bot): void {
  if (!bot) return;

  const server = (bot as any)._client?.socket?._host || "Minecraft Bot";
  const memory = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const title = `[${bot.username}] @ ${server} | RAM: ${memory}MB`;
  process.stdout.write(`\x1b]0;${title}\x07`);
}

import http from "http";
import https from "https";
import { URL } from "url";

export function getResourcePackSize(urlString: string, maxRedirects: number = 5): Promise<number | null> {
  return new Promise((resolve) => {
    if (maxRedirects < 0) {
      resolve(null);
      return;
    }

    try {
      const parsedUrl = new URL(urlString);
      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;

      const options: http.RequestOptions = {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Range": "bytes=0-0",
          "Accept-Encoding": "identity",
        },
        timeout: 5000,
      };

      const req = lib.request(parsedUrl, options, (res) => {
        // Handle redirect
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          const redirectUrl = res.headers.location;
          req.destroy();
          if (redirectUrl) {
            const resolvedUrl = new URL(redirectUrl, parsedUrl.href).href;
            resolve(getResourcePackSize(resolvedUrl, maxRedirects - 1));
          } else {
            resolve(null);
          }
          return;
        }

        let size: number | null = null;
        const contentRange = res.headers["content-range"];
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match && match[1]) {
            size = parseInt(match[1], 10);
          }
        }

        if (size === null && res.headers["content-length"]) {
          const len = parseInt(res.headers["content-length"], 10);
          if (res.statusCode === 200) {
            size = len;
          }
        }

        req.destroy();

        if (size && !isNaN(size) && size > 0) {
          resolve(size);
        } else {
          resolve(null);
        }
      });

      req.on("error", () => {
        resolve(null);
      });

      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });

      req.end();
    } catch {
      resolve(null);
    }
  });
}

export function extractTextFromNbt(obj: any): string {
  if (!obj || typeof obj !== "object") return "";
  
  let text = "";

  if (obj.type === "compound" && obj.value) {
    return extractTextFromNbt(obj.value);
  }

  if (obj.type === "list" && obj.value) {
    return extractTextFromNbt(obj.value);
  }

  if (obj.type === "string" && obj.value !== undefined) {
    return obj.value;
  }

  if (obj.text && typeof obj.text === "object") {
    text += extractTextFromNbt(obj.text);
  } else if (typeof obj.text === "string") {
    text += obj.text;
  }

  if (obj.extra && typeof obj.extra === "object") {
    text += extractTextFromNbt(obj.extra);
  }

  if (Array.isArray(obj)) {
    for (const child of obj) {
      text += extractTextFromNbt(child);
    }
  } else if (obj.value && Array.isArray(obj.value)) {
    for (const child of obj.value) {
      text += extractTextFromNbt(child);
    }
  }

  return text;
}

