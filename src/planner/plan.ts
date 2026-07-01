import type {
  Config,
  Dialect,
  LlmAdapter,
  NormalizedSchema,
  QueryPlan,
  ResolvedEntity,
  RetrievedContext,
} from '../types';

const ALLOWED_DIALECTS: Dialect[] = ['mysql', 'clickhouse'];
const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

const emptyPlan = (dialect: Dialect, entities: ResolvedEntity[]): QueryPlan => ({
  intent: 'sql',
  entities,
  metrics: [],
  dimensions: [],
  timeWindow: null,
  grain: null,
  filters: [],
  tables: [],
  joins: [],
  dialect,
  riskFlags: [],
});

/** Strict structural validator; throws on malformed plans. */
export function validatePlan(plan: any): QueryPlan {
  const required = ['intent', 'entities', 'metrics', 'dimensions', 'filters', 'tables', 'joins', 'dialect', 'riskFlags'];
  for (const k of required) if (!(k in plan)) throw new Error(`plan missing field: ${k}`);
  for (const k of ['entities', 'metrics', 'dimensions', 'filters', 'tables', 'joins', 'riskFlags']) {
    if (!Array.isArray(plan[k])) throw new Error(`plan.${k} must be an array`);
  }
  if (!ALLOWED_DIALECTS.includes(plan.dialect)) throw new Error(`plan.dialect unsupported: ${plan.dialect}`);
  return normalizePlan(plan, plan.dialect, plan.entities);
}

function cleanModelJsonText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parsePlannerJsonOrThrow(text: string, model: string): any {
  const cleaned = cleanModelJsonText(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
    const err: any = new Error(`planner: model ${model} did not return JSON (preview: ${cleaned.slice(0, 400)})`);
    err._raw = cleaned.slice(0, 2000);
    throw err;
  }
}

function looksLikeSchemaBlob(o: any): boolean {
  const hasSchemaish = typeof o?.schema === 'string' || Array.isArray(o?.columns) || Array.isArray(o?.relationships);
  const hasPlanish =
    typeof o?.intent === 'string' ||
    Array.isArray(o?.metrics) ||
    Array.isArray(o?.dimensions) ||
    Array.isArray(o?.filters) ||
    Array.isArray(o?.joins) ||
    Array.isArray(o?.riskFlags);
  return hasSchemaish && !hasPlanish;
}

function normalizePlan(o: any, dialect: Dialect, fallbackEntities: ResolvedEntity[]): QueryPlan {
  if (looksLikeSchemaBlob(o)) return emptyPlan(dialect, fallbackEntities);
  const arr = (x: any): string[] => (Array.isArray(x) ? x.map((v) => String(v)) : []);
  const tw = o.timeWindow ?? o.time_window;
  const rf = o.riskFlags ?? o.risk_flags;
  const dialectOut: Dialect = ALLOWED_DIALECTS.includes(o.dialect) ? o.dialect : dialect;
  return {
    intent: typeof o.intent === 'string' && o.intent.trim() ? o.intent.trim() : 'sql',
    entities: Array.isArray(o.entities) ? o.entities : fallbackEntities,
    metrics: arr(o.metrics),
    dimensions: arr(o.dimensions),
    timeWindow: tw != null ? String(tw) : null,
    grain: o.grain != null ? String(o.grain) : null,
    filters: arr(o.filters),
    tables: arr(o.tables),
    joins: arr(o.joins),
    dialect: dialectOut,
    riskFlags: arr(rf),
  };
}

function bareTable(name: string): string {
  return name.split('.').pop()!.toLowerCase();
}

function schemaSlice(schema: NormalizedSchema, entities: ResolvedEntity[]): NormalizedSchema {
  const wanted = new Set(entities.filter((e) => e.type === 'table').map((e) => bareTable(e.name)));
  let tables = wanted.size
    ? schema.tables.filter((t) => wanted.has(t.name.toLowerCase()))
    : [...schema.tables].sort((a, b) => (RISK_ORDER[a.risk] ?? 1) - (RISK_ORDER[b.risk] ?? 1)).slice(0, 15);
  tables = tables.slice(0, 20);
  const tableNames = new Set(tables.map((t) => t.name.toLowerCase()));
  return {
    tables,
    columns: schema.columns.filter((c) => tableNames.has(c.table.toLowerCase())).slice(0, 400),
    relationships: schema.relationships
      .filter((r) => tableNames.has(r.from.table.toLowerCase()) || tableNames.has(r.to.table.toLowerCase()))
      .slice(0, 200),
    indexes: schema.indexes.filter((i) => tableNames.has(i.table.toLowerCase())).slice(0, 100),
  };
}

function ragContext(retrieved: RetrievedContext) {
  const pick = (type: string, cap: number) =>
    retrieved.docs
      .filter((d) => d.metadata?.type === type)
      .slice(0, cap)
      .map((d) => ({ id: d.id, text: d.document ?? null }));
  return {
    joinEdges: pick('fk_edge', 12),
    examples: pick('example_query', 8),
    notes: pick('domain_note', 6),
  };
}

function buildPrompt(opts: {
  dialect: Dialect;
  question: string;
  entities: ResolvedEntity[];
  slice: NormalizedSchema;
  rag: ReturnType<typeof ragContext>;
}): string {
  const { dialect, question, entities, slice, rag } = opts;
  return [
    `You are a STRICT query PLANNER for the ${dialect} SQL dialect.`,
    'Return ONLY one JSON object. No markdown, no prose, no SQL.',
    'Rules:',
    '- Never emit SQL. Emit a structured PLAN only.',
    '- Never invent tables, columns, or categorical values; use only the provided context.',
    '- If a join lacks foreign-key evidence, add a risk flag and do not plan that join.',
    '- Require a time filter unless the user explicitly asks for all time.',
    '',
    'Output JSON schema:',
    '{ "intent": string, "entities": [{"name","type","confidence","source"}], "metrics": string[],',
    '  "dimensions": string[], "timeWindow": string|null, "grain": string|null, "filters": string[],',
    `  "tables": string[], "joins": string[], "dialect": "${dialect}", "riskFlags": string[] }`,
    '',
    `Dialect: ${dialect}`,
    `Question: ${question}`,
    '',
    '[Resolved entities]',
    JSON.stringify(entities),
    '[Schema slice]',
    JSON.stringify(slice),
    '[Join edges]',
    JSON.stringify(rag.joinEdges),
    '[Examples]',
    JSON.stringify(rag.examples),
    '[Notes]',
    JSON.stringify(rag.notes),
  ].join('\n');
}

/** Stage 4 — produce a validated structured plan (never SQL). */
export async function planQuery(opts: {
  llm: LlmAdapter;
  cfg: Config;
  schema: NormalizedSchema;
  dialect: Dialect;
  question: string;
  entities: ResolvedEntity[];
  retrieved: RetrievedContext;
}): Promise<QueryPlan> {
  const { llm, cfg, schema, dialect, question, entities, retrieved } = opts;
  const slice = schemaSlice(schema, entities);
  const rag = ragContext(retrieved);
  const prompt = buildPrompt({ dialect, question, entities, slice, rag });

  let res: { text: string };
  try {
    res = await llm.generate({ model: cfg.model, prompt, format: 'json' });
  } catch (e: any) {
    throw e;
  }

  const parsed = parsePlannerJsonOrThrow(res.text, cfg.model);
  const plan = normalizePlan(parsed, dialect, entities);
  plan._raw = String(res.text ?? '').slice(0, 2000);
  return plan;
}
