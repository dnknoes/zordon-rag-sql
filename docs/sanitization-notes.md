# Sanitization Notes

This repository is a **clean-room extraction**: it reproduces the *architecture
and engineering patterns* of a private NL-to-SQL engine while containing none of
its data, schema, identifiers, or code text.

## What was kept

- The pipeline shape: index → alias → retrieve → resolve → plan → generate →
  validate → repair.
- The engineering patterns: typed retrieval cards, client-side embedding,
  fuzzy re-rank, FK-graph join evidence, structured plan contract, layered
  fail-closed validation, learning alias disambiguation, golden evaluation.
- Standard, non-proprietary technology names: RAG, embeddings, vector store,
  Chroma, Ollama, MySQL dialect concepts.

## What was replaced or removed

| Category | In this repo |
|---|---|
| Schema (tables/columns/relationships/row counts) | Fully synthetic `demo_*` maintenance/work-order schema |
| Example queries / domain notes | Written from scratch, fictional |
| Product / site / line / process / station / part / serial identifiers | **None** — replaced with generic demo values |
| Internal system / API / collection / project names | **None** — generic names only (`ZORDON_*`, `zordon_demo`) |
| Real hostnames / DB names | Local placeholders only (`localhost`, `example`-style) |
| Credentials / tokens / JWTs | **None** — `.env.example` placeholders only |
| Real usernames / people | **None** — `demo_operator`-style only |
| Copied source files / git history | **None** — authored fresh; fresh git history |

## How it was verified

- A strict pattern audit of the extracted tree for employer/product/internal
  terms, secrets, emails, and long encoded strings (see the extraction report).
- `npm run typecheck`, `npm test`, and `npm run eval` all pass offline.

## Corpus policy

Anything placed under a retrieval corpus (example queries, domain notes) **must be
synthetic**. Never add real production queries, real schema, real notes, serials,
or internal identifiers. The bundled corpus in
[`scripts/_shared.ts`](../scripts/_shared.ts) is fictional and consistent with the
synthetic schema.
