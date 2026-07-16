import { defaultConfig } from '../config';
import { createZordon } from '../index';
import { createMockLlm } from '../llm/mockLlm';
import { createHashEmbedder } from '../retrieval/embed';
import { indexSchema, type DomainNote, type ExampleQuery } from '../retrieval/index';
import { InMemoryVectorStore } from '../retrieval/vectorStore';
import { loadNormalizedSchema } from '../schema/loader';
import type { Config, LlmAdapter, NormalizedSchema } from '../types';

/**
 * Build a self-contained engine over a synthetic schema with a local-only
 * retrieval stack: an in-memory vector store and a deterministic hash embedder,
 * so no Chroma is ever needed.
 *
 * The LLM defaults to the deterministic offline mock (used by the bundled demo +
 * eval so they are reproducible). Pass `opts.llm` to inject a live adapter — e.g.
 * `createOllamaAdapter()` for the `npm run demo:ollama` live demo. Only the
 * planner/generator model changes; retrieval stays local and in-memory.
 */
export async function buildOfflineEngine(opts: {
  schemaDir: string;
  examples?: ExampleQuery[];
  notes?: DomainNote[];
  /** Override the deterministic mock model (retrieval remains offline). */
  llm?: LlmAdapter;
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
  const llm = opts.llm ?? createMockLlm();
  const engine = createZordon({ llm, store, embedder, schema, cfg });
  return { engine, cfg, schema, indexed: upserted };
}
