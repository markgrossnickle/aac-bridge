// The aac-bridge wire protocol: one JSON envelope, a major version, and a short
// list of event types. Transports carry these objects unchanged. See PROTOCOL.md.

export const PROTOCOL = "aac-bridge";
export const VERSION = 1;

export const EVENT = Object.freeze({
  HELLO: "session.hello",
  BYE: "session.bye",
  SYMBOL: "symbol.select",
  BOARD: "board.change",
  PHRASE: "phrase.speak",
});

const KNOWN_TYPES = new Set(Object.values(EVENT));

export const LIMITS = Object.freeze({
  text: 500,
  short: 128,
  url: 2048,
  symbols: 100,
  capabilities: 32,
});

/** A random id; uses crypto.randomUUID where available. */
export function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function str(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function optStr(v, max) {
  return v === undefined || v === null || str(v, max);
}

function imageUrl(v) {
  if (v === undefined || v === null) return true;
  if (!str(v, LIMITS.url)) return false;
  return /^https?:\/\//i.test(v);
}

/** Copy only the known, valid fields of a symbol. Returns null if invalid. */
export function cleanSymbol(s) {
  if (!s || typeof s !== "object") return null;
  if (!str(s.text, LIMITS.text)) return null;
  if (!optStr(s.key, LIMITS.short) || !optStr(s.id, LIMITS.short)) return null;
  if (!optStr(s.vocalization, LIMITS.text) || !imageUrl(s.image)) return null;
  const out = { text: s.text };
  if (s.key) out.key = s.key;
  if (s.id) out.id = s.id;
  if (s.vocalization) out.vocalization = s.vocalization;
  if (s.image) out.image = s.image;
  return out;
}

function cleanSource(s) {
  if (!s || typeof s !== "object" || !str(s.app, LIMITS.short)) return null;
  if (!optStr(s.version, LIMITS.short) || !optStr(s.lang, 35)) return null;
  const out = { app: s.app };
  if (s.version) out.version = s.version;
  if (s.lang) out.lang = s.lang;
  return out;
}

function cleanPayload(type, e) {
  switch (type) {
    case EVENT.SYMBOL: {
      const symbol = cleanSymbol(e.symbol);
      if (!symbol || !optStr(e.boardId, LIMITS.short)) return null;
      return e.boardId ? { symbol, boardId: e.boardId } : { symbol };
    }
    case EVENT.BOARD: {
      if (!str(e.boardId, LIMITS.short) || !optStr(e.fromBoardId, LIMITS.short)) return null;
      const out = { boardId: e.boardId };
      if (e.fromBoardId) out.fromBoardId = e.fromBoardId;
      if (e.symbol !== undefined) {
        const symbol = cleanSymbol(e.symbol);
        if (!symbol) return null;
        out.symbol = symbol;
      }
      return out;
    }
    case EVENT.PHRASE: {
      if (typeof e.text !== "string" || e.text.length > LIMITS.text) return null;
      const list = e.symbols === undefined ? [] : e.symbols;
      if (!Array.isArray(list) || list.length > LIMITS.symbols) return null;
      const symbols = [];
      for (const s of list) {
        const c = cleanSymbol(s);
        if (!c) return null;
        symbols.push(c);
      }
      return { text: e.text, symbols };
    }
    case EVENT.HELLO: {
      const caps = e.capabilities === undefined ? [] : e.capabilities;
      if (!Array.isArray(caps) || caps.length > LIMITS.capabilities || caps.some((c) => !str(c, LIMITS.short))) return null;
      return { capabilities: caps };
    }
    case EVENT.BYE:
      return {};
    default:
      return null;
  }
}

/**
 * Validate an incoming message and return a cleaned copy holding only the
 * fields this version defines. Never throws.
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
export function validateEvent(raw) {
  let e = raw;
  if (typeof e === "string") {
    if (e.length > 64 * 1024) return { ok: false, reason: "too large" };
    try {
      e = JSON.parse(e);
    } catch {
      return { ok: false, reason: "not JSON" };
    }
  }
  if (!e || typeof e !== "object" || Array.isArray(e)) return { ok: false, reason: "not an object" };
  if (e.protocol !== PROTOCOL) return { ok: false, reason: "not an aac-bridge message" };
  if (e.v !== VERSION) return { ok: false, reason: `unsupported version ${e.v}` };
  if (!str(e.type, 64)) return { ok: false, reason: "missing type" };
  if (!KNOWN_TYPES.has(e.type)) return { ok: false, reason: `unknown type ${e.type}` };
  if (!str(e.id, 64) || !str(e.session, 64)) return { ok: false, reason: "missing id or session" };
  if (!Number.isInteger(e.seq) || e.seq < 0) return { ok: false, reason: "bad seq" };
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) return { ok: false, reason: "bad ts" };
  const source = cleanSource(e.source);
  if (!source) return { ok: false, reason: "bad source" };
  const payload = cleanPayload(e.type, e);
  if (!payload) return { ok: false, reason: `bad ${e.type} payload` };
  return {
    ok: true,
    event: { protocol: PROTOCOL, v: VERSION, type: e.type, id: e.id, session: e.session, seq: e.seq, ts: e.ts, source, ...payload },
  };
}

/** Build an envelope. Used by the emitter and by tests and the dev panel. */
export function createEvent(type, payload, { session, seq, source, id, ts } = {}) {
  return {
    protocol: PROTOCOL,
    v: VERSION,
    type,
    id: id ?? randomId(),
    session: session ?? "local",
    seq: seq ?? 0,
    ts: ts ?? Date.now(),
    source: source ?? { app: "unknown" },
    ...payload,
  };
}
