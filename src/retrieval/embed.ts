import type { Embedder } from '../types';

/** Real embedder: local Ollama embeddings endpoint. */
export function createOllamaEmbedder(opts?: { baseUrl?: string; model?: string }): Embedder {
  const baseUrl = (opts?.baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const model = opts?.model || process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

  return {
    async embed(text: string): Promise<number[]> {
      const prompt = String(text ?? '').trim();
      if (!prompt) throw new Error('embed: empty text');
      const resp = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Ollama embeddings HTTP ${resp.status}: ${body}`);
      }
      const data: any = await resp.json();
      if (!Array.isArray(data?.embedding)) throw new Error('embed: missing embedding array in response');
      return data.embedding.map((n: any) => Number(n));
    },
  };
}

/**
 * Deterministic OFFLINE embedder: hashes tokens into a fixed-dimension
 * bag-of-words vector. Not semantically meaningful — it exists only so the
 * bundled demo/eval run with no external services. Use the Ollama embedder
 * for real semantic retrieval.
 */
export function createHashEmbedder(dim = 96): Embedder {
  return {
    async embed(text: string): Promise<number[]> {
      const v = new Array<number>(dim).fill(0);
      // Split identifiers on underscores too (work_order_id -> work, order, id)
      // so shared words drive similarity in this offline stand-in.
      const tokens = String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      for (const tok of tokens) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i += 1) {
          h ^= tok.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        v[Math.abs(h) % dim] += 1;
      }
      return v;
    },
  };
}
