# Local play: one Wi-Fi network, no internet

An AAC device controls a game on a nearby computer. The traffic stays on the
local network and nothing needs the internet once the software is installed.

```
 AAC phone or tablet ── Wi-Fi ──► computer: relay + game site ──► game in the computer's browser
```

The computer runs the reference relay with `--serve`. It hands out three
things from one address:

- the game site (any built static site that uses aac-bridge),
- an example AAC app at `/aac-bridge/examples/aac-app.html`,
- the relay itself (pairing and streaming).

## Run it

You need Node.js 20 or newer on the computer and a built game site.

```bash
git clone https://github.com/markgrossnickle/aac-bridge
cd aac-bridge/relay && npm install
node server.js --serve /path/to/built/site
```

It prints two addresses:

```
[aac-relay] game site:   http://localhost:8787/   (open this on THIS computer)
[aac-relay] AAC device:  http://192.168.1.20:8787/aac-bridge/examples/aac-app.html   (same Wi-Fi)
```

1. On the computer, open the game site address and start pairing ("Connect AAC
   board" in the AAC Game Playground hub). It shows a 6-digit code.
2. On the AAC device, open the AAC device address, type the code, press
   Connect, then turn on "Share what I say with the game". "Only the game's
   words" is on by default.
3. Press words. The game reacts. Turn sharing off or press "Forget this game"
   to stop.

The AAC Game Playground wraps all of this as `npm run local`.

## Without internet

- Install and build while online. After that the relay, the game site and the
  example AAC app are all served by the computer.
- A Wi-Fi router with no internet connection works. So does a phone hotspot
  with mobile data turned off, if both devices join it.
- On Windows, allow Node.js on private networks when the firewall asks.
- Open the game as `http://localhost:8787` on the computer itself. Browsers
  treat localhost as secure, so offline caching works there. Other devices
  reach the computer by its network address over plain `http`, which is
  fine for the AAC page.

## Known limits

- **Networks that isolate devices.** Many guest, school and hotel networks
  stop devices from reaching each other. Use another network or a hotspot.
- **AAC apps served over `https`.** A secure web page cannot call a plain
  `http` address on the local network (mixed content), and Chrome adds a
  permission step for local network access. The example AAC page is served by
  the relay itself, so it is unaffected. A web AAC app such as Cboard on
  `https://app.cboard.io` needs either a relay with a trusted certificate or
  its native app; this is an open integration question.
- **One computer as the receiver.** A tablet or TV as the receiver, with no
  laptop, needs a native app that runs the relay itself (planned, see
  `PROTOCOL.md`).
- **Not yet tested on real devices.** The relay, pairing and serving are
  covered by automated tests over real sockets. Home, school, guest and
  hotspot networks still need trying with real devices before any support
  claim.
