import { test } from "node:test";
import assert from "node:assert/strict";
import { pairingLink, parsePairingLink } from "../src/index.js";

test("a pairing link round-trips the relay and code", () => {
  const link = pairingLink({ relay: "http://192.168.1.20:8787/", code: "123 456" });
  assert.equal(link, "http://192.168.1.20:8787/aac-bridge/examples/aac-app.html#aac-pair=123456&relay=http%3A%2F%2F192.168.1.20%3A8787");
  assert.deepEqual(parsePairingLink(link), { relay: "http://192.168.1.20:8787", code: "123456" });
});

test("a pairing link can point at another AAC page", () => {
  const link = pairingLink({ relay: "https://relay.example.org", code: "000123", page: "https://app.example/pair" });
  assert.equal(link.startsWith("https://app.example/pair#aac-pair=000123&relay="), true);
  assert.deepEqual(parsePairingLink(link), { relay: "https://relay.example.org", code: "000123" });
});

test("parsePairingLink accepts a bare code and refuses anything else", () => {
  assert.deepEqual(parsePairingLink("123 456"), { relay: null, code: "123456" });
  assert.equal(parsePairingLink("https://x.example/#aac-pair=12345&relay=https%3A%2F%2Fr.example"), null);
  assert.equal(parsePairingLink("https://x.example/#aac-pair=123456&relay=javascript%3Aalert(1)"), null);
  assert.equal(parsePairingLink("https://x.example/?aac-pair=123456"), null);
  assert.equal(parsePairingLink(""), null);
  assert.throws(() => pairingLink({ relay: "https://r.example", code: "12" }));
});
