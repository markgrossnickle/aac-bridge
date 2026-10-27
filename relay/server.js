// aac-bridge relay: lets an AAC app on one device drive a game on another,
// only after the two have been PAIRED.
//
// Pairing (HTTP, JSON). There are two ways to pair; both end with the AAC app
// holding a secret sender token and the game a secret listener token.
//
//   POST   /pairings          the game asks for a pairing. Body (all optional):
//                               vocabulary: ["go", "pop", ...]  the game's words
//                               name: "AAC Game Playground"      shown to AAC apps
//                               discoverable: true               list it on GET /games
//                               remember: true                   keep it until revoked
//                             Returns a one-time `code` to show the user, a secret
//                             `listenerToken` the game keeps, expiry times, and
//                             whether it is `discoverable` and `remembered`.
//
//   1. Code: POST /pairings/claim  the AAC app sends { code } typed, or read
//                             from the game's QR code. Returns a secret
//                             `senderToken` and the game's `vocabulary`.
//
//   2. Tap to allow (local networks): the AAC app lists GET /games, the user
//      taps one, and the AAC app sends POST /pairings/request { game, app,
//      device }. The game's open dialog is told over its socket and asks
//      "Allow?". The AAC app polls GET /pairings/request/<id> (Authorization:
//      Bearer <pollToken>) until it gets the sender token, or "denied".
//      Discovery is ON only for a local relay (--serve), never by default on
//      an internet relay: listing games publicly would leak them to anyone.
//
//   DELETE /pairings          either side revokes, with "Authorization: Bearer
//                             <token>". Both sides are disconnected; both tokens die.
//
// Remembered pairings last `rememberTtlMs` (90 days) after their last use
// instead of 12 hours, and with `stateFile` they survive a relay restart. The
// state file holds token HASHES only, never tokens, codes or speech.
//
// Streaming (WebSocket on the same port): connect to "/", then send
// {"relay":"auth","token":"..."} as the first message. The token decides the
// role. Messages flow ONE way, sender to listeners. Tokens never travel in URLs.
// The only thing a listener may send is a control message answering a pairing
// request: {"relay":"approve"|"deny","request":"<id>"}.
//
// Presence: the relay tells each listener whether the paired AAC app is
// connected ({"relay":"presence","sender":true|false}), and hands a listener
// that joins while the app is sharing the app's current session.hello
// ({"relay":"replay","event":{...}}). Only the hello is kept, never speech.
// Pairing requests reach listeners as {"relay":"request","request":{id,app,device}}
// and their outcome as {"relay":"request-done","request":id,"approved":bool}.
//
// Close codes: 4401 bad or expired token, 4403 revoked, 4408 no auth in time,
// 4409 replaced by a newer sender connection.
//
//   node relay/server.js                     PORT=8787, ALLOWED_ORIGINS=https://a.app,https://b.game
//   node relay/server.js --serve path/to/dist
//       local play: also serve a built game site, plus this package's example
//       AAC app at /aac-bridge/examples/aac-app.html, from the same port, so a
//       game on this computer and an AAC device on the same Wi-Fi need no
//       internet. Discovery is on, and remembered pairings are saved to
//       ~/.aac-bridge/relay-pairings.json (--state <file> to change, --no-state
//       to keep them in memory). See docs/local-play.md.
import { createServer } from "node:http";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const hash = (token) => createHash("sha256").update(String(token)).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const shortId = () => randomBytes(9).toString("base64url");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VOCAB_MAX = 300;
const VOCAB_WORD_MAX = 64;
const NAME_MAX = 64;

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

/**
 * The computer's addresses on the local network (IPv4). Home and office ranges
 * (192.168.x, then 10.x) come first; 172.16-31.x is often a virtual adapter.
 */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
  }
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y));
}

/** Where a local relay keeps remembered pairings unless told otherwise. */
export const DEFAULT_STATE_FILE = join(homedir(), ".aac-bridge", "relay-pairings.json");

const cleanText = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

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
  rememberTtlMs = 90 * 24 * 60 * 60_000,
  allowRemember = true,
  requestTtlMs = 2 * 60_000,
  maxRequestsPerPairing = 3,
  authTimeoutMs = 5_000,
  createPerMinutePerIp = 20,
  claimPerMinutePerIp = 10,
  requestPerMinutePerIp = 10,
  listPerMinutePerIp = 60,
  claimFailuresPerMinute = 200,
  allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  log = (msg) => console.log(`[aac-relay] ${msg}`),
  now = () => Date.now(),
  serveDir = null,
  serveExamples = Boolean(serveDir),
  discovery = Boolean(serveDir),
  stateFile = null,
} = {}) {
  const staticRoot = serveDir ? resolve(serveDir) : null;
  /**
   * pairing: { id, publicId, code, codeExpiresAt, expiresAt, lastActive, listenerHash,
   *   senderHash, sender, listeners:Set, hello, vocabulary, name, discoverable, remember,
   *   requests: Map<id, { id, pollHash, app, device, status, senderToken, createdAt }> }
   */
  const pairings = new Map();
  const byCode = new Map();
  const byPublicId = new Map();
  const byToken = new Map(); // tokenHash -> { pairing, role }
  const requests = new Map(); // request id -> { pairing, request }
  const ipBuckets = new Map(); // `${kind}:${ip}` -> { count, resetAt }
  let globalFailures = { count: 0, resetAt: 0 };

  // ---- remembered pairings on disk (hashes only) ----
  let dirty = false;
  const persist = () => {
    if (!stateFile || !dirty) return;
    dirty = false;
    const list = [];
    for (const p of pairings.values()) {
      if (!p.remember || !p.senderHash) continue;
      list.push({
        id: p.id,
        listenerHash: p.listenerHash,
        senderHash: p.senderHash,
        vocabulary: p.vocabulary,
        name: p.name,
        expiresAt: p.expiresAt,
        lastActive: p.lastActive,
      });
    }
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, pairings: list }));
      renameSync(tmp, stateFile);
    } catch (err) {
      log(`could not save remembered pairings: ${err.message}`);
    }
  };
  const changed = () => {
    dirty = true;
  };
  if (stateFile) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      const t = now();
      for (const s of saved.pairings ?? []) {
        if (!s || typeof s.listenerHash !== "string" || typeof s.senderHash !== "string" || !(s.expiresAt > t)) continue;
        const p = {
          id: s.id || newToken(),
          publicId: shortId(),
          code: null,
          codeExpiresAt: 0,
          expiresAt: s.expiresAt,
          lastActive: s.lastActive || t,
          listenerHash: s.listenerHash,
          senderHash: s.senderHash,
          sender: null,
          listeners: new Set(),
          hello: null,
          vocabulary: Array.isArray(s.vocabulary) ? s.vocabulary : null,
          name: typeof s.name === "string" ? s.name : "",
          discoverable: false,
          remember: true,
          requests: new Map(),
        };
        pairings.set(p.id, p);
        byPublicId.set(p.publicId, p);
        byToken.set(p.listenerHash, { pairing: p, role: "listener" });
        byToken.set(p.senderHash, { pairing: p, role: "sender" });
      }
      if (pairings.size) log(`restored ${pairings.size} remembered pairing(s)`);
    } catch (err) {
      if (err.code !== "ENOENT") log(`could not read remembered pairings: ${err.message}`);
    }
  }

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

  const tell = (socket, msg) => {
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const tellListeners = (p, msg) => {
    for (const l of p.listeners) tell(l, msg);
  };

  const endRequest = (p, r, status) => {
    r.status = status;
    if (status !== "approved") r.senderToken = null;
    tellListeners(p, { relay: "request-done", request: r.id, approved: status === "approved" });
  };

  const drop = (p, code, reason) => {
    pairings.delete(p.id);
    byPublicId.delete(p.publicId);
    if (p.code) byCode.delete(p.code);
    byToken.delete(p.listenerHash);
    if (p.senderHash) byToken.delete(p.senderHash);
    for (const r of p.requests.values()) {
      if (r.status === "pending") r.status = "denied";
      r.senderToken = null;
    }
    for (const s of [p.sender, ...p.listeners]) {
      if (s && s.readyState === s.OPEN) s.close(code, reason);
    }
    p.sender = null;
    p.listeners.clear();
    if (p.remember) changed();
  };

  /** Mark a pairing used; a remembered one slides its expiry forward. */
  const touch = (p, t = now()) => {
    p.lastActive = t;
    if (p.remember) {
      p.expiresAt = t + rememberTtlMs;
      changed();
    }
  };

  /** Give a pairing its sender (by code or by approval). Returns the new secret token. */
  const makeSender = (p) => {
    const senderToken = newToken();
    p.senderHash = hash(senderToken);
    byToken.set(p.senderHash, { pairing: p, role: "sender" });
    if (p.code) byCode.delete(p.code);
    p.code = null;
    for (const r of p.requests.values()) if (r.status === "pending") endRequest(p, r, "denied");
    touch(p);
    changed();
    return senderToken;
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
      for (const r of p.requests.values()) {
        if (r.createdAt + requestTtlMs <= t) {
          if (r.status === "pending") endRequest(p, r, "denied");
          p.requests.delete(r.id);
          requests.delete(r.id);
        }
      }
      const connected = p.sender || p.listeners.size > 0;
      const idle = p.remember ? rememberTtlMs : idleTtlMs;
      if (p.expiresAt <= t || (!connected && p.lastActive + idle <= t)) drop(p, 4401, "pairing expired");
    }
    for (const [k, b] of ipBuckets) if (b.resetAt <= t) ipBuckets.delete(k);
    persist();
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

  const bearer = (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    return m ? m[1] : null;
  };

  // Static files for local play. Only GET/HEAD, only inside the given folder,
  // or exactly this package's examples/ or src/ folder under /aac-bridge/.
  // No dotfiles. Backslashes are refused outright: Windows treats them as
  // separators, so "%5c..%5c" would otherwise slip past the segment checks.
  const fileFor = (urlPath) => {
    let p;
    try {
      p = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (p.includes("\0") || p.includes("\\") || p.split("/").some((seg) => seg.startsWith("."))) return null;
    let root = staticRoot;
    const pkg = serveExamples ? /^\/aac-bridge\/(examples|src)(\/.*)$/.exec(p) : null;
    if (pkg) {
      root = join(PACKAGE_ROOT, pkg[1]);
      p = pkg[2];
    } else if (p.startsWith("/aac-bridge/")) return null;
    if (!root) return null;
    let full = resolve(join(root, p));
    if (full !== root && !full.startsWith(root + sep)) return null;
    // Second guard, after normalization: no dot segment anywhere under the root.
    if (relative(root, full).split(/[\\/]/).some((seg) => seg.startsWith("."))) return null;
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

  /** Games an AAC app on this network may ask to join: discoverable, waiting, and open right now. */
  const listable = (p) => p.discoverable && !p.senderHash && p.listeners.size > 0;

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
      const body = (await readJson(req)) ?? {};
      let vocabulary = null;
      if (body.vocabulary !== undefined) {
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
      const remember = Boolean(body.remember) && allowRemember;
      const p = {
        id: newToken(),
        publicId: shortId(),
        code,
        codeExpiresAt: t + codeTtlMs,
        expiresAt: t + (remember ? rememberTtlMs : maxLifetimeMs),
        lastActive: t,
        listenerHash: hash(listenerToken),
        senderHash: null,
        sender: null,
        hello: null, // the sender's latest session.hello (JSON text), while it is connected
        vocabulary,
        name: cleanText(body.name, NAME_MAX),
        discoverable: Boolean(body.discoverable) && discovery,
        remember,
        listeners: new Set(),
        requests: new Map(),
      };
      pairings.set(p.id, p);
      byPublicId.set(p.publicId, p);
      byCode.set(code, p);
      byToken.set(p.listenerHash, { pairing: p, role: "listener" });
      log(`pairing created (${pairings.size} active)`);
      return send(
        res,
        201,
        { code, listenerToken, codeExpiresAt: p.codeExpiresAt, expiresAt: p.expiresAt, discoverable: p.discoverable, remembered: p.remember },
        origin,
      );
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
      const senderToken = makeSender(p);
      log("pairing claimed with a code");
      return send(res, 200, claimBody(p, senderToken), origin);
    }

    if (req.method === "GET" && path === "/games") {
      if (!discovery) return send(res, 404, { error: "discovery is off on this relay" }, origin);
      if (limited("list", ip, listPerMinutePerIp)) return send(res, 429, { error: "too many requests" }, origin);
      const games = [...pairings.values()].filter(listable).map((p) => ({ id: p.publicId, name: p.name || "Game" }));
      return send(res, 200, { games }, origin);
    }

    if (req.method === "POST" && path === "/pairings/request") {
      if (!discovery) return send(res, 404, { error: "discovery is off on this relay" }, origin);
      if (limited("request", ip, requestPerMinutePerIp)) return send(res, 429, { error: "too many requests" }, origin);
      const body = (await readJson(req)) ?? {};
      const p = typeof body.game === "string" ? byPublicId.get(body.game) : null;
      if (!p || !listable(p)) return send(res, 404, { error: "no such game waiting" }, origin);
      const pending = [...p.requests.values()].filter((r) => r.status === "pending");
      if (pending.length >= maxRequestsPerPairing) return send(res, 429, { error: "too many requests for this game" }, origin);
      const app = cleanText(body.app, NAME_MAX);
      if (!app) return send(res, 400, { error: "app name required" }, origin);
      const pollToken = newToken();
      const r = { id: shortId(), pollHash: hash(pollToken), app, device: cleanText(body.device, NAME_MAX), status: "pending", senderToken: null, createdAt: now() };
      p.requests.set(r.id, r);
      requests.set(r.id, { pairing: p, request: r });
      tellListeners(p, { relay: "request", request: { id: r.id, app: r.app, device: r.device } });
      log("pairing requested");
      return send(res, 202, { requestId: r.id, pollToken, expiresAt: r.createdAt + requestTtlMs }, origin);
    }

    const poll = req.method === "GET" && /^\/pairings\/request\/([A-Za-z0-9_-]{1,32})$/.exec(path);
    if (poll) {
      const found = requests.get(poll[1]);
      const token = bearer(req);
      if (!found || !token || hash(token) !== found.request.pollHash) return send(res, 404, { error: "unknown request" }, origin);
      const { pairing: p, request: r } = found;
      if (r.status === "pending") return send(res, 200, { status: "pending" }, origin);
      p.requests.delete(r.id);
      requests.delete(r.id);
      if (r.status === "approved" && r.senderToken) {
        const senderToken = r.senderToken;
        r.senderToken = null;
        return send(res, 200, { status: "approved", ...claimBody(p, senderToken) }, origin);
      }
      return send(res, 200, { status: "denied" }, origin);
    }

    if (req.method === "DELETE" && path === "/pairings") {
      const token = bearer(req);
      const entry = token && byToken.get(hash(token));
      if (!entry) return send(res, 404, { error: "unknown token" }, origin);
      drop(entry.pairing, 4403, "revoked");
      persist();
      log(`pairing revoked by ${entry.role}`);
      return send(res, 204, undefined, origin);
    }

    if (req.method === "GET" && path === "/healthz") {
      const body = { ok: true, relay: "aac-bridge", discovery };
      // A local relay says how other devices on the Wi-Fi can reach it, so a
      // game opened at localhost can put the right address in its QR code.
      if (discovery) body.addresses = lanAddresses().map((a) => `http://${a}:${server.address().port}`);
      return send(res, 200, body, origin);
    }
    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res, path)) return;
    return send(res, 404, { error: "not found" }, origin);
  });

  function claimBody(p, senderToken) {
    const out = { senderToken, expiresAt: p.expiresAt, remembered: p.remember };
    if (p.vocabulary) out.vocabulary = p.vocabulary;
    if (p.name) out.name = p.name;
    return out;
  }

  const wss = new WebSocketServer({
    server,
    maxPayload: maxMessageBytes,
    verifyClient: ({ origin }, done) => (originOk(origin) ? done(true) : done(false, 403, "origin not allowed")),
  });

  wss.on("error", (err) => log(`server socket error: ${err.message}`));

  /** A listener answers a pairing request: the only thing a listener may send. */
  const answer = (p, msg) => {
    const r = typeof msg.request === "string" ? p.requests.get(msg.request) : null;
    if (!r || r.status !== "pending") return;
    if (msg.relay === "approve" && !p.senderHash) {
      r.status = "approved"; // first, so makeSender's "deny the others" skips this one
      r.senderToken = makeSender(p);
      tellListeners(p, { relay: "request-done", request: r.id, approved: true });
      log("pairing approved");
    } else {
      endRequest(p, r, "denied");
      log("pairing request denied");
    }
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
        touch(p);
        entry = found;
        socket.send(JSON.stringify({ relay: "ok", role: found.role, expiresAt: p.expiresAt }));
        if (found.role === "sender") tellListeners(p, { relay: "presence", sender: true });
        else {
          tell(socket, { relay: "presence", sender: Boolean(p.sender) });
          if (p.sender && p.hello) tell(socket, { relay: "replay", event: JSON.parse(p.hello) });
          for (const r of p.requests.values()) {
            if (r.status === "pending") tell(socket, { relay: "request", request: { id: r.id, app: r.app, device: r.device } });
          }
        }
        return;
      }
      const t = now();
      tokens = Math.min(messagesPerSecond, tokens + ((t - last) / 1000) * messagesPerSecond);
      last = t;
      if (tokens < 1) return;
      tokens -= 1;
      if (entry.role === "listener") {
        if (msg && (msg.relay === "approve" || msg.relay === "deny")) answer(entry.pairing, msg);
        return;
      }
      if (entry.pairing.sender !== socket) return;
      if (!msg || msg.protocol !== "aac-bridge") return;
      touch(entry.pairing, t);
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
      touch(p);
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
    /** Write remembered pairings to the state file now (also done on every sweep). */
    save() {
      dirty = true;
      persist();
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      dirty = true;
      persist();
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
  const stateFile = args.includes("--no-state") ? null : arg("--state") || process.env.STATE_FILE || (serveDir ? DEFAULT_STATE_FILE : null);
  const discovery = args.includes("--no-discovery") ? false : args.includes("--discovery") || Boolean(serveDir);
  if (serveDir) {
    try {
      if (!statSync(serveDir).isDirectory()) throw new Error();
    } catch {
      console.error(`[aac-relay] --serve: ${serveDir} is not a folder (build the game site first)`);
      process.exit(2);
    }
  }
  const relay = createRelay({ port, serveDir, stateFile, discovery });
  const stop = () => relay.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  relay.ready.then(() => {
    const p = relay.port;
    console.log(`[aac-relay] listening on port ${p} (pairing over http, streaming over ws)`);
    console.log(`[aac-relay] nearby-game discovery: ${discovery ? "on" : "off"}; remembered pairings: ${stateFile ?? "in memory only"}`);
    if (serveDir) {
      console.log(`[aac-relay] game site:   http://localhost:${p}/   (open this on THIS computer)`);
      for (const a of lanAddresses()) console.log(`[aac-relay] AAC device:  http://${a}:${p}/aac-bridge/examples/aac-app.html   (same Wi-Fi)`);
      if (!lanAddresses().length) console.log("[aac-relay] no local network address found; join a Wi-Fi network to pair another device");
    } else {
      for (const a of lanAddresses()) console.log(`[aac-relay] on this network: http://${a}:${p}`);
    }
  });
}
