# Safety Notes

## This is a sanitized showcase

This repository is a **clean-room, synthetic portfolio artifact**. It was authored
from an understanding of a private engine's architecture; no source files, schema,
data, or identifiers were copied.

- **All schema/data/examples are synthetic.** The `demo_*` maintenance/work-order
  schema, the row counts, the example SQL, the domain notes, and the golden cases
  are fictional and written from scratch.
- **No employer data is included.** No product/site/process/line/station/serial
  identifiers, no internal system or API names, no internal usernames or people.
- **No production credentials are included.** There are no tokens, passwords, JWTs,
  or private hostnames. `.env.example` contains only local placeholders.
- **No real database connection is included.** The engine generates and validates
  SQL; it does not execute it. There is no DB executor.

## The live Ollama demo is local-only

`npm run demo:ollama` ([`scripts/run-ollama-demo.ts`](scripts/run-ollama-demo.ts))
swaps the deterministic mock for a real **local** model, and nothing else changes:

- **Local-only.** It talks to a local Ollama server (`OLLAMA_URL`, default
  `http://localhost:11434`) and makes no other network calls. **No external API,
  no API key, no tokens** — Ollama needs none, and none are read.
- **No real DB, no real schema.** Retrieval and generation run over the same
  synthetic `demo_*` schema; SQL is still only generated and validated, never run.
- **No credentials.** The demo reads only `OLLAMA_URL`/`OLLAMA_MODEL`; `.env`/
  `.env.local` are git-ignored and never required.
- **Model output is treated as untrusted.** The local model's plan and SQL pass the
  exact same fail-closed validator as the offline demo before anything is shown.
  Invalid JSON fails closed (no SQL), and write/destructive requests are neutralized
  to a safe read-only fallback. A live model cannot bypass the guardrails.
- **Graceful when absent.** If Ollama isn't reachable the demo prints a clear notice
  and exits, pointing back to the offline `npm run demo`.

## Runtime safety properties

The engine is **read-only by construction**. Generated SQL must pass a layered,
fail-closed validation pipeline before it is ever returned:

- **Write operations are blocked.** A string-level guard requires the statement to
  start with `SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `DESCRIBE` and rejects any
  `INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE/REPLACE/GRANT/REVOKE/CALL/EXEC/…`
  keyword (scanned with string literals masked). A write request from the user is
  neutralized to a safe read-only fallback.
- **No `SELECT *`** — unbounded column projection is rejected.
- **Single statement only** — more than one statement is rejected.
- **Schema-grounded** — plan and SQL tables must exist in the schema; qualified
  columns must exist on their resolved table.
- **FK-backed joins** — every `ON a.x = b.y` must correspond to a real foreign key
  (a same-name `*_id` heuristic is allowed only in non-strict mode).
- **Broad/full-scan queries are guarded** — non-aggregations require a `LIMIT`, and
  queries touching event-like/high-risk tables require a time-range predicate.
- **Fail-closed** — if any check fails and a single repair pass can't fix it, the
  engine returns an error and **no SQL**, rather than something unverified.

## What would need hardening for production

This is a showcase, not a hardened service. Before real use you would add:

- Execution with least-privilege, read-only DB credentials and per-query timeouts
  and row caps enforced at the connection level (not just in generated text).
- A proper SQL parser/AST for validation instead of lexical regex screens.
- Wiring the repair loop into the request path with retry limits, observability,
  and cost/latency budgets (see [PROMPT_ARCHITECTURE.md](PROMPT_ARCHITECTURE.md)).
- Authn/authz, rate limiting, audit logging, and prompt-injection defenses on any
  retrieved/user content.
- Tenant/schema isolation and PII controls on the indexed corpus.
