import type { Config, LlmAdapter, NormalizedSchema, QueryPlan, RetrievedContext } from '../types';
import { guardSqlString } from '../validate/guards';

const FALLBACK_SQL = "SELECT 'insufficient grounding for this request' AS message LIMIT 1;";
const WRITE_OR_DDL = /\b(insert|update|delete|replace|merge|upsert|create|alter|drop|truncate|grant|revoke|call|exec|execute)\b/i;

function bareTable(name: string): string {
  return name.split('.').pop()!.toLowerCase();
}

function compactSchemaForGen(schema: NormalizedSchema, plan: QueryPlan): NormalizedSchema {
  const wanted = new Set(plan.tables.map(bareTable));
  const tables = schema.tables.filter((t) => wanted.has(t.name.toLowerCase()));
  const names = new Set(tables.map((t) => t.name.toLowerCase()));
  return {
    tables,
    columns: schema.columns.filter((c) => names.has(c.table.toLowerCase())),
    relationships: schema.relationships.filter(
      (r) => names.has(r.from.table.toLowerCase()) || names.has(r.to.table.toLowerCase()),
    ),
    indexes: schema.indexes.filter((i) => names.has(i.table.toLowerCase())),
  };
}

function cleanSqlText(text: string): string {
  let s = String(text ?? '').trim();
  if (!s) return '';
  s = s.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '');
  s = s.replace(/^\s*(here is the sql|sql)\s*:\s*\n+/i, '');
  const m = s.match(/(^|\n)\s*(with|select)\b[\s\S]*/i);
  if (m) s = s.slice(s.indexOf(m[2]));
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.slice(0, semi + 1);
  return s.trim();
}

function isReadOnlySqlCandidate(sql: string): boolean {
  const s = sql.trim();
  if (!s) return false;
  if (!/^(with|select)\b/i.test(s)) return false;
  return !WRITE_OR_DDL.test(s);
}

function ragBuckets(retrieved: RetrievedContext) {
  const pick = (type: string, cap: number) =>
    retrieved.docs.filter((d) => d.metadata?.type === type).slice(0, cap).map((d) => ({ id: d.id, text: d.document ?? null }));
  return { joinEdges: pick('fk_edge', 12), examples: pick('example_query', 8), notes: pick('domain_note', 6) };
}

function buildPrompt(opts: {
  strict: boolean;
  cfg: Config;
  plan: QueryPlan;
  slice: NormalizedSchema;
  rag: ReturnType<typeof ragBuckets>;
  question: string;
}): string {
  const { strict, plan, slice, rag, question } = opts;
  const lines = [
    `You are a STRICT SQL generator for the ${plan.dialect} dialect.`,
    'Output SQL ONLY — exactly one read-only statement.',
    'Rules:',
    '- No SELECT *; project explicit columns.',
    '- Use explicit JOINs; alias every table.',
    '- Include a time filter unless the plan says no time window.',
    '- Include a bounded LIMIT for non-aggregation queries.',
    '- Never invent tables, columns, or categorical values.',
  ];
  if (strict) {
    lines.push(
      'MANDATORY: output must be a single statement, must start with WITH or SELECT, no prose/markdown/JSON, and end with a semicolon.',
    );
  }
  lines.push(
    '',
    `Question: ${question}`,
    '[Approved plan]',
    JSON.stringify(plan),
    '[Schema slice]',
    JSON.stringify(slice),
    '[Join edges]',
    JSON.stringify(rag.joinEdges),
    '[Examples]',
    JSON.stringify(rag.examples),
    '[Notes]',
    JSON.stringify(rag.notes),
    'Return one statement ending with a semicolon.',
  );
  return lines.join('\n');
}

/** Stage 5 — generate exactly one read-only SQL statement. */
export async function generateSql(opts: {
  llm: LlmAdapter;
  cfg: Config;
  schema: NormalizedSchema;
  plan: QueryPlan;
  retrieved: RetrievedContext;
  question: string;
  debug?: { sqlRaw?: string; sqlFinal?: string };
}): Promise<string> {
  const { llm, cfg, schema, plan, retrieved, question, debug } = opts;
  const slice = compactSchemaForGen(schema, plan);
  const rag = ragBuckets(retrieved);

  const runOnce = async (strict: boolean): Promise<{ raw: string; cleaned: string }> => {
    const prompt = buildPrompt({ strict, cfg, plan, slice, rag, question });
    const res = await llm.generate({ model: cfg.model, prompt });
    const raw = String(res.text ?? '');
    return { raw, cleaned: cleanSqlText(raw) };
  };

  let { raw, cleaned } = await runOnce(false);
  if (debug) debug.sqlRaw = raw.slice(0, 2000);

  let candidate = cleaned;
  if (!isReadOnlySqlCandidate(candidate)) {
    ({ raw, cleaned } = await runOnce(true));
    if (debug) debug.sqlRaw = raw.slice(0, 2000);
    candidate = cleaned;
  }

  let finalSql = candidate;
  if (!isReadOnlySqlCandidate(finalSql)) finalSql = FALLBACK_SQL;
  else if (!finalSql.endsWith(';')) finalSql += ';';

  try {
    guardSqlString(finalSql);
  } catch {
    finalSql = FALLBACK_SQL;
    guardSqlString(finalSql); // guaranteed to pass
  }

  if (debug) debug.sqlFinal = finalSql;
  return finalSql;
}
