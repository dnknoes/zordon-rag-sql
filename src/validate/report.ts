import type { NormalizedSchema } from '../types';
import { guardSqlString } from './guards';
import { requireLimitForNonAggregations } from './rules/requireLimit';

/**
 * Human-facing, per-check summary of the guardrails as applied to a *final* SQL
 * string. This does not add any new safety logic — it re-runs the same guards the
 * engine already enforces so a demo/UI can show WHY a statement is (or isn't)
 * safe. Treat model output as untrusted; this only describes the outcome.
 */
export interface GuardrailReport {
  /** Passes the string-level read-only guard (SELECT/WITH only, no write verbs, no `SELECT *`, single statement). */
  readOnly: boolean;
  /** Every table referenced by the SQL exists in the schema (vacuously true if none). */
  knownTables: boolean;
  /** Has a bounded LIMIT, or is an aggregation that is exempt. */
  limit: boolean;
  /** The natural-language question expressed destructive/write intent. */
  destructiveIntent: boolean;
  /** Destructive intent was present but the emitted SQL is read-only (i.e. neutralized). */
  destructiveBlocked: boolean;
}

// Write/DDL intent expressed in NATURAL LANGUAGE (not SQL) — used only to label
// the demo, never to gate SQL (the SQL guards do that unconditionally).
const WRITE_INTENT = /\b(delete|drop|truncate|update|insert|remove|wipe|purge|alter|overwrite)\b/i;

function bare(name: string): string {
  return name.split('.').pop()!.toLowerCase();
}

function stripStrings(sql: string): string {
  return String(sql ?? '').replace(/'(?:[^']|'')*'/g, "''");
}

function tablesInSql(sql: string): string[] {
  const out: string[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z0-9_.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) out.push(bare(m[1]));
  return [...new Set(out)];
}

/**
 * Summarize how a final SQL string fares against the engine's guardrails, plus
 * whether a destructive natural-language request was neutralized.
 */
export function describeGuardrails(opts: {
  schema: NormalizedSchema;
  sql: string;
  question: string;
}): GuardrailReport {
  const { schema, sql, question } = opts;

  let readOnly = true;
  try {
    guardSqlString(sql);
  } catch {
    readOnly = false;
  }

  const known = new Set(schema.tables.map((t) => t.name.toLowerCase()));
  const used = tablesInSql(stripStrings(sql));
  const knownTables = used.every((t) => known.has(t));

  let limit = true;
  try {
    requireLimitForNonAggregations(sql, 500);
  } catch {
    limit = false;
  }

  const destructiveIntent = WRITE_INTENT.test(question);
  const destructiveBlocked = destructiveIntent && readOnly;

  return { readOnly, knownTables, limit, destructiveIntent, destructiveBlocked };
}
