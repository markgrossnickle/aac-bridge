import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createRelay } from "./server.js";
import { createAacEmitter, createAacListener, relayTransport } from "../src/index.js";

const open = (url) =>
  new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.once("open", () => resolve(s));
    s.once("error", reject);
  });
const closed = (s) => new Promise((resolve) => s.once("close", (code) => resolve(code)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRelay() {
  const relay = createRelay({ port: 0, host: "127.0.0.1", log: () => {} });
  await new Promise((r) => relay.wss.once("listening", r));
  return relay;
}

test("relay forwards sender to listeners only, end to end through the library", async () => {
  const relay = await startRelay();
  const url = `ws://127.0.0.1:${relay.port}/`;
  try {
    const listener = createAacListener({
      transport: relayTransport({ url, room: "room-1234", WebSocketImpl: WebSocket }),
      vocabulary: ["yes"],
    });
    const words = [];
    listener.on("word", (d) => words.push(d.word));
    await wait(150);
    const out = createAacEmitter({
      app: { app: "t" },
      transport: relayTransport({ url, room: "room-1234", role: "sender", WebSocketImpl: WebSocket }),
    });
    out.enable();
    out.symbol({ text: "yes" });
    await wait(300);
    assert.deepEqual(words, ["yes"]);

    // A listener cannot inject words into the room.
    const sneaky = await open(`${url}?room=room-1234&role=listener`);
    sneaky.send(
      JSON.stringify({ protocol: "aac-bridge", v: 1, type: "symbol.select", id: "z", session: "z", seq: 0, ts: 1, source: { app: "x" }, symbol: { text: "yes" } }),
    );
    await wait(200);
    assert.deepEqual(words, ["yes"]);
    sneaky.close();
    out.close();
    listener.close();
  } finally {
    await relay.close();
  }
});

test("relay rejects bad rooms and roles", async () => {
  const relay = await startRelay();
  try {
    const a = await open(`ws://127.0.0.1:${relay.port}/?room=x&role=listener`);
    assert.equal(await closed(a), 1008);
    const b = await open(`ws://127.0.0.1:${relay.port}/?room=good-room&role=admin`);
    assert.equal(await closed(b), 1008);
  } finally {
    await relay.close();
  }
});

test("relay drops messages that are not aac-bridge envelopes", async () => {
  const relay = await startRelay();
  try {
    const l = await open(`ws://127.0.0.1:${relay.port}/?room=abcd&role=listener`);
    const s = await open(`ws://127.0.0.1:${relay.port}/?room=abcd&role=sender`);
    const got = [];
    l.on("message", (m) => got.push(String(m)));
    s.send("hello");
    s.send(JSON.stringify({ protocol: "other" }));
    s.send(JSON.stringify({ protocol: "aac-bridge", ok: 1 }));
    await wait(200);
    assert.equal(got.length, 1);
    l.close();
    s.close();
  } finally {
    await relay.close();
  }
});

test("relay enforces the per-sender rate limit", async () => {
  const relay = createRelay({ port: 0, host: "127.0.0.1", messagesPerSecond: 5, log: () => {} });
  await new Promise((r) => relay.wss.once("listening", r));
  try {
    const l = await open(`ws://127.0.0.1:${relay.port}/?room=rate&role=listener`);
    const s = await open(`ws://127.0.0.1:${relay.port}/?room=rate&role=sender`);
    let n = 0;
    l.on("message", () => n++);
    for (let i = 0; i < 50; i++) s.send(JSON.stringify({ protocol: "aac-bridge", i }));
    await wait(200);
    assert.ok(n <= 6, `forwarded ${n}`);
    l.close();
    s.close();
  } finally {
    await relay.close();
  }
});
