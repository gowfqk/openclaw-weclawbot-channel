// WeClawBot Bridge channel configuration schema.
// Cold-path validation is handled by channelConfigs in openclaw.plugin.json.
// This is a lightweight runtime passthrough that defers to the manifest schema.
// External plugins should NOT use buildChannelConfigSchema — it depends on
// OpenClaw's internal zod types which are binary-incompatible with user-space zod.

export const weclawbotChannelConfigSchema = {
  // Schema validation is defined declaratively in openclaw.plugin.json
  // under channelConfigs.weclawbot.schema. This runtime export exists
  // only to satisfy the ChannelPlugin configSchema contract.
} as Record<string, never>;
