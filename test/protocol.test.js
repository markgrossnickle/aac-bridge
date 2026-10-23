import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT, createEvent, validateEvent } from "../src/index.js";

const src = { app: "test", lang: "en" };

test("accepts a valid symbol event and strips unknown fields", () => {
  const e = createEvent(
    EVENT.SYMBOL,
    { symbol: { text: "yes", key: "cboard.symbol.yes", secret: "x", image: "https://x/y.svg" }, boardId: "root", extra: 1 },
    { source: src },
  );
  const r = validateEvent(e);
  assert.equal(r.ok, true);
  assert.deepEqual(r.event.symbol, { text: "yes", key: "cboard.symbol.yes", image: "https://x/y.svg" });
  assert.equal(r.event.extra, undefined);
});

test("accepts JSON strings", () => {
  const e = createEvent(EVENT.PHRASE, { text: "I want more", symbols: [{ text: "I" }, { text: "want" }, { text: "more" }] }, { source: src });
  assert.equal(validateEvent(JSON.stringify(e)).ok, true);
});

const bad = [
  ["other protocol", (e) => (e.protocol = "cboard"), /not an aac-bridge/],
  ["future version", (e) => (e.v = 2), /unsupported version/],
  ["unknown type", (e) => (e.type = "tile:select"), /unknown type/],
  ["missing symbol text", (e) => (e.symbol = { key: "k" }), /bad symbol.select/],
  ["relative image url", (e) => (e.symbol = { text: "a", image: "/symbols/a.svg" }), /bad symbol.select/],
  ["javascript image url", (e) => (e.symbol = { text: "a", image: "javascript:alert(1)" }), /bad symbol.select/],
  ["negative seq", (e) => (e.seq = -1), /bad seq/],
  ["no source app", (e) => (e.source = {}), /bad source/],
  ["huge text", (e) => (e.symbol = { text: "x".repeat(501) }), /bad symbol.select/],
];

for (const [name, mutate, reason] of bad) {
  test(`rejects ${name}`, () => {
    const e = createEvent(EVENT.SYMBOL, { symbol: { text: "yes" } }, { source: src });
    mutate(e);
    const r = validateEvent(e);
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
  });
}

test("rejects non-objects and bad JSON", () => {
  for (const x of [null, 3, [], "nope", "{"]) assert.equal(validateEvent(x).ok, false);
});
