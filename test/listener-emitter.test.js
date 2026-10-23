import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT,
  createEvent,
  createAacEmitter,
  createAacListener,
  memoryLink,
  broadcastTransport,
  postMessageTransport,
} from "../src/index.js";

const app = { app: "test-aac", version: "1.0.0", lang: "en" };

function collect(listener, names) {
  const got = [];
  for (const n of names) listener.on(n, (d) => got.push([n, d]));
  return got;
}

test("emitter sends nothing until enabled, then hello first", () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener, vocabulary: ["yes"] });
  const got = collect(listener, ["hello", "word"]);
  const out = createAacEmitter({ app, transport: link.sender });
  assert.equal(out.symbol({ text: "yes" }), false);
  assert.equal(got.length, 0);
  out.enable();
  out.symbol({ text: "Yes" }, { boardId: "root" });
  assert.deepEqual(got.map(([n]) => n), ["hello", "word"]);
  assert.equal(got[1][1].word, "yes");
  assert.equal(got[1][1].boardId, "root");
  assert.equal(listener.source.app, "test-aac");
  out.disable();
  assert.equal(out.symbol({ text: "yes" }), false);
});

test("word fires only for vocabulary words; symbol fires for all", () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener, vocabulary: ["jump"] });
  const got = collect(listener, ["symbol", "word"]);
  const out = createAacEmitter({ app, transport: link.sender });
  out.enable();
  out.symbol({ text: "cat" });
  out.symbol({ text: "jump" });
  assert.deepEqual(got.map(([n, d]) => `${n}:${d.text}`), ["symbol:cat", "symbol:jump", "word:jump"]);
});

test("without a vocabulary every symbol is a word", () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener });
  const got = collect(listener, ["word"]);
  const out = createAacEmitter({ app, transport: link.sender });
  out.enable();
  out.symbol({ text: "Banana!" });
  assert.equal(got[0][1].word, "banana");
});

test("phrase reports matched words in order", () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener, vocabulary: ["more", "juice"] });
  const got = collect(listener, ["phrase"]);
  const out = createAacEmitter({ app, transport: link.sender });
  out.enable();
  out.phrase("I want more juice", [{ text: "I" }, { text: "want" }, { text: "more" }, { text: "juice" }]);
  assert.deepEqual(got[0][1].words, ["more", "juice"]);
});

test("duplicates are dropped and gaps reported", () => {
  const listener = createAacListener({ vocabulary: ["a"] });
  const got = collect(listener, ["word", "gap"]);
  const mk = (seq, id) => createEvent(EVENT.SYMBOL, { symbol: { text: "a" } }, { session: "s1", seq, id, source: app });
  listener.inject(mk(0, "x0"));
  listener.inject(mk(0, "x0"));
  listener.inject(mk(3, "x3"));
  assert.deepEqual(got.map(([n]) => n), ["word", "gap", "word"]);
  assert.deepEqual(got[1][1], { session: "s1", expected: 1, got: 3 });
});

test("invalid messages go to onInvalid, not to handlers", () => {
  const reasons = [];
  const listener = createAacListener({ onInvalid: (r) => reasons.push(r) });
  const got = collect(listener, ["*"]);
  listener.inject({ source: "cboard", type: "tile:select" });
  listener.inject("garbage");
  assert.equal(got.length, 0);
  assert.equal(reasons.length, 2);
});

test("a throwing handler does not stop the others", () => {
  const listener = createAacListener();
  let reached = false;
  const orig = console.error;
  console.error = () => {};
  listener.on("word", () => {
    throw new Error("boom");
  });
  listener.on("word", () => {
    reached = true;
  });
  listener.inject(createEvent(EVENT.SYMBOL, { symbol: { text: "x" } }, { source: app }));
  console.error = orig;
  assert.equal(reached, true);
});

test("emitter refuses to send invalid events", () => {
  const link = memoryLink();
  const out = createAacEmitter({ app, transport: link.sender });
  out.enable();
  assert.throws(() => out.symbol({ key: "no-text" }), /invalid symbol.select/);
});

test("postMessageTransport refuses '*' and filters by origin", () => {
  assert.throws(() => postMessageTransport({ origin: "*", win: new EventTarget() }), /not allowed/);
  const win = new EventTarget();
  const listener = createAacListener({ transport: postMessageTransport({ origin: "https://aac.example", win }) });
  const got = collect(listener, ["word"]);
  const ev = createEvent(EVENT.SYMBOL, { symbol: { text: "hi" } }, { source: app });
  win.dispatchEvent(new MessageEvent("message", { data: ev, origin: "https://evil.example" }));
  win.dispatchEvent(new MessageEvent("message", { data: { ...ev, id: "other" }, origin: "https://aac.example" }));
  assert.equal(got.length, 1);
  listener.close();
});

test("disable() stops every transport so queued speech is discarded", () => {
  const log = [];
  const fake = {
    name: "fake",
    queued: [],
    started: 0,
    stopped: 0,
    start() {
      this.started++;
    },
    send(e) {
      this.queued.push(e);
    },
    stop() {
      this.stopped++;
      this.queued = [];
      log.push("stop");
    },
  };
  const out = createAacEmitter({ app, transport: fake });
  out.enable();
  out.symbol({ text: "private" });
  out.disable();
  assert.equal(fake.stopped, 1);
  assert.deepEqual(fake.queued, []);
  assert.equal(out.symbol({ text: "after" }), false);
  out.enable();
  assert.equal(fake.started, 2, "re-enable restarts transports");
});

test("messages after a session says bye are ignored", () => {
  const link = memoryLink();
  const listener = createAacListener({ transport: link.listener });
  const words = [];
  listener.on("word", (d) => words.push(d.word));
  const s = { session: "s9", source: app };
  listener.inject(createEvent(EVENT.HELLO, { capabilities: [] }, { ...s, seq: 0 }));
  listener.inject(createEvent(EVENT.SYMBOL, { symbol: { text: "one" } }, { ...s, seq: 1 }));
  listener.inject(createEvent(EVENT.BYE, {}, { ...s, seq: 2 }));
  listener.inject(createEvent(EVENT.SYMBOL, { symbol: { text: "late" } }, { ...s, seq: 3 }));
  assert.deepEqual(words, ["one"]);
  assert.equal(listener.source, null);
});

test("stale selections expire, measured with the session's clock offset", () => {
  const listener = createAacListener({ maxAgeMs: 2000 });
  const words = [];
  const stale = [];
  listener.on("word", (d) => words.push(d.word));
  listener.on("stale", (d) => stale.push(Math.round(d.ageMs / 1000)));
  const now = Date.now();
  // Sender clock runs 60 s ahead; the first message arrives promptly.
  const skew = 60_000;
  const s = { session: "clock", source: app };
  listener.inject(createEvent(EVENT.HELLO, { capabilities: [] }, { ...s, seq: 0, ts: now + skew }));
  listener.inject(createEvent(EVENT.SYMBOL, { symbol: { text: "fresh" } }, { ...s, seq: 1, ts: now + skew }));
  // This one was created 10 s ago by the sender's clock: it sat in a queue.
  listener.inject(createEvent(EVENT.SYMBOL, { symbol: { text: "late" } }, { ...s, seq: 2, ts: now + skew - 10_000 }));
  assert.deepEqual(words, ["fresh"]);
  assert.deepEqual(stale, [10]);
});

test("broadcastTransport delivers between channels", async () => {
  const listener = createAacListener({ transport: broadcastTransport({ channel: "t1" }) });
  const out = createAacEmitter({ app, transport: broadcastTransport({ channel: "t1" }) });
  const words = [];
  listener.on("word", (d) => words.push(d.word));
  out.enable();
  out.symbol({ text: "go" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(words, ["go"]);
  out.close();
  listener.close();
});
