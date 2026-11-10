import type { Bot } from "mineflayer";
import type { FeaturesConfig } from "./config";

let currentTargetId: number | null = null;

export function tickAimMobs(bot: Bot, config: FeaturesConfig): void {
  if (!config.aimMobs.enabled || bot.health === 0 || !bot.entity) {
    currentTargetId = null;
    return;
  }

  let closestEntity: any = null;
  let closestDist = Infinity;

  // Validate current target
  if (currentTargetId !== null) {
    const current = bot.entities[currentTargetId];
    if (!current || !current.isValid) {
      currentTargetId = null;
    }
  }

  for (const entity of Object.values(bot.entities)) {
    if (entity === bot.entity || !entity.position) continue;

    let targetRange = config.aimMobs.range;

    // Handle real players in the tablist
    if (entity.type === "player") {
      const isRealPlayer = entity.username ? bot.players[entity.username] !== undefined : false;
      if (isRealPlayer) {
        if (!config.aimMobs.aimPlayers) {
          continue;
        }
        targetRange = config.aimMobs.playerRange;
      }
    }

    // Filter out non-mob/non-combat entities
    const type = entity.type;
    if (
      type !== "mob" &&
      type !== "monster" &&
      type !== "hostile" &&
      type !== "player" &&
      type !== "passive" &&
      type !== "living" &&
      type !== "object"
    ) {
      continue;
    }

    const name = (entity.name || "").toLowerCase();
    const displayName = (entity.displayName || "").toLowerCase();
    
    // Exclude decorations, text displays, projectiles, items, vehicles, etc.
    if (
      name === "item" ||
      displayName === "item" ||
      name === "item_stack" ||
      name === "arrow" ||
      name === "experience_orb" ||
      name === "potion" ||
      name === "trident" ||
      name === "firework_rocket" ||
      name === "armor_stand" ||
      displayName === "armor stand" ||
      name === "text_display" ||
      displayName === "text display" ||
      name === "item_frame" ||
      name === "glow_item_frame" ||
      name === "block_display" ||
      name === "item_display" ||
      name === "interaction" ||
      name === "area_effect_cloud" ||
      name === "fishing_bobber" ||
      name === "evoker_fangs" ||
      name === "leash_knot" ||
      name === "painting" ||
      name === "chest_minecart" ||
      name === "minecart" ||
      name === "boat" ||
      name === "chest_boat"
    ) {
      continue;
    }

    // Use 3D distance
    let dist = bot.entity.position.distanceTo(entity.position);
    
    // If the distance is within the actual configured range, evaluate it
    if (dist <= targetRange) {
      // Hysteresis (Stickiness): artificially reduce distance for current target
      // Reduced to 0.2 so it switches to a closer mob (even behind the bot) much faster
      const effectiveDist = (entity.id === currentTargetId) ? dist - 0.2 : dist;

      if (effectiveDist < closestDist) {
        closestDist = effectiveDist;
        closestEntity = entity;
      }
    }
  }

  if (closestEntity) {
    currentTargetId = closestEntity.id;
    try {
      const height = closestEntity.height ?? 1.8;
      const dx = closestEntity.position.x - bot.entity.position.x;
      const dz = closestEntity.position.z - bot.entity.position.z;
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);

      if (horizontalDist < 0.2) {
        // Quái vật đang đứng chính xác ở cùng một tọa độ (bên trong người bot)
        // Giữ nguyên hướng nhìn hiện tại (yaw) nhưng đưa góc nhìn ngang (pitch = 0) 
        // để chắc chắn đánh trúng hitbox từ bên trong ra.
        const currentYaw = bot.entity.yaw;
        bot.look(currentYaw, 0, true).catch(() => {});
      } else {
        // Tính toán độ cao điểm nhìn
        let targetY = closestEntity.position.y + (height / 2);
        
        // Nếu quái cách 1 block hoặc gần hơn, nâng góc nhìn lên ngang tầm mắt bot
        // để tránh việc bot nhìn cắm gầm mặt xuống đất (làm server raycast bị trượt)
        if (horizontalDist <= 1.0) {
          targetY = bot.entity.position.y + bot.entity.height;
        }

        const lookTarget = closestEntity.position.offset(0, targetY - closestEntity.position.y, 0);
        bot.lookAt(lookTarget, true).catch(() => {});
      }
    } catch (err) {
      // Ignore look exceptions
    }
  } else {
    currentTargetId = null;
  }
}
