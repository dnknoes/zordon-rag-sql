# Retrieval Pipeline

Retrieval grounds the model in the *relevant slice* of the schema instead of
prompt-stuffing everything. Code: [`src/retrieval/`](../src/retrieval/).

## Indexing (build side)

[`indexSchema`](../src/retrieval/index.ts) renders the normalized schema into
compact, **type-tagged cards** and embeds each one:

| Card type | Example document |
|---|---|
| `table_card` | `TABLE demo.demo_work_orders — ~1000 rows, risk=medium. …` |
| `column_card` | `COLUMN demo.demo_work_orders.created_at datetime NOT NULL` |
| `fk_edge` | `FOREIGN KEY demo.demo_defects.work_order_id -> demo.demo_work_orders.work_order_id` |
| `index_hint` | `INDEX ix_events_timestamp ON demo.demo_work_order_events (event_timestamp)` |
| `example_query` | a synthetic example SQL statement |
| `domain_note` | a short synthetic note about the domain |

Card IDs are deterministic (`table:…`, `column:…`, `fk:…`) so upserts are
idempotent. The raw schema JSON is **never** sent to the LLM — only cards are.

## Retrieval (query side)

[`retrieveContext`](../src/retrieval/retrieve.ts):

1. **Embed the question once** (client-side), then query each card type
   separately with its own top-k (`kTables`, `kColumns`, `kRelationships`, …).
   Client-side embedding keeps the query path independent of any server-side
   embedding config.
2. **Fuzzy re-rank** each group with a deterministic Jaccard token score
   ([`fuzzy.ts`](../src/retrieval/fuzzy.ts)) — a *dampener* over semantic order,
   with a stable id tie-break so results are reproducible.
3. **Dedupe examples by join-family**: an example's set of referenced tables is
   its family key; keep one per family (prevents near-duplicate queries from
   dominating).
4. **Budget merge**: add schema-truth cards first, then examples, stopping at a
   doc-count and character budget. Schema truth therefore always wins the budget.
5. **FK-graph expansion** ([`graph.ts`](../src/retrieval/graph.ts)): seed from the
   merged cards' tables and expand 2 hops over the undirected FK graph to supply
   **join evidence** downstream.

## Pluggable stores/embedders

Both a real [`ChromaVectorStore`](../src/retrieval/vectorStore.ts) and an
`InMemoryVectorStore` implement the same `VectorStore` interface; a real
`createOllamaEmbedder` and an offline `createHashEmbedder` implement `Embedder`.
The demo/eval use the in-memory + hash pair for deterministic offline runs; a real
deployment swaps in Chroma + Ollama with no engine changes.

> The offline hash embedder is a **stand-in**, not a semantic model — it exists so
> the pipeline runs with no services. Real semantic retrieval uses Ollama.
