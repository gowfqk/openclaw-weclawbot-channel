import assert from "node:assert/strict";
import test from "node:test";

import { dispatchWeClawBotInbound } from "../dist/src/inbound.js";

const OPEN = 1;

function createSocket() {
  const messages = [];
  return {
    readyState: OPEN,
    send(payload, callback) {
      messages.push(JSON.parse(payload));
      callback?.();
    },
    messages,
  };
}

function createContext(accountId) {
  const account = { accountId };
  const channelRuntime = {
    routing: {
      resolveAgentRoute: () => ({ agentId: "agent", sessionKey: `session:${accountId}` }),
    },
    inbound: {
      buildContext: () => ({}),
      run: async ({ raw, adapter }) => {
        const turn = await adapter.resolveTurn({
          id: `message:${raw.requestId}`,
          timestamp: Date.now(),
          rawText: raw.text,
          textForAgent: raw.text,
          textForCommands: raw.text,
        });
        await turn.delivery.deliver({ payload: { text: `reply:${raw.requestId}` } });
      },
    },
    session: {
      resolveStorePath: () => "",
      recordInboundSession: () => undefined,
    },
    reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
  };

  return { account, cfg: {}, channelRuntime, log: {} };
}

test("each inbound turn replies through its own account WebSocket", async () => {
  const accountA = createSocket();
  const accountB = createSocket();

  await Promise.all([
    dispatchWeClawBotInbound({
      ctx: createContext("account-a"),
      ws: accountA,
      requestId: "request-a",
      text: "hello A",
    }),
    dispatchWeClawBotInbound({
      ctx: createContext("account-b"),
      ws: accountB,
      requestId: "request-b",
      text: "hello B",
    }),
  ]);

  assert.deepEqual(accountA.messages, [
    { type: "chat", id: "request-a", text: "reply:request-a", final: true },
  ]);
  assert.deepEqual(accountB.messages, [
    { type: "chat", id: "request-b", text: "reply:request-b", final: true },
  ]);
});

test("an inbound request never falls back to another account socket", async () => {
  const closedSocket = { readyState: 3, send: () => assert.fail("must not send") };
  const ctx = createContext("account-a");
  const errors = [];
  ctx.log.error = (message) => errors.push(message);

  await dispatchWeClawBotInbound({
    ctx,
    ws: closedSocket,
    requestId: "request-a",
    text: "hello",
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /WebSocket is not connected/);
});
