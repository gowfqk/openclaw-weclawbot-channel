import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { dispatchWeClawBotInbound } from "../dist/src/inbound.js";
import {
  loadOutboundReplyMedia,
  mediaPlaceholder,
  saveInboundMedia,
} from "../dist/src/media.js";

const OPEN = 1;

// Tiny 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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

/**
 * Channel runtime mock whose inbound.run() delivers a fixed reply payload so
 * tests can observe the exact frame the plugin sends back to the Bridge.
 */
function createContext({ storePath = "", deliveryInput } = {}) {
  const account = { accountId: "account-a" };
  const captured = { contextPayload: null };
  const channelRuntime = {
    routing: {
      resolveAgentRoute: () => ({ agentId: "agent", sessionKey: "session:a" }),
    },
    inbound: {
      buildContext: (ctxPayload) => {
        captured.contextPayload = ctxPayload;
        return ctxPayload;
      },
      run: async ({ raw, adapter }) => {
        const turn = await adapter.resolveTurn({
          id: `message:${raw.requestId}`,
          timestamp: Date.now(),
          rawText: raw.text,
          textForAgent: raw.text,
          textForCommands: raw.text,
        });
        await turn.delivery.deliver(
          deliveryInput ?? { payload: { text: `reply:${raw.requestId}` } },
        );
      },
    },
    session: {
      resolveStorePath: () => storePath,
      recordInboundSession: () => undefined,
    },
    reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
  };
  return { account, cfg: {}, channelRuntime, log: {}, captured };
}

// ---- inbound: base64 → disk -------------------------------------------------

test("saveInboundMedia writes base64 media using mediaFormat extension", async () => {
  const storePath = await mkdtemp(path.join(os.tmpdir(), "weclawbot-"));
  try {
    const saved = await saveInboundMedia({
      storePath,
      media: PNG.toString("base64"),
      mediaType: "image",
      mediaFileName: "photo.bin",
      mediaFormat: "png",
      messageId: "msg-1",
    });

    assert.ok(saved, "expected media to be saved");
    assert.equal(saved.fileName, "msg-1.png");
    assert.equal(saved.contentType, "image/png");
    assert.equal(saved.kind, "image");
    assert.deepEqual(await readFile(saved.path), PNG);
  } finally {
    await rm(storePath, { recursive: true, force: true });
  }
});

test("saveInboundMedia falls back to mediaType mapping without format or file name", async () => {
  const storePath = await mkdtemp(path.join(os.tmpdir(), "weclawbot-"));
  try {
    const saved = await saveInboundMedia({
      storePath,
      media: PNG.toString("base64"),
      mediaType: "voice",
      messageId: "msg-voice",
    });

    assert.ok(saved, "expected media to be saved");
    assert.equal(saved.fileName, "msg-voice.silk");
    assert.equal(saved.kind, "audio");
  } finally {
    await rm(storePath, { recursive: true, force: true });
  }
});

test("saveInboundMedia returns null when no media payload is present", async () => {
  const saved = await saveInboundMedia({
    storePath: "/tmp/nowhere",
    media: null,
    messageId: "msg-null",
  });
  assert.equal(saved, null);
});

test("mediaPlaceholder labels each media kind for the agent text", () => {
  assert.equal(
    mediaPlaceholder({ kind: "image", fileName: "a.png", path: "/tmp/a.png", contentType: "image/png" }),
    "[图片]",
  );
  assert.equal(
    mediaPlaceholder({ kind: "video", fileName: "a.mp4", path: "/tmp/a.mp4", contentType: "video/mp4" }),
    "[视频]",
  );
  assert.equal(
    mediaPlaceholder({ kind: "audio", fileName: "a.silk", path: "/tmp/a.silk", contentType: "audio/silk" }),
    "[语音]",
  );
  assert.equal(
    mediaPlaceholder({ kind: "document", fileName: "a.pdf", path: "/tmp/a.pdf", contentType: "application/pdf" }),
    "[文件:a.pdf]",
  );
});

// ---- outbound: OpenClaw mediaUrls → base64 ----------------------------------

test("loadOutboundReplyMedia reads a file:// URL and classifies it as image", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weclawbot-"));
  try {
    const filePath = path.join(dir, "chart.png");
    await writeFile(filePath, PNG);
    const { media, note } = await loadOutboundReplyMedia({
      mediaUrls: [pathToFileURL(filePath).toString()],
    });

    assert.ok(media, "expected outbound media");
    assert.deepEqual(media.data, PNG);
    assert.equal(media.mediaType, "image");
    assert.equal(media.mediaFormat, "png");
    assert.equal(note, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOutboundReplyMedia keeps the first attachment and lists the rest as note", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weclawbot-"));
  try {
    const first = path.join(dir, "one.png");
    const second = path.join(dir, "two.txt");
    await writeFile(first, PNG);
    await writeFile(second, Buffer.from("hello"));

    const { media, note } = await loadOutboundReplyMedia({
      mediaUrls: [
        pathToFileURL(first).toString(),
        pathToFileURL(second).toString(),
      ],
    });

    assert.ok(media, "expected first attachment");
    assert.equal(media.mediaFileName, "one.png");
    assert.match(note, /two\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadOutboundReplyMedia returns nothing for an empty URL list", async () => {
  const { media, note } = await loadOutboundReplyMedia({ mediaUrls: [] });
  assert.equal(media, null);
  assert.equal(note, "");
});

// ---- end-to-end through dispatchWeClawBotInbound ----------------------------

test("inbound media is persisted and attached to the turn context", async () => {
  const storePath = await mkdtemp(path.join(os.tmpdir(), "weclawbot-"));
  try {
    const env = createContext({ storePath });
    const ws = createSocket();

    await dispatchWeClawBotInbound({
      ctx: env,
      ws,
      requestId: "request-1",
      text: "",
      media: PNG.toString("base64"),
      mediaType: "image",
      mediaFormat: "png",
    });

    assert.ok(env.captured.contextPayload.media, "expected media in buildContext");
    const inbound = env.captured.contextPayload.media[0];
    assert.equal(inbound.kind, "image");
    assert.equal(inbound.contentType, "image/png");
    // The file is named after the plugin's randomUUID message id, not the
    // turn id; only the extension and on-disk content are stable here.
    assert.match(path.basename(inbound.path), /\.png$/);
    assert.deepEqual(await readFile(inbound.path), PNG);
  } finally {
    await rm(storePath, { recursive: true, force: true });
  }
});

test("outbound reply media is encoded into the Bridge chat frame", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "weclawbot-"));
  try {
    const filePath = path.join(dir, "answer.png");
    await writeFile(filePath, PNG);
    const env = createContext({
      deliveryInput: {
        payload: { text: "here you go", mediaUrls: [pathToFileURL(filePath).toString()] },
      },
    });
    const ws = createSocket();

    await dispatchWeClawBotInbound({ ctx: env, ws, requestId: "request-2", text: "hi" });

    assert.equal(ws.messages.length, 1);
    const frame = ws.messages[0];
    assert.equal(frame.type, "chat");
    assert.equal(frame.id, "request-2");
    assert.equal(frame.text, "here you go");
    assert.equal(frame.final, true);
    assert.equal(frame.media, PNG.toString("base64"));
    assert.equal(frame.mediaType, "image");
    assert.equal(frame.mediaFormat, "png");
    assert.equal(frame.mediaFileName, "answer.png");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
