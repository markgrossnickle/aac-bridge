// aac-bridge: let any web game listen to what a person selects on an AAC board.
export { PROTOCOL, VERSION, EVENT, LIMITS, createEvent, validateEvent, cleanSymbol, randomId } from "./protocol.js";
export { normalizeWord, keyWord, symbolForms, createVocabulary } from "./vocabulary.js";
export { postMessageTransport, broadcastTransport, relayTransport, memoryLink, DEFAULT_CHANNEL } from "./transports.js";
export { createPairing, claimPairing, revokePairing, relaySocketUrl, vocabularyWords } from "./pairing.js";
export { createAacListener } from "./listener.js";
export { createAacEmitter } from "./emitter.js";
export { mountDevPanel } from "./devpanel.js";
