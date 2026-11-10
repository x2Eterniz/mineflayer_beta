import type { AppConfig } from "./config";
import { logger } from "./logger";

let enabled = false;
let webhookUrl = "";
let queue: string[] = [];
let sending = false;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function enqueue(line: string) {
  if (!enabled || !webhookUrl || !line.trim()) return;
  if (line.startsWith("[Webhook]")) return;

  queue.push(stripAnsi(line).slice(0, 1900));
  if (queue.length > 100) queue.splice(0, queue.length - 100);
  void flush();
}

async function flush() {
  if (sending || !queue.length || !enabled || !webhookUrl) return;
  sending = true;

  try {
    const lines = queue.splice(0, 10);
    const content = lines.join("\n").slice(0, 1900);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      const failed = response.status === 429 ? lines : [];
      if (failed.length) queue.unshift(...failed);
    }
  } catch {
    // Webhook failure must never affect the Minecraft bot.
  } finally {
    sending = false;
    if (queue.length) setTimeout(() => void flush(), 500);
  }
}

export function initLogWebhook(config: AppConfig) {
  webhookUrl = config.discord?.logWebhookUrl?.trim() ?? "";
  enabled = !!config.discord?.logWebhookEnabled && !!webhookUrl;

  if (!enabled) return;

  logger.addSink((message) => enqueue(message));
  logger.info("[Webhook] Log webhook enabled.");
}
