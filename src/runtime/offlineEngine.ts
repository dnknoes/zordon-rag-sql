import { defaultConfig } from '../config';
import { createZordon } from '../index';
import { createMockLlm } from '../llm/mockLlm';
import { createHashEmbedder } from '../retrieval/embed';
import { indexSchema, type DomainNote, type ExampleQuery } from '../retrieval/index';
import { InMemoryVectorStore } from '../retrieval/vectorStore';
import { loadNormalizedSchema } from '../schema/loader';
import type { Config, NormalizedSchema } from '../types';

/**
 * Build a fully self-contained engine that runs offline: in-memory vector store,
 * deterministic hash embedder, and mock LLM, over a synthetic schema. Used by
 * the bundled demo + eval so they need no Ollama/Chroma.
 */
export async function buildOfflineEngine(opts: {
  schemaDir: string;
  examples?: ExampleQuery[];
  notes?: DomainNote[];
}): Promise<{
  engine: ReturnType<typeof createZordon>;
  cfg: Config;
  schema: NormalizedSchema;
  indexed: number;
}> {
  const cfg = defaultConfig();
  const schema = await loadNormalizedSchema(opts.schemaDir);
  const store = new InMemoryVectorStore();
  const embedder = createHashEmbedder();
  const { upserted } = await indexSchema({ store, embedder, schema, examples: opts.examples, notes: opts.notes });
  const llm = createMockLlm();
  const engine = createZordon({ llm, store, embedder, schema, cfg });
  return { engine, cfg, schema, indexed: upserted };
}
