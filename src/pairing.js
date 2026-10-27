// Pairing with an aac-bridge relay (see relay/server.js).
//
//   Game:     const p = await createPairing({ relay });     // show p.code to the user, keep p.listenerToken
//   AAC app:  const s = await claimPairing({ relay, code }); // user typed or scanned the code; keep s.senderToken
//   Either:   await revokePairing({ relay, token });         // disconnects both sides for good
//
// `relay` is the relay's base URL, https://... (or http://localhost in development).
// Tokens are secrets: keep them in app storage, never in a URL or a log.

function base(relay) {
  if (typeof relay !== "string" || !/^https?:\/\//i.test(relay)) {
    throw new Error("pairing: relay must be the relay base URL, starting with https:// (or http:// for local development)");
  }
  return relay.replace(/\/+$/, "");
}

/** The WebSocket URL for a relay base URL. */
export function relaySocketUrl(relay) {
  return base(relay).replace(/^http/i, "ws") + "/";
}

async function call(fetchImpl, url, init) {
  const f = fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("pairing: no fetch implementation");
  const res = await f(url, { ...init, cache: "no-store", credentials: "omit" });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(body.error || `relay answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Flatten vocabulary entries (strings or { word, synonyms }) into a short list of plain words. */
export function vocabularyWords(entries) {
  if (!entries) return undefined;
  const list = Array.isArray(entries) ? entries : entries.words;
  const out = new Set();
  for (const e of list ?? []) {
    const forms = typeof e === "string" ? [e] : e && typeof e.word === "string" ? [e.word, ...(e.synonyms ?? [])] : [];
    for (const f of forms) if (typeof f === "string" && f.trim() && f.length <= PAIRING_WORD_MAX) out.add(f.trim());
  }
  return [...out].slice(0, PAIRING_WORDS_MAX);
}
export const PAIRING_WORDS_MAX = 300;
export const PAIRING_WORD_MAX = 64;

/**
 * Game side: ask the relay for a pairing. Returns { code, listenerToken, codeExpiresAt, expiresAt }.
 * Pass `vocabulary` (the words the game understands) so the AAC app can offer
 * "share only the game's words"; it is handed to the AAC app when it claims.
 */
export function createPairing({ relay, vocabulary, fetchImpl } = {}) {
  const words = vocabularyWords(vocabulary);
  return call(fetchImpl, `${base(relay)}/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(words && words.length ? { vocabulary: words } : {}),
  });
}

/**
 * AAC app side: claim the code the user entered. Returns { senderToken, expiresAt, vocabulary? }.
 * `vocabulary` is the game's word list, when the game sent one: pass it to
 * the emitter's `limitTo()` if the user chose to share only those words.
 */
export function claimPairing({ relay, code, fetchImpl } = {}) {
  const clean = String(code ?? "").replace(/\D/g, "");
  if (clean.length !== 6) return Promise.reject(new Error("pairing: the code has 6 digits"));
  return call(fetchImpl, `${base(relay)}/pairings/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: clean }),
  });
}

/** Either side: end the pairing. Both tokens stop working and both sides are disconnected. */
export async function revokePairing({ relay, token, fetchImpl } = {}) {
  if (!token) throw new Error("pairing: token required");
  try {
    await call(fetchImpl, `${base(relay)}/pairings`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    if (err.status !== 404) throw err; // already gone counts as revoked
  }
}
