// Lowest-level, string-only SQL safety gate. Enforces a single read-only
// statement with no dangerous verbs and no unbounded projection, before any
// schema-aware checks run. Throws on any violation.

const READ_ONLY = /^\s*(with\b[\s\S]*\bselect\b|select\b|explain\b|show\b|describe\b)/i;

const FORBIDDEN =
  /\b(insert|update|delete|replace|merge|upsert|create|alter|drop|truncate|grant|revoke|call|exec|execute|load|into\s+outfile|into\s+dumpfile|infile)\b/i;

/** Blank the contents of quoted string literals so keyword scans ignore them. */
function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|\\.)*"/g, '""');
}

/** Throws unless `sql` is a single read-only, non-wildcard statement. */
export function guardSqlString(sql: string): void {
  const s = String(sql ?? '').trim();
  if (!s) throw new Error('empty SQL');

  if (!READ_ONLY.test(s)) {
    throw new Error('read-only SQL only: must start with SELECT / WITH / EXPLAIN / SHOW / DESCRIBE');
  }

  const stripped = stripStrings(s);

  const forbidden = stripped.match(FORBIDDEN);
  if (forbidden) throw new Error(`forbidden statement keyword: ${forbidden[1]}`);

  if (/\bselect\s+\*/i.test(stripped)) throw new Error('wildcard SELECT * is not allowed');

  const semicolons = (s.match(/;/g) || []).length;
  if (semicolons > 1) throw new Error('multiple statements are not allowed');
}
