# Architecture

Zordon RAG SQL is a pipeline of small, independently testable stages. Each stage
narrows uncertainty: retrieval grounds the model in real schema, planning forces
structure, generation produces one statement, and validation refuses anything
unsafe.

## End-to-end flow

```mermaid
flowchart TD
  Q[User question] --> A[Alias resolution\n(evidence-based)]
  A -->|needs clarification| CL[Return clarification]
  A --> R[Retrieve schema cards + examples\n(typed vector search, fuzzy re-rank, budget)]
  R --> W{Strong enough\ngrounding?}
  W -->|no, strict| CL
  W -->|yes| E[Resolve entities\n(tables/columns, confidence, literals)]
  E --> P[Plan\nLLM -> strict JSON plan]
  P --> G[Generate SQL\nLLM -> one read-only statement]
  G --> V[Validate\nguard + dialect + schema + joins + time + LIMIT]
  V -->|ok| OUT[Safe read-only SQL]
  V -->|invalid| RP[Repair once]
  RP --> V2[Re-validate]
  V2 -->|ok| OUT
  V2 -->|still invalid| ERR[Fail-closed error]
```

## Module map

```
src/
  index.ts              createZordon(): composes run(request) -> Response
  types.ts              all shared contracts (plan, cards, adapters, config, request/response)
  config.ts             env-driven defaults (ZORDON_* / generic fallbacks)
  llm/
    ollamaAdapter.ts    real local LLM transport (POST /api/generate)
    mockLlm.ts          deterministic OFFLINE stand-in (demo/eval)
  retrieval/
    embed.ts            Ollama embedder + offline hash embedder
    vectorStore.ts      Chroma REST client + in-memory store (same interface)
    index.ts            schema -> typed embedding cards -> upsert
    retrieve.ts         Stage 2: typed search + fuzzy re-rank + budget + FK graph
    fuzzy.ts            Jaccard token-set similarity (deterministic dampener)
    graph.ts            FK graph expansion (join evidence)
  entities/
    resolve.ts          Stage 3: rank tables/columns, ambiguity gate, literal protection
  domain/
    aliasStore.ts       learning shorthand memory (Laplace-smoothed, atomic snapshot)
  planner/
    plan.ts             Stage 4: schema slice + strict JSON plan contract + normalize/validate
  sql/
    dialect.ts          non-MySQL token screen
    generate.ts         Stage 5: one read-only statement (+ strict retry + safe fallback + guard)
    repair.ts           one validator-error-driven repair pass
  validate/
    guards.ts           string-level read-only guard
    validate.ts         Stage 6: schema+plan-aware orchestrator (fail-closed)
    rules/              dialectOnly, requireLimit, requireTimeFilter
  schema/
    loader.ts           load normalized schema cards from JSON
  runtime/
    offlineEngine.ts    wire in-memory store + hash embedder + mock LLM for demo/eval
```

## Data flow

1. **Cards** — the schema is rendered into compact, typed cards
   (`table_card`, `column_card`, `fk_edge`, `index_hint`, `example_query`,
   `domain_note`) and embedded into the vector store. The raw schema is never
   sent to the model.
2. **Context** — a question is embedded once; each card type is queried
   separately with its own top-k, re-ranked with a deterministic fuzzy score,
   deduped (examples by join-family), and merged under a doc/char budget with
   schema truth prioritized over examples. FK-graph expansion adds join evidence.
3. **Entities** — tables/columns are scored across schema, vector, and graph
   signals; quoted literals are tagged low-confidence.
4. **Plan** — the model emits a JSON plan grounded in a capped, entity-scoped
   schema slice + retrieved cards.
5. **SQL** — the model emits one statement; cleanup isolates a single statement.
6. **Validation** — the statement must pass every guardrail or it is not returned.

## Why a synthetic schema

The whole value of an NL-to-SQL engine is in the *patterns* (retrieval grounding,
plan contract, guardrails), not in any particular schema. Using a fictional
maintenance/work-order schema lets the architecture be shown openly while keeping
all real schema, data, and identifiers out of the repo.

## What is intentionally excluded

- No real database executor (generation + validation only).
- No production schema, queries, credentials, or hostnames.
- No UI / API server (CLI-first; the engine is a library).
- No BM25/keyword retrieval variant (kept as a possible separate showcase).
