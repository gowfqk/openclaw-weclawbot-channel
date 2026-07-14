# OpenClaw WeClawBot Bridge Channel Plugin

将 WeClawBot-Bridge 的微信消息接入 OpenClaw Agent。

> 依赖项目：[WeClawBot-Bridge](https://github.com/gowfqk/WeClawBot-Bridge)

## 架构

```text
微信 → WeClawBot-Bridge → 本插件 (WebSocket) → OpenClaw Gateway
```

## 安装

```bash
# 1. 安装 OpenClaw（如果还没有）
npm install -g openclaw

# 2. 进入插件目录，安装依赖并构建
cd openclaw-weclawbot-channel
npm install
npm run build

# 3. 在 OpenClaw 中安装本插件
openclaw plugins install --link "$(pwd)"
openclaw config set plugins.entries.weclawbot.enabled true
```

## 配置

在 Bridge 管理面板为 OpenClaw 创建一个 WS Remote Agent：
- ID: `openclaw`
- 类型: WS Remote
- 超时: 180000

然后将 Bridge 生成的 Token 配置到 OpenClaw：

```bash
# 方式一：环境变量（推荐）
export WECLAWBOT_TOKEN="<Bridge WS Token>"
export WECLAWBOT_BRIDGE_URL="wss://<your-bridge-url>/ws/agent"  # 可选，默认值
export WECLAWBOT_AGENT_ID="openclaw"  # 可选，默认值
```

或写入 systemd 环境文件：

```ini
# /etc/systemd/system/openclaw.service.d/weclawbot.conf
[Service]
EnvironmentFile=/root/.config/openclaw-weclawbot.env
```

```bash
# /root/.config/openclaw-weclawbot.env (chmod 600)
WECLAWBOT_TOKEN=***
WECLAWBOT_BRIDGE_URL=wss://<your-bridge-url>/ws/agent
WECLAWBOT_AGENT_ID=openclaw
```

或写入 `~/.openclaw/openclaw.json`：

```json5
{
  "channels": {
    "weclawbot": {
      "enabled": true,
      "token": "wsk_lMJskzogWAmiTCm6wDDBfuveYxx4BkVB7LUD-Qaoc_A",
      "bridgeUrl": "wss://railway.122048.xyz/ws/agent",
      "agentId": "openclawtest"
    }
  }
}
```

## 重启

```bash
openclaw gateway restart
```

## 验证

```bash
openclaw channels status --probe
journalctl -u openclaw.service -f
```

预期日志：

```text
WeClawBot: connecting to wss://<your-bridge-url>/ws/agent as agent "openclaw"
WeClawBot: authenticated as agent "openclaw"
```

然后在微信中发送消息给 Bot，确认 OpenClaw 能正常回复。

## 切换 Agent

微信内发送：

```text
#openclaw  → 切换到 OpenClaw
#hermes    → 切换到 Hermes（如果同时运行）
```

## 故障排查

### 插件未加载

```bash
openclaw plugins list | grep weclawbot
# 应显示 enabled
openclaw config get plugins.entries.weclawbot.enabled
# 应为 true
```

### 认证失败

检查 Token 是否正确，Bridge Agent ID 是否匹配，Bridge WS endpoint 是否可达：

```bash
curl -sS https://<your-bridge-url>/api/health
```

### 重连日志

正常重连日志：

```text
WeClawBot: connection lost (WebSocket closed: 1001 server shutdown); reconnecting in 3s
```

连续认证失败需要检查 Token 是否过期或 Bridge Agent 配置是否变更。
