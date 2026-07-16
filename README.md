# Zordon RAG SQL — Local Retrieval-Grounded NL-to-SQL Engine

Zordon RAG SQL is a **local-first AI system** that turns plain-English analytical
questions into **validated, read-only SQL** over a synthetic schema. It
demonstrates retrieval-grounded generation, schema-aware planning, entity
resolution, ambiguity handling, and defense-in-depth SQL guardrails using
[Ollama](https://ollama.com) and [Chroma](https://www.trychroma.com).

> **Portfolio showcase.** Everything here — schema, data, queries, notes — is
> **synthetic**. It contains no employer, production, or proprietary information.
> See [SAFETY_NOTES.md](SAFETY_NOTES.md). License is restrictive: see [LICENSE](LICENSE).

The bundled demo and evaluation run **fully offline** (a deterministic mock model
and an in-memory vector store), so you can see the whole pipeline work with no
external services:

```bash
npm install
npm run demo     # NL questions -> validated SQL (offline)
npm run eval     # golden-case evaluation (offline)
npm test         # unit tests for the guardrails + math
```

## 1. What this is

A read-only **natural-language-to-SQL** engine built as a pipeline of small,
testable stages. Given a question like *"Which locations had the most defects in
the last 30 days?"*, it retrieves the relevant slice of a schema, plans a
structured query, generates SQL, and **validates it against the schema and a set
of safety rules before returning it**.

## 2. Why it exists

Letting an LLM emit SQL directly against a real database is risky: it can
hallucinate tables/columns, write destructive statements, or run unbounded scans.
This project shows a disciplined pattern that keeps the model useful while making
the output **safe by construction**.

## 3. Problem

- LLMs don't know your schema and will invent tables/columns.
- Prompt-stuffing an entire schema is expensive and still unreliable.
- Generated SQL may be non-read-only, unbounded, or dialect-wrong.
- Analytical shorthands ("WOs", "last week") are ambiguous.

## 4. Solution

- **Retrieval-grounded**: index the schema as small "cards" in a vector store and
  retrieve only what a question needs — never the whole schema.
- **Plan, then generate**: the model first emits a *structured plan* (JSON), not
  SQL. SQL generation is gated on a valid plan.
- **Validate, then trust**: every statement passes a layered, schema-aware,
  fail-closed validator before it is returned. Write statements are impossible to
  emit.
- **Disambiguate with evidence**: a learning alias store resolves shorthands from
  confirmed past choices instead of guessing.

## 5. Architecture

```
question
  → alias resolution (evidence-based; may ask to clarify)
  → retrieve schema cards + examples (vector search, typed, budgeted)
  → resolve entities (tables/columns) + detect ambiguity
  → plan (LLM → strict JSON plan; never SQL)
  → generate SQL (LLM → one read-only statement)
  → validate (string guard + dialect + schema + joins + time filter + LIMIT)
  → [one repair pass if invalid]
  → safe read-only SQL  |  clarification  |  fail-closed error
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map and data flow, and
[docs/](docs/) for deep dives.

## 6. Pipeline stages

| Stage | Module | Role |
|---|---|---|
| Index | [`src/retrieval/index.ts`](src/retrieval/index.ts) | Render schema → typed embedding cards |
| Alias | [`src/domain/aliasStore.ts`](src/domain/aliasStore.ts) | Evidence-based shorthand disambiguation |
| Retrieve | [`src/retrieval/retrieve.ts`](src/retrieval/retrieve.ts) | Typed vector search + fuzzy re-rank + FK graph |
| Resolve | [`src/entities/resolve.ts`](src/entities/resolve.ts) | Rank tables/columns; literal protection; ambiguity |
| Plan | [`src/planner/plan.ts`](src/planner/plan.ts) | LLM → strict JSON plan |
| Generate | [`src/sql/generate.ts`](src/sql/generate.ts) | LLM → one read-only statement |
| Repair | [`src/sql/repair.ts`](src/sql/repair.ts) | One validator-error-driven fix pass |
| Validate | [`src/validate/`](src/validate/) | Fail-closed guardrails |

## 7. Synthetic schema

A fictional **maintenance / work-order** domain (all `demo_*`), defined as JSON
cards in [`examples/synthetic-schema/`](examples/synthetic-schema/):
`demo_work_orders`, `demo_assets`, `demo_locations`, `demo_technicians`,
`demo_defects`, `demo_inspections`, `demo_work_order_events`. Row counts are
obviously fake. See [docs/synthetic-schema.md](docs/synthetic-schema.md).

## 8. Retrieval strategy

Per-type semantic search (tables / columns / FK edges / indexes / notes /
examples), a deterministic fuzzy re-rank "dampener", example dedup by join-family,
strict doc/char budgets with schema-truth prioritized over examples, and 2-hop FK
graph expansion for join evidence. See [docs/retrieval-pipeline.md](docs/retrieval-pipeline.md).

## 9. Entity resolution

Deterministic scoring across schema (exact/fuzzy), vector hits, and the FK graph,
with confidence bands by trust and **literal protection** (quoted values are
tagged low-confidence so they can't be silently trusted as filters). See
[docs/entity-resolution.md](docs/entity-resolution.md).

## 10. Ambiguity handling

Two mechanisms: (a) the **alias store** returns a clarification when a learned
shorthand is not decisively resolved (Laplace-smoothed confirmations); (b) the
resolver flags near-tied entities. For multi-table analytical queries the latter
is surfaced as a *warning* rather than a hard stop.

## 11. SQL planning / generation

The planner is constrained to emit a **plan object only** (intent, metrics,
dimensions, filters, tables, joins, time window, grain, risk flags) grounded in a
capped schema slice + retrieved cards. Generation then emits a single statement.
See [PROMPT_ARCHITECTURE.md](PROMPT_ARCHITECTURE.md).

## 12. SQL validation and guardrails

Layered and **fail-closed**: a string-level read-only guard (no writes/DDL, no
`SELECT *`, single statement), single-dialect enforcement, table/column existence,
FK-backed joins, a required time filter on event-like/high-risk tables, and a
mandatory `LIMIT` on non-aggregations. See [docs/sql-guardrails.md](docs/sql-guardrails.md).

## 13. Local-first AI stack

- **Ollama** for the planner/generator model and embeddings (default
  `qwen2.5-coder` + `nomic-embed-text`).
- **Chroma** for the vector store.
- No cloud calls, no secrets, no production database. See [`.env.example`](.env.example).

## 14. Demo modes

Both demos run against the **same synthetic schema** and the **same guardrails**.
The only difference is who plays the planner/generator model.

### Offline deterministic demo

```bash
npm run demo                       # canned sample questions
npm run demo -- "your question"    # ask your own
DEBUG=1 npm run demo               # include retrieval/plan debug
```

Uses a deterministic **mock LLM** (and an in-memory vector store), so the demo,
eval, and tests are stable and need no external services.

### Live local Ollama demo

```bash
npm run demo:ollama                     # 3 synthetic questions via local Ollama
npm run demo:ollama -- "your question"  # ask your own
```

Runs the real pipeline with a **local [Ollama](https://ollama.com) model** as the
planner/generator, over the same synthetic schema. For each question it prints the
retrieved schema cards, the provider/model, the raw model output, the parsed plan,
the validated SQL, and a per-check guardrail summary — so the AI step is visible
end-to-end. Requires Ollama running locally with the model pulled:

```bash
ollama pull qwen2.5-coder:7b        # or set OLLAMA_MODEL to any installed model
```

Configure via [`.env.example`](.env.example) (`OLLAMA_URL`, `OLLAMA_MODEL`). If
Ollama is unreachable the demo exits gracefully and points you back to
`npm run demo`. Even in this mode:

- **No real DB connection** — SQL is generated and validated, never executed.
- **No production data** — synthetic `demo_*` schema only.
- **No credentials** — local Ollama only; no API keys or tokens.
- **Model output is untrusted** — it still passes the full validation/guardrail
  pipeline before it is shown, and write requests are neutralized to a safe
  read-only fallback.

Real vector store (optional — needs Chroma running):

```bash
npm run index:schema   # embed synthetic cards into Chroma
# then wire ChromaVectorStore instead of the in-memory store
```

## 15. What was sanitized

This repo was extracted clean-room from a private engine. All real schema,
queries, hostnames, credentials, product/process/site identifiers, and internal
names were removed and replaced with synthetic equivalents. See
[docs/sanitization-notes.md](docs/sanitization-notes.md).

## 16. What this demonstrates

Practical AI-systems engineering: retrieval-augmented generation, structured
LLM output contracts, schema grounding, deterministic + probabilistic
disambiguation, defense-in-depth validation, golden-case evaluation, and a
pluggable local-first architecture with offline test doubles.

## 17. Future improvements

- Wire the repair loop into an HTTP service path with retry limits + tracing.
- Real embeddings-backed retrieval eval (recall@k) on a synthetic corpus.
- Broaden dialect support beyond MySQL with a proper AST-level check.
- Cost/latency budgeting and caching for the plan/generate calls.

---
MIT-incompatible; all rights reserved. © 2026 dnknoes. See [LICENSE](LICENSE).
