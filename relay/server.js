// aac-bridge relay: lets an AAC app on one device drive a game on another,
// only after the two have been PAIRED.
//
// Pairing (HTTP, JSON):
//   POST   /pairings          the game asks for a pairing. Returns a short
//                             one-time `code` to show the user, a secret
//                             `listenerToken` the game keeps, and expiry times.
//   POST   /pairings/claim    the AAC app sends { code } typed or scanned by the
//                             user. Returns a secret `senderToken`. A code can be
//                             claimed once, within `codeTtlMs`.
//   DELETE /pairings          either side revokes, with "Authorization: Bearer
//                             <token>". Both sides are disconnected; both tokens die.
//
// Streaming (WebSocket on the same port): connect to "/", then send
// {"relay":"auth","token":"..."} as the first message. The token decides the
// role. Messages flow ONE way, sender to listeners. Tokens never travel in URLs.
//
// Close codes: 4401 bad or expired token, 4403 revoked, 4408 no auth in time.
//
//   node relay/server.js       PORT=8787, ALLOWED_ORIGINS=https://a.app,https://b.game
import { createServer } from "node:http";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const hash = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

export function createRelay({
  port = Number(process.env.PORT) || 8787,
  host,
  maxMessageBytes = 16 * 1024,
  messagesPerSecond = 30,
  maxListenersPerPairing = 8,
  maxPairings = 10_000,
  codeTtlMs = 10 * 60_000,
  idleTtlMs = 30 * 60_000,
  maxLifetimeMs = 12 * 60 * 60_000,
  authTimeoutMs = 5_000,
  createPerMinutePerIp = 20,
  claimPerMinutePerIp = 10,
  claimFailuresPerMinute = 200,
  allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  log = (msg) => console.log(`[aac-relay] ${msg}`),
  now = () => Date.now(),
} = {}) {
  /** pairing: { id, code, codeExpiresAt, expiresAt, lastActive, listenerHash, senderHash, sender, listeners:Set } */
  const pairings = new Map();
  const byCode = new Map();
  const byToken = new Map(); // tokenHash -> { pairing, role }
  const ipBuckets = new Map(); // `${kind}:${ip}` -> { count, resetAt }
  let globalFailures = { count: 0, resetAt: 0 };

  const limited = (kind, ip, perMinute) => {
    const key = `${kind}:${ip}`;
    const t = now();
    let b = ipBuckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + 60_000 };
      ipBuckets.set(key, b);
    }
    b.count += 1;
    return b.count > perMinute;
  };

  const originOk = (origin) => !allowedOrigins.length || !origin || allowedOrigins.includes(origin);

  const drop = (p, code, reason) => {
    pairings.delete(p.id);
    if (p.code) byCode.delete(p.code);
    byToken.delete(p.listenerHash);
    if (p.senderHash) byToken.delete(p.senderHash);
    for (const s of [p.sender, ...p.listeners]) {
      if (s && s.readyState === s.OPEN) s.close(code, reason);
    }
    p.sender = null;
    p.listeners.clear();
  };

  const sweep = () => {
    const t = now();
    for (const p of pairings.values()) {
      if (p.code && p.codeExpiresAt <= t) {
        byCode.delete(p.code);
        p.code = null;
        if (!p.senderHash) {
          drop(p, 4401, "pairing code expired");
          continue;
        }
      }
      const connected = p.sender || p.listeners.size > 0;
      if (p.expiresAt <= t || (!connected && p.lastActive + idleTtlMs <= t)) drop(p, 4401, "pairing expired");
    }
    for (const [k, b] of ipBuckets) if (b.resetAt <= t) ipBuckets.delete(k);
  };
  const sweeper = setInterval(sweep, 15_000);
  sweeper.unref?.();

  const newCode = () => {
    for (let i = 0; i < 20; i++) {
      const c = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (!byCode.has(c)) return c;
    }
    return null;
  };

  const send = (res, status, body, origin) => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin && originOk(origin) ? origin : allowedOrigins.length ? allowedOrigins[0] : "*",
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    };
    res.writeHead(status, headers);
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const readJson = (req) =>
    new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 4096) req.destroy();
        else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const ip = req.socket.remoteAddress || "?";
    const path = (req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") return send(res, 204, undefined, origin);
    if (!originOk(origin)) return send(res, 403, { error: "origin not allowed" }, origin);
    sweep();

    if (req.method === "POST" && path === "/pairings") {
      if (limited("create", ip, createPerMinutePerIp)) return send(res, 429, { error: "too many requests" }, origin);
      if (pairings.size >= maxPairings) return send(res, 503, { error: "relay full" }, origin);
      const code = newCode();
      if (!code) return send(res, 503, { error: "try again" }, origin);
      const listenerToken = newToken();
      const t = now();
      const p = {
        id: newToken(),
        code,
        codeExpiresAt: t + codeTtlMs,
        expiresAt: t + maxLifetimeMs,
        lastActive: t,
        listenerHash: hash(listenerToken),
        senderHash: null,
        sender: null,
        listeners: new Set(),
      };
      pairings.set(p.id, p);
      byCode.set(code, p);
      byToken.set(p.listenerHash, { pairing: p, role: "listener" });
      log(`pairing created (${pairings.size} active)`);
      return send(res, 201, { code, listenerToken, codeExpiresAt: p.codeExpiresAt, expiresAt: p.expiresAt }, origin);
    }

    if (req.method === "POST" && path === "/pairings/claim") {
      if (limited("claim", ip, claimPerMinutePerIp)) return send(res, 429, { error: "too many attempts" }, origin);
      const t = now();
      if (globalFailures.resetAt <= t) globalFailures = { count: 0, resetAt: t + 60_000 };
      if (globalFailures.count >= claimFailuresPerMinute) return send(res, 429, { error: "too many attempts" }, origin);
      const body = await readJson(req);
      const code = body && typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
      const p = byCode.get(code);
      if (!p || p.codeExpiresAt <= t || p.senderHash) {
        globalFailures.count += 1;
        return send(res, 404, { error: "unknown or expired code" }, origin);
      }
      const senderToken = newToken();
      p.senderHash = hash(senderToken);
      byToken.set(p.senderHash, { pairing: p, role: "sender" });
      byCode.delete(code);
      p.code = null;
      p.lastActive = t;
      log("pairing claimed");
      return send(res, 200, { senderToken, expiresAt: p.expiresAt }, origin);
    }

    if (req.method === "DELETE" && path === "/pairings") {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
      const entry = m && byToken.get(hash(m[1]));
      if (!entry) return send(res, 404, { error: "unknown token" }, origin);
      drop(entry.pairing, 4403, "revoked");
      log(`pairing revoked by ${entry.role}`);
      return send(res, 204, undefined, origin);
    }

    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true }, origin);
    return send(res, 404, { error: "not found" }, origin);
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: maxMessageBytes,
    verifyClient: ({ origin }, done) => (originOk(origin) ? done(true) : done(false, 403, "origin not allowed")),
  });

  wss.on("connection", (socket) => {
    let entry = null;
    let tokens = messagesPerSecond;
    let last = now();
    socket.alive = true;
    socket.on("pong", () => (socket.alive = true));
    const authTimer = setTimeout(() => {
      if (!entry) socket.close(4408, "authenticate first");
    }, authTimeoutMs);

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!entry) {
        clearTimeout(authTimer);
        const found = msg && msg.relay === "auth" && typeof msg.token === "string" ? byToken.get(hash(msg.token)) : null;
        sweep();
        if (!found || !pairings.has(found.pairing.id)) {
          socket.close(4401, "bad or expired token");
          return;
        }
        const p = found.pairing;
        if (found.role === "sender") {
          if (p.sender && p.sender !== socket) p.sender.close(4409, "replaced by a newer connection");
          p.sender = socket;
        } else {
          if (p.listeners.size >= maxListenersPerPairing) {
            socket.close(1013, "too many listeners");
            return;
          }
          p.listeners.add(socket);
        }
        p.lastActive = now();
        entry = found;
        socket.send(JSON.stringify({ relay: "ok", role: found.role, expiresAt: p.expiresAt }));
        return;
      }
      if (entry.role !== "sender" || entry.pairing.sender !== socket) return;
      const t = now();
      tokens = Math.min(messagesPerSecond, tokens + ((t - last) / 1000) * messagesPerSecond);
      last = t;
      if (tokens < 1) return;
      tokens -= 1;
      if (!msg || msg.protocol !== "aac-bridge") return;
      entry.pairing.lastActive = t;
      for (const l of entry.pairing.listeners) if (l.readyState === l.OPEN) l.send(text);
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!entry) return;
      const p = entry.pairing;
      if (p.sender === socket) p.sender = null;
      p.listeners.delete(socket);
      p.lastActive = now();
    });
  });

  const heartbeat = setInterval(() => {
    for (const s of wss.clients) {
      if (!s.alive) {
        s.terminate();
        continue;
      }
      s.alive = false;
      s.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  server.listen(port, host);

  return {
    server,
    wss,
    ready: new Promise((r) => server.once("listening", r)),
    get port() {
      return server.address().port;
    },
    get size() {
      return pairings.size;
    },
    sweep,
    close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      return new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => server.close(() => resolve()));
      });
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const relay = createRelay();
  relay.ready.then(() => console.log(`[aac-relay] listening on http://localhost:${relay.port} (pairing) and ws://localhost:${relay.port}/ (streaming)`));
}
