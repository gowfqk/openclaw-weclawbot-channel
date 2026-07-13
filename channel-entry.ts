import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "weclawbot",
  name: "WeClawBot Bridge",
  description:
    "OpenClaw channel plugin for WeClawBot-Bridge — connects WeChat through the Bridge WS Remote Agent protocol",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "weclawbotPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
});
