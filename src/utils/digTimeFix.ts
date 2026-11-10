import type { Bot } from "mineflayer";

interface NormalizedEnchant {
  name: string;
  lvl: number;
}

function enchantName(bot: Bot, id: unknown): string | null {
  if (typeof id === "string") {
    const name = id.includes(":") ? id.split(":").pop() : id;
    return name || null;
  }

  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;

  const registry: any = (bot as any).registry;
  const entry = registry?.enchantments?.[numericId]
    ?? registry?.enchantmentsById?.[numericId];

  return entry?.name ? String(entry.name).replace(/^minecraft:/, "") : null;
}

function enchantLevel(value: any): number {
  const level = Number(value?.lvl ?? value?.level ?? value?.value ?? value);
  return Number.isFinite(level) ? level : 0;
}

/**
 * Minecraft 1.20.5+ stores item enchantments as a data component.
 * Some prismarine-item versions expose that component directly instead of
 * returning the normalized [{ name, lvl }] format expected by prismarine-block.
 */
export function normalizeItemEnchantments(bot: Bot, item: any): NormalizedEnchant[] {
  if (!item) return [];

  const raw = item.enchantments ?? item.enchants;
  if (!raw) return [];

  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.enchantments)
      ? raw.enchantments
      : raw.levels && typeof raw.levels === "object"
        ? Object.entries(raw.levels).map(([id, value]) => ({ id, level: value }))
        : typeof raw === "object"
          ? Object.entries(raw).map(([id, value]) => ({ id, level: value }))
          : [];

  const result: NormalizedEnchant[] = [];

  for (const entry of source as any[]) {
    const id = entry?.name ?? entry?.id;
    const name = enchantName(bot, id);
    const lvl = enchantLevel(entry?.lvl ?? entry?.level ?? entry?.value ?? entry);
    if (!name || lvl <= 0) continue;
    result.push({ name, lvl });
  }

  return result;
}

function hasEnchantment(bot: Bot, item: any, wanted: string): number {
  const wantedName = wanted.toLowerCase();
  return normalizeItemEnchantments(bot, item).find((enchant) =>
    enchant.name.toLowerCase().replace(/^minecraft:/, "") === wantedName
  )?.lvl ?? 0;
}

function isInWater(bot: Bot): boolean {
  const entity: any = (bot as any).entity;

  try {
    if (typeof entity?.isInWater === "function") return !!entity.isInWater();
    if (typeof entity?.isInWater === "boolean") return entity.isInWater;
  } catch {}

  const pos = entity?.position;
  if (!pos || typeof (bot as any).blockAt !== "function") return false;

  try {
    const feet = bot.blockAt(pos);
    const head = bot.blockAt(pos.offset(0, 1, 0));
    return [feet?.name, head?.name].some((name) =>
      name === "water" || name === "bubble_column"
    );
  } catch {
    return false;
  }
}

function hasAquaAffinity(bot: Bot): boolean {
  const slot = bot.getEquipmentDestSlot?.("head");
  const helmet = slot == null ? null : bot.inventory?.slots?.[slot];
  return hasEnchantment(bot, helmet, "aqua_affinity") > 0;
}

/**
 * Installs a safe bot.digTime implementation for 1.20.5+ component data.
 * Efficiency is passed in normalized form to prismarine-block.
 * Aqua Affinity removes the underwater mining penalty when worn on the head.
 */
export function installDigTimeFix(bot: Bot): void {
  const original = typeof (bot as any).digTime === "function"
    ? (bot as any).digTime.bind(bot)
    : null;

  const fixed = (block: any): number => {
    const item: any = (bot as any).heldItem;
    const enchantments = normalizeItemEnchantments(bot, item);
    const underwater = isInWater(bot) && !hasAquaAffinity(bot);
    const notOnGround = (bot as any).entity?.onGround === false;
    const creative = String((bot as any).game?.gameMode ?? "").toLowerCase() === "creative";

    try {
      if (block?.digTime && typeof block.digTime === "function") {
        return block.digTime(
          item?.type ?? null,
          creative,
          underwater,
          notOnGround,
          enchantments,
          (bot as any).entity?.effects ?? []
        );
      }
    } catch {
      // Fall through to the original implementation only if the block API
      // itself rejects the normalized call.
    }

    if (original) {
      try {
        const result = original(block);
        if (Number.isFinite(result)) return result;
      } catch {}
    }

    const hardness = Number(block?.hardness);
    if (!Number.isFinite(hardness) || hardness <= 0) return 50;
    return Math.max(50, Math.ceil(hardness * 1000));
  };

  (bot as any).digTime = fixed;
}
