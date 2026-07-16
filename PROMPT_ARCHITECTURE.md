# Prompt Architecture

The model is used in two constrained roles — **planner** and **generator** — plus
a one-shot **repair** step. Prompts inject only synthetic, retrieved context; no
private prompt text exists in this repo.

## Planner contract (structured output, not SQL)

The planner ([`src/planner/plan.ts`](src/planner/plan.ts)) is deliberately **not**
allowed to emit SQL. It must return exactly one JSON object:

```json
{
  "intent": "string",
  "entities": [{ "name": "…", "type": "table|column|…", "confidence": 0.9, "source": "…" }],
  "metrics": ["string"],
  "dimensions": ["string"],
  "timeWindow": "last 7 days | null",
  "grain": "day | null",
  "filters": ["string"],
  "tables": ["string"],
  "joins": ["string"],
  "dialect": "mysql",
  "riskFlags": ["string"]
}
```

Why plan-first:

- **Structure before syntax.** Forcing a plan makes the model commit to *which*
  tables/metrics/filters it will use before it writes SQL, which is far easier to
  ground and check than free-form SQL.
- **Fail fast.** A non-JSON or schema-echo response is detected and either
  discarded (replaced with a safe empty plan) or thrown with a truncated preview.
- **Grounding.** The prompt injects only a **capped, entity-scoped schema slice**
  and a small set of retrieved cards — never the full schema.

## Schema-slice minimization

`schemaSlice()` keeps only the tables implied by the resolved entities (falling
back to the lowest-risk tables when nothing resolves), then filters columns,
relationships, and indexes to that table set, each with a hard cap. This bounds
prompt size and keeps the model from wandering outside the relevant subgraph.

## Structured-output robustness

`parsePlannerJsonOrThrow` strips markdown fences, tries a direct `JSON.parse`,
then falls back to the first `{ … }` span. `normalizePlan` coerces every field to
the right type (arrays forced to string arrays, non-string `timeWindow`/`grain`
nulled, dialect constrained to the allowed enum). `validatePlan` is a stricter
gate used where a hard contract is required.

## Mock planner vs. live Ollama planner (demo modes)

The planner/generator is a pluggable `LlmAdapter`, so the *same* prompts, parser,
and validator run regardless of which model answers:

- **Deterministic mock** ([`src/llm/mockLlm.ts`](src/llm/mockLlm.ts)) — routes on
  the question and returns a canned plan (JSON mode) or SQL. Used by `npm run demo`,
  `npm run eval`, and the tests so behavior is reproducible with no external model.
- **Live Ollama** ([`src/llm/ollamaAdapter.ts`](src/llm/ollamaAdapter.ts)) — a
  local model emits the plan JSON and the SQL. Wired by
  [`scripts/run-ollama-demo.ts`](scripts/run-ollama-demo.ts) (`npm run demo:ollama`),
  which prints the raw model output, the parsed plan, the validated SQL, and a
  per-check guardrail summary so the boundary is visible.

The parser/validator boundary is the contract between them: raw model text is
**untrusted** and only becomes a plan (then SQL) after `parsePlannerJsonOrThrow` +
`normalizePlan` and the full validator. **Invalid model output fails closed** — a
non-JSON planner response throws with a truncated preview (no SQL generated), and a
non-read-only generator response is neutralized to a safe fallback `SELECT`. The
live demo cannot produce anything the offline demo couldn't, because both share the
same downstream guardrails.

## Ambiguity handling

- **Alias store** ([`src/domain/aliasStore.ts`](src/domain/aliasStore.ts)) is the
  evidence-based, interactive path: it ranks an alias's canonical targets from
  Laplace-smoothed confirmation counts and asks for clarification unless the leader
  is decisively ahead.
- **Entity resolver** flags near-tied tables/columns; for multi-table analytical
  queries this is surfaced as a warning (see [docs/entity-resolution.md](docs/entity-resolution.md)).

## Generator contract

The generator ([`src/sql/generate.ts`](src/sql/generate.ts)) is a **strict SQL
producer**: one read-only statement, explicit columns (no `SELECT *`), explicit
aliased joins, a time filter unless the plan says otherwise, and a bounded `LIMIT`
for non-aggregations. It injects the approved plan + compacted schema slice + RAG
buckets as authoritative JSON. On a non-read-only first attempt it retries once in
a stricter mode, then falls back to a safe literal SELECT, and always ends with a
hard string-level guard.

## Repair loop architecture

`repairSqlOnce` ([`src/sql/repair.ts`](src/sql/repair.ts)) takes the failing SQL
plus the validator's structured error list and asks the model for a corrected
statement, then re-validates. It is bounded to a **single** pass.

### Known gap (honest)

The repair function exists as a standalone pipeline component and is exercised by
the engine's `run()` and by the eval/demo scaffolding. This showcase keeps
execution local and synthetic; a production service would wire repair into the
HTTP request path with **retry limits, timeouts, tracing, and cost budgets**, and
would likely feed richer structured diagnostics (not just error strings) back to
the model. It is intentionally not over-engineered here.
