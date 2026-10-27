import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT, createEvent, createAacEmitter, createAacListener, memoryLink, vocabularyWords } from "../src/index.js";

const app = { app: "test-aac", version: "1.0.0", lang: "en" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a sharing app repeats its hello, so a listener that starts late learns sharing is on", async () => {
  const link = memoryLink();
  const out = createAacEmitter({ app, transport: link.sender, helloEveryMs: 40 });
  out.enable();
  // The game page opens after sharing started: it missed the first hello.
  const late = createAacListener({ transport: link.listener });
  const hellos = [];
  late.on("hello", (d) => hellos.push(d));
  await wait(110);
  assert.ok(hellos.length >= 2, `got ${hellos.length} hellos`);
  assert.equal(hellos[0].repeat, false);
  assert.equal(hellos[1].repeat, true);
  assert.ok(late.source.capabilities.includes("session.heartbeat"));
  out.disable();
  late.close();
});

test("a heartbeat sender that goes quiet without a bye is reported lost", async () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener, quietMs: 60 });
  const lost = [];
  listener.on("lost", (d) => lost.push(d.session));
  const out = createAacEmitter({ app, transport: link.sender, helloEveryMs: 20 });
  out.enable();
  await wait(100);
  assert.equal(lost.length, 0, "still alive while hellos keep coming");
  // Simulate a closed tab: stop the heartbeat without sending bye.
  link.sender.send = () => {};
  await wait(120);
  assert.equal(lost.length, 1);
  assert.equal(listener.source, null);
  out.disable();
  listener.close();
});

test("an old sender without the heartbeat capability is never reported lost", async () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener, quietMs: 30 });
  const lost = [];
  listener.on("lost", () => lost.push(1));
  link.sender.send(createEvent(EVENT.HELLO, { capabilities: ["symbol.select"] }, { session: "old", seq: 0, source: app }));
  await wait(80);
  assert.equal(lost.length, 0);
  assert.equal(listener.source.app, "test-aac");
  listener.close();
});

test("a replayed hello sets the source without skewing gaps or the stale check", () => {
  const old = createEvent(EVENT.HELLO, { capabilities: [] }, { session: "s", seq: 0, ts: Date.now() - 60_000, source: app });
  const t = { name: "relay", start(h) { this.h = h; }, stop() {} };
  const l2 = createAacListener({ transport: t, vocabulary: ["go"] });
  const g2 = { gap: 0, stale: 0, words: [], hello: [] };
  l2.on("gap", () => g2.gap++);
  l2.on("stale", () => g2.stale++);
  l2.on("word", (d) => g2.words.push(d.word));
  l2.on("hello", (d) => g2.hello.push(d.replay));
  t.h.message(old, { replay: true });
  t.h.message(createEvent(EVENT.SYMBOL, { symbol: { text: "go" } }, { session: "s", seq: 41, source: app }), {});
  assert.deepEqual(g2.hello, [true]);
  assert.deepEqual(g2.words, ["go"]);
  assert.equal(g2.gap, 0);
  assert.equal(g2.stale, 0);
  // Only a hello may be replayed.
  t.h.message(createEvent(EVENT.SYMBOL, { symbol: { text: "go" } }, { session: "s", seq: 42, source: app }), { replay: true });
  assert.deepEqual(g2.words, ["go"]);
  l2.close();
});

test("limitTo shares only the game's words, and can be changed while sharing", () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener });
  const got = [];
  listener.on("symbol", (d) => got.push(d.symbol.text));
  listener.on("phrase", (d) => got.push(`phrase:${d.text}`));
  listener.on("board", (d) => got.push(`board:${d.boardId}`));
  const out = createAacEmitter({ app, transport: link.sender, helloEveryMs: 0, limitTo: ["go", { word: "pop", synonyms: ["burst"] }] });
  out.enable();
  assert.equal(out.limited, true);
  assert.ok(listener.source.capabilities.includes("sharing.limited"));
  assert.equal(out.symbol({ text: "hungry" }), false);
  assert.equal(out.symbol({ text: "burst" }), true);
  assert.equal(out.symbol({ text: "x", key: "cboard.symbol.go" }), true);
  assert.equal(out.board("food"), false);
  assert.equal(out.phrase("I feel sad", [{ text: "I" }, { text: "feel" }, { text: "sad" }]), false);
  out.phrase("go go now", [{ text: "go" }, { text: "go" }, { text: "now" }]);
  out.limitTo(null);
  assert.equal(out.limited, false);
  assert.ok(!listener.source.capabilities.includes("sharing.limited"));
  out.symbol({ text: "hungry" });
  assert.deepEqual(got, ["burst", "x", "phrase:go go", "hungry"]);
  out.disable();
});

test("vocabularyWords flattens entries for a pairing", () => {
  assert.deepEqual(vocabularyWords(["go", { word: "pop", synonyms: ["burst", "go"] }, "", { word: "x".repeat(65) }]), ["go", "pop", "burst"]);
  assert.equal(vocabularyWords(undefined), undefined);
});
