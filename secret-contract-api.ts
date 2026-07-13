// WeClawBot Bridge channel secrets contract.
export const channelSecrets = {
  token: {
    id: "WECLAWBOT_TOKEN",
    description: "Bridge WS Remote Agent token (from management panel)",
    required: true,
  },
  bridgeUrl: {
    id: "WECLAWBOT_BRIDGE_URL",
    description: "Bridge WebSocket URL (default: wss://railway.122048.xyz/ws/agent)",
    required: false,
  },
  agentId: {
    id: "WECLAWBOT_AGENT_ID",
    description: "Bridge Agent ID (default: openclaw)",
    required: false,
  },
};
