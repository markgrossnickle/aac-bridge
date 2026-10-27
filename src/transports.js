// Transports move protocol objects between an AAC app and a game. They do not
// validate or interpret messages; the listener and emitter do that.
//
// A transport is: { name, start({ message, status, presence }), send?(event), stop() }
//   message(data, meta)   called with each received message (object or string)
//   status(state, detail) "connecting" | "open" | "closed" | "error" | "revoked" | "unauthorized"
//   presence(present)     optional; a transport that knows whether the AAC app
//                         is connected (the relay) reports it here
//
// A transport being "open" only means the channel works. It does not mean an
// AAC app is there or sharing: that is presence and session.hello.

export const DEFAULT_CHANNEL = "aac-bridge";

function noop() {}

/**
 * postMessage between windows: an AAC app in an iframe and the game page that
 * embeds it, or the other way round.
 *
 * Listening: pass `origin` (one exact origin or a list). Messages from any other
 * origin are ignored. Optionally pass `source` (a Window, an <iframe>, or a
 * function returning one) to also require the message to come from that window.
 *
 * Sending: pass `target` (a Window or an <iframe>) and a single exact `origin`.
 * "*" is refused in both directions: AAC output is the user's speech.
 */
export function postMessageTransport({ origin, source, target, win } = {}) {
  const origins = Array.isArray(origin) ? origin : [origin];
  if (!origin || origins.some((o) => typeof o !== "string" || !o || o === "*")) {
    throw new Error('postMessageTransport: pass the exact origin(s) of the other side; "*" is not allowed');
  }
  const w = win ?? globalThis.window;
  if (!w) throw new Error("postMessageTransport: no window");
  const asWindow = (x) => {
    const v = typeof x === "function" ? x() : x;
    return v && v.contentWindow ? v.contentWindow : v;
  };
  let onMessage = null;
  return {
    name: "postMessage",
    start({ message = noop, status = noop } = {}) {
      onMessage = (ev) => {
        if (!origins.includes(ev.origin)) return;
        const want = asWindow(source);
        if (want && ev.source !== want) return;
        message(ev.data, { origin: ev.origin });
      };
      w.addEventListener("message", onMessage);
      status("open");
    },
    send(event) {
      const t = asWindow(target);
      if (!t) throw new Error("postMessageTransport: no target window to send to");
      if (origins.length !== 1) throw new Error("postMessageTransport: sending needs exactly one origin");
      t.postMessage(event, origins[0]);
    },
    stop() {
      if (onMessage) w.removeEventListener("message", onMessage);
      onMessage = null;
    },
  };
}

/**
 * BroadcastChannel between tabs or frames of the SAME origin. Mostly useful for
 * development and for an AAC app and game served from one site.
 */
export function broadcastTransport({ channel = DEFAULT_CHANNEL } = {}) {
  let bc = null;
  return {
    name: "broadcast",
    start({ message = noop, status = noop } = {}) {
      if (typeof BroadcastChannel === "undefined") {
        status("error", "BroadcastChannel unavailable");
        return;
      }
      bc = new BroadcastChannel(channel);
      bc.onmessage = (ev) => message(ev.data, { channel });
      status("open");
    },
    send(event) {
      if (!bc) bc = new BroadcastChannel(channel);
      bc.postMessage(event);
    },
    stop() {
      bc?.close();
      bc = null;
    },
  };
}

/**
 * WebSocket to a paired aac-bridge relay (see relay/ and src/pairing.js).
 * `token` is the secret from createPairing() (game) or claimPairing() (AAC app);
 * it is sent as the first message, never in the URL, and decides the role.
 *
 * - Messages queued while disconnected are dropped once older than
 *   `queueTtlMs`: a late "jump" is worse than none.
 * - stop() clears the queue and cancels every reconnect, so nothing is sent
 *   after sharing ends.
 * - A revoked or expired pairing ends the transport for good (status
 *   "revoked" or "unauthorized"); pair again to continue.
 */
export function relayTransport({ url, relay, token, WebSocketImpl, maxQueue = 50, queueTtlMs = 3000 } = {}) {
  let target = url ?? relay;
  if (typeof target === "string" && /^https?:\/\//i.test(target)) target = target.replace(/\/+$/, "").replace(/^http/i, "ws") + "/";
  if (!target || !/^wss?:\/\//i.test(target)) throw new Error("relayTransport: pass the relay url (wss://, or https:// which is converted)");
  if (typeof token !== "string" || token.length < 16) throw new Error("relayTransport: pass the pairing token from createPairing() or claimPairing()");
  const WS = WebSocketImpl ?? globalThis.WebSocket;
  if (!WS) throw new Error("relayTransport: no WebSocket implementation");

  let socket = null;
  let authed = false;
  let stopped = true;
  let finished = false;
  let delay = 500;
  let timer = null;
  let queue = [];
  let handlers = { message: noop, status: noop, presence: noop };

  const fresh = () => {
    const cutoff = Date.now() - queueTtlMs;
    queue = queue.filter((q) => q.at >= cutoff);
    return queue;
  };

  const connect = () => {
    if (stopped || finished) return;
    handlers.status("connecting");
    let s;
    try {
      s = new WS(target);
    } catch (err) {
      handlers.status("error", String(err));
      schedule();
      return;
    }
    socket = s;
    authed = false;
    s.onopen = () => s.send(JSON.stringify({ relay: "auth", token }));
    s.onmessage = (ev) => {
      const text = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (!authed) {
        let msg = null;
        try {
          msg = JSON.parse(text);
        } catch {
          /* ignore */
        }
        if (msg && msg.relay === "ok") {
          authed = true;
          delay = 500;
          handlers.status("open", msg.role);
          const pending = fresh();
          queue = [];
          for (const q of pending) s.send(q.msg);
        }
        return;
      }
      // Relay control messages (protocol "Presence"): whether the paired AAC
      // app is connected, and its current session.hello for a listener that
      // joined after sharing started. Never anything the user said.
      if (text.startsWith('{"relay"')) {
        let msg = null;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.relay === "presence") handlers.presence(Boolean(msg.sender));
        else if (msg.relay === "replay" && msg.event) handlers.message(msg.event, { relay: true, replay: true });
        return;
      }
      handlers.message(text, { relay: true });
    };
    s.onerror = () => handlers.status("error", "socket error");
    s.onclose = (ev) => {
      socket = null;
      authed = false;
      const code = ev && ev.code;
      if (code === 4401 || code === 4403) {
        finished = true;
        queue = [];
        handlers.status(code === 4403 ? "revoked" : "unauthorized", ev.reason || "");
        return;
      }
      handlers.status("closed");
      schedule();
    };
  };
  const schedule = () => {
    if (stopped || finished) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10_000);
  };

  return {
    name: "relay",
    start(h = {}) {
      handlers = { message: h.message ?? noop, status: h.status ?? noop, presence: h.presence ?? noop };
      if (finished) {
        handlers.status("unauthorized", "pairing ended; pair again");
        return;
      }
      stopped = false;
      connect();
    },
    send(event) {
      if (stopped || finished) return;
      const msg = typeof event === "string" ? event : JSON.stringify(event);
      if (socket && authed && socket.readyState === 1) socket.send(msg);
      else if (fresh().length < maxQueue) queue.push({ msg, at: Date.now() });
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      queue = [];
      if (socket) {
        socket.onclose = null;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      socket = null;
      authed = false;
    },
  };
}

/**
 * An in-memory pair: whatever `sender.send()` gets, `listener` receives.
 * For tests, the dev panel, and an AAC keyboard built into the same page.
 */
export function memoryLink() {
  const listeners = new Set();
  const listener = {
    name: "memory",
    start({ message = noop, status = noop } = {}) {
      listeners.add(message);
      status("open");
    },
    stop() {
      listeners.clear();
    },
  };
  const sender = {
    name: "memory",
    start({ status = noop } = {}) {
      status("open");
    },
    send(event) {
      for (const fn of listeners) fn(event, { memory: true });
    },
    stop() {},
  };
  return { sender, listener };
}
