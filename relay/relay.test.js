import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "./server.js";
import {
  claimPairing,
  createAacEmitter,
  createAacListener,
  createPairing,
  memoryLink,
  relayTransport,
  revokePairing,
} from "../src/index.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(opts = {}) {
  const relay = createRelay({ port: 0, host: "127.0.0.1", log: () => {}, ...opts });
  await relay.ready;
  const http = `http://127.0.0.1:${relay.port}`;
  return { relay, http, ws: `ws://127.0.0.1:${relay.port}/` };
}

/** Open a raw socket, authenticate with `token`, resolve with { socket, reply, closeCode }. */
function rawAuth(ws, token, { authenticate = true } = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(ws);
    const out = { socket, reply: null, closeCode: null, messages: [], control: [] };
    socket.on("open", () => {
      if (authenticate) socket.send(JSON.stringify({ relay: "auth", token }));
    });
    socket.on("message", (m) => {
      const msg = JSON.parse(String(m));
      if (msg.relay === "ok") {
        out.reply = msg;
        resolve(out);
      } else if (msg.relay) out.control.push(msg);
      else out.messages.push(msg);
    });
    socket.on("close", (code) => {
      out.closeCode = code;
      resolve(out);
    });
  });
}

/** A WebSocket whose connection opens late, to simulate a slow or flaky network. */
function slowSocket(delayMs) {
  return class SlowWS extends WebSocket {
    set onopen(fn) {
      super.onopen = fn ? () => setTimeout(fn, delayMs) : null;
    }
  };
}

const envelope = (text) => ({
  protocol: "aac-bridge",
  v: 1,
  type: "symbol.select",
  id: `x-${Math.random()}`,
  session: "forged",
  seq: 0,
  ts: Date.now(),
  source: { app: "cboard" },
  symbol: { text },
});

test("pair, claim and stream end to end through the library", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http });
    assert.match(p.code, /^\d{6}$/);
    const listener = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }), vocabulary: ["yes"] });
    const words = [];
    listener.on("word", (d) => words.push(d.word));
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const out = createAacEmitter({ app: { app: "t" }, transport: relayTransport({ relay: http, token: senderToken, WebSocketImpl: WebSocket }) });
    await wait(150);
    out.enable();
    out.symbol({ text: "yes" });
    await wait(300);
    assert.deepEqual(words, ["yes"]);
    out.close();
    listener.close();
  } finally {
    await relay.close();
  }
});

test("a code can be claimed once, so nobody else can become the sender", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http });
    await claimPairing({ relay: http, code: p.code });
    await assert.rejects(claimPairing({ relay: http, code: p.code }), /unknown or expired code/);
  } finally {
    await relay.close();
  }
});

test("without the sender token nobody can inject words, including the listener and a stranger", async () => {
  const { relay, http, ws } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const game = await rawAuth(ws, p.listenerToken);
    assert.equal(game.reply.role, "listener");

    const stranger = await rawAuth(ws, "not-a-real-token-at-all-0000000000");
    assert.equal(stranger.closeCode, 4401);

    const secondListener = await rawAuth(ws, p.listenerToken);
    secondListener.socket.send(JSON.stringify(envelope("forged by listener")));

    const sender = await rawAuth(ws, senderToken);
    assert.equal(sender.reply.role, "sender");
    sender.socket.send(JSON.stringify(envelope("real")));
    await wait(200);
    assert.deepEqual(game.messages.map((m) => m.symbol.text), ["real"]);
    for (const s of [game, secondListener, sender]) s.socket.close();
  } finally {
    await relay.close();
  }
});

test("no authentication in time closes the socket", async () => {
  const { relay, ws } = await start({ authTimeoutMs: 100 });
  try {
    const r = await rawAuth(ws, null, { authenticate: false });
    assert.equal(r.closeCode, 4408);
  } finally {
    await relay.close();
  }
});

test("turning sharing off discards speech queued on a slow connection", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const listener = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }) });
    const seen = [];
    listener.on("symbol", (d) => seen.push(d.symbol.text));
    await wait(150);
    const out = createAacEmitter({ app: { app: "t" }, transport: relayTransport({ relay: http, token: senderToken, WebSocketImpl: slowSocket(300) }) });
    out.enable();
    out.symbol({ text: "something private" });
    out.disable();
    await wait(800);
    assert.deepEqual(seen, []);
    listener.close();
  } finally {
    await relay.close();
  }
});

test("queued messages older than queueTtlMs are dropped, fresh ones delivered", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const listener = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }) });
    const seen = [];
    listener.on("symbol", (d) => seen.push(d.symbol.text));
    await wait(150);
    const t = relayTransport({ relay: http, token: senderToken, WebSocketImpl: slowSocket(400), queueTtlMs: 200 });
    const out = createAacEmitter({ app: { app: "t" }, transport: t });
    out.enable();
    out.symbol({ text: "too old" });
    await wait(900);
    out.symbol({ text: "fresh" });
    await wait(300);
    assert.deepEqual(seen, ["fresh"]);
    out.close();
    listener.close();
  } finally {
    await relay.close();
  }
});

test("revoking disconnects both sides and kills both tokens", async () => {
  const { relay, http, ws } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const statuses = [];
    const listener = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }) });
    listener.on("status", (s) => statuses.push(s.state));
    const sender = await rawAuth(ws, senderToken);
    await wait(150);
    const closed = new Promise((r) => sender.socket.once("close", (code) => r(code)));
    await revokePairing({ relay: http, token: senderToken });
    assert.equal(await closed, 4403);
    await wait(200);
    assert.equal(listener.status, "revoked");
    assert.ok(statuses.includes("revoked"));
    assert.equal((await rawAuth(ws, p.listenerToken)).closeCode, 4401);
    assert.equal((await rawAuth(ws, senderToken)).closeCode, 4401);
    assert.equal(relay.size, 0);
    listener.close();
  } finally {
    await relay.close();
  }
});

test("pairing codes expire", async () => {
  let clock = Date.now();
  const { relay, http } = await start({ codeTtlMs: 60_000, now: () => clock });
  try {
    const p = await createPairing({ relay: http });
    clock += 61_000;
    await assert.rejects(claimPairing({ relay: http, code: p.code }), /unknown or expired code/);
    assert.equal(relay.size, 0);
  } finally {
    await relay.close();
  }
});

test("claim attempts are rate limited per address", async () => {
  const { relay, http } = await start({ claimPerMinutePerIp: 3 });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${http}/pairings/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
  } finally {
    await relay.close();
  }
});

test("origins outside ALLOWED_ORIGINS are refused", async () => {
  const { relay, http } = await start({ allowedOrigins: ["https://game.example"] });
  try {
    const bad = await fetch(`${http}/pairings`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(bad.status, 403);
    const good = await fetch(`${http}/pairings`, { method: "POST", headers: { Origin: "https://game.example" } });
    assert.equal(good.status, 201);
  } finally {
    await relay.close();
  }
});

test("the sender is rate limited", async () => {
  const { relay, http, ws } = await start({ messagesPerSecond: 5 });
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const game = await rawAuth(ws, p.listenerToken);
    const sender = await rawAuth(ws, senderToken);
    for (let i = 0; i < 50; i++) sender.socket.send(JSON.stringify(envelope(`m${i}`)));
    await wait(200);
    assert.ok(game.messages.length <= 6, `forwarded ${game.messages.length}`);
    game.socket.close();
    sender.socket.close();
  } finally {
    await relay.close();
  }
});

test("an oversized or malformed frame closes only that client; the relay keeps serving", async () => {
  const { relay, http, ws } = await start({ maxMessageBytes: 16 * 1024 });
  try {
    const big = new WebSocket(ws);
    const bigClosed = new Promise((r) => big.on("close", r));
    big.on("error", () => {});
    big.on("open", () => big.send("x".repeat(17_000)));
    await bigClosed;

    const bad = new WebSocket(ws);
    const badClosed = new Promise((r) => bad.on("close", r));
    bad.on("error", () => {});
    bad.on("open", () => bad._socket.write(Buffer.from([0x8f, 0x80, 0, 0, 0, 0]))); // reserved opcode
    await badClosed;

    // Still alive: a new pairing streams end to end.
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const game = await rawAuth(ws, p.listenerToken);
    const sender = await rawAuth(ws, senderToken);
    sender.socket.send(JSON.stringify(envelope("still here")));
    await wait(150);
    assert.deepEqual(game.messages.map((m) => m.symbol.text), ["still here"]);
    game.socket.close();
    sender.socket.close();
  } finally {
    await relay.close();
  }
});

test("a game that opens while sharing is on learns it at once (presence + replayed hello), with no false gap", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const hub = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }) });
    const hubHellos = [];
    hub.on("hello", (d) => hubHellos.push(d));
    await wait(150);
    const out = createAacEmitter({ app: { app: "cboard" }, transport: relayTransport({ relay: http, token: senderToken, WebSocketImpl: WebSocket }) });
    out.enable();
    await wait(200);
    for (const w of ["a", "b", "c"]) out.symbol({ text: w });
    await wait(150);
    assert.equal(hubHellos.length, 1);
    hub.close(); // the hub page navigates into a game

    const game = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }), vocabulary: ["go"] });
    const seen = { hello: [], presence: [], gap: 0, words: [] };
    game.on("hello", (d) => seen.hello.push(d));
    game.on("presence", (d) => seen.presence.push(d.present));
    game.on("gap", () => seen.gap++);
    game.on("word", (d) => seen.words.push(d.word));
    await wait(250);
    assert.equal(seen.hello.length, 1, "replayed hello");
    assert.equal(seen.hello[0].replay, true);
    assert.equal(seen.hello[0].source.app, "cboard");
    assert.equal(game.source.app, "cboard");
    assert.deepEqual(seen.presence, [true]);
    assert.equal(game.presenceOf("relay"), true);
    out.symbol({ text: "go" });
    await wait(150);
    assert.deepEqual(seen.words, ["go"]);
    assert.equal(seen.gap, 0);

    // The sender's connection goes away: presence turns false.
    out.close();
    await wait(200);
    assert.equal(game.presenceOf("relay"), false);
    game.close();
  } finally {
    await relay.close();
  }
});

test("no replay before sharing starts or after it stops", async () => {
  const { relay, http, ws } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const before = await rawAuth(ws, p.listenerToken);
    await wait(100);
    assert.deepEqual(before.control, [{ relay: "presence", sender: false }]);
    const out = createAacEmitter({ app: { app: "cboard" }, transport: relayTransport({ relay: http, token: senderToken, WebSocketImpl: WebSocket }) });
    out.enable();
    await wait(200);
    out.disable();
    await wait(200);
    const after = await rawAuth(ws, p.listenerToken);
    await wait(100);
    assert.deepEqual(after.control, [{ relay: "presence", sender: false }]);
    before.socket.close();
    after.socket.close();
  } finally {
    await relay.close();
  }
});

test("the game word list travels with the pairing, and only those words are shared when the AAC app limits to it", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http, vocabulary: ["go", { word: "pop", synonyms: ["burst"] }] });
    const claim = await claimPairing({ relay: http, code: p.code });
    assert.deepEqual(claim.vocabulary, ["go", "pop", "burst"]);
    const game = createAacListener({ transport: relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket }) });
    const got = [];
    game.on("symbol", (d) => got.push(d.symbol.text));
    game.on("phrase", (d) => got.push(`phrase:${d.text}`));
    game.on("board", () => got.push("board"));
    await wait(150);
    const out = createAacEmitter({ app: { app: "cboard" }, transport: relayTransport({ relay: http, token: claim.senderToken, WebSocketImpl: WebSocket }), limitTo: claim.vocabulary });
    out.enable();
    await wait(200);
    assert.equal(out.symbol({ text: "I feel sad" }), false);
    out.symbol({ text: "Burst" });
    out.board("food");
    out.phrase("I want to go home", [{ text: "I" }, { text: "want" }, { text: "go" }, { text: "home" }]);
    await wait(200);
    assert.deepEqual(got, ["Burst", "phrase:go"]);
    assert.ok(game.source.capabilities.includes("sharing.limited"));
    out.close();
    game.close();

    const bad = await fetch(`${http}/pairings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vocabulary: ["x".repeat(65)] }) });
    assert.equal(bad.status, 400);
    const none = await claimPairing({ relay: http, code: (await createPairing({ relay: http })).code });
    assert.equal(none.vocabulary, undefined);
  } finally {
    await relay.close();
  }
});

test("a revoked relay shows in statusOf even while another channel stays open", async () => {
  const { relay, http } = await start();
  try {
    const p = await createPairing({ relay: http });
    const { senderToken } = await claimPairing({ relay: http, code: p.code });
    const local = memoryLink();
    const game = createAacListener({ transports: [local.listener, relayTransport({ relay: http, token: p.listenerToken, WebSocketImpl: WebSocket })] });
    await wait(150);
    await revokePairing({ relay: http, token: senderToken });
    await wait(200);
    assert.equal(game.status, "open", "the other channel is still open");
    assert.equal(game.statusOf("relay"), "revoked");
    assert.equal(game.statusOf("memory"), "open");
    game.close();
  } finally {
    await relay.close();
  }
});

test("local play: --serve hands out the game site and the example AAC app, nothing outside them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aac-serve-"));
  writeFileSync(join(dir, "index.html"), "<h1>hub</h1>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "a-123.js"), "export{}");
  writeFileSync(join(dir, ".secret"), "no");
  const { relay, http } = await start({ serveDir: dir });
  try {
    const home = await fetch(`${http}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal(await home.text(), "<h1>hub</h1>");
    const asset = await fetch(`${http}/assets/a-123.js`);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${http}/aac-bridge/examples/aac-app.html`)).status, 200);
    assert.equal((await fetch(`${http}/aac-bridge/src/index.js`)).status, 200);
    assert.equal((await fetch(`${http}/aac-bridge/relay/server.js`)).status, 404);
    assert.equal((await fetch(`${http}/.secret`)).status, 404);
    assert.equal((await fetch(`${http}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
    assert.equal((await fetch(`${http}/..%2f..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${http}/healthz`)).status, 200);
    assert.equal((await fetch(`${http}/pairings`, { method: "POST" })).status, 201);
  } finally {
    await relay.close();
  }
  const plain = await start();
  try {
    assert.equal((await fetch(`${plain.http}/aac-bridge/examples/aac-app.html`)).status, 404);
  } finally {
    await plain.relay.close();
  }
});
