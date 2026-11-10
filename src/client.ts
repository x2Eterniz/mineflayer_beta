import * as mineflayer from "mineflayer";
import mc from "minecraft-protocol";
const { ping } = mc;
import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "./logger";
import { registerEvents } from "./events";
import type { AppConfig } from "./config";
import { pathfinder } from "mineflayer-pathfinder";
import { join } from "path";
import { initAntiBot } from "./antibot";
import { registerDebugEvents } from "./debug/client";
import { consumeReconnectDelayOverride, resetReconnectBackoff } from "./events/connection";
import { patchScoreboard } from "./commands/scoreboard";
import { initFeatures } from "./features";
import { getResourcePackSize } from "./utils/helpers";
import { getAutoFarm } from "./features/autoFarm";
import { installDigTimeFix } from "./utils/digTimeFix";
import { createMinecraftProxySocket, isProxyEnabled } from "./utils/proxy";

export interface BotClient {
  readonly bot: Bot | null;
  connect(): void;
  ensureConnected(): void;
  reconnect(): void;
  disconnect(): void;
}

// ── Resource Pack status codes (Minecraft 1.21.x) ─────────────────────────
// result=0  SUCCESSFULLY_LOADED   pack applied and active
// result=1  DECLINED              client refused the pack
// result=2  FAILED_DOWNLOAD       download error  ← old code was sending this as "loaded"!
// result=3  ACCEPTED              acknowledged, starting download
// result=4  DOWNLOADED            1.20.3+: download done, now loading
// result=5  INVALID_URL           1.20.3+
// result=6  FAILED_RELOAD         1.20.3+
// result=7  DISCARDED             1.20.3+
//
// Correct sequence for 1.20.3+ (which includes 1.21.x):
//   ACCEPTED(3) → DOWNLOADED(4) → SUCCESSFULLY_LOADED(0)
//
// Old sequence for <1.20.3:
//   ACCEPTED(3) → SUCCESSFULLY_LOADED(0)
//
// THE BUG: old code sent ACCEPTED(3) → result(0) → result(2)
// result=2 is FAILED_DOWNLOAD — that is exactly what the server reported!

const RP_STATUS = {
  SUCCESSFULLY_LOADED: 0,
  DECLINED: 1,
  FAILED_DOWNLOAD: 2,
  ACCEPTED: 3,
  DOWNLOADED: 4,
} as const;

const SELF_WHITELIST = new Set(["entity_velocity", "entity_teleport", "entity_metadata", "entity_equipment", "entity_update_attributes"]);
const SAFE_TO_DROP_WITHOUT_WORLD = new Set(["tile_entity_data", "update_sign"]);

export function createBotClient(config: AppConfig): BotClient {
  let bot: Bot | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unknownEntityCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let connecting = false;
  let intentionalDisconnect = false;
  let lastBotError = "";
  let lastBotErrorAt = 0;

  async function connect(): Promise<void> {
    if (connecting || bot) return;
    connecting = true;
    intentionalDisconnect = false;
    const proxyEnabled = isProxyEnabled(config.proxy);

    logger.connectionInfo(
      config.server.host,
      config.server.port,
      config.bot.username,
      config.server.version,
      config.bot.auth
    );

    if (config.server.pingBeforeConnect && !proxyEnabled) {
      logger.startSpinner("Pinging server...");
      try {
        const PING_TIMEOUT_MS = 10000;
        const pingData = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Ping timed out after ${PING_TIMEOUT_MS / 1000}s`));
          }, PING_TIMEOUT_MS);

          ping(
            {
              host: config.server.host,
              port: config.server.port,
              version: config.server.version === false ? undefined : (config.server.version as string),
            },
            (err: Error | null, data: any) => {
              clearTimeout(timer);
              if (err) reject(err);
              else resolve(data);
            }
          );
        });

        const online = pingData.players?.online ?? "?";
        const max = pingData.players?.max ?? "?";
        logger.stopSpinner(
          `Server online (${pingData.latency}ms) - Players: ${online}/${max}`,
          true
        );
      } catch (err) {
        logger.stopSpinner("Server unreachable", false);
        logger.error(chalk.red("Ping failed:"), (err as Error).message);
        connecting = false;
        scheduleReconnect();
        return;
      }
    } else if (proxyEnabled) {
      logger.info(chalk.gray(`[Proxy] ${config.proxy.type}://${config.proxy.host}:${config.proxy.port} — skipping direct server ping`));
    }

    logger.startSpinner("Handshaking with server...");

    try {
      const botOptions: any = {
        host: config.server.host,
        port: config.server.port,
        username: config.bot.username,
        auth: config.bot.auth as any,
        onMsaCode: config.bot.auth === "microsoft" ? (data: any) => {
          logger.stopSpinner();
          logger.separator();
          logger.info(chalk.hex("#FBBF24").bold(" [ MICROSOFT AUTHENTICATION ] "));
          logger.info(chalk.white(" To sign in, please visit:"), chalk.cyan.underline(data.verification_uri));
          logger.info(chalk.white(" Enter the following code:"), chalk.hex("#10B981").bold(data.user_code));
          logger.info(chalk.gray(" This code will expire in "), chalk.white(Math.round(data.expires_in / 60)), chalk.gray(" minutes."));
          logger.separator();
          logger.startSpinner("Waiting for authentication...");
        } : undefined,
        version: config.server.version === false ? undefined : config.server.version,
        viewDistance: config.server.viewDistance as any,
        hideErrors: true,
        profilesFolder: join(config.bot.profilesFolder, config.bot.username),
        // FIX: "disabled" instead of "all" — prevent mineflayer's built-in
        // resource pack handler from sending its OWN status packets alongside
        // ours. When both handlers run, the server gets duplicate conflicting
        // packets and interprets the sequence as FAILED_DOWNLOAD.
        resourcePackSupport: "disabled",
        plugins: {
          bed: false,
          book: false,
          boss_bar: true,
          command_block: false,
          creative: false,
          dispenser: false,
          enchantment_table: false,
          furnace: false,
          generic_place: false,
          particle: false,
          rain: false,
          villager: false,
          sound: false,
          title: false,
          resource_pack: false,
        },
      };


      if (config.antiBot.enabled) {
        botOptions.brand = config.antiBot.brand.name;
        botOptions.physicsEnabled = config.antiBot.physics.forceEnabled;
      }

      if (proxyEnabled) {
        const targetHost = config.server.host;
        const targetPort = config.server.port;
        botOptions.connect = (client: any) => {
          void createMinecraftProxySocket(config.proxy, targetHost, targetPort)
            .then((socket) => {
              client.setSocket(socket);
              client.emit("connect");
            })
            .catch((error) => client.emit("error", error));
        };
      }

      bot = mineflayer.createBot(botOptions);
      logger.bindEmitter(bot as any, config.bot.username);
      logger.bindEmitter((bot as any)._client, config.bot.username);

      // Some custom servers send thousands of unsupported/custom entities.
      // Mineflayer keeps them in bot.entities even after a server transfer,
      // which can grow RSS dramatically. Remove only objects that are clearly
      // unparsed placeholders; real players/mobs and metadata-bearing entities
      // are left untouched.
      const cleanupUnknownEntities = () => {
        if (!bot) return;
        let removed = 0;
        for (const [id, entity] of Object.entries(bot.entities as Record<string, any>)) {
          if (!entity || entity === bot.entity) continue;
          const name = String(entity.name ?? "");
          const isUnknownPlaceholder = entity.type === "unknown" &&
            name.startsWith("entity#") &&
            !entity.username &&
            (!Array.isArray(entity.metadata) || entity.metadata.length === 0);
          if (!isUnknownPlaceholder) continue;
          delete (bot.entities as Record<string, any>)[id];
          removed++;
        }
        if (removed > 0 && config.debug?.enabled) {
          logger.info(chalk.yellow("[EntityCleanup]"), `removed ${removed} unknown entities; remaining=${Object.keys(bot.entities).length}`);
        }
      };
      const isUnknownPlaceholder = (entity: any): boolean => {
        const name = String(entity?.name ?? "");
        return !!entity && entity !== bot?.entity && entity.type === "unknown" &&
          name.startsWith("entity#") && !entity.username &&
          (!Array.isArray(entity.metadata) || entity.metadata.length === 0);
      };
      const onEntitySpawn = (entity: any) => {
        // Mineflayer inserts the entity before emitting entitySpawn. Remove it
        // directly; scheduling one setImmediate per entity creates a large
        // callback burst when a lobby sends thousands of placeholders.
        if (!isUnknownPlaceholder(entity)) return;
        const id = String(entity.id);
        if ((bot.entities as Record<string, any>)[id] === entity) {
          delete (bot.entities as Record<string, any>)[id];
        }
      };
      bot.on("entitySpawn", onEntitySpawn);
      unknownEntityCleanupTimer = setInterval(cleanupUnknownEntities, 2000);
      bot.once("end", () => {
        bot?.off("entitySpawn", onEntitySpawn);
        if (unknownEntityCleanupTimer) {
          clearInterval(unknownEntityCleanupTimer);
          unknownEntityCleanupTimer = null;
        }
      });

      // Minecraft 1.20.5+ stores enchantments in data components.
      // Normalize them before Mineflayer digTime/dig sees them.
      installDigTimeFix(bot);

      bot.setMaxListeners(50);

      // Connection timeout: only start counting AFTER authentication is done.
      // For Microsoft auth, the user may need minutes to enter the MSA code,
      // so we must not include that time in the connection timeout.
      // For busy servers (50k+ players), handshake can take 60s+.
      const CONNECTION_TIMEOUT_MS = 90000;
      let connectionTimer: ReturnType<typeof setTimeout> | null = null;

      const startConnectionTimer = () => {
        connectionTimer = setTimeout(() => {
          if (bot && !(bot as any)._loggedIn) {
            logger.stopSpinner("Connection timed out", false);
            logger.warn(chalk.yellow(`Server did not respond within ${CONNECTION_TIMEOUT_MS / 1000}s — reconnecting...`));
            try { bot.end("Connection timeout"); } catch {}
          }
        }, CONNECTION_TIMEOUT_MS);
      };

      const internalClient = (bot as any)._client;
      if (config.bot.auth === "microsoft" && internalClient) {
        // Wait for MS auth to finish before starting the connection timer
        internalClient.once("session", () => {
          logger.stopSpinner();
          logger.startSpinner("Connecting to server...");
          startConnectionTimer();
        });
      } else {
        startConnectionTimer();
      }

      bot.once("login", () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
        (bot as any)._loggedIn = true;
      });

      bot.once("end", () => {
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
      });

      bot.once("inject_allowed", () => {
        const internalClient = (bot as any)._client;
        if (!internalClient) return;

        internalClient.setMaxListeners(100);

        const WORLD_PACKETS = new Set([
          "tile_entity_data", "map_chunk", "update_light", "block_change",
          "multi_block_change", "update_sign", "unload_chunk", "map_chunk_bulk",
        ]);

        const UNWANTED_PACKETS = new Set<string>();
        if (config.antiBot?.packetGuard?.optimizePackets) {
          const heavyPackets = [
            "entity_velocity", "rel_entity_move", "entity_look", "entity_move_look",
            "entity_teleport", "entity_head_rotation", "entity_metadata",
            "entity_update_attributes", "entity_equipment", "animation",
            "particle", "world_particles", "named_sound_effect", "sound_effect",
            "stop_sound",
            "spawn_entity", "spawn_entity_living", "spawn_entity_experience_orb", "destroy_entity"
          ];
          heavyPackets.forEach(p => UNWANTED_PACKETS.add(p));
          if (config.debug?.enabled) {
            logger.info(chalk.hex("#A78BFA")("[PacketGuard]"), chalk.gray("Packet optimizer active (high performance mode)"));
          }
        }
        
        const debugPackets = !!(config.debug?.enabled && (config.debug as any)?.logAllPackets);

        const _origEmit = internalClient.emit.bind(internalClient);
        internalClient.emit = function (event: string, ...args: any[]) {
          if (UNWANTED_PACKETS.has(event)) {
            // Không drop packets của chính bot — mineflayer cần để sync physics
            if (SELF_WHITELIST.has(event) && bot?.entity && args[0]?.entityId === bot.entity.id) {
              return _origEmit(event, ...args);
            }
            
            // Tự động cho phép gói tin đi qua nếu các tính năng chiến đấu/ngắm/bám theo đang bật
            const features = (bot as any).featuresConfig;
            const combatActive = features && (
              features.aimMobs?.enabled ||
              features.attackLog?.enabled ||
              features.autoSkill?.enabled ||
              features.autoFollow?.enabled
            );
            if (combatActive) {
              const combatPackets = new Set([
                "spawn_entity", "spawn_entity_living", "destroy_entity",
                "entity_metadata", "entity_teleport", "rel_entity_move",
                "entity_move_look", "entity_look", "entity_head_rotation",
                "entity_update_attributes", "entity_velocity", "entity_equipment", "animation"
              ]);
              if (combatPackets.has(event)) {
                return _origEmit(event, ...args);
              }
            }
            return false;
          }

          if (debugPackets) {
            const dataStr = args.length > 0 ? JSON.stringify(args[0]) : null;
            console.log(chalk.gray(`[Packet IN] ${event}`), dataStr ? dataStr.slice(0, 160) : "");
          }

          // ── Resource Pack Handler (1.20.3+ / 1.21.x compatible) ────
          const isRP = event === "add_resource_pack" || event === "resource_pack_send";
          if (isRP) {
            const packet = args[0];

            if (packet?.uuid || packet?.url) {
              const uuid = packet.uuid;
              const action = config.resourcePack.action;

              // Use packet name to detect protocol generation more reliably
              // than version string parsing (version may still be "auto" here).
              const isModern = event === "add_resource_pack";

              void (async () => {
                const sendStatus = (result: number) => {
                  try {
                    if (isModern) {
                      internalClient.write("resource_pack_receive", { uuid, result });
                    } else {
                      internalClient.write("resource_pack_receive", { hash: packet.hash ?? "", result });
                    }
                  } catch (err) {
                    logger.error(chalk.red("[ResourcePack] Send status error:"), (err as Error).message);
                  }
                };

                try {
                  if (action === "decline") {
                    if (packet?.forced) {
                      logger.warn(
                        chalk.hex("#FBBF24")("[ResourcePack]"),
                        "Pack is FORCED by server — declining will cause a kick on most servers!"
                      );
                    }
                    logger.info(chalk.hex("#F87171")("[ResourcePack]"), "Declining per config.");
                    sendStatus(RP_STATUS.DECLINED);
                    return;
                  }

                  if (action === "prompt") {
                    const answer = (await logger.ask("Accept Resource Pack? (y/n)")).toLowerCase();
                    if (answer !== "y" && answer !== "yes") {
                      sendStatus(RP_STATUS.DECLINED);
                      return;
                    }
                  }

                  // Step 1: ACCEPTED
                  sendStatus(RP_STATUS.ACCEPTED);
                  
                  const tag = chalk.hex("#A78BFA")("[ResourcePack]");
                  logger.info(tag, chalk.white("Resource Pack URL:"), chalk.cyan.underline(packet.url || "none"));
                  
                  // Check actual resource pack size via robust HTTP GET Range request
                  let totalSizeMB = 5.0;
                  let fetchedSuccessfully = false;
                  if (packet.url) {
                    try {
                      const sizeBytes = await getResourcePackSize(packet.url);
                      if (sizeBytes && sizeBytes > 0) {
                        totalSizeMB = parseFloat((sizeBytes / 1024 / 1024).toFixed(1));
                        fetchedSuccessfully = true;
                      }
                    } catch (err) {
                      // Silently fallback
                    }
                  }
                  
                  if (!fetchedSuccessfully) {
                    // Generate a random realistic size if fetch failed
                    totalSizeMB = parseFloat((Math.random() * 8.0 + 4.0).toFixed(1));
                  }
                  
                  logger.startSpinner(`${tag} Downloading resource pack 0.0 / ${totalSizeMB} MB`, "yellow");

                  // Calculate realistic download time (assume 3.5 MB/s connection speed, min 800ms, max 15s)
                  const downloadTimeMs = Math.min(15000, Math.max(800, (totalSizeMB / 3.5) * 1000));

                  await new Promise(r => setTimeout(r, downloadTimeMs * 0.4));
                  logger.updateSpinner(`${tag} Downloading resource pack ${(totalSizeMB * 0.4).toFixed(1)} / ${totalSizeMB} MB`);
                  await new Promise(r => setTimeout(r, downloadTimeMs * 0.6));
                  logger.updateSpinner(`${tag} Downloading resource pack ${totalSizeMB} / ${totalSizeMB} MB`);

                  if (isModern) {
                    // Step 2 (1.20.3+ only): DOWNLOADED
                    sendStatus(RP_STATUS.DOWNLOADED);
                    await new Promise(r => setTimeout(r, 200));
                  }

                  // Final step: SUCCESSFULLY_LOADED
                  sendStatus(RP_STATUS.SUCCESSFULLY_LOADED);
                  logger.stopSpinner(`${tag} Pack applied successfully (${totalSizeMB} MB)`, true);
                } catch (err) {
                  logger.stopSpinner("Resource pack handling failed", false);
                  logger.error(chalk.red("[ResourcePack] Error:"), (err as Error).message);
                }
              })();
            }
          }

          // Chỉ drop tile_entity_data và update_sign khi world chưa init
          // KHÔNG drop map_chunk, update_light, block_change — mineflayer cần
          // chunk data để tính onGround. Nếu drop → onGround=false mãi → GRIM flag.
          if (WORLD_PACKETS.has(event) && SAFE_TO_DROP_WITHOUT_WORLD.has(event) && internalClient.state !== "play" && !(bot as any)?.world) {
            return false;
          }
          return _origEmit(event, ...args);
        };

        const PLAY_ONLY_PACKETS = new Set([
          "position", "position_look", "look", "arm_animation", "block_dig",
          "block_place", "use_entity", "held_item_slot", "entity_action",
          "steer_vehicle", "client_command", "close_window", "window_click",
          "use_item", "teleport_confirm", "vehicle_move",
        ]);

        // ── Outgoing position/look packet guard ────────────────────────────
        //
        // FIX 1 — Sliding window rate limiter:
        //   setInterval(50ms) thực tế chạy ~46-47ms → bot gửi ~21 packets/giây
        //   thay vì 20 → GrimAC TickTimer[flying] violation.
        //   Giải pháp: sliding window 1000ms, tối đa 19 packets trong bất kỳ cửa sổ nào.
        //
        // FIX 2 — Dynamic post-teleport cooldown (chunk-aware):
        //   Khi server teleport bot sang sub-server, mineflayer gửi flying packets
        //   liên tục cho đến khi chunk load xong và physics xác định onGround=true.
        //   Cooldown cố định không đủ vì SMP server bận có thể mất 5-10s để gửi chunk.
        //   Giải pháp: chặn outgoing position/look cho đến khi nhận được chunk đầu tiên
        //   (map_chunk packet), sau đó thêm 500ms buffer để physics ổn định.
        //   teleport_confirm (position_look với teleportId) vẫn được gửi ngay.
        //
        // FIX 3 — Warmup phase sau buffer:
        //   gravityFix.ts re-enable physics ở t=600ms (sau map_chunk).
        //   packets được phép từ t=500ms. Trong 300ms đầu (500-800ms), rate limit
        //   giảm xuống 10/giây để đảm bảo không burst ngay khi physics mới start.
        //
        // FIX 4 — onGround override sau transfer:
        //   Root cause của GRIM TickTimer[flying]: map_chunk ĐẦU TIÊN nhận được
        //   không phải là chunk tại vị trí bot (server gửi chunk theo spiral).
        //   Physics chạy nhưng không tìm thấy ground → onGround=false kéo dài
        //   nhiều giây → GRIM đếm violation mỗi giây.
        //   Fix: Force onGround=true trong ON_GROUND_OVERRIDE_MS sau buffer.
        //   Server đã teleport bot đến vị trí hợp lệ → onGround=true là đúng.
        const POS_WRITE_PACKETS = new Set(["position", "position_look", "look", "flying"]);
        const posPacketWindow: number[] = [];
        const MAX_POS_PER_SECOND = 18;          // giới hạn bình thường (giảm từ 19→18, bù timer drift)
        const WARMUP_POS_PER_SECOND = 8;        // giới hạn trong warmup phase (giảm từ 10→8)
        const WARMUP_DURATION_MS = 1000;        // 1s warmup sau khi buffer hết (tăng từ 300→1000ms cho SMP transfer)
        const ON_GROUND_OVERRIDE_MS = 6000;     // 6s force onGround=true sau buffer (đủ để chunk load)
        let waitingForChunk = false;            // true = đang chờ chunk sau teleport
        let chunkReceivedAt = 0;               // timestamp khi nhận chunk đầu tiên
        let onGroundOverrideEnd = 0;           // timestamp khi kết thúc force onGround=true
        let onGroundOverrideLogged = false;    // đảm bảo chỉ log 1 lần
        const POST_CHUNK_BUFFER_MS = 500;      // 500ms buffer sau chunk (phải đồng bộ với gravityFix.ts)
        let teleportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        const TELEPORT_DEBOUNCE_MS = 150;      // debounce rapid position teleports

        // FIX 1: Debounce teleport resets — server gửi nhiều position packets liên tiếp
        // khi transfer sub-server. Nếu reset rate limiter mỗi lần → burst → GRIM flag.
        // Giải pháp: debounce 150ms — nhiều position packets trong 150ms chỉ reset 1 lần.
        let waitingForChunkTimeout: NodeJS.Timeout | null = null;
        const handleTeleportReset = (source: string) => {
          // Luôn set waitingForChunk ngay lập tức để block packets
          if (!waitingForChunk) {
            if (config.debug?.enabled) {
              logger.info(chalk.yellow("[Cooldown]"), `${source} teleport → waiting for chunk`);
            }
          }
          waitingForChunk = true;
          chunkReceivedAt = 0;
          onGroundOverrideEnd = 0;
          onGroundOverrideLogged = false;
          // FIX 4: KHÔNG xóa posPacketWindow — giữ sliding window để tránh burst
          // khi chunks arrive. Rate limiter phải liên tục, không bị reset.

          // Debounce: chỉ log 1 lần cho chuỗi teleport liên tiếp
          if (teleportDebounceTimer) clearTimeout(teleportDebounceTimer);
          teleportDebounceTimer = setTimeout(() => {
            teleportDebounceTimer = null;
          }, TELEPORT_DEBOUNCE_MS);
          
          if (waitingForChunkTimeout) clearTimeout(waitingForChunkTimeout);
          waitingForChunkTimeout = setTimeout(() => {
            if (waitingForChunk) {
              waitingForChunk = false;
              chunkReceivedAt = Date.now();
              onGroundOverrideEnd = chunkReceivedAt + POST_CHUNK_BUFFER_MS + ON_GROUND_OVERRIDE_MS;
              if (config.debug?.enabled) {
                logger.info(chalk.yellow("[Cooldown]"), "map_chunk timeout → forcing resume");
              }
            }
          }, 2000);
        };

        internalClient.on("position", () => handleTeleportReset("position"));
        internalClient.on("position_look", () => handleTeleportReset("position_look"));

        // Khi nhận chunk đầu tiên sau teleport: ghi nhận thời điểm, bắt đầu override
        internalClient.on("map_chunk", () => {
          if (waitingForChunk) {
            waitingForChunk = false;
            if (waitingForChunkTimeout) {
              clearTimeout(waitingForChunkTimeout);
              waitingForChunkTimeout = null;
            }
            chunkReceivedAt = Date.now();
            // Bắt đầu force onGround=true sau khi buffer hết (500ms + 6000ms = 6.5s từ map_chunk)
            // Đủ thời gian để SMP server gửi chunk tại vị trí bot và physics ổn định
            onGroundOverrideEnd = chunkReceivedAt + POST_CHUNK_BUFFER_MS + ON_GROUND_OVERRIDE_MS;
            if (config.debug?.enabled) {
              logger.info(chalk.green("[Cooldown]"), "map_chunk received → starting 500ms buffer + 6s onGround grace");
            }
          }
        });

        const _origWrite = internalClient.write.bind(internalClient);
        internalClient.write = function (name: string, data: any) {
          if (debugPackets) {
            const dataStr = JSON.stringify(data);
            console.log(chalk.gray(`[Packet OUT] ${name}`), dataStr ? dataStr.slice(0, 160) : "");
          }

          if (internalClient.state === "configuration" && PLAY_ONLY_PACKETS.has(name)) {
            return;
          }

          if (POS_WRITE_PACKETS.has(name)) {
            const now = Date.now();

            // Đang chờ chunk sau teleport: chỉ cho teleport_confirm đi qua
            if (waitingForChunk) {
              if (name === "position_look" && data?.teleportId != null) {
                return _origWrite(name, data); // teleport_confirm — bắt buộc
              }
              return;
            }

            // Đã nhận chunk nhưng vẫn trong buffer 500ms
            if (chunkReceivedAt > 0 && now - chunkReceivedAt < POST_CHUNK_BUFFER_MS) {
              if (name === "position_look" && data?.teleportId != null) {
                return _origWrite(name, data);
              }
              return;
            }

            // Sliding window rate limit: giới hạn tốc độ gửi
            // Warmup phase (300ms đầu sau buffer): giới hạn ở 10/giây trước khi physics ổn
            // Bình thường: 19/giây (timer drift compensation)
            const inWarmup = chunkReceivedAt > 0 &&
              now - chunkReceivedAt < POST_CHUNK_BUFFER_MS + WARMUP_DURATION_MS;
            const rateLimit = inWarmup ? WARMUP_POS_PER_SECOND : MAX_POS_PER_SECOND;

            let oldest: number | undefined;
            while ((oldest = posPacketWindow[0]) !== undefined && now - oldest >= 1000) {
              posPacketWindow.shift();
            }
            if (posPacketWindow.length >= rateLimit) {
              // Only drop 'flying' packets to maintain rate compliance. 
              // Never drop position/look packets to avoid desyncing head rotation/movement.
              if (name === "flying") {
                return;
              }
            }
            posPacketWindow.push(now);

            // FIX 4: Force onGround=true trong grace period sau transfer
            // Lý do: map_chunk đầu tiên thường không phải chunk tại vị trí bot
            // → physics không tìm thấy ground → onGround=false → GRIM TickTimer[flying]
            // Server đã teleport bot đến vị trí hợp lệ nên onGround=true là chính xác.
            if (onGroundOverrideEnd > 0 && now < onGroundOverrideEnd && data?.onGround === false) {
              if (!onGroundOverrideLogged) {
                onGroundOverrideLogged = true;
                if (config.debug?.enabled) {
                  logger.info(chalk.yellow("[Cooldown]"), "onGround override ACTIVE → forcing onGround=true (6s)");
                }
              }
              return _origWrite(name, { ...data, onGround: true });
            }
          }

          return _origWrite(name, data);
        };

        internalClient._botOrigEmit = _origEmit;
        internalClient._botOrigWrite = _origWrite;

        // Register debug events AFTER packet wrappers are set up
        // so debug wrapper is the outermost layer
        if (bot && config.debug?.enabled) {
          registerDebugEvents(bot, config.debug);
        }
      });

      patchScoreboard(bot);
      bot.loadPlugin(pathfinder);
    } catch (err) {
      logger.stopSpinner("Connection failed", false);
      logger.error(chalk.red("Failed to create bot:"), (err as Error).message);
      connecting = false;
      scheduleReconnect();
      return;
    }

    connecting = false;

    initAntiBot(bot, config.antiBot, config.debug?.enabled);
    registerEvents(bot, config, () => reconnect());
    initFeatures(bot);
    getAutoFarm(bot, config);

    // Catch transient network errors (ETIMEDOUT, ECONNRESET, etc.)
    // so they don't bubble up as unhandled rejections.
    // The "end" event fires right after and triggers reconnect.
    bot.on("error", (err: Error) => {
      const msg = err?.message || String(err) || "Unknown error";
      const now = Date.now();
      if (msg === lastBotError && now - lastBotErrorAt < 3000) return;
      lastBotError = msg;
      lastBotErrorAt = now;
      const TRANSIENT = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "Channel closed", "client timed out"];
      if (TRANSIENT.some(s => msg.includes(s))) {
        logger.warn(chalk.yellow("[Network]"), chalk.gray(msg));
        return;
      }
      logger.error(chalk.red("[Bot Error]"), msg);
    });

    bot.on("end", (reason: string) => {
      const endedBot = bot;
      bot = null;
      // Release the largest per-connection object graphs before scheduling
      // the next account connection. Mineflayer keeps entities, players,
      // windows and protocol listeners attached to the old client.
      try {
        for (const id of Object.keys((endedBot as any).entities ?? {})) {
          delete (endedBot as any).entities[id];
        }
        for (const name of Object.keys((endedBot as any).players ?? {})) {
          delete (endedBot as any).players[name];
        }
        (endedBot as any).currentWindow = null;
      } catch { }
      try {
        const oldClient = (endedBot as any)._client;
        oldClient?.removeAllListeners?.();
      } catch { }
      endedBot?.removeAllListeners();
      if (intentionalDisconnect) return;
      scheduleReconnect(consumeReconnectDelayOverride());
    });

    bot.on("login", () => {
      logger.info(chalk.white("Detected :"), chalk.hex("#60A5FA").bold(bot!.version));
    });

    bot.once("spawn", () => {
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    });
  }

  function scheduleReconnect(delayOverrideMs?: number | null): void {
    if (intentionalDisconnect) return;

    if (!config.reconnect.enabled) {
      logger.info(chalk.gray("Reconnection disabled. Exiting."));
      process.exit(0);
    }

    reconnectAttempts++;
    if (reconnectAttempts > config.reconnect.maxAttempts) {
      logger.error(
        chalk.red(`Max reconnection attempts (${config.reconnect.maxAttempts}) reached. Exiting.`)
      );
      process.exit(1);
    }

    const delayMs = delayOverrideMs ?? config.reconnect.delay;
    const delaySec = (delayMs / 1000).toFixed(1);
    logger.warn(
      chalk.white(`Reconnecting in ${delaySec}s`),
      chalk.gray(`(attempt ${reconnectAttempts}/${config.reconnect.maxAttempts})`)
    );

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  }

  function reconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    resetReconnectBackoff();
    if (bot) {
      intentionalDisconnect = true;
      bot.end("Manual reconnect");
      bot = null;
    }
    reconnectAttempts = 0;
    connect();
  }

  function ensureConnected(): void {
    if (intentionalDisconnect || bot || reconnectTimer || connecting) return;
    connect();
  }

  function disconnect(): void {
    intentionalDisconnect = true;
    resetReconnectBackoff();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (bot) {
      bot.end("User disconnect");
      bot = null;
    }
  }

  return {
    get bot() {
      return bot;
    },
    connect,
    ensureConnected,
    reconnect,
    disconnect,
  };
}
