import type { EntitySource, NormalizedSchema, ResolvedEntity, RetrievedContext } from '../types';

export interface EntityCandidate {
  id: string;
  type: 'table' | 'column';
  confidence: number;
  source: EntitySource;
}

export interface AmbiguityGate {
  kind: 'table' | 'column';
  delta: number;
  top: EntityCandidate;
  runnerUp: EntityCandidate;
  question: string;
  clarification: string;
}

export interface ResolveDetail {
  entities: ResolvedEntity[];
  tableCandidates: EntityCandidate[];
  columnCandidates: EntityCandidate[];
  ambiguity?: AmbiguityGate;
}

function tokenize(s: string): Set<string> {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function tokenOverlapScore(qTokens: Set<string>, name: string): number {
  const nameToks = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!nameToks.length) return 0;
  let hit = 0;
  for (const t of nameToks) if (qTokens.has(t)) hit += 1;
  return hit / nameToks.length;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function vectorConfidence(distance?: number | null): number {
  if (distance == null || !Number.isFinite(distance)) return 0.6;
  return clamp01(1 / (1 + distance));
}

function dedupeSort(list: EntityCandidate[]): EntityCandidate[] {
  const best = new Map<string, EntityCandidate>();
  for (const c of list) {
    const key = `${c.type}:${c.id.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || c.confidence > prev.confidence) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}

/** Full-detail entity resolution: ranked candidates + optional ambiguity gate. */
export function resolveEntitiesDetailed(opts: {
  schema: NormalizedSchema;
  retrieved: RetrievedContext;
  question: string;
  ambiguityDelta?: number;
}): ResolveDetail {
  const { schema, retrieved, question } = opts;
  const delta = opts.ambiguityDelta ?? 0.03;
  const qTokens = tokenize(question);

  const tableCands: EntityCandidate[] = [];
  const colCands: EntityCandidate[] = [];

  // 1) schema fuzzy pass
  for (const t of schema.tables) {
    const score = tokenOverlapScore(qTokens, t.name);
    if (score > 0) tableCands.push({ id: `${t.schema}.${t.name}`, type: 'table', confidence: clamp01(0.55 + 0.45 * score), source: 'fuzzy' });
    if (qTokens.has(t.name.toLowerCase())) tableCands.push({ id: `${t.schema}.${t.name}`, type: 'table', confidence: 1, source: 'schema' });
  }
  for (const c of schema.columns) {
    const score = tokenOverlapScore(qTokens, c.name);
    if (score > 0) colCands.push({ id: `${c.schema}.${c.table}.${c.name}`, type: 'column', confidence: clamp01(0.45 + 0.45 * score), source: 'fuzzy' });
  }

  // 2) retrieval pass
  for (const doc of retrieved.docs) {
    const md = doc.metadata;
    if (!md) continue;
    const conf = vectorConfidence(doc.distance);
    if (md.type === 'table_card' && md.schema && md.table) {
      tableCands.push({ id: `${md.schema}.${md.table}`, type: 'table', confidence: clamp01(0.75 + 0.25 * conf), source: 'vector' });
    } else if (md.type === 'column_card' && md.schema && md.table && md.column) {
      colCands.push({ id: `${md.schema}.${md.table}.${md.column}`, type: 'column', confidence: clamp01(0.7 + 0.25 * conf), source: 'vector' });
    }
  }

  // 3) graph pass (join evidence)
  for (const gt of (retrieved.graphTables ?? []).slice(0, 50)) {
    const table = schema.tables.find((t) => t.name.toLowerCase() === gt.toLowerCase());
    if (table) tableCands.push({ id: `${table.schema}.${table.name}`, type: 'table', confidence: 0.58, source: 'graph' });
  }

  const tableCandidates = dedupeSort(tableCands);
  const columnCandidates = dedupeSort(colCands);

  // 4) ambiguity gate (tables first, then columns)
  let ambiguity: AmbiguityGate | undefined;
  for (const [kind, list] of [
    ['table', tableCandidates],
    ['column', columnCandidates],
  ] as const) {
    if (ambiguity) break;
    if (list.length >= 2) {
      const [top, runnerUp] = list;
      if (Math.abs(top.confidence - runnerUp.confidence) <= delta && top.id.toLowerCase() !== runnerUp.id.toLowerCase()) {
        ambiguity = {
          kind,
          delta,
          top,
          runnerUp,
          question,
          clarification: `Ambiguous ${kind}: did you mean "${top.id}" or "${runnerUp.id}"? Please clarify.`,
        };
      }
    }
  }

  // 5) emit entities (+ literal protection)
  const entities: ResolvedEntity[] = [];
  for (const c of tableCandidates.slice(0, 8)) entities.push({ name: c.id, type: 'table', confidence: c.confidence, source: c.source });
  for (const c of columnCandidates.slice(0, 12)) entities.push({ name: c.id, type: 'column', confidence: c.confidence, source: c.source });

  const quoted = question.match(/'([^']+)'/g) || [];
  for (const q of quoted) {
    entities.push({ name: q.replace(/'/g, ''), type: 'literal', confidence: 0.2, source: 'user' });
  }

  // final dedupe
  const bestE = new Map<string, ResolvedEntity>();
  for (const e of entities) {
    const key = `${e.type}:${e.name.toLowerCase()}`;
    const prev = bestE.get(key);
    if (!prev || e.confidence > prev.confidence) bestE.set(key, e);
  }
  const finalEntities = [...bestE.values()].sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  return { entities: finalEntities, tableCandidates, columnCandidates, ambiguity };
}

/** Thin wrapper returning just the entities. */
export function resolveEntities(opts: { schema: NormalizedSchema; retrieved: RetrievedContext; question: string }): ResolvedEntity[] {
  return resolveEntitiesDetailed(opts).entities;
}
