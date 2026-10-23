// Transports move protocol objects between an AAC app and a game. They do not
// validate or interpret messages; the listener and emitter do that.
//
// A transport is: { name, start({ message, status }), send?(event), stop() }
//   message(data, meta)   called with each received message (object or string)
//   status(state, detail) "connecting" | "open" | "closed" | "error"

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
 * WebSocket to an aac-bridge relay (see relay/). The AAC app connects as
 * "sender" and the game as "listener" with the same room code; the relay
 * forwards sender messages to listeners only. Reconnects with backoff.
 */
export function relayTransport({ url, room, role = "listener", WebSocketImpl, maxQueue = 50 } = {}) {
  if (!url || !/^wss?:\/\//i.test(url)) throw new Error("relayTransport: url must start with ws:// or wss://");
  if (!room || !/^[A-Za-z0-9_-]{4,64}$/.test(room)) throw new Error("relayTransport: room must be 4 to 64 letters, digits, _ or -");
  if (role !== "listener" && role !== "sender") throw new Error('relayTransport: role is "listener" or "sender"');
  const WS = WebSocketImpl ?? globalThis.WebSocket;
  if (!WS) throw new Error("relayTransport: no WebSocket implementation");
  const full = `${url}${url.includes("?") ? "&" : "?"}room=${encodeURIComponent(room)}&role=${role}`;

  let socket = null;
  let stopped = true;
  let delay = 500;
  let timer = null;
  let queue = [];
  let handlers = { message: noop, status: noop };

  const connect = () => {
    if (stopped) return;
    handlers.status("connecting");
    let s;
    try {
      s = new WS(full);
    } catch (err) {
      handlers.status("error", String(err));
      schedule();
      return;
    }
    socket = s;
    s.onopen = () => {
      delay = 500;
      handlers.status("open");
      const pending = queue;
      queue = [];
      for (const m of pending) s.send(m);
    };
    s.onmessage = (ev) => handlers.message(typeof ev.data === "string" ? ev.data : String(ev.data), { room });
    s.onerror = () => handlers.status("error", "socket error");
    s.onclose = () => {
      socket = null;
      handlers.status("closed");
      schedule();
    };
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 10_000);
  };

  return {
    name: "relay",
    start(h = {}) {
      handlers = { message: h.message ?? noop, status: h.status ?? noop };
      stopped = false;
      connect();
    },
    send(event) {
      const msg = typeof event === "string" ? event : JSON.stringify(event);
      if (socket && socket.readyState === 1) socket.send(msg);
      else if (queue.length < maxQueue) queue.push(msg);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      queue = [];
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socket = null;
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
