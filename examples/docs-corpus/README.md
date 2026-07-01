# docs-corpus (synthetic)

This folder is a placeholder for a **retrieval corpus** — example SQL queries and
short "domain note" documents that get indexed alongside the schema so the
planner/generator can ground on realistic patterns.

Everything here must be **synthetic**. Never place real production queries, real
schema, real table/column names, or copied internal notes in this folder.

For the bundled offline demo and eval, a small synthetic corpus is defined inline
in [`scripts/_shared.ts`](../../scripts/_shared.ts) (`EXAMPLES` and `NOTES`) and
indexed into the in-memory vector store. When running the real-stack indexer
(`npm run index:schema`), the same `EXAMPLES`/`NOTES` are embedded with Ollama
and upserted into Chroma.

To extend the corpus, add more entries to `EXAMPLES` (example queries) and
`NOTES` (domain notes) — keeping them fully fictional and consistent with the
synthetic `demo_*` schema under [`examples/synthetic-schema/`](../synthetic-schema/).
