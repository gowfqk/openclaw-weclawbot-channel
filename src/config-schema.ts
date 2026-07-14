// WeClawBot Bridge channel configuration schema.
// Cold-path validation is handled by channelConfigs in openclaw.plugin.json.
// External plugins cannot use buildChannelConfigSchema — it depends on
// OpenClaw's internal zod types. This provides a minimal valid schema shape
// that satisfies the ChannelConfigSchema contract without runtime validation.

export const weclawbotChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: true,
    properties: {},
  },
};
