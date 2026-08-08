// WeClawBot Bridge inbound dispatch — routes Bridge chat messages into
// OpenClaw's channel runtime pipeline and delivers replies (text + media) back.

import { randomUUID } from "node:crypto";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { WECLAWBOT_CHANNEL_ID, type ResolvedWeClawBotAccount } from "./accounts.js";
import { sendWeClawBotReply } from "./gateway.js";
import {
  loadOutboundReplyMedia,
  mediaPlaceholder,
  saveInboundMedia,
  type OutboundReplyMedia,
} from "./media.js";

// ---- types -----------------------------------------------------------------

type WeClawBotChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

type DispatchParams = {
  ctx: ChannelGatewayContext<ResolvedWeClawBotAccount>;
  requestId: string;
  text: string;
  /** Bridge base64 media (string, Buffer, or structured object). */
  media?: unknown;
  mediaType?: string;
  mediaFileName?: string;
  mediaFormat?: string;
  /** Socket owned by this account's gateway connection. */
  ws: import("ws").WebSocket;
};

type FinalReply = {
  text: string;
  media?: OutboundReplyMedia | null;
};

// ---- public API ------------------------------------------------------------

/**
 * Dispatch an inbound WeChat message (delivered by the Bridge) into OpenClaw's
 * agent pipeline. The reply (text and/or media) is sent back through the same
 * WebSocket connection.
 */
export async function dispatchWeClawBotInbound(params: DispatchParams): Promise<void> {
  const { ctx, requestId, text, ws, media, mediaType, mediaFileName, mediaFormat } = params;
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

  const storePath = channelRuntime.session.resolveStorePath(
    ctx.cfg.session?.store,
    { agentId: route.agentId },
  );

  const timestamp = Date.now();
  const messageId = randomUUID();

  // Decode and persist inbound media so OpenClaw can attach the local file.
  let savedMedia: Awaited<ReturnType<typeof saveInboundMedia>> = null;
  try {
    savedMedia = await saveInboundMedia({
      storePath,
      media,
      mediaType,
      mediaFileName,
      mediaFormat,
      messageId,
    });
    if (savedMedia) {
      ctx.log?.info?.(`WeClawBot: 入站媒体已落盘 ${savedMedia.path} (${savedMedia.kind})`);
    }
  } catch (err) {
    ctx.log?.warn?.(
      `WeClawBot: failed to persist inbound media (${String(err)}); continuing without attachment`,
    );
  }

  // Media-only messages get a placeholder caption so the turn still has text.
  const bodyText = (text || (savedMedia ? mediaPlaceholder(savedMedia) : "")).trim();

  // The gateway supplies the socket that received this request. Keeping it in
  // the dispatch scope prevents another configured account from stealing the
  // correlated Bridge reply while this turn is running.

  // The runtime dispatcher may call delivery once with the final visible
  // answer. Keep only the newest completed block and emit it once after the
  // run, so a normal OpenClaw reply does not appear twice in WeChat.
  let finalReply: FinalReply | null = null;

  await channelRuntime.inbound.run({
    channel: WECLAWBOT_CHANNEL_ID,
    accountId: account.accountId,
    raw: {
      kind: "message",
      requestId,
      text: bodyText,
    },
    adapter: {
      ingest: () => ({
        id: messageId,
        timestamp,
        rawText: bodyText,
        textForAgent: bodyText,
        textForCommands: bodyText,
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
          ...(savedMedia
            ? {
                media: [
                  {
                    path: savedMedia.path,
                    contentType: savedMedia.contentType,
                    kind: savedMedia.kind,
                    messageId: input.id,
                  },
                ],
              }
            : {}),
        });

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
              const reply = extractReply(deliveryInput);
              if (reply.text) {
                finalReply = { text: reply.text };
              }
              if (reply.mediaUrls.length > 0) {
                const loaded = await loadOutboundReplyMedia({
                  mediaUrls: reply.mediaUrls,
                  log: ctx.log,
                });
                if (loaded.media) {
                  finalReply = {
                    text: `${finalReply?.text ?? ""}${loaded.note}`,
                    media: loaded.media,
                  };
                } else if (loaded.note) {
                  finalReply = {
                    text: `${finalReply?.text ?? ""}${loaded.note}`,
                  };
                }
              }
              // Reply after inbound.run() completes. Sending here as well
              // produces a duplicate: this callback often receives the same
              // completed answer that is retained in finalReply.
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

  // The closure above assigns finalReply, so TS's flow analysis narrows it to
  // its `null` initializer here (closure writes are invisible to outer flow)
  // and an annotated copy is still narrowed to `never` after the check below.
  // An explicit `as` cast is the reliable way to keep the union type.
  const replyToSend = finalReply as FinalReply | null;
  if (!replyToSend) return;
  if (!replyToSend.text && !replyToSend.media) return;
  try {
    await sendWeClawBotReply({
      ctx,
      ws,
      requestId,
      text: replyToSend.text,
      media: replyToSend.media,
    });
  } catch (err) {
    ctx.log?.error?.(`WeClawBot: failed to send final reply for ${requestId}: ${String(err)}`);
  }
}

// ---- reply extraction ------------------------------------------------------

type ExtractedReply = {
  text: string | null;
  mediaUrls: string[];
};

function extractReply(deliveryInput: unknown): ExtractedReply {
  const source = payloadSource(deliveryInput);
  if (!source) return { text: null, mediaUrls: [] };

  return {
    text: extractText(source),
    mediaUrls: extractMediaUrls(source),
  };
}

/**
 * The delivery input from OpenClaw's reply pipeline varies by version: either
 * the normalized OutboundReplyPayload itself, or a wrapper carrying `payload`.
 */
function payloadSource(deliveryInput: unknown): Record<string, unknown> | null {
  if (!deliveryInput || typeof deliveryInput !== "object") return null;
  const input = deliveryInput as Record<string, unknown>;
  const payload = input.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload === "object") return payload;
  return input;
}

function extractText(source: Record<string, unknown>): string | null {
  // Shape: { text?: string, blocks?: [...] }
  if (typeof source.text === "string" && source.text.trim()) {
    return source.text;
  }
  const blocks = source.blocks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(blocks)) {
    const parts = blocks
      .filter((b) => typeof b.text === "string")
      .map((b) => b.text as string)
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

function extractMediaUrls(source: Record<string, unknown>): string[] {
  const urls = source.mediaUrls;
  if (Array.isArray(urls)) {
    return urls.filter((u): u is string => typeof u === "string" && u.trim().length > 0);
  }
  if (typeof source.mediaUrl === "string" && source.mediaUrl.trim()) {
    return [source.mediaUrl];
  }
  return [];
}
