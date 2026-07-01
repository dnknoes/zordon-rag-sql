import path from 'path';
import type { DomainNote, ExampleQuery } from '../src/retrieval/index';

// npm scripts run from the repo root, so process.cwd() is the project root.
export const ROOT = process.cwd();
export const SCHEMA_DIR = path.join(ROOT, 'examples', 'synthetic-schema');
export const GOLDEN_PATH = path.join(ROOT, 'examples', 'synthetic-queries', 'golden_cases.json');

/** Synthetic example queries indexed as retrieval "example_query" cards. */
export const EXAMPLES: ExampleQuery[] = [
  {
    name: 'recent-open-work-orders',
    sql: 'SELECT wo.work_order_id, wo.status FROM demo_work_orders wo WHERE wo.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY wo.created_at DESC LIMIT 100;',
  },
  {
    name: 'defects-by-location',
    sql: 'SELECT loc.location_name, COUNT(*) AS defect_count FROM demo_defects d JOIN demo_work_orders wo ON d.work_order_id = wo.work_order_id JOIN demo_locations loc ON wo.location_id = loc.location_id WHERE d.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY loc.location_name ORDER BY defect_count DESC LIMIT 25;',
  },
  {
    name: 'events-by-type',
    sql: 'SELECT e.event_type, COUNT(*) AS event_count FROM demo_work_order_events e WHERE e.event_timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY e.event_type ORDER BY event_count DESC LIMIT 50;',
  },
];

/** Synthetic domain notes indexed as retrieval "domain_note" cards. */
export const NOTES: DomainNote[] = [
  {
    name: 'statuses',
    text: 'Work orders move through statuses: open, in_progress, completed, cancelled. Priority is one of low, medium, high.',
  },
  {
    name: 'events-table',
    text: 'demo_work_order_events is an append-only, high-volume log; always apply a time filter on event_timestamp when querying it.',
  },
  {
    name: 'joins',
    text: 'demo_defects and demo_inspections both reference demo_work_orders via work_order_id. demo_work_orders references demo_assets, demo_locations, and demo_technicians.',
  },
];
