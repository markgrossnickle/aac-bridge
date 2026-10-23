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
 */
export function createAacListener({ transport, transports, vocabulary, onInvalid, maxAgeMs = 5000 } = {}) {
  const list = transports ?? (transport ? [transport] : []);
  const vocab = vocabulary && typeof vocabulary.match === "function" ? vocabulary : vocabulary ? createVocabulary(vocabulary) : null;
  const handlers = new Map();
  const seen = new Set();
  const seenOrder = [];
  const lastSeq = new Map();
  const clockOffset = new Map(); // session -> smallest (arrival - ts) seen
  const ended = new Set(); // sessions that said bye; later messages are ignored
  const statuses = new Map();
  let source = null;
  let closed = false;

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
    if (seen.has(e.id)) return;
    remember(e.id);
    if (ended.has(e.session)) return;

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

    switch (e.type) {
      case EVENT.HELLO:
        source = { ...e.source, capabilities: e.capabilities, session: e.session };
        emit("hello", { source, event: e });
        break;
      case EVENT.BYE:
        ended.add(e.session);
        if (source && source.session === e.session) source = null;
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
        emit("status", { state: overall(), transport: t.name, transportState: state, detail });
      },
    });
  });

  return {
    /** Subscribe: "word", "symbol", "phrase", "board", "hello", "bye", "status", "gap", "stale", or "*". Returns an unsubscribe function. */
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
    /** "idle" | "connecting" | "open" | "error" | "closed" across all transports. */
    get status() {
      return overall();
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
      for (const t of list) t.stop();
      handlers.clear();
    },
  };
}
