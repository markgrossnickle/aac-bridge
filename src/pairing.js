// Pairing with an aac-bridge relay (see relay/server.js).
//
// By code (works anywhere):
//   Game:     const p = await createPairing({ relay, name, remember: true }); // show p.code (and a QR of pairingLink())
//   AAC app:  const s = await claimPairing({ relay, code });                  // typed, or read from the QR
//
// Tap to allow (same Wi-Fi, a local relay with discovery on):
//   Game:     const p = await createPairing({ relay, name, discoverable: true, remember: true });
//             listener.on("request", ({ id, app, device }) => ask("Allow?") ? listener.approve(id) : listener.deny(id));
//   AAC app:  const games = await listGames({ relay });                       // show the list, user taps one
//             const s = await requestPairing({ relay, game: games[0].id, app: "cboard", device: "Kitchen tablet" });
//
// Either:     await revokePairing({ relay, token });                          // disconnects both sides for good
//
// `relay` is the relay's base URL, https://... (or http:// on a local network).
// Tokens are secrets: keep them in app storage, never in a URL or a log.

function base(relay) {
  if (typeof relay !== "string" || !/^https?:\/\//i.test(relay)) {
    throw new Error("pairing: relay must be the relay base URL, starting with https:// (or http:// on a local network)");
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
 * Game side: ask the relay for a pairing.
 * Returns { code, listenerToken, codeExpiresAt, expiresAt, discoverable, remembered }.
 * @param {object} opts
 * @param {string} opts.relay
 * @param {Array|object} [opts.vocabulary] the game's words, so the AAC app can share only those
 * @param {string} [opts.name] shown in the AAC app's list of nearby games and after pairing
 * @param {boolean} [opts.discoverable] list this game for tap-to-allow pairing (local relays only)
 * @param {boolean} [opts.remember] keep the pairing until someone revokes it (90 days after last use)
 */
export function createPairing({ relay, vocabulary, name, discoverable, remember, fetchImpl } = {}) {
  const words = vocabularyWords(vocabulary);
  const body = {};
  if (words && words.length) body.vocabulary = words;
  if (name) body.name = String(name);
  if (discoverable) body.discoverable = true;
  if (remember) body.remember = true;
  return call(fetchImpl, `${base(relay)}/pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * AAC app side: claim the code the user entered or scanned.
 * Returns { senderToken, expiresAt, remembered, vocabulary?, name? }. Pass
 * `vocabulary` to the emitter's `limitTo()` if the user chose to share only
 * the game's words.
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

/** AAC app side: games waiting to be paired on this (local) relay. Returns [{ id, name }]. */
export async function listGames({ relay, fetchImpl } = {}) {
  const body = await call(fetchImpl, `${base(relay)}/games`, { method: "GET" });
  return Array.isArray(body.games) ? body.games : [];
}

/**
 * AAC app side: ask a listed game to pair, and wait while the game asks its
 * user "Allow?". Resolves like claimPairing() once allowed; rejects with an
 * error whose `reason` is "denied" or "timeout".
 * @param {object} opts
 * @param {string} opts.relay
 * @param {string} opts.game  an id from listGames()
 * @param {string} opts.app   your app's name, shown on the game's screen
 * @param {string} [opts.device] a name for this device, shown too ("Kitchen tablet")
 * @param {number} [opts.pollMs] how often to check (default 1000)
 * @param {AbortSignal} [opts.signal] stop waiting
 */
export async function requestPairing({ relay, game, app, device, pollMs = 1000, signal, fetchImpl } = {}) {
  if (!game || !app) throw new Error("pairing: game and app are required");
  const started = await call(fetchImpl, `${base(relay)}/pairings/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(device ? { game, app, device } : { game, app }),
    signal,
  });
  const url = `${base(relay)}/pairings/request/${encodeURIComponent(started.requestId)}`;
  const headers = { Authorization: `Bearer ${started.pollToken}` };
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error("pairing: cancelled"), { reason: "cancelled" });
    if (Date.now() > started.expiresAt) throw Object.assign(new Error("pairing: the game did not answer in time"), { reason: "timeout" });
    let body;
    try {
      body = await call(fetchImpl, url, { method: "GET", headers, signal });
    } catch (err) {
      if (err.status === 404) throw Object.assign(new Error("pairing: the request expired"), { reason: "timeout" });
      throw err;
    }
    if (body.status === "approved") {
      const { status, ...rest } = body;
      return rest;
    }
    if (body.status === "denied") throw Object.assign(new Error("pairing: the game said no"), { reason: "denied" });
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A link to put in a QR code next to the 6-digit code. Opening it shows the
 * AAC page with the code filled in; it never pairs or shares by itself (the
 * user still confirms, then turns sharing on). AAC apps that scan the QR read
 * it back with parsePairingLink(). `page` defaults to the relay's example AAC
 * page (served in local play).
 */
export function pairingLink({ relay, code, page } = {}) {
  const clean = String(code ?? "").replace(/\D/g, "");
  if (clean.length !== 6) throw new Error("pairing: the code has 6 digits");
  const target = page ?? `${base(relay)}/aac-bridge/examples/aac-app.html`;
  return `${target}#aac-pair=${clean}&relay=${encodeURIComponent(base(relay))}`;
}

/** Read { relay, code } back from a pairing link (or a bare 6-digit code, with relay null). */
export function parsePairingLink(text) {
  const s = String(text ?? "").trim();
  if (/^\d{3}\s?\d{3}$/.test(s)) return { relay: null, code: s.replace(/\D/g, "") };
  const hashAt = s.indexOf("#");
  if (hashAt < 0) return null;
  const params = new URLSearchParams(s.slice(hashAt + 1));
  const code = (params.get("aac-pair") ?? "").replace(/\D/g, "");
  const relay = params.get("relay");
  if (code.length !== 6 || !relay || !/^https?:\/\//i.test(relay)) return null;
  return { relay: relay.replace(/\/+$/, ""), code };
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
