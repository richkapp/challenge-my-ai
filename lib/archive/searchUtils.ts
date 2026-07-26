const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

export type SearchField = { label: string; text: string };

export type SearchMatchSignal = {
  label: string;
  excerpt: string;
};

export function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function tokenizeSearchQuery(value: string | undefined) {
  return normalizeSearchText(value || "")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function searchMatchThreshold(queryTokens: string[]) {
  if (queryTokens.length <= 2) return queryTokens.length;
  return Math.max(2, Math.ceil(queryTokens.length * 0.35));
}

export function countMatchedSearchTokens(fields: SearchField[], queryTokens: string[]) {
  if (queryTokens.length === 0) return 0;
  const haystack = normalizeSearchText(fields.map((field) => field.text).join(" "));
  return queryTokens.filter((token) => haystack.includes(token)).length;
}

export function hasSearchMatch(fields: SearchField[], queryTokens: string[]) {
  if (queryTokens.length === 0) return true;
  return countMatchedSearchTokens(fields, queryTokens) >= searchMatchThreshold(queryTokens);
}

export function matchSearchReasons(fields: SearchField[], queryTokens: string[]) {
  if (queryTokens.length === 0 || !hasSearchMatch(fields, queryTokens)) return [];
  const reasons = fields
    .filter((field) => {
      const normalized = normalizeSearchText(field.text);
      return queryTokens.some((token) => normalized.includes(token));
    })
    .map((field) => field.label);
  return [...new Set(reasons)];
}

export function matchSearchSignals(fields: SearchField[], queryTokens: string[], limit = 4): SearchMatchSignal[] {
  if (queryTokens.length === 0 || !hasSearchMatch(fields, queryTokens)) return [];
  const signals: SearchMatchSignal[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const normalized = normalizeSearchText(field.text);
    const matchedToken = queryTokens.find((token) => normalized.includes(token));
    if (!matchedToken || seen.has(field.label)) continue;
    seen.add(field.label);
    signals.push({ label: field.label, excerpt: excerptAroundToken(field.text, matchedToken) });
    if (signals.length >= limit) break;
  }

  return signals;
}

function excerptAroundToken(value: string, token: string, max = 150) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;

  const index = compact.toLowerCase().indexOf(token.toLowerCase());
  if (index < 0) return `${compact.slice(0, max - 1).trimEnd()}…`;

  const halfWindow = Math.floor((max - token.length) / 2);
  const start = Math.max(0, index - halfWindow);
  const end = Math.min(compact.length, start + max);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}
