# Entity Resolution

Stage 3 turns a fuzzy natural-language mention into ranked, schema-grounded
entities *before* planning. Code:
[`src/entities/resolve.ts`](../src/entities/resolve.ts).

## Signals and confidence bands

Candidates are gathered from three signals and scored by trust:

| Signal | Source tag | Confidence |
|---|---|---|
| Exact schema name in the question | `schema` | `1.0` |
| Name-token overlap (fuzzy) | `fuzzy` | `0.55 + 0.45·overlap` (tables) |
| Vector retrieval hit | `vector` | `0.70–0.75 + 0.25·vectorConf` |
| FK-graph reachable table | `graph` | `0.58` |

`vectorConf` is derived from distance as `1 / (1 + distance)`. Candidates are
deduped (max confidence per id) and sorted deterministically (confidence desc,
then id asc).

## Literal protection

Every single-quoted value in the question (e.g. `'A-100'`) is emitted as a
low-confidence (`0.2`) entity of type `literal` from source `user`. This is a
guardrail: the pipeline must **confirm** such values against the schema/plan
rather than silently trust them as valid filter values — it never invents
categorical values.

## Ambiguity

`resolveEntitiesDetailed` computes an **ambiguity gate**: if the top two
candidates of a kind are within a small delta (default `0.03`) and are distinct,
it records a clarification.

For multi-table analytical questions, near-ties are *normal* (a defects-by-location
query legitimately ranks `demo_defects` and `demo_locations` together), so the
engine surfaces this as a **warning** and proceeds with the top match. The
**interactive** clarification path is the evidence-based alias store
([`src/domain/aliasStore.ts`](../src/domain/aliasStore.ts)), which learns from
confirmed user choices and only asks when a shorthand is genuinely undecided.

## Determinism

All scoring and tie-breaking is deterministic (no randomness, stable
`localeCompare` ordering), so identical inputs always yield identical resolution —
important for reproducible evaluation.
