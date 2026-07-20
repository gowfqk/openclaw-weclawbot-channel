// WeClawBot Bridge inbound dispatch — routes Bridge chat messages into
// OpenClaw's channel runtime pipeline and delivers replies back.

import { randomUUID } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { WECLAWBOT_CHANNEL_ID, type ResolvedWeClawBotAccount } from "./accounts.js";
import { sendWeClawBotReply } from "./gateway.js";

// ---- types -----------------------------------------------------------------

type WeClawBotChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

type DispatchParams = {
  ctx: ChannelGatewayContext<ResolvedWeClawBotAccount>;
  requestId: string;
  text: string;
  /** Socket owned by this account's gateway connection. */
  ws: import("ws").WebSocket;
};

// ---- public API ------------------------------------------------------------

/**
 * Dispatch an inbound WeChat message (delivered by the Bridge) into OpenClaw's
 * agent pipeline. The reply is sent back through the same WebSocket connection.
 */
export async function dispatchWeClawBotInbound(params: DispatchParams): Promise<void> {
  const { ctx, requestId, text, ws } = params;
  const channelRuntime = ctx.channelRuntime as WeClawBotChannelRuntime | undefined;
  const { account } = ctx;

  if (!channelRuntime) {
    ctx.log?.warn?.("WeClawBot: channel runtime not available, skipping inbound message");
    return;
  }

  // Resolve the agent route for this channel account.
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: WECLAWBOT_CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: "default",
    },
  });

  const timestamp = Date.now();
  const messageId = randomUUID();

  // The gateway supplies the socket that received this request. Keeping it in
  // the dispatch scope prevents another configured account from stealing the
  // correlated Bridge reply while this turn is running.

  // The runtime dispatcher may call delivery once with the final visible
  // answer. Keep only the newest completed block and emit it once after the
  // run, so a normal OpenClaw reply does not appear twice in WeChat.
  let finalReplyText: string | null = null;

  await channelRuntime.inbound.run({
    channel: WECLAWBOT_CHANNEL_ID,
    accountId: account.accountId,
    raw: {
      kind: "message",
      requestId,
      text,
    },
    adapter: {
      ingest: () => ({
        id: messageId,
        timestamp,
        rawText: text,
        textForAgent: text,
        textForCommands: text,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = channelRuntime.inbound.buildContext({
          channel: WECLAWBOT_CHANNEL_ID,
          accountId: account.accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: "weclawbot:default",
          sender: {
            id: "default",
            name: "WeChat User",
          },
          conversation: {
            kind: "direct",
            id: "default",
            label: "WeClawBot WeChat",
          },
          route: {
            agentId: route.agentId,
            accountId: account.accountId,
            routeSessionKey: route.sessionKey,
            dispatchSessionKey: route.sessionKey,
          },
          reply: {
            to: `weclawbot:default`,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
        });

        const storePath = channelRuntime.session.resolveStorePath(
          ctx.cfg.session?.store,
          { agentId: route.agentId },
        );

        return {
          cfg: ctx.cfg,
          channel: WECLAWBOT_CHANNEL_ID,
          accountId: account.accountId,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: channelRuntime.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            deliver: async (deliveryInput) => {
              const replyText = extractReplyText(deliveryInput);
              if (replyText) {
                finalReplyText = replyText;
              }
              // Reply after inbound.run() completes. Sending here as well
              // produces a duplicate: this callback often receives the same
              // completed answer that is retained in finalReplyText.
              return { visibleReplySent: false };
            },
          },
          record: {
            onRecordError: (error) =>
              ctx.log?.warn?.(
                `WeClawBot: session metadata update failed: ${String(error)}`,
              ),
          },
        };
      },
    },
  });

  if (!finalReplyText) return;
  try {
    await sendWeClawBotReply({ ctx, ws, requestId, text: finalReplyText });
  } catch (err) {
    ctx.log?.error?.(`WeClawBot: failed to send final reply for ${requestId}: ${String(err)}`);
  }
}

// ---- reply extraction ------------------------------------------------------

function extractReplyText(deliveryInput: unknown): string | null {
  // The delivery input from OpenClaw's reply pipeline varies by version.
  // Try common shapes.
  if (!deliveryInput || typeof deliveryInput !== "object") return null;

  const input = deliveryInput as Record<string, unknown>;

  // Shape: { payload: { text?: string, blocks?: [...] } }
  const payload = input.payload as Record<string, unknown> | undefined;
  if (payload) {
    if (typeof payload.text === "string" && payload.text.trim()) {
      return payload.text;
    }
    // If there are blocks, concatenate text blocks.
    const blocks = payload.blocks as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(blocks)) {
      const parts = blocks
        .filter((b) => typeof b.text === "string")
        .map((b) => b.text as string)
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
  }

  // Shape: { text?: string }
  if (typeof input.text === "string" && input.text.trim()) {
    return input.text;
  }

  return null;
}
