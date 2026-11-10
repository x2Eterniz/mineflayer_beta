import type { Bot } from "mineflayer";
import type { ChatGamesConfig } from "../../config";

export type ToolTitleType = "MATH" | "MULTIPLY" | "WORD";

type Challenge = {
  key: string;
  type: ToolTitleType;
  answer: string;
};

type State = "IDLE" | "WAITING" | "SENT" | "COMPLETED" | "CANCELLED";

export type ToolTitleHistoryEntry = {
  time: string;
  type: ToolTitleType;
  question: string;
  answer: string;
  status: string;
};

export class ToolTitleSolver {
  private active: Challenge | null = null;
  private state: State = "IDLE";
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private receivedAt = 0n;
  private parsedAt = 0n;
  private benchmarkKey = "";
  private history: ToolTitleHistoryEntry[] = [];

  // The same ChatGame packet can reach us twice: once from the raw protocol
  // listener and again through Mineflayer's normal `message` event.
  // Suppress only an identical message arriving immediately after itself.
  // This does not change parsing rules or Regex-first handlers.
  private lastMessageText = "";
  private lastMessageAt = 0;
  private static readonly DUPLICATE_WINDOW_MS = 100;

  constructor(private readonly bot: Bot, private readonly config: ChatGamesConfig) {}

  onMessage(text: string): boolean {
    if (!this.config.enabled || !this.config.toolTitle.enabled || !text) return false;

    // Only deduplicate actual ChatGame messages. Normal chat must never be
    // swallowed just because the same text was repeated quickly.
    if (text.charCodeAt(0) === 91 && text.startsWith("[CHATGAME]")) {
      const now = Date.now();
      if (text === this.lastMessageText && now - this.lastMessageAt <= ToolTitleSolver.DUPLICATE_WINDOW_MS) {
        return true;
      }
      this.lastMessageText = text;
      this.lastMessageAt = now;
    }

    // Hot path: do not allocate/lowercase every chat message unless a challenge
    // is already active and we actually need winner detection.
    if (this.active && this.state === "WAITING") {
      const status = text.toLowerCase();
      if (this.isWinner(status)) {
        this.complete();
        return false;
      }

      const answerIndex = status.indexOf("đáp án:");
      if (answerIndex >= 0) {
        const answer = text.slice(answerIndex + 8).trim();
        if (answer === this.active.answer) this.complete();
        return false;
      }
    }

    if (text.charCodeAt(0) !== 91 || !text.startsWith("[CHATGAME]")) return false;

    // Start timing immediately before the minimal parser. Keep the hot path
    // synchronous so a 0 ms configured delay really means send now.
    const received = process.hrtime.bigint();
    const challenge = this.parse(text);
    if (!challenge || !this.isEnabled(challenge.type)) return false;

    if (this.active && this.state === "WAITING" && this.active.key === challenge.key) {
      return true;
    }

    this.cancelPending();
    this.active = challenge;
    this.state = "WAITING";
    if (this.config.toolTitle.debug) {
      console.log(`[ToolTitle][DEBUG] ${challenge.type}: ${challenge.answer}`);
    }
    this.receivedAt = received;
    this.parsedAt = process.hrtime.bigint();
    this.benchmarkKey = challenge.key;

    const delay = this.getDelay(challenge.type);
    if (delay <= 0) {
      this.send(challenge);
    } else {
      this.pendingTimer = setTimeout(() => this.send(challenge), delay);
    }

    return true;
  }

  getStatus() {
    const t = this.config.toolTitle;
    return {
      enabled: t.enabled,
      normal: t.normalEnabled,
      multiply: t.multiplyEnabled,
      word: t.wordEnabled,
      delay: [t.normalMinDelayMs, t.normalMaxDelayMs],
      multiplyDelay: [t.multiplyMinDelayMs, t.multiplyMaxDelayMs],
      wordDelay: [t.wordMinDelayMs, t.wordMaxDelayMs],
      debug: t.debug,
      benchmark: t.benchmark,
      state: this.state,
    };
  }

  getHistory(): ToolTitleHistoryEntry[] {
    return [...this.history].reverse();
  }

  reset(): void {
    this.cancelPending();
    this.active = null;
    this.state = "IDLE";
  }

  private send(challenge: Challenge): void {
    if (!this.active || this.state !== "WAITING" || this.active.key !== challenge.key) return;
    if (!this.bot.entity) return;

    this.pendingTimer = null;
    const sentAt = process.hrtime.bigint();

    try {
      const beforeChat = process.hrtime.bigint();
      // Mineflayer's bot.chat() serializes a normal answer behind a previous
      // slash command and waits for tab-complete confirmation. That can add a
      // full network round-trip (~50ms) even when the configured delay is 0.
      // ToolTitle answers are plain chat, so send through the protocol client
      // directly while preserving minecraft-protocol's signing logic.
      const client = (this.bot as any)._client;
      if (client && typeof client.chat === "function") {
        client.chat(challenge.answer);
      } else {
        this.bot.chat(challenge.answer);
      }
      const afterChat = process.hrtime.bigint();

      this.state = "SENT";
      this.history.push({
        time: new Date().toLocaleTimeString(),
        type: challenge.type,
        question: challenge.key.startsWith("WORD|") || challenge.key.startsWith("MATH|") || challenge.key.startsWith("MULTIPLY|")
          ? challenge.key.slice(challenge.key.indexOf("|") + 1)
          : challenge.key,
        answer: challenge.answer,
        status: "SENT",
      });
      if (this.history.length > 50) this.history.shift();
      if (this.config.toolTitle.debug) {
        console.log(`[ToolTitle][DEBUG] SENT ${challenge.answer}`);
      }

      if (this.config.toolTitle.benchmark && this.benchmarkKey === challenge.key) {
        const parseMs = Number(this.parsedAt - this.receivedAt) / 1e6;
        const sendMs = Number(sentAt - this.parsedAt) / 1e6;
        const totalMs = Number(sentAt - this.receivedAt) / 1e6;
        const chatMs = Number(afterChat - beforeChat) / 1e6;
        console.log(
          `[ToolTitle][BENCH] RECEIVED -> PARSED: ${parseMs.toFixed(6)} ms | ` +
          `PARSED -> SENT: ${sendMs.toFixed(6)} ms | TOTAL: ${totalMs.toFixed(6)} ms | ` +
          `bot.chat() call: ${chatMs.toFixed(6)} ms`
        );
        this.benchmarkKey = "";
      }
    } catch {
      this.state = "CANCELLED";
    }
  }

  private parse(text: string): Challenge | null {
    if (text.startsWith("[CHATGAME] Bài toán: [")) return this.parseMath(text);
    if (text.startsWith("[CHATGAME] Bài toán vui:")) return this.parseMathFun(text);
    if (text.startsWith("[CHATGAME] Nhập lại") || text.startsWith("[CHATGAME] Phản xạ nhanh")) {
      return this.parseWord(text);
    }
    return null;
  }

  /**
   * New server format, kept separate from parseMath so the legacy bracketed
   * format remains fully compatible:
   * [CHATGAME] Bài toán vui: 28 - 7 = ?
   */
  private parseMathFun(text: string): Challenge | null {
    const match = /^\[CHATGAME\]\s*Bài toán vui:\s*(-?\d+)\s*([+\-*])\s*(-?\d+)\s*=\s*\?\s*$/u.exec(text);
    if (!match) return null;

    const left = Number(match[1]);
    const operator = match[2];
    const right = Number(match[3]);
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;

    let result: number;
    if (operator === "+") result = left + right;
    else if (operator === "-") result = left - right;
    else result = left * right;
    if (!Number.isSafeInteger(result)) return null;

    const type: ToolTitleType = operator === "*" ? "MULTIPLY" : "MATH";
    const question = `${left} ${operator} ${right}=?`;
    return { key: `${type}|${question}`, type, answer: String(result) };
  }

  private parseMath(text: string): Challenge | null {
    const prefix = "[CHATGAME] Bài toán: [";
    let pos = prefix.length;
    const end = text.length;

    let left = 0;
    let negativeLeft = false;
    if (text.charCodeAt(pos) === 45) {
      negativeLeft = true;
      pos++;
    }

    const leftStart = pos;
    while (pos < end) {
      const code = text.charCodeAt(pos);
      if (code < 48 || code > 57) break;
      left = left * 10 + code - 48;
      pos++;
    }
    if (pos === leftStart) return null;
    if (negativeLeft) left = -left;

    pos = skipSpaces(text, pos);
    if (pos >= end) return null;
    const operator = text.charAt(pos++);
    if (operator !== "+" && operator !== "-" && operator !== "*") return null;

    pos = skipSpaces(text, pos);
    let right = 0;
    let negativeRight = false;
    if (text.charCodeAt(pos) === 45) {
      negativeRight = true;
      pos++;
    }

    const rightStart = pos;
    while (pos < end) {
      const code = text.charCodeAt(pos);
      if (code < 48 || code > 57) break;
      right = right * 10 + code - 48;
      pos++;
    }
    if (pos === rightStart) return null;
    if (negativeRight) right = -right;

    pos = skipSpaces(text, pos);
    if (text.charCodeAt(pos++) !== 61) return null;
    pos = skipSpaces(text, pos);
    if (text.charCodeAt(pos++) !== 63) return null;
    pos = skipSpaces(text, pos);
    if (text.charCodeAt(pos++) !== 93) return null;
    if (skipSpaces(text, pos) !== end) return null;

    let result: number;
    if (operator === "+") result = left + right;
    else if (operator === "-") result = left - right;
    else result = left * right;

    if (!Number.isSafeInteger(result)) return null;

    const type: ToolTitleType = operator === "*" ? "MULTIPLY" : "MATH";
    const question = `${left} ${operator} ${right}=?`;
    return { key: `${type}|${question}`, type, answer: String(result) };
  }

  private parseWord(text: string): Challenge | null {
    const prefix = "[CHATGAME]";
    let pos = skipSpaces(text, prefix.length);

    if (text.startsWith("Phản xạ nhanh", pos) || text.startsWith("phản xạ nhanh", pos)) {
      pos += 13;
      pos = skipSpaces(text, pos);
      if (text.charCodeAt(pos++) !== 58) return null;
      const answer = cleanWord(text, skipSpaces(text, pos), text.length);
      return answer ? { key: `WORD|${answer}`, type: "WORD", answer } : null;
    }

    const repeat = "Nhập lại";
    if (text.startsWith(repeat, pos) || text.startsWith("nhập lại", pos)) {
      pos += repeat.length;
      pos = skipSpaces(text, pos);
      if (text.charCodeAt(pos++) !== 58) return null;
      pos = skipSpaces(text, pos);
      if (text.charCodeAt(pos++) !== 91) return null;
      const close = text.indexOf("]", pos);
      if (close < 0 || skipSpaces(text, close + 1) !== text.length) return null;
      const answer = cleanWord(text, pos, close);
      return answer ? { key: `WORD|${answer}`, type: "WORD", answer } : null;
    }

    return null;
  }

  private isEnabled(type: ToolTitleType): boolean {
    if (type === "WORD") return this.config.toolTitle.wordEnabled;
    if (type === "MULTIPLY") return this.config.toolTitle.multiplyEnabled;
    return this.config.toolTitle.normalEnabled;
  }

  private getDelay(type: ToolTitleType): number {
    let min: number;
    let max: number;
    if (type === "WORD") {
      min = this.config.toolTitle.wordMinDelayMs;
      max = this.config.toolTitle.wordMaxDelayMs;
    } else if (type === "MULTIPLY") {
      min = this.config.toolTitle.multiplyMinDelayMs;
      max = this.config.toolTitle.multiplyMaxDelayMs;
    } else {
      min = this.config.toolTitle.normalMinDelayMs;
      max = this.config.toolTitle.normalMaxDelayMs;
    }

    if (max <= min) return Math.max(0, min);
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private cancelPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private complete(): void {
    this.cancelPending();
    this.state = "COMPLETED";
  }

  private isWinner(text: string): boolean {
    return text.includes("người đúng:") ||
      text.includes("winner:") ||
      text.includes("người thắng:") ||
      text.includes("đã trả lời đúng");
  }
}

function skipSpaces(text: string, pos: number): number {
  while (pos < text.length) {
    const code = text.charCodeAt(pos);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 160) break;
    pos++;
  }
  return pos;
}

function cleanWord(text: string, start: number, end: number): string {
  let left = start;
  let right = end;
  while (left < right && isSpace(text.charCodeAt(left))) left++;
  while (right > left && isSpace(text.charCodeAt(right - 1))) right--;
  return text.slice(left, right);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 160;
}
