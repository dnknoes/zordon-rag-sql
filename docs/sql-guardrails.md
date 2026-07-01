# SQL Guardrails

Validation is **fail-closed**: SQL is returned only if it passes every check;
otherwise the engine attempts one repair, then errors with no SQL. Code:
[`src/validate/`](../src/validate/) and [`src/sql/dialect.ts`](../src/sql/dialect.ts).

## Layer 1 — string-level guard

[`guardSqlString`](../src/validate/guards.ts) (runs first; hard short-circuit):

- Must **start with** `SELECT` / `WITH…SELECT` / `EXPLAIN` / `SHOW` / `DESCRIBE`.
- **No** write/DDL/DCL/proc/file verbs anywhere (`INSERT/UPDATE/DELETE/DROP/
  TRUNCATE/ALTER/CREATE/REPLACE/GRANT/REVOKE/CALL/EXEC/LOAD/INTO OUTFILE/…`),
  scanned on a copy with string literals blanked (so `… WHERE note = 'delete me'`
  is fine).
- **No `SELECT *`.**
- **Single statement** (at most one trailing semicolon).

## Layer 2 — dialect screen

[`enforceMysqlOnly`](../src/validate/rules/dialectOnly.ts) requires the plan's
dialect to be `mysql` and runs a lexical screen
([`assertMysqlOnlySql`](../src/sql/dialect.ts)) that rejects analytics-dialect
tokens (`toStartOfDay`, `toTimeZone`, `countIf`, `uniq*`, `arrayJoin`, …).

## Layer 3 — schema + plan awareness

[`validateSqlDetailed`](../src/validate/validate.ts):

- **Plan tables exist** in the schema.
- **SQL tables ⊆ plan tables** (no out-of-plan tables).
- **Columns exist** on their resolved table (alias-aware; unknown qualifiers such
  as function calls are skipped).
- **Joins are FK-backed**: every `ON a.x = b.y` must match a real foreign key in
  either direction. Non-strict mode also accepts a same-name `*_id` heuristic.

## Layer 4 — scan-bounding rules

- [`requireLimitForNonAggregations`](../src/validate/rules/requireLimit.ts):
  non-aggregations must include a `LIMIT`; `GROUP BY`/aggregate queries are exempt.
- [`requireTimeFilterIfEventLike`](../src/validate/rules/requireTimeFilter.ts):
  any query touching an event-like-named or schema-flagged **high-risk** table
  (e.g. `demo_work_order_events`) must carry a time-range predicate on a plausible
  time column (or a relative-date function), unless the user/plan explicitly opts
  out of time filtering.

## Why lexical (and its limits)

These checks are regex/string-level, not a full parser — fast and dependency-free,
which suits a screen that complements (not replaces) least-privilege, read-only DB
execution. A production system should add an AST-level validator; see
[SAFETY_NOTES.md](../SAFETY_NOTES.md).

## Defense in depth

Generation itself also refuses non-read-only output (retry → safe fallback → hard
guard), so by the time SQL reaches validation it is already read-only; validation
then enforces schema/plan/scan correctness. The two layers are independent on
purpose.
