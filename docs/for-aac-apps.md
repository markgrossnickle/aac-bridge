# Adding aac-bridge to an AAC app

You need three things: one emitter, a settings switch that calls `enable()` and
`disable()`, and calls to `symbol()`, `board()` and `phrase()` from the single
place your app already handles a selection.

```js
import { createAacEmitter, relayTransport, claimPairing, revokePairing } from "aac-bridge";

// In settings: the user types (or scans) the 6-digit code the game shows.
const RELAY = "https://relay.example.org";
const { senderToken, vocabulary } = await claimPairing({ relay: RELAY, code: enteredCode });
secureStore.set("aacBridgeToken", senderToken); // a secret: never in a URL or log

const share = createAacEmitter({
  app: { app: "myaac", version: APP_VERSION, lang: currentLanguage },
  transports: [relayTransport({ relay: RELAY, token: senderToken })],
});
// "Forget this game": await revokePairing({ relay: RELAY, token: senderToken });

settings.onShareChange((on) => (on ? share.enable() : share.disable()));
// "Share only the game's words", on by default when the game sent a list:
settings.onLimitChange((on) => share.limitTo(on && vocabulary ? vocabulary : null));
i18n.onChange((lang) => share.setLang(lang));

// Where a tile is selected:
share.symbol(
  { text: displayedText, key: tile.labelKey, id: tile.id, image: absoluteUrl(tile.image) },
  { boardId: board.id },
);
// Where a folder opens another board:
share.board(nextBoard.id, { fromBoardId: board.id, symbol: { text: displayedText, id: tile.id } });
// Where the message bar is spoken:
share.phrase(sentence, tilesInSentence.map(toSymbol));
```

Rules that matter (from `PROTOCOL.md` and `PRIVACY.md`):

- `text` is the word as the user sees it, **already translated**. Put a
  translation key in `key`, never in `text`.
- `image` must be an absolute `https://` URL; the game is on another origin.
- Sharing starts only from a user action and is visibly on while active.
- For an embedded game, use `postMessageTransport({ target: iframe, origin: "https://exact.game.origin" })`.
- Offer **limited sharing** when the game sent its word list: unmatched
  symbols and board changes are then never sent, and phrases carry only the
  matching words.
- Keep the default heartbeat (`helloEveryMs`, 10 s): it is how a game that
  opens after sharing started, or a game in another tab, learns sharing is on.

## Connecting without the internet

The relay can run on a computer in the room (`docs/local-play.md`). For your
app that is just another relay URL, an `http://` address on the local
network. Two things to check in your runtime:

- **Mixed content.** A page served over `https` cannot call a plain `http`
  local address, and Chrome asks for local network access permission. A
  native build (Cordova, Capacitor, a WebView) can usually allow it for local
  addresses; a website cannot without a relay certificate the device trusts.
- **Finding the relay.** Typing the address works for a first test. A native
  app can browse the local network for the relay (DNS-SD) instead, with the
  pairing code still required.

Bluetooth LE and WebRTC are planned transports (`PROTOCOL.md`). Either way
the events, pairing code, sharing switch and revocation stay the same.

## Cboard specifically

Notes from a working prototype (a patch to `cboard-org/cboard`), offered as a
starting point for the Cboard team.

**Hook one place: a Redux middleware.** Every selection already flows through
the `CLICK_SYMBOL`, `CHANGE_BOARD` and `CLICK_OUTPUT` actions, and Cboard
already watches exactly those for analytics with a middleware
(`src/components/Board/Board.analytics.js`, wired in `src/store.js`). An
aac-bridge middleware next to it catches every path (main board, shared-board
viewer, scanning, keyboard) without editing each call site:

```js
// src/aacBridge/aacBridge.middleware.js (sketch)
import { CLICK_SYMBOL, CHANGE_BOARD, CLICK_OUTPUT } from '../components/Board/Board.constants';
import { share } from './aacBridge';   // the emitter, enabled from Settings

export const aacBridgeMiddleware = () => (next) => (action) => {
  const result = next(action);
  if (!share.enabled) return result;
  switch (action.type) {
    case CLICK_SYMBOL:
      share.symbol(action.symbol, { boardId: action.boardId });
      break;
    case CHANGE_BOARD:
      share.board(action.boardId, { fromBoardId: action.fromBoardId });
      break;
    case CLICK_OUTPUT:
      share.phrase(action.outputPhrase, action.symbols || []);
      break;
    default:
  }
  return result;
};
```

What that needs from Cboard:

1. **Richer actions.** Today `clickSymbol(symbolLabel)` carries only a label.
   Add the symbol (translated `text`, `labelKey` as `key`, tile `id`, absolute
   `image`) and the current `boardId`, and the composed symbols on
   `clickOutput`. Analytics keeps reading `symbolLabel`, so nothing breaks.
2. **Translated text.** Cboard's default boards store only `labelKey`
   (for example `cboard.symbol.yes`; all 825 default tiles have no plain
   `label`). Resolve it with `intl.formatMessage` where the action is
   dispatched, as the output bar already does in `translateOutput`.
3. **A Settings entry**, next to the existing navigation settings: "Share
   what I say with a game", a field (or QR scan) for the game's 6-digit code
   that calls `claimPairing`, an on/off switch, "Only the game's words" (on
   by default), a "forget" button that calls `revokePairing`, and an
   indicator in the board header while sharing.
4. **Native builds.** In the Cordova Android app, the WebSocket relay works
   unchanged, including a relay on the local network once the app allows
   cleartext to local addresses. A local Android broadcast intent carrying the
   same JSON is a later option for same-device play.

The prototype's `?game=` URL switch and `"*"` default target were fine for a
demo but should not ship: see `PRIVACY.md`.
