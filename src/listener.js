// The game side. Wraps one or more transports, validates every message,
// drops duplicates, notices gaps, and turns symbol selections into words the
// game understands.
//
//   const aac = createAacListener({ transport, vocabulary: ["yes", "no", "jump"] });
//   aac.on("word", ({ word }) => { if (word === "jump") player.jump(); });

import { EVENT, validateEvent } from "./protocol.js";
import { createVocabulary, normalizeWord } from "./vocabulary.js";

const RECENT_IDS = 500;

/**
 * @param {object} opts
 * @param {object} [opts.transport]   one transport
 * @param {object[]} [opts.transports] several transports (all are listened to)
 * @param {Array|object} [opts.vocabulary] word list, or a createVocabulary() result
 * @param {(reason: string, raw: unknown) => void} [opts.onInvalid] called for rejected messages
 * @param {number} [opts.maxAgeMs] drop selections older than this (default 5000; 0 disables).
 *   Measured against the sender's clock with the session's clock offset removed,
 *   so devices with different clocks still work.
 * @param {number} [opts.quietMs] for a sender that advertises "session.heartbeat",
 *   emit "lost" after this long without hearing from it (default 35000; 0 disables).
 */
export function createAacListener({ transport, transports, vocabulary, onInvalid, maxAgeMs = 5000, quietMs = 35_000 } = {}) {
  const list = transports ?? (transport ? [transport] : []);
  const vocab = vocabulary && typeof vocabulary.match === "function" ? vocabulary : vocabulary ? createVocabulary(vocabulary) : null;
  const handlers = new Map();
  const seen = new Set();
  const seenOrder = [];
  const lastSeq = new Map();
  const clockOffset = new Map(); // session -> smallest (arrival - ts) seen
  const ended = new Set(); // sessions that said bye; later messages are ignored
  const statuses = new Map(); // transport index -> state
  const presence = new Map(); // transport name -> boolean, for transports that know
  let source = null;
  let closed = false;
  let quietTimer = null;

  // A sender that advertises "session.heartbeat" repeats session.hello while
  // sharing. If it goes quiet for `quietMs`, it is gone (closed tab, lost
  // network) even though it never said bye: emit "lost".
  const armQuiet = () => {
    clearTimeout(quietTimer);
    quietTimer = null;
    if (!source || !quietMs || !source.capabilities?.includes("session.heartbeat")) return;
    const session = source.session;
    quietTimer = setTimeout(() => {
      if (closed || !source || source.session !== session) return;
      source = null;
      emit("lost", { session });
    }, quietMs);
    quietTimer.unref?.();
  };

  const emit = (name, detail) => {
    for (const key of [name, "*"]) {
      for (const fn of handlers.get(key) ?? []) {
        try {
          fn(detail, name);
        } catch (err) {
          // A broken game handler must not stop other handlers.
          (globalThis.console?.error ?? (() => {}))("[aac-bridge] handler error", err);
        }
      }
    }
  };

  const remember = (id) => {
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > RECENT_IDS) seen.delete(seenOrder.shift());
  };

  const matchWord = (symbol) => (vocab ? vocab.match(symbol) : normalizeWord(symbol.text) || null);

  const receive = (raw, meta = {}) => {
    if (closed) return;
    const res = validateEvent(raw);
    if (!res.ok) {
      onInvalid?.(res.reason, raw);
      return;
    }
    const e = res.event;
    // A replay is the relay handing a late-joining listener the sender's
    // current session.hello. Only a hello may be replayed, and its old ts and
    // seq must not skew the stale check or report a gap.
    const replay = meta.replay === true;
    if (replay && e.type !== EVENT.HELLO) return;
    // A replay is exempt from duplicate dropping: after this listener's relay
    // link drops and comes back, the relay replays a hello it already saw, and
    // that is exactly how it learns sharing is still on. A hello acts on no
    // game state, so seeing it twice is harmless.
    if (seen.has(e.id) && !replay) return;
    if (!seen.has(e.id)) remember(e.id);
    if (ended.has(e.session)) return;

    if (!replay) {
      // Stale check: a command that arrives seconds late (queued behind a bad
      // connection) would act on a game state the player no longer sees.
      const arrival = Date.now();
      const offset = Math.min(clockOffset.get(e.session) ?? Infinity, arrival - e.ts);
      clockOffset.set(e.session, offset);
      const age = arrival - e.ts - offset;
      if (maxAgeMs > 0 && age > maxAgeMs && (e.type === EVENT.SYMBOL || e.type === EVENT.PHRASE || e.type === EVENT.BOARD)) {
        emit("stale", { ageMs: age, event: e });
        return;
      }

      const prev = lastSeq.get(e.session);
      if (prev !== undefined && e.seq > prev + 1) emit("gap", { session: e.session, expected: prev + 1, got: e.seq });
      if (prev === undefined || e.seq > prev) lastSeq.set(e.session, e.seq);
    }

    if (source && source.session === e.session) armQuiet();

    switch (e.type) {
      case EVENT.HELLO: {
        const repeat = Boolean(source && source.session === e.session);
        source = { ...e.source, capabilities: e.capabilities, session: e.session };
        armQuiet();
        emit("hello", { source, repeat, replay, event: e });
        break;
      }
      case EVENT.BYE:
        ended.add(e.session);
        if (source && source.session === e.session) {
          source = null;
          armQuiet();
        }
        emit("bye", { session: e.session, event: e });
        break;
      case EVENT.SYMBOL: {
        const word = matchWord(e.symbol);
        const detail = { symbol: e.symbol, boardId: e.boardId, word, text: normalizeWord(e.symbol.text), source: e.source, event: e, meta };
        emit("symbol", detail);
        if (word) emit("word", detail);
        break;
      }
      case EVENT.BOARD:
        emit("board", { boardId: e.boardId, fromBoardId: e.fromBoardId, symbol: e.symbol, event: e });
        break;
      case EVENT.PHRASE: {
        const words = e.symbols.map(matchWord).filter(Boolean);
        emit("phrase", { text: e.text, symbols: e.symbols, words, event: e });
        break;
      }
    }
  };

  const overall = () => {
    const values = [...statuses.values()];
    if (values.includes("open")) return "open";
    if (values.length && values.every((v) => v === "revoked" || v === "unauthorized")) return values.includes("revoked") ? "revoked" : "unauthorized";
    if (values.includes("connecting")) return "connecting";
    if (values.includes("error")) return "error";
    return values.length ? "closed" : "idle";
  };

  list.forEach((t, i) => {
    t.start({
      message: receive,
      status: (state, detail) => {
        statuses.set(i, state);
        if (state !== "open") presence.delete(t.name);
        emit("status", { state: overall(), transport: t.name, transportState: state, detail });
      },
      presence: (present) => {
        presence.set(t.name, present);
        emit("presence", { present, transport: t.name });
      },
    });
  });

  return {
    /**
     * Subscribe: "word", "symbol", "phrase", "board", "hello", "bye", "lost",
     * "presence", "status", "gap", "stale", or "*". Returns an unsubscribe function.
     */
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    off(name, fn) {
      handlers.get(name)?.delete(fn);
    },
    /** Feed a message in directly (tests, dev panel, a keyboard on the same page). */
    inject(raw) {
      receive(raw, { injected: true });
    },
    /**
     * Channel availability across all transports: "open" if any transport is
     * open. It does NOT mean an AAC app is connected or sharing; use
     * statusOf(name) for one transport's lifecycle (a revoked relay), and
     * "hello" / "presence" / "bye" / "lost" for whether someone is sharing.
     */
    get status() {
      return overall();
    },
    /** One transport's state by name ("relay", "broadcast", ...), or undefined. */
    statusOf(name) {
      const i = list.findIndex((t) => t.name === name);
      return i < 0 ? undefined : statuses.get(i);
    },
    /** Whether a transport that can tell (the relay) says the AAC app is connected: true, false, or undefined. */
    presenceOf(name) {
      return presence.get(name);
    },
    /** What the AAC app said about itself in session.hello, or null. */
    get source() {
      return source;
    },
    get vocabulary() {
      return vocab;
    },
    close() {
      closed = true;
      clearTimeout(quietTimer);
      for (const t of list) t.stop();
      handlers.clear();
    },
  };
}
