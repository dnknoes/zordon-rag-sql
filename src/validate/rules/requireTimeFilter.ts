import type { NormalizedSchema, QueryPlan } from '../../types';

const PREFERRED_TIME_COLS = [
  'event_time',
  'event_timestamp',
  'created',
  'created_at',
  'updated',
  'updated_at',
  'completed',
  'completed_at',
  'timestamp',
  'ts',
  'time',
];
const EVENT_LIKE = /(event|history|log|audit|trace)/i;
const TIMEISH = /(time|date|ts|stamp)/i;
const RELATIVE_DATE_FN = /\b(DATE_SUB|DATE_ADD|CURDATE|NOW|CURRENT_DATE|CURRENT_TIMESTAMP)\s*\(/i;

function stripStrings(sql: string): string {
  return String(sql ?? '').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|\\.)*"/g, '""');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTables(sql: string): { table: string; alias: string }[] {
  const out: { table: string; alias: string }[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z0-9_.]+)(?:\s+as)?\s*([A-Za-z0-9_]+)?/gi;
  const KEYWORDS = new Set(['on', 'where', 'group', 'order', 'limit', 'join', 'inner', 'left', 'right', 'having', 'using', 'and', 'or']);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const table = m[1].split('.').pop()!.toLowerCase();
    let alias = (m[2] || '').toLowerCase();
    if (alias && KEYWORDS.has(alias)) alias = '';
    out.push({ table, alias });
  }
  return out;
}

/**
 * Require a time-range predicate whenever the query touches an event-like or
 * schema-flagged high-risk table. Honors explicit opt-outs.
 */
export function requireTimeFilterIfEventLike(opts: {
  schema: NormalizedSchema;
  plan: QueryPlan;
  sql: string;
  userRequestedNoTimeFilter?: boolean;
}): void {
  const { schema, plan, sql } = opts;
  if (opts.userRequestedNoTimeFilter) return;
  if (plan.timeWindow && /all\s*time|no\s*time|any\s*time/i.test(plan.timeWindow)) return;

  const stripped = stripStrings(sql);
  const tables = extractTables(stripped);
  const highRisk = new Set(schema.tables.filter((t) => t.risk === 'high').map((t) => t.name.toLowerCase()));

  const qualifying = tables.filter((t) => EVENT_LIKE.test(t.table) || highRisk.has(t.table));
  if (!qualifying.length) return;

  const hasWhere = /\bwhere\b/i.test(stripped);
  for (const q of qualifying) {
    const cols = schema.columns.filter((c) => c.table.toLowerCase() === q.table);
    let candidates = cols.filter((c) => PREFERRED_TIME_COLS.includes(c.name.toLowerCase())).map((c) => c.name);
    if (!candidates.length) candidates = cols.filter((c) => TIMEISH.test(c.name)).slice(0, 5).map((c) => c.name);

    const aliases = new Set<string>(['']);
    for (const t of tables) if (t.table === q.table && t.alias) aliases.add(t.alias);

    if (hasWhere) {
      for (const col of candidates) {
        for (const a of aliases) {
          const qualifier = a ? `${escapeRegex(a)}\\.` : '';
          const re = new RegExp(`${qualifier}${escapeRegex(col)}\\s*(>=|>|<=|<|between)`, 'i');
          if (re.test(stripped)) return;
        }
      }
      if (RELATIVE_DATE_FN.test(stripped)) return;
    }
  }

  throw new Error('missing required time filter for event-like/high-risk table');
}
