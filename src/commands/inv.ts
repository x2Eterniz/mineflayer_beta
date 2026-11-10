import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { getItemDisplayName, centerText, getItemInfo, dumpItemJson } from "../utils/helpers";
import { sharedState, hasUsableCurrentWindow } from "../events/connection";

function warnIfInventoryMayBeStale(): void {
  const msSinceSpawn = Date.now() - sharedState.lastSpawnTime;
  if (msSinceSpawn < 3000 && sharedState.lastSpawnTime > 0) {
    logger.system(chalk.yellow("Inventory may still be syncing after transfer/spawn."));
  }

  if (sharedState.inventorySyncPending) {
    logger.system(
      chalk.yellow(
        `Inventory sync pending (${sharedState.inventorySyncSource}). Data may be stale until backend packets arrive.`
      )
    );
  }
}

function getActiveWindow(bot: Bot): any | null {
  return hasUsableCurrentWindow(bot) ? (bot as any).currentWindow : null;
}

function renderInfoList(title: string, values: string[], color: (value: string) => string = chalk.gray): void {
  if (values.length === 0) return;
  logger.system("");
  logger.system(chalk.hex("#A78BFA").bold(` ${title}:`));
  for (const value of values) {
    logger.system(color(`  ${value}`));
  }
}

function compactInventoryItem(item: any): any {
  if (!item) return null;
  return {
    name: item.name,
    type: item.type,
    metadata: item.metadata,
    count: item.count,
    slot: item.slot,
    displayName: typeof item.displayName === "string" ? item.displayName : undefined,
  };
}

export async function handleInv(bot: Bot, parts: string[]) {
  const inventory = bot.inventory;
  if (!inventory) {
    logger.system(chalk.red("Inventory not loaded yet!"));
    return;
  }

  warnIfInventoryMayBeStale();

  if (sharedState.debugInventory) {
    const totalSlots = inventory.slots?.length ?? 0;
    const filledSlots = inventory.slots?.filter((s: any) => s != null).length ?? 0;
    const itemCount = inventory.items().length;
    const hotbarStart = inventory.hotbarStart ?? 36;
    const msSinceWindowItems =
      sharedState.lastWindowItemsTime > 0 ? Date.now() - sharedState.lastWindowItemsTime : null;
    const currentWindow = getActiveWindow(bot);
    logger.debug(
      chalk.hex("#C084FC")("[InvDbg]"),
      chalk.gray(
        `handleInv totalSlots=${totalSlots} filled=${filledSlots} items=${itemCount} hotbarStart=${hotbarStart} msSinceWindowItems=${msSinceWindowItems}ms pending=${sharedState.inventorySyncPending} hasWindow=${!!currentWindow}`
          .replace(
            `msSinceWindowItems=${msSinceWindowItems}ms`,
            `msSinceWindowItems=${msSinceWindowItems === null ? "n/a" : `${msSinceWindowItems}ms`}`
          )
      )
    );
  }

  let allItems = inventory.items();
  const currentFilledSlots = inventory.slots?.filter((s: any) => s != null).length ?? 0;
  
  const hasCurrentItems = allItems.length > 0;
  const hasStableSnapshot = sharedState.lastStableInventoryItems.length > 0;
  
  const shouldUseStableSnapshot =
    !hasCurrentItems &&
    currentFilledSlots <= 5 &&
    hasStableSnapshot;

  if (shouldUseStableSnapshot) {
    allItems = sharedState.lastStableInventoryItems;
  } else if (hasCurrentItems) {
    // Only update stable snapshot if the current inventory is "better" or we have nothing yet
    if (allItems.length >= sharedState.lastStableInventoryItems.length) {
      sharedState.lastStableInventoryItems = allItems.map(compactInventoryItem);
      sharedState.lastStableInventorySlots = inventory.slots.map(compactInventoryItem);
    }
  }
  const subCmd = parts[1]?.toLowerCase() ?? "";

  if (subCmd === "help") {
    logger.separator();
    logger.info(chalk.hex("#A78BFA").bold("  Inventory Commands:"));
    logger.info(chalk.white("    /inv                  "), chalk.gray("Show all items with grid"));
    logger.info(chalk.white("    /inv info <slot>      "), chalk.gray("Show lore and full item details"));
    logger.info(chalk.white("    /inv search <q>       "), chalk.gray("Search items by name"));
    logger.info(chalk.white("    /inv move <from> <to> "), chalk.gray("Move item from one slot to another"));
    logger.separator();
    return;
  }

  if (subCmd === "move") {
    const fromSlot = parseInt(parts[2] ?? "", 10);
    const toSlot = parseInt(parts[3] ?? "", 10);
    
    if (isNaN(fromSlot) || isNaN(toSlot)) {
      logger.system(chalk.red("Usage: /inv move <from_slot> <to_slot>"));
      return;
    }

    if (fromSlot < 0 || toSlot < 0 || fromSlot === toSlot) {
      logger.system(chalk.red("Source and destination slots must be different non-negative numbers."));
      return;
    }

    const activeWindow = (bot as any).currentWindow;
    const moveWindow = activeWindow ?? inventory;
    const slotCount = moveWindow?.slots?.length ?? 0;
    if (fromSlot >= slotCount || toSlot >= slotCount) {
      logger.system(chalk.red(`Slot must be between 0 and ${Math.max(0, slotCount - 1)} for the current inventory/window.`));
      return;
    }

    try {
      logger.system(chalk.cyan(`Moving item from slot ${fromSlot} to ${toSlot}...`));
      await bot.moveSlotItem(fromSlot, toSlot);
      logger.system(chalk.green(`Successfully moved item from ${fromSlot} to ${toSlot}.`));
    } catch (err) {
      logger.system(chalk.red(`Failed to move item: ${(err as Error)?.message ?? err}`));
    }
    return;
  }

  if (subCmd === "info" || subCmd === "i" || subCmd === "lore") {
    const slot = parseInt(parts[2] ?? "", 10);
    if (isNaN(slot)) {
      logger.system(chalk.red("Usage: /inv info <slot>"));
      return;
    }

    const currentWindow = getActiveWindow(bot);
    const item = currentWindow ? currentWindow.slots[slot] : inventory.slots[slot];

    if (!item) {
      logger.warn(chalk.red(`No item found in slot ${slot}${currentWindow ? " of current menu" : ""}`));
      return;
    }

    const info = getItemInfo(item);

    logger.separator();
    logger.system(centerText(chalk.hex("#60A5FA").bold(`[ Item Info - Slot ${slot} ]`)));
    logger.system("");
    logger.system(chalk.white(" Name:        ") + chalk.greenBright(info.name));
    logger.system(chalk.white(" Type:        ") + chalk.gray(info.typeName));
    logger.system(chalk.white(" Count:       ") + chalk.yellow(String(info.count ?? "?")));
    logger.system(chalk.white(" Slot:        ") + chalk.gray(String(info.slot ?? slot)));
    logger.system(chalk.white(" Item ID:     ") + chalk.gray(info.itemId != null ? String(info.itemId) : "?"));
    logger.system(chalk.white(" Metadata:    ") + chalk.gray(info.metadata != null ? String(info.metadata) : "?"));

    if (info.stackId != null) {
      logger.system(chalk.white(" Stack ID:    ") + chalk.gray(String(info.stackId)));
    }
    if (info.maxStackSize != null) {
      logger.system(chalk.white(" Stack Size:  ") + chalk.gray(String(info.maxStackSize)));
    }
    if (info.durabilityMax != null) {
      const used = info.durabilityUsed ?? 0;
      const left = Math.max(0, info.durabilityMax - used);
      logger.system(
        chalk.white(" Durability:  ") +
        chalk.gray(`${left}/${info.durabilityMax} remaining`) +
        chalk.gray.dim(` (used ${used})`)
      );
    }
    if (info.unbreakable != null) {
      logger.system(chalk.white(" Unbreakable: ") + chalk.gray(info.unbreakable ? "yes" : "no"));
    }
    if (info.customModel) {
      logger.system(chalk.white(" Model Data:  ") + chalk.gray(info.customModel));
    }
    if (info.repairCost != null) {
      logger.system(chalk.white(" Repair Cost: ") + chalk.gray(String(info.repairCost)));
    }

    // ── Plugin Info ──
    if (info.pluginSource) {
      logger.system("");
      logger.system(chalk.hex("#FBBF24").bold(` ⚙ Plugin: ${info.pluginSource}`));
      if (info.pluginId) {
        logger.system(chalk.white("   ID:   ") + chalk.hex("#60A5FA")(info.pluginId));
      }
      if (info.pluginType) {
        logger.system(chalk.white("   Type: ") + chalk.hex("#60A5FA")(info.pluginType));
      }
      if (info.tier) {
        const tierColors: Record<string, string> = {
          "S": "#FF6B6B", "A": "#FBBF24", "B": "#A78BFA",
          "C": "#60A5FA", "D": "#34D399", "E": "#9CA3AF",
        };
        const tierColor = tierColors[info.tier.toUpperCase()] ?? "#9CA3AF";
        logger.system(chalk.white("   Tier: ") + chalk.hex(tierColor).bold(info.tier));
      }
    }

    renderInfoList("Lore", info.lore);

    // Plugin-specific lore (if different from standard lore)
    if (info.pluginLore.length > 0) {
      renderInfoList("Plugin Lore", info.pluginLore, chalk.hex("#A78BFA"));
    }

    renderInfoList("Enchantments", info.enchantments);

    // Plugin enchantments (show if not already in standard list)
    if (info.pluginEnchants.length > 0) {
      const standard = new Set(info.enchantments.map(e => e.toLowerCase()));
      const extra = info.pluginEnchants.filter(e => !standard.has(e.toLowerCase()));
      if (extra.length > 0) {
        renderInfoList("Plugin Enchants", extra, chalk.hex("#34D399"));
      }
    }

    // Attribute modifiers
    if (info.attributes.length > 0) {
      renderInfoList("Attributes", info.attributes, chalk.hex("#F472B6"));
    }

    renderInfoList("Can Place On", info.canPlaceOn);
    renderInfoList("Can Break", info.canBreak);

    if (info.componentKeys.length > 0) {
      renderInfoList("Components", info.componentKeys.sort(), chalk.gray.dim);
    }

    // Custom data keys (debug-level info, always show when debug is on)
    if (sharedState.debugInventory && info.customDataKeys.length > 0) {
      renderInfoList("Custom Data Keys", info.customDataKeys, chalk.gray.dim);
    }

    if (sharedState.debugInventory) {
      logger.system("");
      logger.system(chalk.hex("#C084FC").bold(" Raw JSON:"));
      logger.system(chalk.gray(`  ${dumpItemJson(item, 2000)}`));
    }

    logger.separator();
    return;
  }

  logger.separator();
  logger.system(centerText(chalk.hex("#60A5FA").bold("[ Inventory Grid ]")));
  logger.system("");

  for (let r = 0; r < 4; r++) {
    let rowStr = "  ";
    for (let c = 0; c < 9; c++) {
      const slotIdx = 9 + (r * 9 + c);
      const slotItemSource = shouldUseStableSnapshot
        ? sharedState.lastStableInventorySlots[slotIdx]
        : inventory.slots[slotIdx];
      const item = slotItemSource;

      if (item) {
        rowStr += chalk.bgGreen.black(` ${slotIdx.toString().padStart(2, "0")} `) + " ";
      } else {
        rowStr += chalk.bgWhite.black(` ${slotIdx.toString().padStart(2, "0")} `) + " ";
      }
    }
    logger.system(rowStr);
    if (r === 2) {
      logger.separator();
      logger.system(centerText(chalk.gray("[ Hotbar Section ]")));
      logger.system("");
    }
  }

  // ── Armor Slots ──
  const armorSlots = [
    { idx: 5, label: "Helmet" },
    { idx: 6, label: "Chestplate" },
    { idx: 7, label: "Leggings" },
    { idx: 8, label: "Boots" },
  ];
  const armorItems = armorSlots
    .map(({ idx, label }) => {
      const item = shouldUseStableSnapshot
        ? sharedState.lastStableInventorySlots[idx]
        : inventory.slots[idx];
      return { idx, label, item };
    })
    .filter(({ item }) => item != null);

  if (armorItems.length > 0) {
    logger.system("");
    logger.system(centerText(chalk.hex("#F59E0B").bold("[ Armor ]")));
    logger.system("");
    for (const { idx, label, item } of armorItems) {
      const displayName = getItemDisplayName(item);
      logger.system(
        chalk.gray(` [${idx.toString().padStart(2, "0")}] `) +
        chalk.hex("#F59E0B")(label.padEnd(11)) +
        chalk.white(displayName)
      );
    }
  } else {
    logger.system("");
    logger.system(centerText(chalk.hex("#F59E0B").bold("[ Armor ]")));
    logger.system(chalk.gray("  No armor equipped."));
  }

  let displayItems = allItems;
  let filterLabel = "";
  if (subCmd === "search" || subCmd === "find") {
    const query = parts.slice(2).join(" ").toLowerCase();
    if (query) {
      displayItems = allItems.filter((item) => {
        const name = getItemDisplayName(item).toLowerCase();
        return name.includes(query) || item.name.toLowerCase().includes(query);
      });
      filterLabel = ` (${query})`;
    }
  }

  if (displayItems.length > 0) {
    logger.system("");
    logger.system(centerText(chalk.hex("#A78BFA").bold(`[ Item Details${filterLabel} ]`)));
    logger.system("");
    displayItems.forEach((item) => {
      const count = item.count > 1 ? `x${item.count} ` : "";
      const displayName = getItemDisplayName(item);
      logger.system(chalk.gray(` [${item.slot.toString().padStart(2, "0")}] `) + chalk.white(`${count}${displayName}`));
    });
  } else {
    logger.info(chalk.gray("No items found."));
  }

  const offHand = shouldUseStableSnapshot
    ? sharedState.lastStableInventorySlots[45]
    : inventory.slots[45];
  if (offHand) {
    logger.system("");
    logger.system(centerText(chalk.cyan.bold("[ Offhand ]")));
    logger.system("");
    const displayName = getItemDisplayName(offHand);
    logger.system(chalk.gray(" [45] ") + chalk.white(displayName));
  }

  logger.separator();
}
