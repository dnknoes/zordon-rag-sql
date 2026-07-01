// Shared type contracts for the Zordon RAG SQL engine.
// This is a synthetic portfolio showcase — all schema/data is fictional.

export type Dialect = 'mysql' | 'clickhouse';
export type Risk = 'low' | 'medium' | 'high';

/** Provenance of a resolved entity, ordered loosely by trust. */
export type EntitySource = 'schema' | 'vector' | 'fuzzy' | 'graph' | 'user';

/** Kind of a resolved entity. `literal` tags a user-supplied quoted value. */
export type EntityType = 'table' | 'column' | 'metric' | 'dimension' | 'literal' | 'unknown';

export interface ResolvedEntity {
  name: string;
  type: EntityType;
  /** 0..1 */
  confidence: number;
  source: EntitySource;
}

/** Structured query plan the planner LLM must emit (never raw SQL). */
export interface QueryPlan {
  intent: string;
  entities: ResolvedEntity[];
  metrics: string[];
  dimensions: string[];
  /** e.g. "last 7 days", or null when no time bound. */
  timeWindow: string | null;
  /** e.g. "day" | "week", or null. */
  grain: string | null;
  filters: string[];
  tables: string[];
  joins: string[];
  dialect: Dialect;
  riskFlags: string[];
  /** Truncated raw model output, for debugging only. */
  _raw?: string;
}

// ---- Normalized schema "cards" ----------------------------------------------

export interface TableCard {
  schema: string;
  name: string;
  approxRowCount?: number;
  risk: Risk;
  comment?: string;
}

export interface ColumnCard {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  isNullable: boolean;
  comment?: string;
}

export interface Relationship {
  kind: 'foreign_key';
  from: { schema: string; table: string; column: string };
  to: { schema: string; table: string; column: string };
  constraintName?: string;
}

export interface IndexHint {
  schema: string;
  table: string;
  indexName: string;
  columns: string[];
  isUnique: boolean;
}

export interface NormalizedSchema {
  tables: TableCard[];
  columns: ColumnCard[];
  relationships: Relationship[];
  indexes: IndexHint[];
}

// ---- Retrieval --------------------------------------------------------------

export type CardType =
  | 'table_card'
  | 'column_card'
  | 'fk_edge'
  | 'index_hint'
  | 'example_query'
  | 'domain_note';

export interface CardMetadata {
  type: CardType;
  schema?: string;
  table?: string;
  column?: string;
  from?: string;
  to?: string;
  constraintName?: string;
  risk?: Risk;
  approxRowCount?: number;
  file?: string;
}

export interface RetrievedDoc {
  id: string;
  document?: string | null;
  metadata?: CardMetadata | null;
  distance?: number | null;
}

export interface RetrievedContext {
  ids: string[];
  docs: RetrievedDoc[];
  graphTables?: string[];
}

// ---- Pluggable providers ----------------------------------------------------

/** Any chat/completion model. All prompt-building + parsing lives in the pipeline. */
export interface LlmAdapter {
  generate(req: { prompt: string; model: string; format?: 'json' }): Promise<{ text: string }>;
}

/** Turns a string into a vector. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export interface UpsertCard {
  id: string;
  document: string;
  metadata: CardMetadata;
  /** Precomputed embedding (client-side embedding avoids a server-side dependency). */
  embedding: number[];
}

/** Vector store abstraction (Chroma or in-memory). */
export interface VectorStore {
  ensureCollection(): Promise<void>;
  upsert(cards: UpsertCard[]): Promise<void>;
  /** Nearest-neighbor by precomputed embedding, optionally filtered by metadata. */
  query(embedding: number[], nResults: number, where?: Record<string, unknown>): Promise<RetrievedDoc[]>;
  count(): Promise<number>;
}

// ---- Config + request/response ---------------------------------------------

export interface Config {
  model: string;
  embedModel: string;
  dialectDefault: Dialect;
  vectorStore: { url: string; collection: string };
  retrieval: { kTables: number; kColumns: number; kRelationships: number; kExamples: number };
  minDocs: number;
}

export interface Request {
  question: string;
  dialect?: Dialect;
  includeDebug?: boolean;
  strict?: boolean;
  /** alias -> chosen canonical id OR a 1-based option number as a string. */
  aliasChoices?: Record<string, string>;
}

export interface ClarificationOption {
  label: string;
  canonical: string;
  probability?: number;
}

export interface Clarification {
  prompt: string;
  alias?: string;
  entityType?: EntityType;
  scope?: Record<string, string>;
  options: ClarificationOption[];
  reason?: string;
}

export interface DebugInfo {
  entities?: ResolvedEntity[];
  plan?: QueryPlan;
  retrievedIds?: string[];
  retrievalUsedEmbeddings?: boolean;
  embedModel?: string;
  plannerRaw?: string;
  sqlRaw?: string;
  sqlFinal?: string;
}

export interface Response {
  sql?: string;
  error?: string;
  clarification?: Clarification;
  warnings?: string[];
  debug?: DebugInfo;
}
