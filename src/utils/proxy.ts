import * as net from "node:net";
import * as tls from "node:tls";
import { SocksClient } from "socks";
import type { ProxyConfig, ProxyType } from "../config";

function proxyAddress(config: ProxyConfig): string {
  return `${config.host}:${config.port}`;
}

function waitForConnect(socket: net.Socket | tls.TLSSocket): Promise<void> {
  if (socket.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("secureConnect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("secureConnect", onConnect);
    socket.once("error", onError);
  });
}

function connectThroughHttpProxy(config: ProxyConfig, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = config.type === "https"
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect(config.port, config.host);
    let response = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Proxy ${proxyAddress(config)} timed out`)), 10000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("error", onError);
      socket.off("data", onData);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (response.length > 16384) finish(new Error("Proxy response headers are too large"));
        return;
      }
      const header = response.subarray(0, headerEnd).toString("latin1");
      const statusLine = header.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1] ?? 0);
      if (status !== 200) {
        finish(new Error(`Proxy CONNECT failed (${status || "invalid response"})`));
        return;
      }
      const rest = response.subarray(headerEnd + 4);
      if (rest.length > 0) socket.unshift(rest);
      finish();
    };

    socket.on("error", onError);
    socket.on("data", onData);
    void waitForConnect(socket).then(() => {
      const auth = config.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        "Proxy-Connection: Keep-Alive\r\n" + auth + "\r\n"
      );
    }).catch(onError);
  });
}

export function isProxyEnabled(config: ProxyConfig | undefined): boolean {
  return !!config?.enabled && !!config.host && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535;
}

export async function createMinecraftProxySocket(
  config: ProxyConfig,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  if (!isProxyEnabled(config)) throw new Error("Proxy is enabled but host/port is invalid");

  if (config.type === "socks4" || config.type === "socks5") {
    const result = await SocksClient.createConnection({
      proxy: {
        host: config.host,
        port: config.port,
        type: config.type === "socks4" ? 4 : 5,
        userId: config.username || undefined,
        password: config.password || undefined,
      },
      command: "connect",
      destination: { host: targetHost, port: targetPort },
    });
    return result.socket;
  }

  return connectThroughHttpProxy(config, targetHost, targetPort);
}

export function proxyType(value: string | undefined): ProxyType | null {
  const normalized = value?.toLowerCase();
  return normalized === "socks5" || normalized === "socks4" || normalized === "http" || normalized === "https"
    ? normalized
    : null;
}
