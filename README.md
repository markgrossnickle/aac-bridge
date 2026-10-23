# aac-bridge

Let any web game listen to what a person selects on an AAC board.

AAC (Augmentative and Alternative Communication) apps such as
[Cboard](https://github.com/cboard-org/cboard) give people a voice through
symbol boards. aac-bridge is a small open protocol plus a dependency-free
library so those selections can drive games and other software, with the
user's consent:

- **Games** create a listener, list the words they understand, and get a
  `word` event when the player picks one.
- **AAC apps** create an emitter, put an on/off switch in settings, and call
  `symbol()` where a tile is pressed.
- **A relay** connects an AAC app on one device to a game on another.

```
 AAC app                                   Game
 ───────                                   ────
 tile pressed ─► emitter.symbol() ─┬─ postMessage (one page, iframe) ─┐
 sentence spoken ─► .phrase()      ├─ relay (other device / app)    ──┼─► listener.on("word")
                                   └─ BroadcastChannel (same site)  ──┘
```

Status: 0.1, draft protocol v1. Feedback from AAC app makers is very welcome.

## For game developers

Not on npm yet. Pin a tagged release from GitHub:

```bash
npm install github:markgrossnickle/aac-bridge#v0.2.0
```

```js
import { createAacListener, createPairing, relayTransport, mountDevPanel } from "aac-bridge";

// Once: ask the relay for a pairing, show the code, keep the token.
const { code, listenerToken } = await createPairing({ relay: "https://relay.example.org" });
showPairingCode(code); // the user types it into their AAC app

const aac = createAacListener({
  transport: relayTransport({ relay: "https://relay.example.org", token: listenerToken }),
  vocabulary: ["yes", "no", { word: "jump", synonyms: ["hop"] }, "more"],
});

aac.on("word", ({ word }) => {
  if (word === "jump") player.jump();
});
aac.on("phrase", ({ text, words }) => showSpeechBubble(text));
aac.on("status", ({ state }) => setConnectedIcon(state === "open"));

// No AAC app handy? A row of fake word buttons for development and tests:
if (import.meta.env?.DEV) mountDevPanel({ listener: aac });
```

Events: `word` (a selection that matched your vocabulary, or any selection if
you gave none), `symbol` (every selection), `phrase` (the spoken message, with
matched `words`), `board`, `hello` (who connected), `bye`, `status`, `gap`
(messages were missed), `stale` (a selection arrived too late and was dropped),
and `*`. After `bye` nothing more from that session is delivered.

Matching is forgiving: case, punctuation and spacing are ignored, synonyms are
supported, and a stable key such as `cboard.symbol.yes` matches `yes` even when
the user's board is in Spanish.

Transports:

| | When | Listener |
|---|---|---|
| `postMessageTransport({ origin })` | AAC app embedded in your page (or yours in theirs) | `origin` is the AAC app's exact origin; `"*"` is refused |
| `relayTransport({ relay, token })` | AAC app on another device or in a native app | the token from `createPairing()` |
| `broadcastTransport()` | same site, other tab | none |
| `memoryLink()` | tests, an on-page keyboard | none |

Always keep touch controls too. AAC is another way to play, not a gate.

## For AAC apps

```js
import { createAacEmitter, claimPairing, relayTransport } from "aac-bridge";

const { senderToken } = await claimPairing({ relay: "https://relay.example.org", code: codeTheUserTyped });
const share = createAacEmitter({
  app: { app: "myaac", version: "2.3.0", lang: "en-US" },
  transports: [relayTransport({ relay: "https://relay.example.org", token: senderToken })],
});
shareSwitch.onchange = (on) => (on ? share.enable() : share.disable());

share.symbol({ text: "yes", key: "myaac.yes", id: tile.id, image: "https://..." }, { boardId: "home" });
share.phrase("I want more juice", composedSymbols);
```

Nothing is sent before `enable()`, and `disable()` discards anything not yet
sent and stops reconnecting. Read `docs/for-aac-apps.md` (including
notes for Cboard) and `PRIVACY.md` before shipping.

## Relay

```bash
cd relay && npm install && npm start      # http://localhost:8787 (pairing) + ws://localhost:8787/ (streaming)
```

Paired devices only (one-time code, a secret token per side, revocable,
expiring), one way only (sender to listeners), size and rate limited, nothing
stored. Put it behind TLS and set `ALLOWED_ORIGINS` in production. Hosts that
cannot hold WebSockets open (for example Vercel functions) will not work; any
small Node host will.

## Try it

```bash
npm run examples          # http://localhost:5180/examples/
```

`examples/game.html` is a word game with the dev panel; open
`examples/aac-app.html` in another tab of the same site and it drives the game
over BroadcastChannel. Add `?relay=http://localhost:8787` to both to go through
a local relay instead: the game shows a code, type it into the AAC app.

## Docs

- `PROTOCOL.md`: the message format, events and transports.
- `PRIVACY.md`: consent and data rules for senders, listeners and relays.
- `docs/for-aac-apps.md`: integrating a sender, with Cboard notes.

## Development

```bash
npm test                          # library tests (node --test)
cd relay && npm install && npm test   # relay tests over real sockets
```

No runtime dependencies in the library. The relay depends on `ws`.

License: MIT.
