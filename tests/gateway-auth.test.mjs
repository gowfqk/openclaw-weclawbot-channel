import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";

import { authenticateWebSocket } from "../dist/src/gateway.js";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.sent = [];
    this.terminated = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
}

const account = {
  token: "test-token",
  agentId: "test-agent",
  agentName: "OpenClaw",
  command: "openclaw",
};

function startAuth(socket, timeoutMs = 50) {
  return authenticateWebSocket({
    account,
    url: "ws://bridge.example/ws/agent",
    createSocket: () => socket,
    timeoutMs,
  });
}

test("authentication timeout covers the auth response and terminates stale socket", async () => {
  const socket = new FakeSocket();
  const auth = startAuth(socket, 15);
  socket.readyState = WebSocket.OPEN;
  socket.emit("open");

  await assert.rejects(auth, /authentication timed out/);
  assert.deepEqual(socket.sent, [{
    type: "auth",
    token: "test-token",
    agentId: "test-agent",
    name: "OpenClaw",
    command: "openclaw",
    description: "OpenClaw Channel Plugin",
  }]);
  assert.equal(socket.terminated, true);
});

test("authentication pre-auth close rejects and terminates the socket", async () => {
  const socket = new FakeSocket();
  const auth = startAuth(socket);
  socket.emit("close", 1006, Buffer.from("bridge gone"));

  await assert.rejects(auth, /closed before authentication/);
  assert.equal(socket.terminated, true);
});

test("auth_fail rejects and closes the candidate socket", async () => {
  const socket = new FakeSocket();
  const auth = startAuth(socket);
  socket.readyState = WebSocket.OPEN;
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ type: "auth_fail", reason: "bad token" })));

  await assert.rejects(auth, /Bridge authentication rejected: bad token/);
  assert.equal(socket.terminated, true);
});

test("auth_ok resolves without terminating the authenticated socket", async () => {
  const socket = new FakeSocket();
  const auth = startAuth(socket);
  socket.readyState = WebSocket.OPEN;
  socket.emit("open");
  socket.emit("message", Buffer.from(JSON.stringify({ type: "auth_ok", agentId: "test-agent" })));

  assert.equal(await auth, socket);
  assert.equal(socket.terminated, false);
});
