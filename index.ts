import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { weclawbotPlugin } from "./src/channel.js";

// Use explicit default export — defineChannelPluginEntry's return type
// cannot be named in declaration output for external plugins.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _entry: any = defineChannelPluginEntry({
  id: "weclawbot",
  name: "WeClawBot Bridge",
  description:
    "Connect OpenClaw to WeChat through the WeClawBot-Bridge WS Remote Agent protocol.",
  plugin: weclawbotPlugin,
});

export default _entry;
