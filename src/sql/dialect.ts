// Lightweight lexical dialect screen: rejects SQL containing functions/tokens
// that belong to a columnar/analytics dialect, keeping generated SQL within the
// target MySQL-family dialect. This is a fast screen, not a parser.

const NON_MYSQL_TOKENS: RegExp[] = [
  /toStartOf(Second|Minute|Hour|Day|Week|Month|Quarter|Year)\s*\(/i,
  /toTimeZone\s*\(/i,
  /date_diff\s*\(/i,
  /dateAdd\s*\(/i,
  /add(Days|Hours|Minutes|Seconds)\s*\(/i,
  /\btoday\s*\(\s*\)/i,
  /now64\s*\(/i,
  /\buniq\w*\s*\(/i,
  /countIf\s*\(/i,
  /arrayJoin\s*\(/i,
];

/** Throws if `sql` contains a token from a non-MySQL analytics dialect. */
export function assertMysqlOnlySql(sql: string): void {
  const s = String(sql ?? '').trim();
  for (const re of NON_MYSQL_TOKENS) {
    if (re.test(s)) throw new Error(`Non-MySQL token detected: ${re.source}`);
  }
}
