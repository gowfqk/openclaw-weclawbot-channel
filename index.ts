import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { weclawbotPlugin } from "./src/channel.js";

const entry = defineChannelPluginEntry({
  id: "weclawbot",
  name: "WeClawBot Bridge",
  description:
    "Connect OpenClaw to WeChat through the WeClawBot-Bridge WS Remote Agent protocol.",
  plugin: weclawbotPlugin,
});

export default entry;
