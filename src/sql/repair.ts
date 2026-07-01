import type { Config, LlmAdapter, NormalizedSchema, QueryPlan, RetrievedContext } from '../types';
import { guardSqlString } from '../validate/guards';

function bareTable(name: string): string {
  return name.split('.').pop()!.toLowerCase();
}

function compactSchema(schema: NormalizedSchema, plan: QueryPlan): NormalizedSchema {
  const wanted = new Set(plan.tables.map(bareTable));
  const tables = schema.tables.filter((t) => wanted.has(t.name.toLowerCase()));
  const names = new Set(tables.map((t) => t.name.toLowerCase()));
  return {
    tables,
    columns: schema.columns.filter((c) => names.has(c.table.toLowerCase())).slice(0, 600),
    relationships: schema.relationships
      .filter((r) => names.has(r.from.table.toLowerCase()) || names.has(r.to.table.toLowerCase()))
      .slice(0, 300),
    indexes: [],
  };
}

function ragBuckets(retrieved: RetrievedContext) {
  const pick = (type: string, cap: number) =>
    retrieved.docs.filter((d) => d.metadata?.type === type).slice(0, cap).map((d) => ({ id: d.id, text: d.document ?? null }));
  return { joinEdges: pick('fk_edge', 10), examples: pick('example_query', 6), notes: pick('domain_note', 4) };
}

/** Single-shot repair: feed the failing SQL + validator errors back to the LLM. */
export async function repairSqlOnce(opts: {
  llm: LlmAdapter;
  cfg: Config;
  schema: NormalizedSchema;
  plan: QueryPlan;
  retrieved: RetrievedContext;
  originalSql: string;
  validatorErrors: string[];
}): Promise<string> {
  const { llm, cfg, schema, plan, retrieved, originalSql, validatorErrors } = opts;
  const slice = compactSchema(schema, plan);
  const rag = ragBuckets(retrieved);

  const prompt = [
    `You are a STRICT SQL repair assistant for the ${plan.dialect} dialect.`,
    'Output SQL ONLY, no markdown. Fix the SQL so it satisfies the validator errors.',
    'Rules: no SELECT *; exactly one statement ending in a semicolon; keep tables within the approved plan;',
    'never invent tables, columns, or categorical values.',
    '',
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
    '[Original SQL]',
    String(originalSql ?? '').trim(),
    '[Validator errors]',
    ...validatorErrors.map((e) => `- ${e}`),
    'Return the corrected SQL.',
  ].join('\n');

  const res = await llm.generate({ model: cfg.model, prompt });
  let sql = String(res.text ?? '').trim();
  guardSqlString(sql); // authoritative; throws on violation (no fallback here)
  if (!sql.endsWith(';')) sql += ';';
  return sql;
}
