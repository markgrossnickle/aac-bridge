# aac-bridge protocol, version 1

A tiny, transport-neutral way for an AAC (Augmentative and Alternative
Communication) app to tell other software what its user selects and says.
Status: draft. Breaking changes bump `v`; listeners ignore versions they do
not know.

## Envelope

Every message is one JSON object:

```json
{
  "protocol": "aac-bridge",
  "v": 1,
  "type": "symbol.select",
  "id": "4f0c2b9e-...",
  "session": "9a1d...",
  "seq": 7,
  "ts": 1761234567890,
  "source": { "app": "cboard", "version": "1.40.0", "lang": "en-US" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `protocol` | `"aac-bridge"` | Lets listeners ignore every other message on a shared channel. |
| `v` | integer | Major version. This document is `1`. |
| `type` | string | One of the event types below. |
| `id` | string, 1 to 64 | Unique per message. Listeners drop repeats. |
| `session` | string, 1 to 64 | New random value each time the user turns sharing on. |
| `seq` | integer, 0 and up | Counts up by one per message within a session. A jump tells a listener it missed something. |
| `ts` | number | Sender clock, milliseconds since the epoch. |
| `source.app` | string | Sending app, lowercase, e.g. `cboard`. |
| `source.version` | string, optional | Sending app version. |
| `source.lang` | string, optional | BCP 47 tag of the language the user is communicating in. |

Unknown fields are ignored and dropped by conforming listeners.

## Symbol

A selectable item on a board (Cboard calls it a tile).

| Field | Type | Meaning |
|---|---|---|
| `text` | string, 1 to 500, **required** | The word or phrase **as the user sees it, in their language**. Never a translation key. |
| `key` | string, optional | A stable, language-independent identifier, e.g. `cboard.symbol.yes`. Lets games match across languages. |
| `id` | string, optional | The app's own id for this symbol. |
| `vocalization` | string, optional | What is spoken, when it differs from `text`. |
| `image` | absolute `http(s)` URL, optional | The symbol picture. Relative paths are invalid: the listener is on another origin. |

## Events

| `type` | Payload | When |
|---|---|---|
| `session.hello` | `capabilities: string[]` (event types the app may send) | Sharing was turned on. Always the first message of a session. |
| `symbol.select` | `symbol`, `boardId?` | The user selected a symbol that adds to their message or speaks. |
| `board.change` | `boardId`, `fromBoardId?`, `symbol?` (the folder symbol) | The user opened another board. |
| `phrase.speak` | `text`, `symbols: Symbol[]` | The user spoke their composed message. |
| `session.bye` | none | Sharing was turned off. |

Limits: `symbols` holds at most 100 entries, ids and keys at most 128
characters, a whole message at most 64 KB.

## Transports

The envelope is the same on every transport.

| Transport | Use | Rules |
|---|---|---|
| `window.postMessage` | AAC app and game in one page (one embeds the other in an iframe). | Sender passes the game's exact origin, never `"*"`. Listener checks `event.origin` against an allow list. |
| WebSocket relay | AAC app and game on different devices, or in different native apps. | Paired first (below). The relay forwards sender to listeners only. Use `wss://` outside a LAN. |
| `BroadcastChannel` (`aac-bridge`) | Same origin only: development, or app and game served by one site. | None beyond same-origin. |

Native wrappers (for example an Android broadcast intent) may carry the same
JSON string unchanged.

## Relay pairing

Knowing a room name is not authorization, so the relay has no rooms. Instead:

1. The game calls `POST /pairings` and gets a one-time 6-digit `code` (valid
   10 minutes) and a secret `listenerToken`. It shows the code.
2. The user or caregiver enters the code in the AAC app, which calls
   `POST /pairings/claim` with `{ "code" }` and gets a secret `senderToken`.
   A code can be claimed once; claims are rate limited.
3. Each side opens a WebSocket to the relay and sends
   `{ "relay": "auth", "token": "..." }` as its first message. Tokens never
   appear in URLs. The relay answers `{ "relay": "ok", "role": "sender" | "listener" }`.
   Only the sender token may send; messages go to the listeners of that
   pairing only.
4. Either side ends it with `DELETE /pairings` and `Authorization: Bearer <token>`.
   Both are disconnected (close code 4403) and both tokens stop working.
   Unused pairings expire (idle 30 minutes, at most 12 hours).

Close codes: 4401 bad or expired token, 4403 revoked, 4408 no authentication
in time, 4409 replaced by a newer sender connection.

## Delivery guarantees

Senders must not deliver anything after sharing is turned off: stopping
sharing discards anything not yet sent. Messages waiting on a slow connection
are dropped after a few seconds rather than delivered late, and listeners drop
selections more than a few seconds old (measured against the sender's clock
with the session's offset removed). Late commands act on a game state the
player no longer sees.

## Consent

Sharing is off by default, turned on by the user or their caregiver through a
visible control, shown while active, and turned off with one action. A link or
URL parameter alone must never turn sharing on or choose where it goes. See
`PRIVACY.md`.

## Not in version 1, planned

- Game to AAC app messages, for example a game offering the vocabulary it uses
  as an Open Board Format board, or asking the app to show a board.
- Signed or encrypted messages for untrusted relays.
