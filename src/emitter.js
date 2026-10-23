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

/**
 * @param {object} opts
 * @param {{ app: string, version?: string, lang?: string }} opts.app  who is sending
 * @param {object[]} [opts.transports] transports with send()
 * @param {object} [opts.transport]
 * @param {string[]} [opts.capabilities] advertised in session.hello
 */
export function createAacEmitter({ app, transports, transport, capabilities = ["symbol.select", "phrase.speak", "board.change"] } = {}) {
  if (!app || typeof app.app !== "string" || !app.app) {
    throw new Error('createAacEmitter: pass app: { app: "<name>", version?, lang? }');
  }
  const list = transports ?? (transport ? [transport] : []);
  for (const t of list) {
    if (typeof t.send !== "function") throw new Error(`createAacEmitter: transport "${t.name}" cannot send`);
  }
  let enabled = false;
  let started = false;
  let session = null;
  let seq = 0;
  const source = { ...app };

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

  return {
    /** Start sharing (call only after the user agreed). Sends session.hello. */
    enable() {
      if (enabled) return;
      if (!started) {
        for (const t of list) t.start?.({});
        started = true;
      }
      enabled = true;
      session = randomId();
      seq = 0;
      send(EVENT.HELLO, { capabilities });
    },
    /** Stop sharing. Sends session.bye first. */
    disable() {
      if (!enabled) return;
      send(EVENT.BYE, {});
      enabled = false;
    },
    get enabled() {
      return enabled;
    },
    /** Update the language after the user switches it. */
    setLang(lang) {
      source.lang = lang;
    },
    /** A symbol (tile) was selected. `symbol.text` is the word as shown/spoken in the user's language. */
    symbol(symbol, { boardId } = {}) {
      return send(EVENT.SYMBOL, boardId ? { symbol, boardId } : { symbol });
    },
    /** The user opened another board (folder). */
    board(boardId, { fromBoardId, symbol } = {}) {
      const p = { boardId };
      if (fromBoardId) p.fromBoardId = fromBoardId;
      if (symbol) p.symbol = symbol;
      return send(EVENT.BOARD, p);
    },
    /** The sentence/message bar was spoken. */
    phrase(text, symbols = []) {
      return send(EVENT.PHRASE, { text, symbols });
    },
    close() {
      this.disable();
      for (const t of list) t.stop?.();
    },
  };
}
