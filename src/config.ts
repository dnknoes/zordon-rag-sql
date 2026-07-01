import type { Config, Dialect } from './types';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Build the default runtime config from environment variables, each with a
 * local-first fallback. No secrets are ever required.
 */
export function defaultConfig(): Config {
  const model = env('OLLAMA_MODEL') || env('ZORDON_MODEL') || 'qwen2.5-coder:7b';
  const embedModel = env('OLLAMA_EMBED_MODEL') || env('ZORDON_EMBED_MODEL') || 'nomic-embed-text';
  const url = env('ZORDON_CHROMA_URL') || env('CHROMA_URL') || 'http://localhost:8000';
  const collection = env('ZORDON_CHROMA_COLLECTION') || env('CHROMA_COLLECTION') || 'zordon_demo';
  const dialectDefault = (env('ZORDON_DIALECT') as Dialect) || 'mysql';
  const minDocs = Number(env('ZORDON_MIN_DOCS') || '3');

  return {
    model,
    embedModel,
    dialectDefault,
    vectorStore: { url, collection },
    retrieval: { kTables: 10, kColumns: 20, kRelationships: 20, kExamples: 6 },
    minDocs: Number.isFinite(minDocs) ? minDocs : 3,
  };
}
