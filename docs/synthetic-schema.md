# Synthetic Schema

The engine is demonstrated over a **fully fictional maintenance / work-order**
domain. Every table, column, relationship, and row count is invented for this
showcase. Cards live in [`examples/synthetic-schema/`](../examples/synthetic-schema/).

## Tables

| Table | ~Rows (fake) | Risk | Purpose |
|---|---|---|---|
| `demo_work_orders` | 1000 | medium | One row per maintenance work order |
| `demo_assets` | 100 | low | Assets that work orders are performed on |
| `demo_locations` | 25 | low | Sites/locations where assets live |
| `demo_technicians` | 40 | low | Technicians who perform work orders |
| `demo_defects` | 600 | medium | Defects recorded against work orders |
| `demo_inspections` | 800 | medium | Inspection results for work orders |
| `demo_work_order_events` | 5000 | **high** | Append-only work-order event log |

`demo_work_order_events` is intentionally marked **high risk** and named
event-like so it exercises the "require a time filter" guardrail.

## Relationships (foreign keys)

```
demo_work_orders.asset_id        -> demo_assets.asset_id
demo_work_orders.location_id     -> demo_locations.location_id
demo_work_orders.technician_id   -> demo_technicians.technician_id
demo_assets.location_id          -> demo_locations.location_id
demo_defects.work_order_id       -> demo_work_orders.work_order_id
demo_inspections.work_order_id   -> demo_work_orders.work_order_id
demo_work_order_events.work_order_id -> demo_work_orders.work_order_id
```

These FKs are what the join-evidence guardrail checks against — a join without a
matching FK is rejected.

## Example NL questions (synthetic)

- "Show open high-priority work orders from the last 7 days."
- "Which locations had the most defects in the last 30 days?"
- "List completed inspections for asset 'A-100' in the last 24 hours."
- "Count work order events by event_type in the last 7 days."

## Extending it

Edit the JSON card files under `examples/synthetic-schema/` (they map 1:1 to the
`TableCard` / `ColumnCard` / `Relationship` / `IndexHint` types in
[`src/types.ts`](../src/types.ts)) and add matching synthetic examples/notes in
[`scripts/_shared.ts`](../scripts/_shared.ts). Keep everything fictional — see
[sanitization-notes.md](sanitization-notes.md).
