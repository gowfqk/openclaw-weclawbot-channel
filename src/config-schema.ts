// WeClawBot Bridge channel configuration schema.
// This is intentionally minimal — we accept arbitrary config keys so the plugin
// does not break when OpenClaw or the Bridge add new fields.

import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const WeClawBotAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    bridgeUrl: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    command: z.string().optional(),
  })
  .strict();

const WeClawBotConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    bridgeUrl: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    command: z.string().optional(),
    defaultAccount: z.string().optional(),
    accounts: z.record(z.string(), WeClawBotAccountSchema).optional(),
  })
  .strict();

const _schema = buildChannelConfigSchema(WeClawBotConfigSchema);
export const weclawbotChannelConfigSchema: typeof _schema = _schema;
