import type { Bot } from "mineflayer";
import chalk from "chalk";
import { logger } from "../logger";
import { sendToDiscord } from "../discord";
import type { AppConfig } from "../config";
import { sharedState } from "./connection";
import { cleanIcons, extractChatText, stripAnsiCodes, stripColorCodes } from "../utils/helpers";
import { inspect } from "util";

function pickRenderedChat(jsonMsg: any): { plain: string; rendered: string } {
  const extractedPlain = extractChatText(jsonMsg);

  let ansi = "";
  try {
    ansi = cleanIcons(String(jsonMsg?.toAnsi?.() ?? ""))
      .replace(/\r/g, "")
      .replace(/[\u2600-\u26FF]/g, "$& ");
  } catch { }

  const ansiVisible = stripColorCodes(stripAnsiCodes(ansi)).replace(/\s+/g, " ").trim();

  if (!ansi.trim()) {
    return { plain: extractedPlain, rendered: extractedPlain };
  }

  // Some servers with tags/ranks produce ANSI output that keeps only prefixes/names.
  // If the flattened plain text is meaningfully longer, prefer the plain render.
  if (extractedPlain && ansiVisible && extractedPlain.length > ansiVisible.length + 3) {
    return { plain: extractedPlain, rendered: extractedPlain };
  }

  if (!ansiVisible && extractedPlain) {
    return { plain: extractedPlain, rendered: extractedPlain };
  }

  return {
    plain: extractedPlain || ansiVisible,
    rendered: ansi,
  };
}

export function registerChatEvents(bot: Bot, config: AppConfig, onReconnect?: () => void) {
  // Actionbar visibility belongs to this bot instance. Do not use the
  // process-wide shared flag when multiple bot clients are active.
  // Actionbar is hidden by default for every new connection. It can still be
  // enabled explicitly with /actionbar on.
  (bot as any).hideActionBar = true;

  const isActionBarHidden = () => Boolean((bot as any).hideActionBar);
  const isActionBarPosition = (position: any): boolean =>
    position === "game_info" ||
    position === "actionbar" ||
    position === 2 ||
    position?.positionId === 2 ||
    position?.position === 2;

  // ActionBar can arrive through both Mineflayer and the raw protocol event.
  // Keep one tiny last-value guard so the terminal does not render duplicates.
  let lastActionBarText = "";
  let lastActionBarAt = 0;
  let lastRenderedChatText = "";
  let lastRenderedChatAt = 0;
  let lastChatOutputText = "";
  let lastChatOutputAt = 0;
  const coopJoinCooldown = new Map<string, number>();
  let lastRejoinRequestAt = 0;

  const handleRejoinRequest = (plain: string, position: any) => {
    if (!onReconnect || !config.reconnect.enabled) return;
    if (position === "game_info" || position === "actionbar" || position === 2) return;
    const normalized = stripColorCodes(stripAnsiCodes(plain))
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized.includes("hay tham gia lai")) return;

    const now = Date.now();
    if (now - lastRejoinRequestAt < 15000) return;
    lastRejoinRequestAt = now;
    logger.warn(chalk.yellow("[Reconnect]"), "Server yêu cầu tham gia lại; khởi động lại kết nối...");
    setTimeout(() => {
      try { onReconnect(); } catch (err) {
        logger.error(chalk.red("[Reconnect]"), String((err as Error)?.message ?? err));
      }
    }, 250);
  };

  const isDuplicateChatOutput = (value: string): boolean => {
    const normalized = stripColorCodes(stripAnsiCodes(value)).replace(/\s+/g, " ").trim();
    if (!normalized) return false;
    const now = Date.now();
    const duplicate = normalized === lastChatOutputText && now - lastChatOutputAt < 500;
    lastChatOutputText = normalized;
    lastChatOutputAt = now;
    return duplicate;
  };

  // Some servers/proxies emit a structured player-chat packet followed by a
  // messagestr "system" fragment containing only the sender/rank prefix. The
  // old exact-match guard missed that because the fragment is shorter.
  const compactChatKey = (value: string): string =>
    stripColorCodes(stripAnsiCodes(value)).replace(/\s+/g, "").trim().toLowerCase();

  const isRecentChatFragment = (value: string): boolean => {
    const current = compactChatKey(value);
    const previous = compactChatKey(lastRenderedChatText);
    if (!current || !previous) return false;
    const age = Date.now() - lastRenderedChatAt;
    return age < 750 && (current === previous || current.startsWith(previous) || previous.startsWith(current));
  };

  const emitActionBar = (text: string) => {
    const now = Date.now();
    const normalized = stripColorCodes(stripAnsiCodes(text)).replace(/\s+/g, " ").trim();
    if (!normalized) return false;
    if (normalized === lastActionBarText && now - lastActionBarAt < 500) return false;
    lastActionBarText = normalized;
    lastActionBarAt = now;
    (bot as any).currentActionBar = text;
    if (!isActionBarHidden()) logger.system(text);
    return true;
  };

  const autoCoopOnJoin = (plain: string, position: any) => {
    if (position === "game_info" || !config.coop?.enabled) return;
    if (!config.coop.owner) return;

    const match = plain.match(/\b([A-Za-z0-9_]{1,16})\s+(?:joined the game|đã tham gia)\b/i);
    const joinedName = match?.[1];
    if (!joinedName) return;

    // Only the configured main account watches for secondary accounts
    // reconnecting and sends `/is coop <secondary>`.
    if (bot.username.toLowerCase() !== config.coop.owner.toLowerCase()) return;
    const coopTarget = config.coop.members.find((name) => name.toLowerCase() === joinedName.toLowerCase());

    if (!coopTarget || coopTarget.toLowerCase() === bot.username.toLowerCase()) return;

    const now = Date.now();
    const last = coopJoinCooldown.get(coopTarget.toLowerCase()) ?? 0;
    if (now - last < 10000) return;
    coopJoinCooldown.set(coopTarget.toLowerCase(), now);

    // Let the join message finish rendering before sending the server command.
    setTimeout(() => {
      try {
        bot.chat(`/is coop ${coopTarget}`);
        logger.info(chalk.hex("#60A5FA")(`[Coop] ${coopTarget} joined -> /is coop ${coopTarget}`));
      } catch (err) {
        logger.warn(chalk.yellow(`[Coop] Failed for ${coopTarget}: ${(err as Error)?.message ?? err}`));
      }
    }, 0);
  };

  bot.on("message", (jsonMsg: any, position: any) => {
    let targetMsg = jsonMsg;
    let isUnsignedUsed = false;

    if (jsonMsg?.unsigned) {
      targetMsg = jsonMsg.unsigned;
      isUnsignedUsed = true;
    }

    // Actionbar packets can arrive at a high rate. They do not need the
    // expensive toAnsi()/rendered-chat path; extract only their plain text.
    if (isActionBarPosition(position)) {
      const actionText = cleanIcons(extractChatText(targetMsg));
      if (actionText) emitActionBar(actionText);
      return;
    }

    let { plain, rendered } = pickRenderedChat(targetMsg);

    // Try to extract sender from jsonMsg if available, since parameter doesn't exist
    if (position === "chat" && !isUnsignedUsed) {
      const senderName = typeof jsonMsg?.with?.[0]?.text === 'string' ? jsonMsg.with[0].text : "Player";

      const cleanPlain = stripColorCodes(stripAnsiCodes(plain));
      const cleanSender = stripColorCodes(stripAnsiCodes(senderName));

      if (cleanSender && cleanSender !== "Player" && !cleanPlain.startsWith(cleanSender) && !cleanPlain.startsWith(`<${cleanSender}>`) && !cleanPlain.startsWith(`[${cleanSender}]`)) {
        plain = `<${senderName}> ${plain}`;
        rendered = `<${senderName}> ${rendered}`;
      }
    }

    if (sharedState.debugChat) {
      logger.info(
        chalk.hex("#A78BFA")("[Chat Debug]"),
        chalk.gray(`Pos: ${position} | Plain: "${plain}" | Rendered: "${rendered}" | Raw: ${inspect(jsonMsg, { depth: 2, colors: false })}`)
      );
    }

    logger.writeChatLog(plain);
    (bot as any).lastChatLine = plain;
    autoCoopOnJoin(plain, position);
    handleRejoinRequest(plain, position);

    if (config.filters.hideEmptyMessages && !plain.trim()) return;



    if (!sharedState.isJoinApproved) {
      if (plain.trim() && sharedState.messageBuffer.length < sharedState.maxBufferSize) {
        sharedState.messageBuffer.push(position === "game_info" ? `\x00${rendered}` : rendered);
      }
      return;
    }

    if (position !== "game_info") {
      sendToDiscord(plain);
    }


    const lines = rendered.includes("\n") ? rendered.split("\n") : [rendered];

    // Remember the structured message so the messagestr fallback below can
    // avoid rendering the same packet twice.
    lastRenderedChatText = plain;
    lastRenderedChatAt = Date.now();

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r/g, "");
      if (!line.trim() && config.filters.hideEmptyMessages) continue;

    if (isActionBarPosition(position)) {
        emitActionBar(line);
      } else {
        if (isDuplicateChatOutput(line)) continue;
        logger.chat(line);
      }
    }
  });

  // Mineflayer emits a plain-text companion event as well. Keep this as a
  // fallback for proxies that preserve `messagestr` but skip the structured
  // `message` event during a server transfer. The short duplicate guard keeps
  // normal packets from being rendered twice.
  bot.on("messagestr", (text: string, position: any) => {
    const clean = cleanIcons(String(text ?? ""));
    if (!clean.trim()) return;

    if (isActionBarPosition(position)) {
      emitActionBar(clean);
      return;
    }

    if (!sharedState.isJoinApproved) return;

    const normalized = stripColorCodes(stripAnsiCodes(clean)).replace(/\s+/g, " ").trim();
    const now = Date.now();
    if (compactChatKey(clean) === compactChatKey(lastRenderedChatText) && now - lastRenderedChatAt < 750) return;

    // Do not print a short system fragment when it is just the prefix of the
    // structured chat message rendered immediately before it.
    if (position === "system" && isRecentChatFragment(clean)) return;

    if (isDuplicateChatOutput(clean)) return;

    lastRenderedChatText = normalized;
    lastRenderedChatAt = now;
    if (position === "system") logger.system(clean);
    else logger.chat(clean);

  });

  bot.on("actionBar", (jsonMsg: any) => {
    const actionText = cleanIcons(extractChatText(jsonMsg));
    if (actionText) emitActionBar(actionText);
  });

  bot.on("title", (text: string) => {
    if (!text) return;
    const plain = stripColorCodes(stripAnsiCodes(text));
    if (!plain.trim()) return;
    if (!isActionBarHidden()) {
      logger.system(chalk.hex("#FBBF24")("[Title] ") + text);
    }
  });

  const internalClient = (bot as any)._client;
  if (internalClient) {
    // The same protocol object can be emitted through both its named packet
    // event and the generic `packet` fallback. Avoid parsing it twice.
    const handledRawPackets = new WeakSet<object>();
    const alreadyHandled = (packet: any): boolean => {
      if (!packet || typeof packet !== "object") return false;
      if (handledRawPackets.has(packet)) return true;
      handledRawPackets.add(packet);
      return false;
    };

    // Modern Minecraft protocol uses `set_action_bar_text`. Keep the old
    // `action_bar` name as a compatibility fallback for older protocol builds.
    const handleRawActionBar = (packet: any) => {
      if (alreadyHandled(packet)) return;
      const rawText = packet?.text ?? packet?.contents ?? packet?.content;
      if (rawText == null) return;

      const extracted = extractChatText(rawText);
      if (!extracted) return;

      const cleanString = cleanIcons(extracted);
      if (!cleanString) return;
      emitActionBar(cleanString);

      // Parse HP from action bar
      const lower = cleanString.toLowerCase();
      const match = lower.match(/(\d+(?:\.\d+)?)\s*[\/|]\s*(\d+(?:\.\d+)?)/) || lower.match(/(?:❤|máu|hp)\s*(\d+(?:\.\d+)?)/);
      if (match) {
        const hp = Number.parseFloat(match[1]!);
        const maxHp = match[2] ? Number.parseFloat(match[2]!) : hp;
        if (Number.isFinite(hp) && Number.isFinite(maxHp)) {
          sharedState.currentHp = hp;
          sharedState.maxHp = maxHp;
        }
      }

    };

    internalClient.on("set_action_bar_text", handleRawActionBar);
    internalClient.on("action_bar", handleRawActionBar);

    // Protocol fallback: some server/protocol combinations deliver the
    // actionbar as a system_chat_message with overlay=true (or positionId=2)
    // instead of emitting Mineflayer's actionBar event.
    const handleRawSystemChat = (packet: any) => {
      if (alreadyHandled(packet)) return;
      const isActionBar = packet?.overlay === true ||
        packet?.isActionBar === true ||
        packet?.positionId === 2 ||
        packet?.position === 2 ||
        packet?.position === "game_info" ||
        packet?.position === "actionbar";
      if (!isActionBar) return;

      const rawText = packet?.content ?? packet?.message ?? packet?.unsigned_content ??
        packet?.text ?? packet?.formattedMessage;
      if (rawText == null) return;
      const extracted = extractChatText(rawText);
      if (!extracted) return;
      const cleanString = cleanIcons(extracted);
      if (cleanString) emitActionBar(cleanString);
    };

    internalClient.on("system_chat_message", handleRawSystemChat);
    internalClient.on("system_chat", handleRawSystemChat);
    // Older protocol versions call this packet simply `chat`. In those
    // versions position=2 is the game-info/actionbar channel.
    internalClient.on("chat", handleRawSystemChat);
    internalClient.on("systemChat", handleRawSystemChat);

    // Last-resort protocol fallback. Some proxy/transfer implementations
    // emit the decoded packet through the generic `packet` event but do not
    // preserve the normal named event on every connection. The short guard
    // in emitActionBar prevents this from printing the same actionbar twice.
    internalClient.on("packet", (packet: any, metadata: any) => {
      const name = metadata?.name;
      if (name === "set_action_bar_text" || name === "action_bar") {
        handleRawActionBar(packet);
      } else if (name === "system_chat" || name === "system_chat_message" || name === "chat") {
        handleRawSystemChat(packet);
      }
    });
  }
}


