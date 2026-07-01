function stripStrings(sql: string): string {
  return String(sql ?? '').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|\\.)*"/g, '""');
}

/**
 * Force a LIMIT on any non-aggregating query so an unbounded scan cannot be
 * returned. Aggregations (GROUP BY or an aggregate function) are exempt.
 */
export function requireLimitForNonAggregations(sql: string, defaultLimit: number): void {
  const s = stripStrings(sql);
  const hasLimit = /\blimit\b/i.test(s);
  const isAggregation = /\bgroup\s+by\b/i.test(s) || /\b(count|sum|avg|min|max)\s*\(/i.test(s);
  if (!isAggregation && !hasLimit) {
    throw new Error(`non-aggregation query must include a LIMIT (suggested default ${defaultLimit})`);
  }
}
