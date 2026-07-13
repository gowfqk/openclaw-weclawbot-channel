// WeClawBot Bridge gateway lifecycle — WebSocket connection to the Bridge.
//
// The plugin connects to the Bridge WS Remote Agent endpoint, authenticates
// with its token, then routes incoming `chat` messages into OpenClaw's
// inbound pipeline and outgoing replies back through the same WebSocket.

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { WECLAWBOT_CHANNEL_ID, type ResolvedWeClawBotAccount } from "./accounts.js";
import { dispatchWeClawBotInbound } from "./inbound.js";
import { setActiveWebSocket } from "./inbound.js";

// ---- constants -------------------------------------------------------------

const AUTH_TIMEOUT_MS = 15_000;
const RECONNECT_INITIAL_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const PING_INTERVAL_MS = 25_000;

// ---- internal state --------------------------------------------------------

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ---- public API ------------------------------------------------------------

/**
 * Start the WebSocket connection loop for a single Bridge account.
 *
 * This runs until `ctx.abortSignal` is aborted (Gateway shutdown).
 */
export async function startWeClawBotGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedWeClawBotAccount>,
): Promise<void> {
  const { account, abortSignal, log } = ctx;

  if (!account.enabled) {
    // Wait until shutdown when the account is disabled.
    await new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    return;
  }

  if (!account.configured || !account.token) {
    throw new Error(
      `WeClawBot account "${account.accountId}" is missing a token. ` +
        `Set channels.weclawbot.token or WECLAWBOT_TOKEN.`,
    );
  }

  if (!ctx.channelRuntime) {
    throw new Error(
      "WeClawBot requires OpenClaw channel runtime support. Update OpenClaw and retry.",
    );
  }

  let backoff = RECONNECT_INITIAL_MS;
  let stopped = false;

  abortSignal.addEventListener("abort", () => {
    stopped = true;
  }, { once: true });

  while (!stopped) {
    try {
      await connectAndServe({ ctx, log, abortSignal });
      // Normal close during shutdown — don't reconnect.
      if (stopped) break;
    } catch (error) {
      if (stopped) break;
      log?.warn?.(
        `WeClawBot: connection lost (${formatError(error)}); reconnecting in ${backoff / 1000}s`,
      );
    }

    if (stopped) break;

    // Exponential backoff with jitter.
    const jitter = backoff * 0.2 * Math.random();
    await sleep(backoff + jitter, abortSignal);
    if (stopped) break;
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }

  ctx.setStatus({
    accountId: account.accountId,
    running: false,
    connected: false,
    lastStopAt: Date.now(),
  });
}

// ---- connection loop -------------------------------------------------------

async function connectAndServe(params: {
  ctx: ChannelGatewayContext<ResolvedWeClawBotAccount>;
  log: ChannelGatewayContext["log"];
  abortSignal: AbortSignal;
}): Promise<void> {
  const { ctx, log, abortSignal } = params;
  const { account, channelRuntime } = ctx;
  if (!channelRuntime) return;

  const url = account.bridgeUrl;

  log?.info?.(`WeClawBot: connecting to ${url} as agent "${account.agentId}"`);

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const failTimer = setTimeout(
      () => reject(new Error("WebSocket connection timed out")),
      AUTH_TIMEOUT_MS,
    );

    socket.on("open", () => {
      clearTimeout(failTimer);
      // Send authentication immediately.
      socket.send(
        JSON.stringify({
          type: "auth",
          token: account.token,
          agentId: account.agentId,
          name: account.agentName,
          command: account.command,
          description: "OpenClaw Channel Plugin",
        }),
      );
    });

    socket.on("error", (err) => {
      clearTimeout(failTimer);
      reject(err);
    });

    // Wait for auth_ok or auth_fail.
    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth_ok") {
          clearTimeout(failTimer);
          resolve(socket);
        } else if (msg.type === "auth_fail") {
          clearTimeout(failTimer);
          reject(new Error(`Bridge authentication rejected: ${msg.reason ?? "unknown"}`));
        }
        // Other messages before auth_ok are ignored.
      } catch {
        // non-JSON during auth — ignore.
      }
    });
  });

  log?.info?.(`WeClawBot: authenticated as agent "${account.agentId}"`);

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    lastStartAt: Date.now(),
    lastError: null,
  });

  // Register the active WS so inbound dispatches can send replies.
  setActiveWebSocket(ws);

  // Pending chat requests keyed by Bridge request id.
  const pending = new Map<string, PendingRequest>();

  // Ping timer.
  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, PING_INTERVAL_MS);

  // Cleanup on abort.
  const onAbort = () => {
    clearInterval(pingTimer);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "Gateway shutdown");
    }
    // Reject all pending requests.
    for (const [, pr] of pending) {
      clearTimeout(pr.timer);
      pr.reject(new Error("WeClawBot plugin deactivated"));
    }
    pending.clear();
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });

  try {
    await new Promise<void>((_resolve, reject) => {
      ws.on("message", (data) => {
        void handleMessage({ data: data.toString(), ws, pending, ctx, log }).catch(
          (err) => log?.warn?.(`WeClawBot: message handler error: ${formatError(err)}`),
        );
      });

      ws.on("close", (code, reason) => {
        clearInterval(pingTimer);
        setActiveWebSocket(null);
        abortSignal.removeEventListener("abort", onAbort);
        reject(
          new Error(
            `WebSocket closed: ${code} ${reason?.toString() ?? "no reason"}`,
          ),
        );
      });

      ws.on("error", (err) => {
        clearInterval(pingTimer);
        abortSignal.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  } finally {
    clearInterval(pingTimer);
    abortSignal.removeEventListener("abort", onAbort);
  }
}

// ---- message handling ------------------------------------------------------

async function handleMessage(params: {
  data: string;
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
  ctx: ChannelGatewayContext<ResolvedWeClawBotAccount>;
  log: ChannelGatewayContext["log"];
}): Promise<void> {
  const { data, ws, pending, ctx, log } = params;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }

  if (!msg || typeof msg !== "object") return;

  const type = msg.type;

  if (type === "pong") {
    // heartbeat reply — nothing to do.
    return;
  }

  if (type === "chat") {
    const id = msg.id;
    const payload = msg.payload as Record<string, unknown> | undefined;
    const body = payload?.message as Record<string, unknown> | undefined;
    const text = body?.text;

    if (typeof id !== "string" || !id) return;
    if (typeof text !== "string" || !text.trim()) return;

    // Check if this is a reply to an outbound message.
    if (pending.has(id)) {
      const pr = pending.get(id)!;
      clearTimeout(pr.timer);
      pending.delete(id);
      pr.resolve(text);
      return;
    }

    // Inbound message from WeChat via Bridge → dispatch to OpenClaw.
    try {
      await dispatchWeClawBotInbound({
        ctx,
        requestId: id,
        text: text.trim(),
      });
    } catch (err) {
      log?.warn?.(`WeClawBot: failed to dispatch inbound message ${id}: ${formatError(err)}`);
      // Send an error back to the Bridge so the user isn't left hanging.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", id, reason: "OpenClaw processing failed" }));
      }
    }
    return;
  }

  if (type === "error") {
    log?.warn?.(`WeClawBot: Bridge error: ${msg.reason ?? "unknown"}`);
    return;
  }

  if (type === "push") {
    // Bridge agent push — unsolicited message from the Bridge.
    // Currently not handled; could be used for Bridge health events.
    log?.debug?.(`WeClawBot: push message from Bridge: ${String(msg.text ?? "").slice(0, 100)}`);
    return;
  }
}

// ---- outbound sending ------------------------------------------------------

/**
 * Send a reply text back to the Bridge for delivery to WeChat.
 *
 * Returns a `PendingRequest` that resolves when the Bridge acknowledges
 * or rejects the message.
 */
export async function sendWeClawBotReply(params: {
  ctx: ChannelGatewayContext<ResolvedWeClawBotAccount>;
  ws: WebSocket;
  requestId: string;
  text: string;
}): Promise<void> {
  const { ws, requestId, text } = params;
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WeClawBot WebSocket is not connected");
  }
  await new Promise<void>((resolve, reject) => {
    ws.send(
      JSON.stringify({ type: "chat", id: requestId, text }),
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

// ---- utilities -------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (abortSignal) {
      abortSignal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}
