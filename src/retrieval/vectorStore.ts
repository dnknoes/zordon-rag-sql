import type { Config, RetrievedDoc, UpsertCard, VectorStore } from '../types';

// ---- Offline in-memory store (default for the bundled demo/eval) ------------

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Zero-dependency in-memory vector store. Enough to run the whole pipeline
 * offline; not a production store (no persistence, linear scan).
 */
export class InMemoryVectorStore implements VectorStore {
  private records: UpsertCard[] = [];

  async ensureCollection(): Promise<void> {
    /* no-op */
  }

  async upsert(cards: UpsertCard[]): Promise<void> {
    for (const c of cards) {
      const idx = this.records.findIndex((r) => r.id === c.id);
      if (idx >= 0) this.records[idx] = c;
      else this.records.push(c);
    }
  }

  async query(embedding: number[], nResults: number, where?: Record<string, unknown>): Promise<RetrievedDoc[]> {
    const wantType = where && typeof where.type === 'string' ? (where.type as string) : undefined;
    const scored = this.records
      .filter((r) => (wantType ? r.metadata.type === wantType : true))
      .map((r) => ({ r, sim: cosine(embedding, r.embedding) }))
      .sort((a, b) => (b.sim - a.sim) || a.r.id.localeCompare(b.r.id))
      .slice(0, Math.max(1, nResults));
    return scored.map(({ r, sim }) => ({
      id: r.id,
      document: r.document,
      metadata: r.metadata,
      distance: 1 - sim,
    }));
  }

  async count(): Promise<number> {
    return this.records.length;
  }
}

export function createInMemoryVectorStore(): VectorStore {
  return new InMemoryVectorStore();
}

// ---- Chroma REST store (for a real local stack) ----------------------------

type ChromaQueryResult = {
  ids: string[][];
  distances?: number[][];
  documents?: (string | null)[][];
  metadatas?: (Record<string, any> | null)[][];
};

/** Minimal Chroma v1 REST client implementing the same VectorStore contract. */
export class ChromaVectorStore implements VectorStore {
  private base: string;
  private collectionName: string;
  private collectionId?: string;

  constructor(cfg: Config) {
    this.base = String(cfg.vectorStore.url || '').replace(/\/$/, '');
    this.collectionName = cfg.vectorStore.collection;
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const resp = await fetch(url, init);
    if (!resp.ok) throw new Error(`Chroma HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    return (await resp.json()) as T;
  }

  private collectionsUrl(): string {
    return `${this.base}/api/v1/collections`;
  }

  async ensureCollection(): Promise<void> {
    await this.resolveCollectionId();
  }

  private async resolveCollectionId(): Promise<string> {
    if (this.collectionId) return this.collectionId;
    const name = this.collectionName.trim();
    if (!name) throw new Error('vector store: empty collection name');

    const list = await this.fetchJson<any>(this.collectionsUrl(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const arr: any[] = Array.isArray(list) ? list : Array.isArray(list?.collections) ? list.collections : [];
    const found = arr.find((c) => c && c.name === name);
    if (found?.id) {
      this.collectionId = String(found.id);
      return this.collectionId;
    }

    let created: any = null;
    try {
      created = await this.fetchJson<any>(this.collectionsUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch (e: any) {
      if (!/already exists|conflict|409/i.test(String(e?.message || e))) throw e;
    }
    const id = String(created?.id || created?.collection?.id || '');
    if (id) {
      this.collectionId = id;
      return id;
    }
    throw new Error(`vector store: could not resolve collection '${name}'`);
  }

  async upsert(cards: UpsertCard[]): Promise<void> {
    if (!cards.length) return;
    const id = await this.resolveCollectionId();
    await this.fetchJson(`${this.base}/api/v1/collections/${encodeURIComponent(id)}/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: cards.map((c) => c.id),
        documents: cards.map((c) => c.document),
        metadatas: cards.map((c) => c.metadata),
        embeddings: cards.map((c) => c.embedding),
      }),
    });
  }

  async query(embedding: number[], nResults: number, where?: Record<string, unknown>): Promise<RetrievedDoc[]> {
    const id = await this.resolveCollectionId();
    const res = await this.fetchJson<ChromaQueryResult>(
      `${this.base}/api/v1/collections/${encodeURIComponent(id)}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query_embeddings: [embedding], n_results: Math.max(1, nResults), where }),
      },
    );
    const ids = (res.ids?.[0] || []).filter(Boolean);
    return ids.map((hitId, i) => ({
      id: hitId,
      document: res.documents?.[0]?.[i] ?? null,
      metadata: (res.metadatas?.[0]?.[i] as any) ?? null,
      distance: res.distances?.[0]?.[i] ?? null,
    }));
  }

  async count(): Promise<number> {
    const id = await this.resolveCollectionId();
    try {
      const data: any = await this.fetchJson(`${this.base}/api/v1/collections/${encodeURIComponent(id)}/count`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const n = Number(data?.count ?? data);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
}
