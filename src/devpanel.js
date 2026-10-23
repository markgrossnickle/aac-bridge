// A stand-in AAC board for development and tests: a row of word buttons that
// feed symbol.select events straight into a listener. Lets anyone build and
// test an AAC game without running a real AAC app. Not for production.
//
//   import { createAacListener, mountDevPanel } from "aac-bridge";
//   const aac = createAacListener({ vocabulary: ["yes", "no", "jump"] });
//   if (import.meta.env.DEV) mountDevPanel({ listener: aac, words: aac.vocabulary.words });

import { EVENT, createEvent, randomId } from "./protocol.js";

export function mountDevPanel({ listener, words, parent, position = "bottom", label = "AAC (dev)" } = {}) {
  if (!listener || typeof listener.inject !== "function") throw new Error("mountDevPanel: pass the listener to drive");
  const doc = globalThis.document;
  if (!doc) throw new Error("mountDevPanel: needs a DOM");
  const list = words ?? listener.vocabulary?.words ?? [];
  const session = `dev-${randomId()}`;
  let seq = 0;
  const source = { app: "aac-bridge-devpanel", lang: "en" };
  const send = (type, payload) => listener.inject(createEvent(type, payload, { session, seq: seq++, source }));
  send(EVENT.HELLO, { capabilities: ["symbol.select", "phrase.speak"] });

  const bar = doc.createElement("div");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", label);
  bar.dataset.aacDevPanel = "";
  Object.assign(bar.style, {
    position: "fixed",
    left: "8px",
    right: "8px",
    [position === "top" ? "top" : "bottom"]: "8px",
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    padding: "6px",
    zIndex: "2147483000",
    background: "rgba(20,24,32,.85)",
    borderRadius: "10px",
    font: "600 14px system-ui, sans-serif",
  });
  const tag = doc.createElement("span");
  tag.textContent = label;
  Object.assign(tag.style, { color: "#9aa4b2", alignSelf: "center", padding: "0 6px" });
  bar.appendChild(tag);

  const spoken = [];
  for (const w of list) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = w;
    Object.assign(b.style, { padding: "8px 12px", border: "0", borderRadius: "8px", background: "#fff176", color: "#111", cursor: "pointer" });
    b.addEventListener("click", () => {
      const symbol = { text: w, id: `dev-${w}` };
      spoken.push(symbol);
      send(EVENT.SYMBOL, { symbol, boardId: "dev" });
    });
    bar.appendChild(b);
  }
  const speak = doc.createElement("button");
  speak.type = "button";
  speak.textContent = "speak";
  Object.assign(speak.style, { padding: "8px 12px", border: "0", borderRadius: "8px", background: "#4fd1a5", color: "#111", cursor: "pointer", marginLeft: "auto" });
  speak.addEventListener("click", () => {
    send(EVENT.PHRASE, { text: spoken.map((s) => s.text).join(" "), symbols: spoken.splice(0) });
  });
  bar.appendChild(speak);

  (parent ?? doc.body).appendChild(bar);
  return () => bar.remove();
}
