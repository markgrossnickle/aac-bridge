export declare const PROTOCOL: "aac-bridge";
export declare const VERSION: 1;
export declare const EVENT: {
  readonly HELLO: "session.hello";
  readonly BYE: "session.bye";
  readonly SYMBOL: "symbol.select";
  readonly BOARD: "board.change";
  readonly PHRASE: "phrase.speak";
};
export declare const LIMITS: { readonly text: number; readonly short: number; readonly url: number; readonly symbols: number; readonly capabilities: number };
export declare const DEFAULT_CHANNEL: string;

/** A selectable item on an AAC board. */
export interface AacSymbol {
  /** The word or phrase as shown to the user, in their language. Required. */
  text: string;
  /** Stable, language-independent key, e.g. "cboard.symbol.yes". */
  key?: string;
  /** The app's id for this symbol/tile. */
  id?: string;
  /** What is spoken when it differs from `text`. */
  vocalization?: string;
  /** Absolute http(s) URL of the symbol image. */
  image?: string;
}

export interface AacSource {
  app: string;
  version?: string;
  /** BCP 47 language tag, e.g. "en-US". */
  lang?: string;
}

export interface AacEnvelope {
  protocol: "aac-bridge";
  v: 1;
  type: string;
  id: string;
  session: string;
  seq: number;
  ts: number;
  source: AacSource;
}
export interface SymbolSelectEvent extends AacEnvelope { type: "symbol.select"; symbol: AacSymbol; boardId?: string }
export interface BoardChangeEvent extends AacEnvelope { type: "board.change"; boardId: string; fromBoardId?: string; symbol?: AacSymbol }
export interface PhraseSpeakEvent extends AacEnvelope { type: "phrase.speak"; text: string; symbols: AacSymbol[] }
export interface HelloEvent extends AacEnvelope { type: "session.hello"; capabilities: string[] }
export interface ByeEvent extends AacEnvelope { type: "session.bye" }
export type AacEvent = SymbolSelectEvent | BoardChangeEvent | PhraseSpeakEvent | HelloEvent | ByeEvent;

export declare function randomId(): string;
export declare function createEvent(type: string, payload: object, meta?: Partial<Pick<AacEnvelope, "session" | "seq" | "source" | "id" | "ts">>): AacEnvelope & Record<string, unknown>;
export declare function validateEvent(raw: unknown): { ok: true; event: AacEvent } | { ok: false; reason: string };
export declare function cleanSymbol(s: unknown): AacSymbol | null;

export declare function normalizeWord(input: unknown): string;
export declare function keyWord(key: unknown): string;
export declare function symbolForms(symbolOrText: AacSymbol | string): string[];
export type VocabularyEntry = string | { word: string; synonyms?: string[]; keys?: string[] };
export interface Vocabulary {
  readonly words: string[];
  match(symbolOrText: AacSymbol | string): string | null;
  has(word: string): boolean;
}
export declare function createVocabulary(entries?: VocabularyEntry[]): Vocabulary;

export type TransportState = "connecting" | "open" | "closed" | "error" | "revoked" | "unauthorized";
export interface Transport {
  name: string;
  start(handlers?: {
    message?: (data: unknown, meta?: { replay?: boolean } & Record<string, unknown>) => void;
    status?: (state: TransportState, detail?: string) => void;
    /** Transports that know whether the AAC app is connected (the relay) report it here. */
    presence?: (present: boolean) => void;
    /** Relay pairing requests reaching a listener (tap-to-allow pairing). */
    control?: (event: { type: "request"; request: PairingRequest } | { type: "request-done"; request: string; approved: boolean }) => void;
  }): void;
  send?(event: unknown): void;
  /** Drop anything waiting to be sent (transports that queue, like the relay). */
  clear?(): void;
  /** Send a relay control message now (a listener answering a pairing request). */
  control?(msg: { relay: "approve" | "deny"; request: string }): boolean;
  stop(): void;
}
export interface PairingRequest {
  id: string;
  /** Self-reported by the AAC app: show it, but the user decides. */
  app: string;
  device: string;
}
type WindowLike = Window | HTMLIFrameElement | (() => Window | HTMLIFrameElement | null | undefined);
export declare function postMessageTransport(opts: { origin: string | string[]; source?: WindowLike; target?: WindowLike; win?: Window }): Transport;
export declare function broadcastTransport(opts?: { channel?: string }): Transport;
export declare function relayTransport(opts: { url?: string; relay?: string; token: string; WebSocketImpl?: typeof WebSocket; maxQueue?: number; queueTtlMs?: number }): Transport;
export declare function memoryLink(): { sender: Transport; listener: Transport };

export interface Pairing { code: string; listenerToken: string; codeExpiresAt: number; expiresAt: number; discoverable: boolean; remembered: boolean }
export interface SenderPairing { senderToken: string; expiresAt: number; remembered: boolean; vocabulary?: string[]; name?: string }
/**
 * Game side. `vocabulary`: the game's words, so the AAC app can share only those.
 * `name`: shown to AAC apps. `discoverable`: list it for tap-to-allow pairing (local relays).
 * `remember`: keep the pairing until revoked (90 days after last use).
 */
export declare function createPairing(opts: {
  relay: string;
  vocabulary?: VocabularyEntry[] | Vocabulary;
  name?: string;
  discoverable?: boolean;
  remember?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<Pairing>;
/** AAC app side, by code (typed, or read from the game's QR code). */
export declare function claimPairing(opts: { relay: string; code: string; fetchImpl?: typeof fetch }): Promise<SenderPairing>;
/** AAC app side: games waiting to be paired on a local relay. */
export declare function listGames(opts: { relay: string; fetchImpl?: typeof fetch }): Promise<Array<{ id: string; name: string }>>;
/** AAC app side: ask a listed game to pair and wait for its user to allow. Rejects with `reason` "denied", "timeout" or "cancelled". */
export declare function requestPairing(opts: {
  relay: string;
  game: string;
  app: string;
  device?: string;
  pollMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<SenderPairing>;
/** A link for a QR code next to the code: opens the AAC page with the code filled in. Never pairs or shares by itself. */
export declare function pairingLink(opts: { relay: string; code: string; page?: string }): string;
/** Read { relay, code } from a pairing link, or { relay: null, code } from a bare 6-digit code. */
export declare function parsePairingLink(text: string): { relay: string | null; code: string } | null;
/** Flatten vocabulary entries to the plain word list sent with a pairing. */
export declare function vocabularyWords(entries?: VocabularyEntry[] | Vocabulary): string[] | undefined;
export declare function revokePairing(opts: { relay: string; token: string; fetchImpl?: typeof fetch }): Promise<void>;
export declare function relaySocketUrl(relay: string): string;

export interface SymbolDetail { symbol: AacSymbol; boardId?: string; word: string | null; text: string; source: AacSource; event: SymbolSelectEvent; meta: object }
export interface ListenerEvents {
  word: SymbolDetail & { word: string };
  symbol: SymbolDetail;
  phrase: { text: string; symbols: AacSymbol[]; words: string[]; event: PhraseSpeakEvent };
  board: { boardId: string; fromBoardId?: string; symbol?: AacSymbol; event: BoardChangeEvent };
  /** `repeat`: a heartbeat for the session already known. `replay`: the relay handed over the current hello because this listener joined late. */
  hello: { source: AacSource & { capabilities: string[]; session: string }; repeat: boolean; replay: boolean; event: HelloEvent };
  bye: { session: string; event: ByeEvent };
  /** A sender that advertises "session.heartbeat" went quiet without a bye (closed tab, lost network). */
  lost: { session: string };
  /** A transport that can tell (the relay) says whether the AAC app is connected. */
  presence: { present: boolean; transport: string };
  /** An AAC app asks to pair (tap-to-allow). Answer with approve(id) or deny(id). */
  request: PairingRequest & { transport: string };
  /** A pairing request was answered (here or in another tab) or expired. */
  "request-done": { id: string; approved: boolean; transport: string };
  status: { state: "idle" | TransportState; transport: string; transportState: TransportState; detail?: string };
  gap: { session: string; expected: number; got: number };
  stale: { ageMs: number; event: AacEvent };
  "*": unknown;
}
export interface AacListener {
  on<K extends keyof ListenerEvents>(name: K, fn: (detail: ListenerEvents[K], name: string) => void): () => void;
  off<K extends keyof ListenerEvents>(name: K, fn: (detail: ListenerEvents[K], name: string) => void): void;
  inject(raw: unknown): void;
  /** Channel availability: "open" if ANY transport is open. Not proof that an AAC app is sharing. */
  readonly status: "idle" | TransportState;
  /** One transport's own state, by name ("relay", "broadcast", "postMessage", "memory"). */
  statusOf(name: string): TransportState | undefined;
  /** Whether a transport that can tell says the AAC app is connected. */
  presenceOf(name: string): boolean | undefined;
  /** Allow a pairing request from a "request" event. */
  approve(id: string): boolean;
  /** Refuse a pairing request. */
  deny(id: string): boolean;
  readonly source: (AacSource & { capabilities: string[]; session: string }) | null;
  readonly vocabulary: Vocabulary | null;
  close(): void;
}
export declare function createAacListener(opts?: {
  transport?: Transport;
  transports?: Transport[];
  vocabulary?: VocabularyEntry[] | Vocabulary;
  onInvalid?: (reason: string, raw: unknown) => void;
  maxAgeMs?: number;
  /** Emit "lost" after this long without hearing from a heartbeat sender (default 35000; 0 disables). */
  quietMs?: number;
}): AacListener;

export interface AacEmitter {
  enable(): void;
  disable(): void;
  readonly enabled: boolean;
  setLang(lang: string): void;
  /** Share only selections matching these words; null shares everything. */
  limitTo(entries: VocabularyEntry[] | Vocabulary | null): void;
  readonly limited: boolean;
  symbol(symbol: AacSymbol, opts?: { boardId?: string }): boolean;
  board(boardId: string, opts?: { fromBoardId?: string; symbol?: AacSymbol }): boolean;
  phrase(text: string, symbols?: AacSymbol[]): boolean;
  close(): void;
}
export declare function createAacEmitter(opts: {
  app: AacSource;
  transports?: Transport[];
  transport?: Transport;
  capabilities?: string[];
  /** Repeat session.hello while sharing (default 10000 ms; 0 disables). */
  helloEveryMs?: number;
  /** Start limited to these words (see limitTo). */
  limitTo?: VocabularyEntry[] | Vocabulary | null;
}): AacEmitter;

export declare function mountDevPanel(opts: { listener: AacListener; words?: string[]; parent?: HTMLElement; position?: "top" | "bottom"; label?: string }): () => void;
