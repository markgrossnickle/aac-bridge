# Privacy and safety

What a person says through AAC is their speech. Treat every message as
private conversation, because it is. These rules are part of the protocol, not
suggestions.

## For AAC apps (senders)

1. **Off by default.** Nothing is sent until the user or their caregiver turns
   sharing on in the app. `createAacEmitter` enforces this: it sends nothing
   before `enable()`.
2. **No silent activation.** A URL parameter, deep link or remote config must
   never turn sharing on or change where messages go. Someone could otherwise
   send a link that quietly copies everything the user says to their server.
3. **Visible while on.** Show that sharing is active and to what ("Sharing with
   Bubble Game"). Turning it off is one action and sends `session.bye`.
4. **Exact destinations.** `postMessage` uses the game's exact origin, never
   `"*"`. Relays are chosen in settings, use `wss://`, and are paired with a
   one-time code the user enters or scans. Store the token like a password.
5. **Off means off.** `disable()` discards anything queued and stops
   reconnecting before it returns. Do not keep a copy to send later.
6. **Send the minimum.** Symbol text, optional key and image, the board id. No
   user ids, no names, no history.
7. **Offer limited sharing.** When the game supplied its word list, offer
   "share only the game's words" (`limitTo()`), on by default. Unrelated
   speech then never leaves the device.
8. **Nearby is not consent.** Local Wi-Fi or Bluetooth play needs the same
   pairing code, visible sharing state and revocation as the internet.

## For games and listeners

1. **Use what you get, keep nothing.** Do not log, store or forward AAC
   messages beyond what the game needs right now. No analytics on them, and
   no in-memory history of words outside test code: act on a word, then drop it.
2. **Check the origin.** Listen with an origin allow list (the library refuses
   `"*"`), and validate every message (the library does).
3. **Never require AAC to play.** Offer touch as well; AAC input is an
   alternative, not a gate.

## For relay operators

The reference relay (`relay/server.js`) only connects paired devices (one-time
code, separate secret tokens per side, revocable, expiring), forwards in one
direction only, limits message size, rate and claim attempts, keeps
everything in memory, and logs nothing but counts. It keeps one message per
pairing: the sender's latest `session.hello` (app name, version, language,
capabilities), only while the sender is connected, so a game that joins late
knows sharing is on. A game's word list is kept with its pairing. Run locally
(`--serve`), nothing leaves the room. If you run one, keep it that way, serve it
over TLS, and set `ALLOWED_ORIGINS`.

## Reporting a problem

Open a private security advisory on the GitHub repository rather than a
public issue.
