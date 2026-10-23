# Changelog

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
