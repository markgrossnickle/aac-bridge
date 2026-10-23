// Word matching. AAC apps send the word as displayed in the user's language
// (`text`), sometimes a different spoken form (`vocalization`), and sometimes a
// stable key such as "cboard.symbol.yes". A game lists the words it understands;
// match() maps any of those forms back to the game's canonical word.

/** Lowercase, Unicode-normalize, drop punctuation and symbols, collapse spaces. */
export function normalizeWord(input) {
  return String(input ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The word a key points at: its last segment, with _ and - read as spaces. */
export function keyWord(key) {
  if (typeof key !== "string" || !key) return "";
  const last = key.split(/[.:/#]/).filter(Boolean).pop() ?? "";
  return normalizeWord(last.replace(/[_-]+/g, " "));
}

/** All normalized forms a symbol (or plain string) could be matched by. */
export function symbolForms(symbolOrText) {
  if (typeof symbolOrText === "string") return [normalizeWord(symbolOrText)].filter(Boolean);
  if (!symbolOrText || typeof symbolOrText !== "object") return [];
  const forms = [
    normalizeWord(symbolOrText.text),
    normalizeWord(symbolOrText.vocalization),
    keyWord(symbolOrText.key),
  ];
  return [...new Set(forms.filter(Boolean))];
}

/**
 * @param {Array<string | { word: string, synonyms?: string[], keys?: string[] }>} entries
 */
export function createVocabulary(entries = []) {
  const byForm = new Map();
  const byKey = new Map();
  const words = [];
  for (const entry of entries) {
    const e = typeof entry === "string" ? { word: entry } : entry;
    if (!e || typeof e.word !== "string" || !e.word.trim()) {
      throw new Error("createVocabulary: every entry needs a non-empty word");
    }
    words.push(e.word);
    for (const form of [e.word, ...(e.synonyms ?? [])]) {
      const n = normalizeWord(form);
      if (n && !byForm.has(n)) byForm.set(n, e.word);
    }
    for (const k of e.keys ?? []) byKey.set(k, e.word);
  }

  return {
    words,
    /** The canonical word for a symbol or string, or null when the game does not use it. */
    match(symbolOrText) {
      if (symbolOrText && typeof symbolOrText === "object" && symbolOrText.key && byKey.has(symbolOrText.key)) {
        return byKey.get(symbolOrText.key);
      }
      for (const form of symbolForms(symbolOrText)) {
        if (byForm.has(form)) return byForm.get(form);
      }
      return null;
    },
    has(word) {
      return byForm.has(normalizeWord(word));
    },
  };
}
