// WeClawBot Bridge Channel Plugin for OpenClaw.
//
// Connects WeChat messages through the WeClawBot-Bridge WS Remote Agent protocol
// into OpenClaw's agent pipeline.  This is a "direct" channel — the plugin owns
// the WebSocket transport, routes inbound messages through OpenClaw's channel
// runtime, and delivers replies back through the same connection.
//
// Configuration:
//   channels.weclawbot.token      — WS Agent token (required)
//   channels.weclawbot.bridgeUrl  — WebSocket URL (default: wss://<your-bridge-url>/ws/agent)
//   channels.weclawbot.agentId    — Bridge Agent ID (default: "openclaw")
//   channels.weclawbot.agentName  — display name (default: "OpenClaw")
//   channels.weclawbot.command    — command alias (default: "openclaw")
//   channels.weclawbot.enabled    — boolean
//
// Env vars (for the default account):
//   WECLAWBOT_TOKEN
//   WECLAWBOT_BRIDGE_URL
//   WECLAWBOT_AGENT_ID

import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  buildBaseChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";

import {
  WECLAWBOT_CHANNEL_ID,
  listWeClawBotAccountIds,
  resolveDefaultWeClawBotAccountId,
  resolveWeClawBotAccount,
  type ResolvedWeClawBotAccount,
} from "./accounts.js";
import { weclawbotChannelConfigSchema } from "./config-schema.js";
import { startWeClawBotGatewayAccount } from "./gateway.js";

// ---- types -----------------------------------------------------------------

type WeClawBotProbe = Record<string, never>;

// ---- plugin definition -----------------------------------------------------

export const weclawbotPlugin: ChannelPlugin<
  ResolvedWeClawBotAccount,
  WeClawBotProbe
> = createChatChannelPlugin({
  base: {
    id: WECLAWBOT_CHANNEL_ID,
    meta: {
      id: WECLAWBOT_CHANNEL_ID,
      label: "WeClawBot Bridge",
      selectionLabel: "WeClawBot Bridge (WeChat via WS Remote Agent)",
      docsPath: "/channels/weclawbot",
      docsLabel: "weclawbot",
      blurb:
        "Connect OpenClaw to WeChat through the WeClawBot-Bridge WS Remote Agent protocol.",
      order: 99,
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    reload: { configPrefixes: ["channels.weclawbot"] },
    configSchema: weclawbotChannelConfigSchema,

    // ---- account management -----------------------------------------------

    config: {
      listAccountIds: listWeClawBotAccountIds,
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveWeClawBotAccount({ cfg, accountId }),
      defaultAccountId: resolveDefaultWeClawBotAccountId,
      isConfigured: (account) => account.configured,
      isEnabled: (account) => account.enabled,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            agentId: account.agentId,
            bridgeUrl: account.bridgeUrl,
          },
        }),
    },

    // ---- status & probing -------------------------------------------------

    status: createComputedAccountStatusAdapter<
      ResolvedWeClawBotAccount,
      WeClawBotProbe
    >({
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      buildChannelSummary: ({ snapshot }) =>
        buildBaseChannelStatusSummary(snapshot),
      probeAccount: async () => ({}),
      formatCapabilitiesProbe: () => [],
      collectStatusIssues: (accounts) =>
        accounts.flatMap((account) => {
          if (!account.configured) {
            return [
              {
                channel: WECLAWBOT_CHANNEL_ID,
                accountId: account.accountId,
                kind: "config" as const,
                message: "WeClawBot account is missing a WS token",
                fix: "Set channels.weclawbot.token or WECLAWBOT_TOKEN.",
              },
            ];
          }
          return [];
        }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          agentId: account.agentId,
          bridgeUrl: account.bridgeUrl,
        },
      }),
    }),

    // ---- gateway lifecycle ------------------------------------------------

    gateway: {
      startAccount: async (ctx) => {
        await startWeClawBotGatewayAccount(ctx);
      },
    },
  },

  // ---- outbound (top-level, per SDK convention) -------------------------

  outbound: {
    deliveryMode: "direct",
    sendText: async () => {
      // Bridge's `push` frame is agent-to-WeChat and does not accept an
      // OpenClaw target. A direct-channel socket is intentionally scoped to
      // an inbound request, so there is no safe general outbound route here.
      // Reject rather than returning a fabricated receipt for a lost message.
      throw new Error(
        "WeClawBot does not support proactive OpenClaw sends: the Bridge WS Remote Agent protocol has no targetable outbound delivery route.",
      );
    },
    resolveTarget: ({ to }) => {
      if (!to || to === "weclawbot:default") {
        return { ok: false, error: new Error("WeClawBot supports replies to inbound requests only; proactive sends are unavailable.") };
      }
      return { ok: false, error: new Error(`Unsupported WeClawBot target: ${to}`) };
    },
  },
});
