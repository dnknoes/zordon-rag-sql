// Dependency-free token-set (Jaccard) similarity, used as a deterministic
// re-rank "dampener" on top of vector order — not a full fuzzy-match library.

function tokenize(s: string): Set<string> {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Jaccard similarity of the token sets of `a` and `b`, in [0, 1]. */
export function fuzzyScore(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}
