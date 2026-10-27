// The AAC app side. An AAC app (Cboard or any other) creates one emitter and
// calls symbol() / phrase() / board() from the place where it already handles
// a selection. Nothing is sent until the user turns sharing on with enable():
// what a person says through AAC is their speech, so sharing is opt-in, visible
// and revocable. See PRIVACY.md.
//
//   const out = createAacEmitter({ app: { app: "cboard", version: "1.2.3", lang: "en" }, transports: [relay] });
//   settingsToggle.onchange = (on) => (on ? out.enable() : out.disable());
//   out.symbol({ text: "yes", key: "cboard.symbol.yes", id: "HJVQ", image: "https://..." }, { boardId: "root" });

import { EVENT, createEvent, randomId, validateEvent } from "./protocol.js";
import { createVocabulary } from "./vocabulary.js";

const DEFAULT_CAPABILITIES = ["symbol.select", "phrase.speak", "board.change"];

/**
 * @param {object} opts
 * @param {{ app: string, version?: string, lang?: string }} opts.app  who is sending
 * @param {object[]} [opts.transports] transports with send()
 * @param {object} [opts.transport]
 * @param {string[]} [opts.capabilities] advertised in session.hello
 * @param {number} [opts.helloEveryMs] repeat session.hello this often while
 *   sharing (default 10000; 0 disables), so a game that opens later learns that
 *   sharing is on, and notices when this app disappears without a bye.
 * @param {Array|object|null} [opts.limitTo] share only these words (the game's
 *   vocabulary, e.g. from claimPairing().vocabulary). See limitTo().
 */
export function createAacEmitter({ app, transports, transport, capabilities = DEFAULT_CAPABILITIES, helloEveryMs = 10_000, limitTo = null } = {}) {
  if (!app || typeof app.app !== "string" || !app.app) {
    throw new Error('createAacEmitter: pass app: { app: "<name>", version?, lang? }');
  }
  const list = transports ?? (transport ? [transport] : []);
  for (const t of list) {
    if (typeof t.send !== "function") throw new Error(`createAacEmitter: transport "${t.name}" cannot send`);
  }
  let enabled = false;
  let session = null;
  let seq = 0;
  let timer = null;
  let limit = null;
  const source = { ...app };

  const setLimit = (entries) => {
    limit = entries ? (typeof entries.match === "function" ? entries : createVocabulary(entries)) : null;
  };
  setLimit(limitTo);

  const caps = () => {
    const c = [...capabilities];
    if (helloEveryMs > 0) c.push("session.heartbeat");
    if (limit) c.push("sharing.limited");
    return c;
  };

  const send = (type, payload) => {
    if (!enabled) return false;
    const event = createEvent(type, payload, { session, seq: seq++, source });
    const checked = validateEvent(event);
    if (!checked.ok) throw new Error(`aac-bridge: refusing to send an invalid ${type}: ${checked.reason}`);
    for (const t of list) {
      try {
        t.send(checked.event);
      } catch (err) {
        (globalThis.console?.warn ?? (() => {}))("[aac-bridge] send failed on", t.name, err);
      }
    }
    return true;
  };

  const stopHeartbeat = () => {
    clearInterval(timer);
    timer = null;
  };

  return {
    /** Start sharing (call only after the user agreed). Starts the transports and sends session.hello. */
    enable() {
      if (enabled) return;
      for (const t of list) t.start?.({});
      enabled = true;
      session = randomId();
      seq = 0;
      send(EVENT.HELLO, { capabilities: caps() });
      if (helloEveryMs > 0) {
        timer = setInterval(() => send(EVENT.HELLO, { capabilities: caps() }), helloEveryMs);
        timer.unref?.();
      }
    },
    /**
     * Stop sharing. Sends session.bye if it can go out now, then stops every
     * transport: anything still queued is discarded and no reconnect happens,
     * so nothing the user said can be delivered after this returns.
     */
    disable() {
      if (!enabled) return;
      stopHeartbeat();
      send(EVENT.BYE, {});
      enabled = false;
      for (const t of list) t.stop?.();
    },
    get enabled() {
      return enabled;
    },
    /** Update the language after the user switches it. */
    setLang(lang) {
      source.lang = lang;
    },
    /**
     * Share only selections that match these words (strings or { word,
     * synonyms }, or a createVocabulary() result); null shares everything.
     * While limited: unmatched symbols are not sent, board changes are not
     * sent, and a phrase is sent as only its matching symbols.
     */
    limitTo(entries) {
      setLimit(entries);
      if (enabled) send(EVENT.HELLO, { capabilities: caps() });
    },
    /** Whether sharing is limited to a word list. */
    get limited() {
      return Boolean(limit);
    },
    /** A symbol (tile) was selected. `symbol.text` is the word as shown/spoken in the user's language. Returns whether it was sent. */
    symbol(symbol, { boardId } = {}) {
      if (limit && !limit.match(symbol)) return false;
      return send(EVENT.SYMBOL, boardId ? { symbol, boardId } : { symbol });
    },
    /** The user opened another board (folder). Not sent while limited. */
    board(boardId, { fromBoardId, symbol } = {}) {
      if (limit) return false;
      const p = { boardId };
      if (fromBoardId) p.fromBoardId = fromBoardId;
      if (symbol) p.symbol = symbol;
      return send(EVENT.BOARD, p);
    },
    /** The sentence/message bar was spoken. While limited, only its matching symbols are sent. */
    phrase(text, symbols = []) {
      if (limit) {
        const kept = symbols.filter((s) => limit.match(s));
        if (!kept.length) return false;
        return send(EVENT.PHRASE, { text: kept.map((s) => s.text).join(" "), symbols: kept });
      }
      return send(EVENT.PHRASE, { text, symbols });
    },
    close() {
      this.disable();
    },
  };
}
