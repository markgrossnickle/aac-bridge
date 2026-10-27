// aac-bridge relay: lets an AAC app on one device drive a game on another,
// only after the two have been PAIRED.
//
// Pairing (HTTP, JSON):
//   POST   /pairings          the game asks for a pairing, optionally with
//                             { vocabulary: ["go", "pop", ...] }. Returns a short
//                             one-time `code` to show the user, a secret
//                             `listenerToken` the game keeps, and expiry times.
//   POST   /pairings/claim    the AAC app sends { code } typed or scanned by the
//                             user. Returns a secret `senderToken` and the game's
//                             `vocabulary` if it sent one. A code can be claimed
//                             once, within `codeTtlMs`.
//   DELETE /pairings          either side revokes, with "Authorization: Bearer
//                             <token>". Both sides are disconnected; both tokens die.
//
// Streaming (WebSocket on the same port): connect to "/", then send
// {"relay":"auth","token":"..."} as the first message. The token decides the
// role. Messages flow ONE way, sender to listeners. Tokens never travel in URLs.
//
// Presence: the relay tells each listener whether the paired AAC app is
// connected ({"relay":"presence","sender":true|false}), and hands a listener
// that joins while the app is sharing the app's current session.hello
// ({"relay":"replay","event":{...}}). Only the hello is kept, never speech.
//
// Close codes: 4401 bad or expired token, 4403 revoked, 4408 no auth in time.
//
//   node relay/server.js                     PORT=8787, ALLOWED_ORIGINS=https://a.app,https://b.game
//   node relay/server.js --serve path/to/dist
//       local play: also serve a built game site, plus this package's example
//       AAC app at /aac-bridge/examples/aac-app.html, from the same port, so a
//       game on this computer and an AAC device on the same Wi-Fi need no
//       internet. See docs/local-play.md.
import { createServer } from "node:http";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const hash = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VOCAB_MAX = 300;
const VOCAB_WORD_MAX = 64;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".apk": "application/vnd.android.package-archive",
  ".txt": "text/plain; charset=utf-8",
};

/** The computer's addresses on the local network (IPv4), for printing at startup. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

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
  serveDir = null,
  serveExamples = Boolean(serveDir),
} = {}) {
  const staticRoot = serveDir ? resolve(serveDir) : null;
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
        if (size > 32 * 1024) req.destroy();
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

  // Static files for local play. Only GET/HEAD, only inside the given folder
  // (or this package's examples/ and src/ under /aac-bridge/), no dotfiles.
  const fileFor = (urlPath) => {
    let p;
    try {
      p = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (p.includes("\0") || p.split("/").some((seg) => seg.startsWith("."))) return null;
    let root = staticRoot;
    if (serveExamples && /^\/aac-bridge\/(examples|src)\//.test(p)) {
      root = PACKAGE_ROOT;
      p = p.slice("/aac-bridge".length);
    }
    if (!root) return null;
    let full = resolve(join(root, p));
    if (full !== root && !full.startsWith(root + sep)) return null;
    try {
      let st = statSync(full);
      if (st.isDirectory()) {
        full = join(full, "index.html");
        st = statSync(full);
      }
      return st.isFile() ? { full, size: st.size } : null;
    } catch {
      return null;
    }
  };
  const serveStatic = (req, res, path) => {
    const f = fileFor(path);
    if (!f) return false;
    const type = TYPES[extname(f.full).toLowerCase()] || "application/octet-stream";
    const hashed = /\/assets\//.test(path);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": f.size,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(f.full).on("error", () => res.destroy()).pipe(res);
    return true;
  };

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
      const body = await readJson(req);
      let vocabulary = null;
      if (body && body.vocabulary !== undefined) {
        const v = body.vocabulary;
        if (!Array.isArray(v) || v.length > VOCAB_MAX || v.some((w) => typeof w !== "string" || !w.trim() || w.length > VOCAB_WORD_MAX)) {
          return send(res, 400, { error: `vocabulary: up to ${VOCAB_MAX} words of up to ${VOCAB_WORD_MAX} characters` }, origin);
        }
        vocabulary = [...new Set(v.map((w) => w.trim()))];
      }
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
        hello: null, // the sender's latest session.hello (JSON text), while it is connected
        vocabulary,
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
      return send(res, 200, p.vocabulary ? { senderToken, expiresAt: p.expiresAt, vocabulary: p.vocabulary } : { senderToken, expiresAt: p.expiresAt }, origin);
    }

    if (req.method === "DELETE" && path === "/pairings") {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
      const entry = m && byToken.get(hash(m[1]));
      if (!entry) return send(res, 404, { error: "unknown token" }, origin);
      drop(entry.pairing, 4403, "revoked");
      log(`pairing revoked by ${entry.role}`);
      return send(res, 204, undefined, origin);
    }

    if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true, relay: "aac-bridge" }, origin);
    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, path)) return;
    return send(res, 404, { error: "not found" }, origin);
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: maxMessageBytes,
    verifyClient: ({ origin }, done) => (originOk(origin) ? done(true) : done(false, 403, "origin not allowed")),
  });

  wss.on("error", (err) => log(`server socket error: ${err.message}`));

  const tell = (socket, msg) => {
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const tellListeners = (p, msg) => {
    for (const l of p.listeners) tell(l, msg);
  };

  wss.on("connection", (socket) => {
    // Handle errors first: an oversized or malformed frame raises an "error"
    // on this socket, and an unhandled one would stop the whole relay.
    socket.on("error", (err) => {
      log(`client socket error: ${err.code || err.message}`);
      socket.terminate();
    });
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
          p.hello = null;
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
        if (found.role === "sender") tellListeners(p, { relay: "presence", sender: true });
        else {
          tell(socket, { relay: "presence", sender: Boolean(p.sender) });
          if (p.sender && p.hello) tell(socket, { relay: "replay", event: JSON.parse(p.hello) });
        }
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
      if (msg.type === "session.hello") entry.pairing.hello = text;
      else if (msg.type === "session.bye") entry.pairing.hello = null;
      for (const l of entry.pairing.listeners) if (l.readyState === l.OPEN) l.send(text);
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!entry) return;
      const p = entry.pairing;
      if (p.sender === socket) {
        p.sender = null;
        p.hello = null;
        tellListeners(p, { relay: "presence", sender: false });
      }
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
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const serveDir = arg("--serve") || process.env.SERVE_DIR || null;
  const port = Number(arg("--port")) || Number(process.env.PORT) || 8787;
  if (serveDir) {
    try {
      if (!statSync(serveDir).isDirectory()) throw new Error();
    } catch {
      console.error(`[aac-relay] --serve: ${serveDir} is not a folder (build the game site first)`);
      process.exit(2);
    }
  }
  const relay = createRelay({ port, serveDir });
  relay.ready.then(() => {
    const p = relay.port;
    console.log(`[aac-relay] listening on port ${p} (pairing over http, streaming over ws)`);
    if (serveDir) {
      console.log(`[aac-relay] game site:   http://localhost:${p}/   (open this on THIS computer)`);
      for (const a of lanAddresses()) console.log(`[aac-relay] AAC device:  http://${a}:${p}/aac-bridge/examples/aac-app.html   (same Wi-Fi)`);
      if (!lanAddresses().length) console.log("[aac-relay] no local network address found; join a Wi-Fi network to pair another device");
    } else {
      for (const a of lanAddresses()) console.log(`[aac-relay] on this network: http://${a}:${p}`);
    }
  });
}
