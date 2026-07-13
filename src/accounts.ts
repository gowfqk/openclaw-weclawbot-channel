// WeClawBot Bridge account resolution.
//
// Configuration:
//   channels.weclawbot.token          — required WS token
//   channels.weclawbot.bridgeUrl      — optional, defaults to Railway
//   channels.weclawbot.agentId        — optional, defaults to "openclaw"
//   channels.weclawbot.agentName      — optional display name
//   channels.weclawbot.command        — optional command alias
//   channels.weclawbot.enabled        — boolean
//   channels.weclawbot.defaultAccount — string (multi-account)
//   channels.weclawbot.accounts       — record (multi-account)
//
// Environment (per-account override for the default account):
//   WECLAWBOT_TOKEN
//   WECLAWBOT_BRIDGE_URL
//   WECLAWBOT_AGENT_ID

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

// ---- public helpers --------------------------------------------------------

export { WECLAWBOT_CHANNEL_ID, normalizeWeClawBotAccountId };
export type { ResolvedWeClawBotAccount, WeClawBotAccountConfig };
export {
  listWeClawBotAccountIds,
  resolveDefaultWeClawBotAccountId,
  resolveWeClawBotAccount,
};

// ---- constants -------------------------------------------------------------

const WECLAWBOT_CHANNEL_ID = "weclawbot" as const;
const DEFAULT_BRIDGE_URL = "wss://railway.122048.xyz/ws/agent";
const DEFAULT_AGENT_ID = "openclaw";
const DEFAULT_ACCOUNT_ID = "default";

// ---- types -----------------------------------------------------------------

type WeClawBotAccountConfig = {
  enabled?: boolean;
  name?: string;
  token?: string;
  bridgeUrl?: string;
  agentId?: string;
  agentName?: string;
  command?: string;
  accounts?: Record<string, WeClawBotAccountConfig>;
  defaultAccount?: string;
};

type ResolvedWeClawBotAccount = {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  token: string;
  bridgeUrl: string;
  agentId: string;
  agentName: string;
  command: string;
};

// ---- helpers ---------------------------------------------------------------

function normalizeWeClawBotAccountId(id?: string | null): string {
  return (id ?? DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredStr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveChannelConfig(cfg: OpenClawConfig): WeClawBotAccountConfig | undefined {
  return (cfg as Record<string, unknown>).channels?.[
    WECLAWBOT_CHANNEL_ID
  ] as WeClawBotAccountConfig | undefined;
}

// ---- account listing -------------------------------------------------------

function listWeClawBotAccountIds(cfg: OpenClawConfig): string[] {
  const channel = resolveChannelConfig(cfg);
  if (!channel) return [DEFAULT_ACCOUNT_ID];

  const explicit = channel.accounts ? Object.keys(channel.accounts) : [];
  if (explicit.length > 0) return explicit;

  return [DEFAULT_ACCOUNT_ID];
}

function resolveDefaultWeClawBotAccountId(cfg: OpenClawConfig): string {
  const channel = resolveChannelConfig(cfg);
  return normalizeWeClawBotAccountId(channel?.defaultAccount ?? DEFAULT_ACCOUNT_ID);
}

// ---- full resolution -------------------------------------------------------

function resolveWeClawBotAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWeClawBotAccount {
  const accountId = normalizeWeClawBotAccountId(params.accountId);
  const channel = resolveChannelConfig(params.cfg);

  // Merge top-level config with per-account override.
  const topLevel: WeClawBotAccountConfig = channel ?? {};
  const perAccount =
    accountId !== DEFAULT_ACCOUNT_ID
      ? (channel?.accounts?.[accountId] as WeClawBotAccountConfig | undefined) ?? {}
      : {};

  const merged: WeClawBotAccountConfig = {
    enabled: perAccount.enabled ?? topLevel.enabled ?? true,
    name: perAccount.name ?? topLevel.name,
    token: perAccount.token ?? topLevel.token,
    bridgeUrl: perAccount.bridgeUrl ?? topLevel.bridgeUrl,
    agentId: perAccount.agentId ?? topLevel.agentId,
    agentName: perAccount.agentName ?? topLevel.agentName,
    command: perAccount.command ?? topLevel.command,
  };

  // Environment variables only apply to the default account.
  const envToken =
    accountId === DEFAULT_ACCOUNT_ID
      ? optionalStr(process.env.WECLAWBOT_TOKEN)
      : undefined;
  const envBridgeUrl =
    accountId === DEFAULT_ACCOUNT_ID
      ? optionalStr(process.env.WECLAWBOT_BRIDGE_URL)
      : undefined;
  const envAgentId =
    accountId === DEFAULT_ACCOUNT_ID
      ? optionalStr(process.env.WECLAWBOT_AGENT_ID)
      : undefined;

  const token = envToken ?? merged.token ?? "";
  const bridgeUrl = envBridgeUrl ?? merged.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  const agentId = envAgentId ?? merged.agentId ?? DEFAULT_AGENT_ID;

  return {
    accountId,
    name: merged.name ?? `WeClawBot (${agentId})`,
    enabled: merged.enabled !== false,
    configured: Boolean(token),
    token,
    bridgeUrl,
    agentId,
    agentName: merged.agentName ?? "OpenClaw",
    command: merged.command ?? "openclaw",
  };
}
