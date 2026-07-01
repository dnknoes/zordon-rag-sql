import { defaultConfig } from '../src/config';
import { createOllamaEmbedder } from '../src/retrieval/embed';
import { indexSchema } from '../src/retrieval/index';
import { ChromaVectorStore } from '../src/retrieval/vectorStore';
import { loadNormalizedSchema } from '../src/schema/loader';
import { EXAMPLES, NOTES, SCHEMA_DIR } from './_shared';

// Real-stack indexer: embeds the synthetic schema cards with Ollama and upserts
// them into a Chroma collection. Requires local Ollama + Chroma running.
// (The demo/eval do NOT need this — they run fully offline in-memory.)
async function main(): Promise<void> {
  const cfg = defaultConfig();
  const schema = await loadNormalizedSchema(SCHEMA_DIR);
  const store = new ChromaVectorStore(cfg);
  const embedder = createOllamaEmbedder({ model: cfg.embedModel });

  console.log(`[index] embedding model=${cfg.embedModel}`);
  console.log(`[index] target Chroma=${cfg.vectorStore.url} collection=${cfg.vectorStore.collection}`);
  try {
    const { upserted } = await indexSchema({ store, embedder, schema, examples: EXAMPLES, notes: NOTES });
    console.log(`[index] upserted ${upserted} cards.`);
  } catch (e: any) {
    console.error(
      `[index] failed — is Chroma (${cfg.vectorStore.url}) and Ollama (${process.env.OLLAMA_URL || 'http://localhost:11434'}) running? ${e?.message || e}`,
    );
    process.exit(1);
  }
}

main();
