export type ParseIssue = { path: string; message: string };

export type ParseResult<T> =
  | { ok: true; value: T; raw: string }
  | { ok: false; error: string; raw?: string; issues?: ParseIssue[]; repair?: string[] };

export function extractFencedBlock(input: string, label: string): ParseResult<unknown> {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = input.match(new RegExp("```" + escaped + "\\s*([\\s\\S]*?)\\s*```", "m"));
  if (!match) return { ok: false, error: `Missing fenced ${label} block.` };
  const raw = match[1]?.trim() ?? "";
  try {
    return { ok: true, value: JSON.parse(raw), raw };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON", raw };
  }
}

export function jsonObjectCandidates(input: string, label?: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const candidate = value?.trim();
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  const trimmed = input.trim();

  if (label && trimmed.startsWith(label)) {
    add(trimmed.slice(label.length).replace(/^\s*[:—-]?\s*/, ""));
  }

  const genericFence = /```[^\n`]*\s*([\s\S]*?)\s*```/gim;
  for (const match of input.matchAll(genericFence)) add(match[1]);

  if (trimmed.startsWith("{")) add(trimmed);
  add(firstBalancedJsonObject(trimmed));

  return candidates;
}

export function firstBalancedJsonObject(input: string): string | undefined {
  const start = input.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }

  return undefined;
}
