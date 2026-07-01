# Evaluation Notes

Evaluation is how this project keeps AI behavior **safe and predictable**. The
golden harness runs whole questions through the real pipeline and asserts both the
*outcome* and *structural properties* of any generated SQL — all offline and
deterministic.

Run it:

```bash
npm run eval    # scripts/run-golden-eval.ts
npm test        # unit tests for pure functions (guards, fuzzy, validators, alias math)
```

## Golden cases

Cases live in [`examples/synthetic-queries/golden_cases.json`](examples/synthetic-queries/golden_cases.json).
Each case declares an expected **outcome** and a set of checks:

```jsonc
{
  "id": "defects-by-location",
  "question": "Which locations had the most defects in the last 30 days?",
  "expects": "sql",                                  // sql | ask | reject
  "must_use_tables": ["demo_defects", "demo_locations"],
  "must_not_use_tables": ["demo_work_order_events"], // optional
  "must_include": ["(?i)count\\s*\\(", "(?i)group\\s+by"],
  "must_not_include": ["(?i)select\\s+\\*"],
  "requires_time_filter": false                       // re-checks the time-filter rule
}
```

## Expected intent / outcome classification

The pipeline returns exactly one of:

- **`sql`** — a validated read-only statement.
- **`ask`** — a clarification (alias ambiguity or weak grounding).
- **`reject`** — fail-closed error (unrepairable / unsafe).

The harness fails a case if the outcome class doesn't match `expects`.

## Structural checks on generated SQL

For `sql` outcomes the harness asserts:

- **must-include / must-not-include** regex patterns (a `(?i)` prefix = case
  insensitive). This is how we assert "has a `LIMIT`", "has a `GROUP BY`", "has a
  time predicate on `event_timestamp`", and "**never** contains `SELECT *` /
  `DELETE`".
- **table use** — required tables are present and forbidden tables are absent
  (string literals are masked before table extraction, so quoted content can't be
  mistaken for a table).
- **time-filter check** — when `requires_time_filter` is set, the dedicated
  `requireTimeFilterIfEventLike` rule is re-run against the SQL; it throws if the
  required predicate is missing.

## Representative cases (all synthetic)

| Case | Demonstrates |
|---|---|
| open high-priority work orders | filters + `LIMIT`, single table |
| defects by location | multi-table FK-backed joins + aggregation |
| completed inspections for an asset | 3-table join + quoted literal handling |
| events by type | **required time filter** on a high-volume event table |
| delete all work orders | **write request neutralized** to a safe read-only fallback |

## Strict vs non-strict

`strict` (default true) enables the weak-grounding fail-safe (ask for a more
specific entity when retrieval is too thin) and requires FK evidence for joins. In
non-strict mode a same-name `*_id` join heuristic is accepted. Neither mode ever
emits non-read-only SQL.

## How eval supports safer AI

Golden + unit tests turn the engine's safety properties into **regressions**: if a
change lets `SELECT *` through, drops a `LIMIT`, accepts an unbacked join, or lets
a write verb survive, a test goes red. The offline mock model makes this
deterministic and CI-friendly — the guardrails are tested independently of any
particular model's output.
