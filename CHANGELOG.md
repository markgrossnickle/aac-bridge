# Changelog

## 0.3.1

- Local play server: refuse backslashes in request paths (Windows treats them
  as separators, so an encoded `%5c..%5c` could reach dotfiles and other
  package files), serve `/aac-bridge/examples/` and `/aac-bridge/src/` from
  exactly those folders, and re-check for dot segments after normalizing.
- Limited sharing: turning a limit on now also discards anything still queued
  for sending (for example speech queued while the relay was connecting), so
  the new scope covers everything that has not left the device. Transports
  may implement `clear()`; the relay transport does.
- Listener: a replayed `session.hello` is delivered even if its id was seen
  before, so a game whose own relay link drops and reconnects learns at once
  that sharing is still on.

## 0.3.0

- Relay: a client sending an oversized or malformed frame is disconnected
  instead of crashing the relay for everyone.
- Presence: the relay tells listeners whether the AAC app is connected and
  replays the current `session.hello` to a listener that joins while sharing
  is on (a game opened from a hub). Senders repeat their hello every 10 s
  (`helloEveryMs`, capability `session.heartbeat`), and listeners emit
  `lost` when a heartbeat sender goes quiet. New listener events
  `presence` and `lost`; `hello` carries `repeat` and `replay`.
- Listener: `statusOf(name)` and `presenceOf(name)` report one transport,
  so an always-open BroadcastChannel no longer hides a revoked relay.
- Limited sharing: `createPairing({ vocabulary })` sends the game's words,
  `claimPairing()` returns them, and the emitter's `limitTo()` shares only
  matching selections (capability `sharing.limited`).
- Local play: `node relay/server.js --serve <dir>` also serves a built game
  site and the example AAC app, for play on one Wi-Fi network with no
  internet. The example AAC app pairs with a code field, offers limited
  sharing and "Forget this game".
- Docs: presence, limited sharing, local play, planned transports (local
  relay in a native app, WebRTC, Bluetooth LE, controller adapters).

## 0.2.0

- Relay requires pairing: a one-time 6-digit code, a secret token per side,
  revocation (`DELETE /pairings`) and expiry. Rooms are gone. Tokens are sent
  as the first socket message, never in a URL. New `createPairing`,
  `claimPairing`, `revokePairing`. Breaking: `relayTransport` takes `{ relay, token }`.
- `disable()` stops every transport: queued speech is discarded and no
  reconnect happens, so nothing is delivered after sharing ends.
- Relay transport drops queued messages older than `queueTtlMs` (3 s).
- Listener drops selections older than `maxAgeMs` (5 s, clock-skew aware,
  `stale` event) and ignores a session after its `session.bye`.
- Install from a Git tag; not on npm yet.

## 0.1.0

- First release: protocol v1, listener, emitter, transports, relay, dev panel.
