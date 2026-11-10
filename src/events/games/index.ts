import type { Bot } from "mineflayer";
import type { AppConfig } from "../../config";
import { extractChatText } from "../../utils/helpers";
import { ToolTitleSolver } from "./tooltitleSolver";

let activeToolTitle: ToolTitleSolver | null = null;

// ToolTitle challenges use a very small chat shape. Keep this path cheaper
// than the general-purpose chat extractor, which also handles NBT, item
// components, translations, and deeply nested messages. Fall back to the
// full extractor for protocol/server variants that need that functionality.
function extractToolTitleText(input: any): string {
  if (typeof input === "string") return input;
  if (input == null) return "";

  const raw = input?.json ?? input?.value ?? input;
  if (typeof raw === "string") return raw;

  if (Array.isArray(raw)) {
    let result = "";
    for (const part of raw) result += extractToolTitleText(part);
    return result;
  }

  if (typeof raw === "object") {
    if (typeof raw.text === "string") {
      let result = raw.text;
      if (Array.isArray(raw.extra)) {
        for (const part of raw.extra) result += extractToolTitleText(part);
      }
      return result;
    }

    // Some protocol versions wrap the actual component in `value`/`json`.
    if (raw.value !== undefined || raw.json !== undefined) {
      const nested = extractToolTitleText(raw.value ?? raw.json);
      if (nested) return nested;
    }
  }

  return extractChatText(input);
}

export function getToolTitleSolver(): ToolTitleSolver | null {
  return activeToolTitle;
}

/**
 * ToolTitle-only ChatGame handler.
 *
 * The old /games solver (emoji quiz, Q&A, dictionary, learning, etc.) has
 * been removed. ToolTitle receives the raw protocol packet first so its
 * Regex/parser path can run without waiting for Mineflayer's normal chat
 * rendering/event pipeline.
 */
export function registerGameEvents(bot: Bot, config: AppConfig): void {
  const toolTitle = new ToolTitleSolver(bot, config.chatGames);
  activeToolTitle = toolTitle;

  const rawClient = (bot as any)._client;
  if (rawClient) {
    const fastPacket = (packet: any) => {
      const raw = packet?.content ?? packet?.message ?? packet?.unsigned_content;
      const text = extractToolTitleText(raw);
      if (!text || !text.startsWith("[CHATGAME]")) return;
      toolTitle.onMessage(text);
    };

    if (typeof rawClient.prependListener === "function") {
      rawClient.prependListener("system_chat_message", fastPacket);
      rawClient.prependListener("player_chat", fastPacket);
    } else {
      rawClient.on("system_chat_message", fastPacket);
      rawClient.on("player_chat", fastPacket);
    }
  }

  // Fallback for servers/protocol variants where the raw packet is not
  // available in the expected shape. ToolTitle's duplicate guard prevents a
  // packet already handled by the raw listener from being solved twice.
  (bot as any).on("message", (jsonMsg: any) => {
    const text = extractChatText(jsonMsg);
    if (!text || !text.startsWith("[CHATGAME]")) return;
    toolTitle.onMessage(text);
  });

  (bot as any).on("end", () => {
    toolTitle.reset();
    if (activeToolTitle === toolTitle) activeToolTitle = null;
  });
}
