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

  const ws = await authenticateWebSocket({ account, url, abortSignal });

  log?.info?.(`WeClawBot: authenticated as agent "${account.agentId}"`);

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    lastStartAt: Date.now(),
    lastError: null,
  });

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

type AuthenticatedAccount = Pick<
  ResolvedWeClawBotAccount,
  "token" | "agentId" | "agentName" | "command"
>;

/**
 * Establish and authenticate one socket. The timeout covers both the TCP/WS
 * handshake and Bridge's auth response. Every unsuccessful branch destroys the
 * candidate socket so a later retry cannot leave a duplicate connection alive.
 */
export async function authenticateWebSocket(params: {
  account: AuthenticatedAccount;
  url: string;
  abortSignal?: AbortSignal;
  createSocket?: (url: string) => WebSocket;
  /** Injectable for deterministic transport tests. */
  timeoutMs?: number;
}): Promise<WebSocket> {
  const {
    account,
    url,
    abortSignal,
    createSocket = (target) => new WebSocket(target),
    timeoutMs = AUTH_TIMEOUT_MS,
  } = params;

  return new Promise<WebSocket>((resolve, reject) => {
    const socket = createSocket(url);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const closeFailedSocket = () => {
      if (socket.readyState !== WebSocket.CLOSED) {
        try {
          socket.terminate();
        } catch {
          // A partially-created socket may not be terminable. It will be GC'd.
        }
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeFailedSocket();
      reject(error);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };

    const onOpen = () => {
      try {
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
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onMessage = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === "auth_ok") {
          succeed();
        } else if (msg.type === "auth_fail") {
          fail(new Error(`Bridge authentication rejected: ${String(msg.reason ?? "unknown")}`));
        }
      } catch {
        // Ignore malformed/non-auth frames until the authentication timeout.
      }
    };

    const onError = (error: Error) => fail(error);
    const onClose = (code: number, reason: Buffer) =>
      fail(new Error(`WebSocket closed before authentication: ${code} ${reason.toString() || "no reason"}`));
    const onAbort = () => fail(new Error("WeClawBot gateway shutdown during authentication"));
    const timer = setTimeout(() => fail(new Error("WebSocket authentication timed out")), timeoutMs);

    socket.once("open", onOpen);
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
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
    const hasMedia = body?.media != null;

    if (typeof id !== "string" || !id) return;
    if (typeof text !== "string" || !text.trim()) {
      // The Bridge protocol can carry media, but this direct channel has no
      // media download/attachment mapping yet. Reply explicitly instead of
      // silently dropping an image, file, or voice-only message.
      if (hasMedia && ws.readyState === WebSocket.OPEN) {
        await sendWeClawBotReply({
          ctx,
          ws,
          requestId: id,
          text: "当前 WeClawBot OpenClaw 通道仅支持文本消息，暂无法处理图片、文件或语音。",
        });
      }
      return;
    }

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
        ws,
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
  /** Non-final replies keep the Bridge request open for the final answer. */
  final?: boolean;
}): Promise<void> {
  const { ws, requestId, text, final = true } = params;
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("WeClawBot WebSocket is not connected");
  }
  await new Promise<void>((resolve, reject) => {
    ws.send(
      JSON.stringify({ type: "chat", id: requestId, text, final }),
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
