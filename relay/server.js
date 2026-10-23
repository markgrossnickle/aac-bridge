// aac-bridge relay: lets an AAC app on one device drive a game on another.
//
//   ws://host:8787/?room=<code>&role=sender     the AAC app
//   ws://host:8787/?room=<code>&role=listener   the game(s)
//
// Messages flow ONE way, sender to listeners. Listeners cannot inject words
// into anyone's session. Each message must look like an aac-bridge envelope
// and is size- and rate-limited. Rooms exist only while someone is connected;
// nothing is stored or logged beyond join/leave counts.
//
//   node relay/server.js                 PORT=8787 by default
//   ALLOWED_ORIGINS=https://a.app,https://b.game node relay/server.js
import { WebSocketServer } from "ws";
import { pathToFileURL } from "node:url";

const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function createRelay({
  port = Number(process.env.PORT) || 8787,
  host,
  maxMessageBytes = 16 * 1024,
  maxPerRoom = 8,
  messagesPerSecond = 30,
  allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  log = (msg) => console.log(`[aac-relay] ${msg}`),
} = {}) {
  const rooms = new Map();

  const wss = new WebSocketServer({
    port,
    host,
    maxPayload: maxMessageBytes,
    verifyClient: ({ origin }, done) => {
      if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) return done(false, 403, "origin not allowed");
      done(true);
    },
  });

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url || "/", "http://relay");
    const room = url.searchParams.get("room") || "";
    const role = url.searchParams.get("role") || "listener";
    if (!ROOM_RE.test(room) || (role !== "sender" && role !== "listener")) {
      socket.close(1008, "bad room or role");
      return;
    }
    if (!rooms.has(room)) rooms.set(room, new Set());
    const peers = rooms.get(room);
    if (peers.size >= maxPerRoom) {
      socket.close(1013, "room full");
      return;
    }
    const peer = { socket, role, tokens: messagesPerSecond, last: Date.now(), alive: true };
    peers.add(peer);
    log(`join ${role} (${peers.size} in room)`);

    socket.on("pong", () => (peer.alive = true));

    socket.on("message", (data, isBinary) => {
      if (role !== "sender" || isBinary) return;
      const now = Date.now();
      peer.tokens = Math.min(messagesPerSecond, peer.tokens + ((now - peer.last) / 1000) * messagesPerSecond);
      peer.last = now;
      if (peer.tokens < 1) return;
      peer.tokens -= 1;
      const text = data.toString();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!parsed || parsed.protocol !== "aac-bridge") return;
      for (const other of peers) {
        if (other !== peer && other.role === "listener" && other.socket.readyState === other.socket.OPEN) {
          other.socket.send(text);
        }
      }
    });

    socket.on("close", () => {
      peers.delete(peer);
      if (peers.size === 0) rooms.delete(room);
      log(`leave ${role} (${peers.size} in room)`);
    });
  });

  const heartbeat = setInterval(() => {
    for (const peers of rooms.values()) {
      for (const p of peers) {
        if (!p.alive) {
          p.socket.terminate();
          continue;
        }
        p.alive = false;
        p.socket.ping();
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  return {
    wss,
    get port() {
      return wss.address().port;
    },
    close() {
      clearInterval(heartbeat);
      return new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      });
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const relay = createRelay();
  relay.wss.on("listening", () => console.log(`[aac-relay] listening on ws://localhost:${relay.port}/?room=<code>&role=<sender|listener>`));
}
