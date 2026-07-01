import type { CardType, Config, Embedder, NormalizedSchema, RetrievedContext, RetrievedDoc, VectorStore } from '../types';
import { fuzzyScore } from './fuzzy';
import { expandViaFkGraph } from './graph';

const MAX_DOCS = 80;
const MAX_CHARS = 35_000;

/**
 * Stage 2 — multi-signal retrieval. Embeds the question, does per-type semantic
 * search, applies a deterministic fuzzy re-rank, dedupes examples by join-family,
 * enforces a doc/char budget (schema truth before examples), and expands the FK
 * graph to supply join evidence.
 */
export async function retrieveContext(opts: {
  cfg: Config;
  question: string;
  store: VectorStore;
  embedder: Embedder;
  schema?: NormalizedSchema;
}): Promise<RetrievedContext> {
  const { cfg, question, store, embedder, schema } = opts;
  const qEmb = await embedder.embed(question);
  const r = cfg.retrieval;

  const queryType = (type: CardType, n: number): Promise<RetrievedDoc[]> =>
    store.query(qEmb, Math.max(1, n), { type });

  const [tables, columns, rels, indexes, notes, examples] = await Promise.all([
    queryType('table_card', r.kTables),
    queryType('column_card', r.kColumns),
    queryType('fk_edge', r.kRelationships),
    queryType('index_hint', Math.max(3, Math.floor(r.kTables / 2))),
    queryType('domain_note', 4),
    queryType('example_query', Math.max(3, r.kExamples)),
  ]);

  const rerank = (docs: RetrievedDoc[]): RetrievedDoc[] =>
    docs
      .map((d) => ({ d, s: fuzzyScore(question, d.document || d.id) }))
      .sort((a, b) => b.s - a.s || a.d.id.localeCompare(b.d.id))
      .map((x) => x.d);

  const schemaTruth = [
    ...rerank(tables),
    ...rerank(columns),
    ...rerank(rels),
    ...rerank(indexes),
    ...rerank(notes),
  ];
  const dedupedExamples = dedupeExamples(rerank(examples)).slice(0, 8);

  // Budget merge: schema truth first so it always wins the budget.
  const seen = new Set<string>();
  const merged: RetrievedDoc[] = [];
  let chars = 0;
  const tryAdd = (d: RetrievedDoc): void => {
    if (seen.has(d.id) || merged.length >= MAX_DOCS) return;
    const len = (d.document || '').length + d.id.length;
    if (chars + len > MAX_CHARS) return;
    seen.add(d.id);
    merged.push(d);
    chars += len;
  };
  for (const d of schemaTruth) tryAdd(d);
  for (const d of dedupedExamples) tryAdd(d);

  let graphTables: string[] | undefined;
  if (schema) {
    const seeds = merged.map((d) => d.metadata?.table).filter((t): t is string => Boolean(t));
    if (seeds.length) graphTables = expandViaFkGraph(schema, seeds, 2);
  }

  return { ids: merged.map((d) => d.id), docs: merged, graphTables };
}

function dedupeExamples(docs: RetrievedDoc[]): RetrievedDoc[] {
  const byFamily = new Map<string, RetrievedDoc>();
  for (const d of docs) {
    const key = exampleSkeleton(String(d.document || ''));
    if (!byFamily.has(key)) byFamily.set(key, d);
  }
  return [...byFamily.values()];
}

/** Reduce an example SQL to its set of referenced tables (its "join family"). */
function exampleSkeleton(sql: string): string {
  const noStrings = sql.replace(/'(?:[^']|'')*'/g, "''");
  const ids: string[] = [];
  const re = /\b(?:from|join)\s+([A-Za-z0-9_.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noStrings))) {
    const last = m[1].split('.').pop();
    if (last) ids.push(last.toLowerCase());
  }
  const uniq = [...new Set(ids)].sort();
  return uniq.length ? uniq.join(',') : 'unknown';
}
