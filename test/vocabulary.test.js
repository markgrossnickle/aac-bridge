import { test } from "node:test";
import assert from "node:assert/strict";
import { createVocabulary, normalizeWord, keyWord } from "../src/index.js";

test("normalizeWord lowercases and strips punctuation, keeps letters of any script", () => {
  assert.equal(normalizeWord("  Yes!! "), "yes");
  assert.equal(normalizeWord("I'm   hungry."), "i m hungry");
  assert.equal(normalizeWord("¿Más?"), "más");
  assert.equal(normalizeWord("水"), "水");
});

test("keyWord takes the last segment of a key", () => {
  assert.equal(keyWord("cboard.symbol.yes"), "yes");
  assert.equal(keyWord("symbols/ice_cream"), "ice cream");
  assert.equal(keyWord(undefined), "");
});

test("vocabulary matches text, vocalization, key, synonyms and explicit keys", () => {
  const v = createVocabulary(["yes", { word: "no", synonyms: ["nope"] }, { word: "jump", keys: ["custom:42"] }]);
  assert.equal(v.match("YES"), "yes");
  assert.equal(v.match({ text: "Nope" }), "no");
  assert.equal(v.match({ text: "sí", key: "cboard.symbol.yes" }), "yes");
  assert.equal(v.match({ text: "saltar", key: "custom:42" }), "jump");
  assert.equal(v.match({ text: "hop", vocalization: "jump" }), "jump");
  assert.equal(v.match({ text: "cat" }), null);
  assert.deepEqual(v.words, ["yes", "no", "jump"]);
});

test("vocabulary rejects empty entries", () => {
  assert.throws(() => createVocabulary([""]));
});
