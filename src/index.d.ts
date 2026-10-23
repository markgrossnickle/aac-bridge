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

export type TransportState = "connecting" | "open" | "closed" | "error";
export interface Transport {
  name: string;
  start(handlers?: { message?: (data: unknown, meta?: object) => void; status?: (state: TransportState, detail?: string) => void }): void;
  send?(event: unknown): void;
  stop(): void;
}
type WindowLike = Window | HTMLIFrameElement | (() => Window | HTMLIFrameElement | null | undefined);
export declare function postMessageTransport(opts: { origin: string | string[]; source?: WindowLike; target?: WindowLike; win?: Window }): Transport;
export declare function broadcastTransport(opts?: { channel?: string }): Transport;
export declare function relayTransport(opts: { url: string; room: string; role?: "listener" | "sender"; WebSocketImpl?: typeof WebSocket; maxQueue?: number }): Transport;
export declare function memoryLink(): { sender: Transport; listener: Transport };

export interface SymbolDetail { symbol: AacSymbol; boardId?: string; word: string | null; text: string; source: AacSource; event: SymbolSelectEvent; meta: object }
export interface ListenerEvents {
  word: SymbolDetail & { word: string };
  symbol: SymbolDetail;
  phrase: { text: string; symbols: AacSymbol[]; words: string[]; event: PhraseSpeakEvent };
  board: { boardId: string; fromBoardId?: string; symbol?: AacSymbol; event: BoardChangeEvent };
  hello: { source: AacSource & { capabilities: string[]; session: string }; event: HelloEvent };
  bye: { session: string; event: ByeEvent };
  status: { state: "idle" | TransportState; transport: string; transportState: TransportState; detail?: string };
  gap: { session: string; expected: number; got: number };
  "*": unknown;
}
export interface AacListener {
  on<K extends keyof ListenerEvents>(name: K, fn: (detail: ListenerEvents[K], name: string) => void): () => void;
  off<K extends keyof ListenerEvents>(name: K, fn: (detail: ListenerEvents[K], name: string) => void): void;
  inject(raw: unknown): void;
  readonly status: "idle" | TransportState;
  readonly source: (AacSource & { capabilities: string[]; session: string }) | null;
  readonly vocabulary: Vocabulary | null;
  close(): void;
}
export declare function createAacListener(opts?: {
  transport?: Transport;
  transports?: Transport[];
  vocabulary?: VocabularyEntry[] | Vocabulary;
  onInvalid?: (reason: string, raw: unknown) => void;
}): AacListener;

export interface AacEmitter {
  enable(): void;
  disable(): void;
  readonly enabled: boolean;
  setLang(lang: string): void;
  symbol(symbol: AacSymbol, opts?: { boardId?: string }): boolean;
  board(boardId: string, opts?: { fromBoardId?: string; symbol?: AacSymbol }): boolean;
  phrase(text: string, symbols?: AacSymbol[]): boolean;
  close(): void;
}
export declare function createAacEmitter(opts: { app: AacSource; transports?: Transport[]; transport?: Transport; capabilities?: string[] }): AacEmitter;

export declare function mountDevPanel(opts: { listener: AacListener; words?: string[]; parent?: HTMLElement; position?: "top" | "bottom"; label?: string }): () => void;
