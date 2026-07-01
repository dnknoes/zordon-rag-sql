import type { CardMetadata, Embedder, NormalizedSchema, UpsertCard, VectorStore } from '../types';

export interface ExampleQuery {
  name: string;
  sql: string;
}
export interface DomainNote {
  name: string;
  text: string;
}

interface RawCard {
  id: string;
  document: string;
  metadata: CardMetadata;
}

/**
 * Build embedding "cards" from a normalized schema (+ optional example SQL and
 * domain notes) and upsert them into the vector store. We deliberately index
 * compact per-item cards rather than ever prompt-stuffing a raw schema dump.
 */
export async function indexSchema(opts: {
  store: VectorStore;
  embedder: Embedder;
  schema: NormalizedSchema;
  examples?: ExampleQuery[];
  notes?: DomainNote[];
}): Promise<{ upserted: number }> {
  const { store, embedder, schema, examples = [], notes = [] } = opts;
  await store.ensureCollection();

  const cards: RawCard[] = [];

  for (const t of schema.tables) {
    cards.push({
      id: `table:${t.schema}.${t.name}`,
      document: `TABLE ${t.schema}.${t.name} — ~${t.approxRowCount ?? 'n/a'} rows, risk=${t.risk}${t.comment ? `. ${t.comment}` : ''}`,
      metadata: { type: 'table_card', schema: t.schema, table: t.name, risk: t.risk, approxRowCount: t.approxRowCount },
    });
  }
  for (const c of schema.columns) {
    cards.push({
      id: `column:${c.schema}.${c.table}.${c.name}`,
      document: `COLUMN ${c.schema}.${c.table}.${c.name} ${c.dataType}${c.isNullable ? ' NULL' : ' NOT NULL'}${c.comment ? `. ${c.comment}` : ''}`,
      metadata: { type: 'column_card', schema: c.schema, table: c.table, column: c.name },
    });
  }
  for (const r of schema.relationships) {
    const from = `${r.from.schema}.${r.from.table}.${r.from.column}`;
    const to = `${r.to.schema}.${r.to.table}.${r.to.column}`;
    cards.push({
      id: `fk:${from}->${to}`,
      document: `FOREIGN KEY ${from} -> ${to}`,
      metadata: { type: 'fk_edge', from, to, table: r.from.table, constraintName: r.constraintName },
    });
  }
  for (const ix of schema.indexes) {
    cards.push({
      id: `index:${ix.schema}.${ix.table}.${ix.indexName}`,
      document: `INDEX ${ix.indexName} ON ${ix.schema}.${ix.table} (${ix.columns.join(', ')})${ix.isUnique ? ' UNIQUE' : ''}`,
      metadata: { type: 'index_hint', schema: ix.schema, table: ix.table },
    });
  }
  for (const ex of examples) {
    const sql = String(ex.sql ?? '').trim();
    if (!sql) continue;
    cards.push({ id: `example:${ex.name}`, document: sql, metadata: { type: 'example_query', file: ex.name } });
  }
  for (const n of notes) {
    const text = String(n.text ?? '').trim();
    if (!text) continue;
    cards.push({ id: `note:${n.name}`, document: text, metadata: { type: 'domain_note', file: n.name } });
  }

  const withEmbeddings: UpsertCard[] = [];
  for (const c of cards) {
    withEmbeddings.push({ ...c, embedding: await embedder.embed(c.document) });
  }

  const BATCH = 200;
  for (let i = 0; i < withEmbeddings.length; i += BATCH) {
    await store.upsert(withEmbeddings.slice(i, i + BATCH));
  }
  return { upserted: withEmbeddings.length };
}
