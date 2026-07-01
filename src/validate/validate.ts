import type { NormalizedSchema, QueryPlan } from '../types';
import { guardSqlString } from './guards';
import { enforceMysqlOnly } from './rules/dialectOnly';
import { requireLimitForNonAggregations } from './rules/requireLimit';
import { requireTimeFilterIfEventLike } from './rules/requireTimeFilter';

export type ValidationResult = { ok: true; sql: string } | { ok: false; errors: string[] };

function stripStrings(sql: string): string {
  return String(sql ?? '').replace(/'(?:[^']|'')*'/g, "''");
}
const bare = (name: string): string => name.split('.').pop()!.toLowerCase();

interface SchemaIndex {
  tableBare: Set<string>;
  colsByTable: Map<string, Set<string>>;
  relKeys: Set<string>;
}

function buildSchemaIndex(schema: NormalizedSchema): SchemaIndex {
  const tableBare = new Set(schema.tables.map((t) => t.name.toLowerCase()));
  const colsByTable = new Map<string, Set<string>>();
  for (const c of schema.columns) {
    const t = c.table.toLowerCase();
    if (!colsByTable.has(t)) colsByTable.set(t, new Set());
    colsByTable.get(t)!.add(c.name.toLowerCase());
  }
  const relKeys = new Set<string>();
  for (const r of schema.relationships) {
    const a = `${r.from.table.toLowerCase()}.${r.from.column.toLowerCase()}`;
    const b = `${r.to.table.toLowerCase()}.${r.to.column.toLowerCase()}`;
    relKeys.add(`${a}=${b}`);
    relKeys.add(`${b}=${a}`);
  }
  return { tableBare, colsByTable, relKeys };
}

function extractSqlTables(sql: string): { table: string; alias: string }[] {
  const out: { table: string; alias: string }[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z0-9_.]+)(?:\s+as)?\s*([A-Za-z0-9_]+)?/gi;
  const KW = new Set(['on', 'where', 'group', 'order', 'limit', 'join', 'inner', 'left', 'right', 'having', 'using', 'and', 'or']);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const table = bare(m[1]);
    let alias = (m[2] || '').toLowerCase();
    if (alias && KW.has(alias)) alias = '';
    out.push({ table, alias });
  }
  return out;
}

function aliasMap(tables: { table: string; alias: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tables) {
    map.set(t.table, t.table);
    if (t.alias) map.set(t.alias, t.table);
  }
  return map;
}

function extractQualifiedColumns(sql: string): { qualifier: string; column: string }[] {
  const out: { qualifier: string; column: string }[] = [];
  const re = /\b([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push({ qualifier: m[1].toLowerCase(), column: m[2].toLowerCase() });
  return out;
}

function extractJoinOns(sql: string): { lq: string; lc: string; rq: string; rc: string }[] {
  const out: { lq: string; lc: string; rq: string; rc: string }[] = [];
  const re = /\bon\s+([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    out.push({ lq: m[1].toLowerCase(), lc: m[2].toLowerCase(), rq: m[3].toLowerCase(), rc: m[4].toLowerCase() });
  }
  return out;
}

/** Stage 6 — fail-closed, schema+plan-aware validation. */
export function validateSqlDetailed(opts: {
  schema: NormalizedSchema;
  plan: QueryPlan;
  sql: string;
  strict?: boolean;
  defaultLimit?: number;
  userRequestedNoTimeFilter?: boolean;
}): ValidationResult {
  const strict = opts.strict ?? true;
  const defaultLimit = opts.defaultLimit ?? 500;
  const errors: string[] = [];

  // STEP 1 — string-level guard (hard short-circuit)
  try {
    guardSqlString(opts.sql);
  } catch (e: any) {
    return { ok: false, errors: [String(e?.message || e)] };
  }

  const idx = buildSchemaIndex(opts.schema);
  const stripped = stripStrings(opts.sql);
  const sqlTables = extractSqlTables(stripped);
  const amap = aliasMap(sqlTables);
  const planBare = new Set(opts.plan.tables.map(bare));

  // STEP 2 — dialect
  try {
    enforceMysqlOnly(opts.plan, opts.sql);
  } catch (e: any) {
    errors.push(String(e?.message || e));
  }

  // STEP 3 — plan tables exist in schema
  for (const t of planBare) {
    if (!idx.tableBare.has(t)) errors.push(`plan references unknown table: ${t}`);
  }

  // STEP 4 — SQL tables must be declared in the plan
  for (const t of sqlTables) {
    if (t.table && !planBare.has(t.table)) errors.push(`SQL uses table not in plan: ${t.table}`);
  }

  // STEP 5 — qualified columns must exist on their resolved table
  for (const { qualifier, column } of extractQualifiedColumns(stripped)) {
    const table = amap.get(qualifier);
    if (!table || !planBare.has(table)) continue; // function/derived/other qualifier — skip
    const cols = idx.colsByTable.get(table);
    if (!cols) errors.push(`unknown table/alias for column: ${qualifier}.${column}`);
    else if (!cols.has(column)) errors.push(`unknown column: ${table}.${column}`);
  }

  // STEP 6 — join ON-equalities must be backed by a real FK
  for (const j of extractJoinOns(stripped)) {
    const lt = amap.get(j.lq) || j.lq;
    const rt = amap.get(j.rq) || j.rq;
    const key = `${lt}.${j.lc}=${rt}.${j.rc}`;
    const rev = `${rt}.${j.rc}=${lt}.${j.lc}`;
    if (idx.relKeys.has(key) || idx.relKeys.has(rev)) continue;
    if (!strict && j.lc === j.rc && j.lc.endsWith('id')) continue;
    errors.push(`join lacks FK evidence: ${lt}.${j.lc} = ${rt}.${j.rc}`);
  }

  // STEP 7 — time filter for event-like/high-risk tables
  try {
    requireTimeFilterIfEventLike({
      schema: opts.schema,
      plan: opts.plan,
      sql: opts.sql,
      userRequestedNoTimeFilter: opts.userRequestedNoTimeFilter,
    });
  } catch (e: any) {
    errors.push(String(e?.message || e));
  }

  // STEP 8 — mandatory LIMIT for non-aggregations
  try {
    requireLimitForNonAggregations(opts.sql, defaultLimit);
  } catch (e: any) {
    errors.push(String(e?.message || e));
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, sql: opts.sql.trim() };
}

/** Strict wrapper: returns SQL or throws with all errors joined. */
export function validateSql(opts: { schema: NormalizedSchema; plan: QueryPlan; sql: string }): string {
  const res = validateSqlDetailed({ ...opts, strict: true });
  if (res.ok) return res.sql;
  throw new Error(res.errors.join('\n'));
}
