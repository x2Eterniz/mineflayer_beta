import chalk from "chalk";
import readline, { type Interface } from "readline";
import ora, { type Ora } from "ora";
import { createWriteStream, mkdirSync, existsSync, type WriteStream } from "fs";
import { join } from "path";
import { AsyncLocalStorage } from "node:async_hooks";

const RE_ANSI_LOG = /\x1b\[[0-9;]*m/g;
type LogListener = (log: string) => void;
type LogSink = (log: string, level: string) => void;
let logListener: LogListener | null = null;
const logSinks: LogSink[] = [];
let logHistory: string[] = [];

type LogInterceptor = (msg: string) => void;
let activeInterceptor: LogInterceptor | null = null;

const enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  CHAT = "CHAT",
  SYSTEM = "SYSTEM",
  PACKET = "PACKET",
}

let rl: Interface | null = null;
let currentSpinner: Ora | null = null;
let disableSpinner = false;
let chatLogEnabled = false;
let chatLogDir = "logs";
let currentUsername = "bot";
let activeCompleter: ((line: string) => [string[], string]) | null = null;
let logWriteStream: WriteStream | null = null;
let currentLogPath: string | null = null;

// Throttling redraws to prevent console freezing during high-traffic
let isRedrawScheduled = false;
let accountLabelsEnabled = false;
let selectedAccount: string | null = null;
const accountContext = new AsyncLocalStorage<string>();
const boundEmitters = new WeakSet<object>();

function isReadlineOpen(instance: Interface | null): instance is Interface {
  return !!instance && (instance as Interface & { closed?: boolean }).closed !== true;
}

function globalCompleter(line: string): [string[], string] {
  if (activeCompleter) {
    return activeCompleter(line);
  }
  return [[], line];
}

function getReadline(): Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: globalCompleter,
      terminal: process.stdin.isTTY ? true : false,
      historySize: 100,
    });

    if (process.stdin.isTTY) {
      // Workaround for Windows not firing SIGINT properly
      process.stdin.on("data", (key) => {
        if (key.toString() === "\u0003") {
          process.emit("SIGINT");
        }
      });
    }
  }
  return rl!;
}

function timestamp(): string {
  return chalk.gray(
    new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  );
}

function formatLevel(level: LogLevel): string {
  const map: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: chalk.magenta.bold("DBG"),
    [LogLevel.INFO]: chalk.cyan.bold("INF"),
    [LogLevel.WARN]: chalk.yellow.bold("WRN"),
    [LogLevel.ERROR]: chalk.red.bold("ERR"),
    [LogLevel.CHAT]: chalk.green.bold("CHT"),
    [LogLevel.SYSTEM]: chalk.blue.bold("SYS"),
    [LogLevel.PACKET]: chalk.gray.bold("PKT"),
  };
  return map[level];
}

function log(level: LogLevel, ...args: unknown[]): void {
  const account = accountContext.getStore();
  if (selectedAccount && account && account.toLowerCase() !== selectedAccount.toLowerCase()) return;
  const accountPrefix = accountLabelsEnabled && account
    ? ` ${chalk.hex("#A78BFA")(`[${account}]`)} `
    : " ";
  const prefix = `\x1b[0m${chalk.gray("|")} ${timestamp()} ${formatLevel(level)}${accountPrefix}${chalk.gray("|")}`;

  if (currentSpinner && currentSpinner.isSpinning) {
    currentSpinner.clear(); // temporarily clear spinner
  }

  if (rl) {
    process.stdout.write("\r\x1b[K"); // Clear readline
    console.log(prefix, ...args, "\x1b[0m");

    // Throttle prompt/spinner redraw to the end of the current event loop tick
    if (!isRedrawScheduled) {
      isRedrawScheduled = true;
      setImmediate(() => {
        isRedrawScheduled = false;
        if (isReadlineOpen(rl)) rl.prompt(true);
        if (currentSpinner && currentSpinner.isSpinning) {
          currentSpinner.render();
        }
      });
    }
  } else {
    console.log(prefix, ...args, "\x1b[0m");
    if (currentSpinner && currentSpinner.isSpinning) {
      currentSpinner.render(); // redraw spinner immediately if no readline
    }
  }

  // Notify listener for React UI (only serialize if someone is listening or history needed)
  if (logListener) {
    const logStr = [prefix, ...args].map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    logHistory.push(logStr);
    if (logHistory.length > 200) logHistory.splice(0, logHistory.length - 200);
    logListener(logStr);
  }

  for (const sink of logSinks) {
    try {
      const plainText = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      sink(plainText, level);
    } catch {}
  }

  if (activeInterceptor) {
    const plainText = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    activeInterceptor(plainText);
  }
}

export const logger = {
  getReadline,

  setAccountLabels(enabled: boolean) {
    accountLabelsEnabled = enabled;
  },

  setSelectedAccount(username: string | null) {
    selectedAccount = username?.trim() || null;
  },

  withAccount<T>(username: string, callback: () => T): T {
    return accountContext.run(username, callback);
  },

  bindEmitter(emitter: { emit: (event: string | symbol, ...args: any[]) => boolean }, username: string): void {
    if (!emitter || boundEmitters.has(emitter as object)) return;
    boundEmitters.add(emitter as object);
    const originalEmit = emitter.emit.bind(emitter);
    emitter.emit = ((event: string | symbol, ...args: any[]) =>
      accountContext.run(username, () => originalEmit(event, ...args))) as typeof emitter.emit;
  },


  setCompleter(completer: (line: string) => [string[], string]) {
    activeCompleter = completer;
  },

  subscribe(listener: LogListener) {
    logListener = listener;
  },

  setInterceptor(interceptor: LogInterceptor | null) {
    activeInterceptor = interceptor;
  },

  addSink(sink: LogSink) {
    logSinks.push(sink);
    return () => {
      const index = logSinks.indexOf(sink);
      if (index >= 0) logSinks.splice(index, 1);
    };
  },

  getHistory() {
    return logHistory;
  },

  setDisableSpinner(disable: boolean) {
    disableSpinner = disable;
  },

  startSpinner(text: string, color: "cyan" | "yellow" | "red" | "green" | "blue" | "magenta" | "white" | "gray" = "cyan") {
    if (rl) process.stdout.write("\r\x1b[K");
    if (currentSpinner) {
      currentSpinner.clear();
      currentSpinner.stop();
    }
    const prefix = `${chalk.gray("|")} ${timestamp()} ${formatLevel(LogLevel.INFO)} ${chalk.gray("|")}`;
    if (disableSpinner) {
      logger.info(`${text}...`);
    } else {
      currentSpinner = ora({ text: "", prefixText: `${prefix} ${text}`, color }).start();
    }
  },

  updateSpinner(text: string) {
    const prefix = `${chalk.gray("|")} ${timestamp()} ${formatLevel(LogLevel.INFO)} ${chalk.gray("|")}`;
    if (disableSpinner) {
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${prefix} ${text}`);
      } else {
        logger.info(text);
      }
    } else if (currentSpinner) {
      currentSpinner.prefixText = `${prefix} ${text}`;
      currentSpinner.render();
    }
  },

  stopSpinner(text?: string, success: boolean = true) {
    if (disableSpinner) {
      if (text) {
        if (success) logger.info(chalk.green(text));
        else logger.error(chalk.red(text));
      }
      currentSpinner = null;
      if (isReadlineOpen(rl)) rl.prompt(true);
      return;
    }
    if (currentSpinner) {
      currentSpinner.clear();
      currentSpinner.stop();
      if (text) {
        if (success) logger.info(chalk.green(text));
        else logger.error(chalk.red(text));
      }
      currentSpinner = null;
      if (isReadlineOpen(rl)) rl.prompt(true);
    }
  },

  debug: (...args: unknown[]) => log(LogLevel.DEBUG, ...args),
  info: (...args: unknown[]) => log(LogLevel.INFO, ...args),
  warn: (...args: unknown[]) => log(LogLevel.WARN, ...args),
  error: (...args: unknown[]) => log(LogLevel.ERROR, ...args),
  chat: (...args: unknown[]) => log(LogLevel.CHAT, ...args),
  system: (...args: unknown[]) => log(LogLevel.SYSTEM, ...args),
  packet: (...args: unknown[]) => log(LogLevel.PACKET, ...args),

  separator(): void {
    this.system(chalk.gray("┄".repeat(45)));
  },

  clear(): void {
    console.clear();
    if (isReadlineOpen(rl)) rl.prompt(true);
  },

  setTitle(title: string): void {
    process.stdout.write(`\x1b]0;${title}\x07`);
  },

  async ask(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
      // In non-interactive environments (e.g. Pterodactyl, Docker),
      // print the question and auto-answer "yes" to prevent hanging/crashing.
      const prefix = `${chalk.gray("|")} ${timestamp()} ${chalk.hex("#FBBF24").bold("ASK")} ${chalk.gray("|")} `;
      console.log(`${prefix}${chalk.white(question)} -> Auto-answering "yes" (non-interactive environment)`);
      return "yes";
    }

    const prefix = `${chalk.gray("|")} ${timestamp()} ${chalk.hex("#FBBF24").bold("ASK")} ${chalk.gray("|")} `;
    const fullPrompt = `${prefix}${chalk.white(question)} ${chalk.cyan("> ")}`;

    return new Promise((resolve) => {
      const currentRl = getReadline();
      currentRl.question(fullPrompt, (answer: string) => {
        resolve(answer.trim());
      });
    });
  },

  banner(): void {
    // No-op: banner removed by user preference
  },

  connectionInfo(host: string, port: number, username: string, version: string | false, auth: string): void {
    logger.info(chalk.white("Server  :"), chalk.hex("#34D399").bold(`${host}:${port}`));
    logger.info(chalk.white("User    :"), chalk.hex("#FBBF24").bold(username));
    logger.info(
      chalk.white("Version :"),
      chalk.hex("#60A5FA").bold(version === false ? "auto-detect" : version)
    );
    logger.info(chalk.white("Auth    :"), chalk.hex("#F472B6").bold(auth));
  },

  initChatLog(enabled: boolean, directory: string, username: string): void {
    chatLogEnabled = enabled;
    chatLogDir = directory;
    currentUsername = username;
    if (chatLogEnabled) {
      const absDir = join(process.cwd(), chatLogDir);
      if (!existsSync(absDir)) {
        mkdirSync(absDir, { recursive: true });
      }
      logger.info(
        chalk.hex("#A78BFA")(`Logging to ${absDir}/`)
      );
    }
  },

  writeChatLog(message: string): void {
    if (!chatLogEnabled) return;
    try {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      const filePath = join(process.cwd(), chatLogDir, `chat_${currentUsername}_${dateStr}.txt`);

      // Manage WriteStream to avoid opening/closing for every message
      if (!logWriteStream || currentLogPath !== filePath) {
        if (logWriteStream) logWriteStream.end();
        logWriteStream = createWriteStream(filePath, { flags: "a", encoding: "utf-8" });
        currentLogPath = filePath;
      }

      const clean = message.replace(RE_ANSI_LOG, "");
      logWriteStream.write(`[${timeStr}] ${clean}\n`);
    } catch {
      // Silently fail
    }
  },
};
